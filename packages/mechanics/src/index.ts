/**
 * 机制引擎：v1 货架四件套——资源条 / 属性表 / 判定 / 物品栏。
 * 剧本声明哪个模块，就注册哪个模块的工具与投影；一个都没声明则本插件不挂。
 *
 * 链路（四件套同构）：GM 调工具 → 代码裁决 → 结果进 tool/result.meta
 *      → projection 折叠出当前值 → 经 session/projection 帧实时推前端。
 *
 * 为什么状态走 tool/result.meta 而不是自定义事件类型：dsh 有一份 codegen 的已知事件
 * 白名单，外部插件新增的事件类型会让存档在重新加载时被直接拒绝。meta 是既有事件的
 * 合法字段，随日志持久化、随 fork 复制，projection 重放即可还原。
 */
import { randomInt } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// 副作用导入：这两个包通过模块合并把 tools / sessionProjections 挂上 Context
import '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { DIE_RANGE, renderCheck, resolveCheck, rollDie } from './check.ts'
import { applyInventory, foldInventory, initialInventory } from './inventory.ts'
import {
  applyAllocations,
  applyXp,
  foldProgression,
  initialProgression,
  playerAllocationRequest,
  progressionView,
  reduceProgression,
  renderSpend,
  renderXp,
  type AllocationOutcome,
  type PointAllocation,
  type ProgressionView,
} from './progression.ts'
import { applyChanges, effectiveNumericDefs, foldApplied, initialState } from './resources.ts'
import {
  isAttributesResult,
  isInventoryResult,
  isMechanicsResult,
  isPointsResult,
  isXpResult,
  type AppliedChange,
  type AppliedInventoryChange,
  type AttributeDef,
  type CheckConfig,
  type CheckResult,
  type GroupTitles,
  type InventoryConfig,
  type InventoryState,
  type NumericDef,
  type NumericDefRevision,
  type ProgressionConfig,
  type ProgressionState,
  type ResourceDef,
  type ResourceState,
  type XpResult,
} from './types.ts'

export * from './check.ts'
export * from './inventory.ts'
export * from './progression.ts'
export * from './resources.ts'
export * from './types.ts'

const numericStateSchema = z.record(z.string(), z.object({
  value: z.number(),
  last: z.object({ applied: z.number(), reason: z.string() }).optional(),
}))

const mechanicsSchema = z.object({
  defs: z.array(z.object({
    id: z.string(),
    label: z.string(),
    group: z.enum(['affinity', 'self', 'world']),
    min: z.number(),
    max: z.number(),
    initial: z.number(),
    floor: z.number().optional(),
    maxStep: z.number(),
    display: z.enum(['strip', 'panel', 'hidden']).optional(),
    revealWith: z.string().optional(),
  })),
  state: numericStateSchema,
  groups: z.object({
    self: z.string().optional(),
    affinity: z.string().optional(),
    world: z.string().optional(),
  }).optional(),
})

const attributesSchema = z.object({
  defs: z.array(z.object({
    id: z.string(),
    label: z.string(),
    min: z.number(),
    max: z.number(),
    initial: z.number(),
    maxStep: z.number(),
  })),
  state: numericStateSchema,
})

const inventorySchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    name: z.string(),
    qty: z.number(),
    note: z.string().optional(),
  })),
})

const progressionSchema = z.object({
  label: z.string(),
  xp: z.number(),
  level: z.number(),
  maxLevel: z.number(),
  prev: z.number(),
  next: z.number().nullable(),
  unspent: z.number(),
  pointsPerLevel: z.number(),
  levelNames: z.array(z.string()).optional(),
  display: z.enum(['strip', 'panel']).optional(),
})

/** 玩家可见的资源快照 */
export type MechanicsProjection = { defs: ResourceDef[]; state: ResourceState; groups?: GroupTitles } | null
/** 属性表快照 */
export type AttributesProjection = { defs: Omit<AttributeDef, 'guidance'>[]; state: ResourceState } | null
/** 物品栏快照 */
export type InventoryProjection = { items: { id: string; name: string; qty: number; note?: string }[] } | null
/** 经验与等级快照：等级、经验、未分配属性点 */
export type ProgressionProjection = ProgressionView | null

// 每部剧本占自己的 key（`base:剧本id`），否则先 mount 的剧本会把后来者的 defs 顶掉；
// 裸 key 保留，兼容单剧本部署与旧存档。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    mechanics: MechanicsProjection
    attributes: AttributesProjection
    inventory: InventoryProjection
    progression: ProgressionProjection
    [key: `mechanics:${string}`]: MechanicsProjection
    [key: `attributes:${string}`]: AttributesProjection
    [key: `inventory:${string}`]: InventoryProjection
    [key: `progression:${string}`]: ProgressionProjection
  }
}

export interface Config {
  resources?: ResourceDef[]
  attributes?: AttributeDef[]
  checks?: CheckConfig
  inventory?: InventoryConfig
  /** 经验与等级（需同时声明 attributes：属性点要加在属性上） */
  progression?: ProgressionConfig
  /** 侧栏分组标题自定义（strip/panel/hidden 的选位在各资源的 display 字段上） */
  groups?: GroupTitles
  /**
   * 投影 key 的剧本分片（由编译器写入剧本 id）。
   *
   * dsh 的投影 registry 是**全局按 key 唯一**的，官方语义是"同 key 的注册者共享一个 unit
   * 并计数：同一个工具包挂在 N 个 preset 上就注册 N 次，key 活到最后一个卸载"——它假定
   * 这 N 个注册是**同构**的。而本插件的 defs 与初值来自各剧本自己的 config（闭包），
   * N 部剧本并不同构：先 mount 的那部赢，后 mount 的整份 defs 被它顶掉。
   * 实测后果：荻湾庄的会话每回合拿到澜心岛的面板（姜棠/苏晚晴/手枪/罐头），
   * 前端结算卡片也因为查不到 label 而裸奔出 grain / fuel 这样的 id。
   * 所以每部剧本必须占自己的 key。
   */
  scope?: string
}

/** 投影 key：有剧本分片就用 `base:剧本id`，没有则退回裸 key（兼容单剧本与旧存档）。 */
function projectionKey<B extends string>(base: B, scope?: string): B | `${B}:${string}` {
  return scope ? `${base}:${scope}` : base
}

export const name = 'taleforge-mechanics'
export const inject = ['tools']

type SessionEvents = readonly { type: string; data: unknown }[]

export function apply(ctx: Context, config: Config) {
  const resources = config?.resources ?? []
  const attributes = config?.attributes ?? []
  const checks = config?.checks
  const inventory = config?.inventory
  const progression = config?.progression

  if (resources.length) registerNumericTool(ctx, {
    tool: 'adjust_resources',
    title: '结算本回合变化',
    kindTag: 'mechanics/resources',
    reviseTarget: 'resource',
    remindActionBlock: true,
    defs: resources,
    catalogLine: d => `- \`${d.id}\`（${(d as ResourceDef).label}，${d.min}–${d.max}，单次最多 ±${d.maxStep}）`,
    labelOf: id => resources.find(r => r.id === id)?.label ?? id,
    pick: isMechanicsResult,
    description: '在剧情推进的同时记录本回合的数值变化。',
  })

  if (attributes.length) registerNumericTool(ctx, {
    tool: 'adjust_attributes',
    title: '调整属性',
    kindTag: 'mechanics/attributes',
    reviseTarget: 'attribute',
    defs: attributes,
    catalogLine: d => `- \`${d.id}\`（${(d as AttributeDef).label}，${d.min}–${d.max}，单次最多 ±${d.maxStep}）`,
    labelOf: id => attributes.find(a => a.id === id)?.label ?? id,
    pick: isAttributesResult,
    description: '属性只在剧本 guidance 允许的重大事件时变动，频率远低于资源。',
  })

  if (checks) {
    ctx.tools.register(defineTool({
      name: 'roll_check',
      description: `裁决一次成败不确定的行动：系统掷 ${checks.die}，加上属性与情境修正后与难度比较。`
        + '掷出的结果是最终裁决，只许承接不许翻案。何时必须掷、难度几档，见 persona 的机制面板。',
      parameters: {
        difficulty: { type: 'integer', required: true, description: '难度值，按剧本判定档位设定' },
        attribute: { type: 'string', description: '参与修正的属性 id（若本作声明了属性表）' },
        modifier: { type: 'integer', description: '情境修正（装备、环境、协助……），默认 0' },
        reason: { type: 'string', required: true, description: '判定什么，一句话，玩家可见' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            die: { type: 'string', required: true },
            roll: { type: 'integer', required: true },
            attribute: { type: 'string' },
            attrValue: { type: 'integer', required: true },
            modifier: { type: 'integer', required: true },
            total: { type: 'integer', required: true },
            difficulty: { type: 'integer', required: true },
            outcome: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderCheck(
            { kind: 'mechanics/check', ...(value as Omit<CheckResult, 'kind'>) },
            attributes.find(a => a.id === (value as { attribute?: string }).attribute)?.label,
          ),
        }],
        presentationMeta: (_args, value) => ({ kind: 'mechanics/check', ...(value as object) }),
      },
      execute(args, exec) {
        if (!exec.agent) throw new Error('roll_check 需要一个归属会话')
        const attrId = typeof args.attribute === 'string' && args.attribute ? args.attribute : undefined
        let attrValue = 0
        if (attrId) {
          const def = attributes.find(a => a.id === attrId)
          if (!def) throw new Error(`未知属性 id：${attrId}`)
          const state = readNumeric(attributes, exec.agent.session.events, isAttributesResult)
          attrValue = state[attrId]?.value ?? def.initial
        }
        const result = resolveCheck({
          die: checks.die,
          roll: rollDie(checks.die, sides => randomInt(1, sides + 1)),
          difficulty: Math.trunc(args.difficulty as number),
          attribute: attrId,
          attrValue,
          modifier: Number.isFinite(args.modifier) ? Math.trunc(args.modifier as number) : 0,
          reason: String(args.reason ?? ''),
        })
        // dsh 要求工具输出无损 JSON：undefined 键必须整个省略（不带属性的判定没有 attribute）
        const { kind: _kind, attribute, ...rest } = result
        return Promise.resolve(attribute === undefined ? rest : { attribute, ...rest })
      },
      presentCall: () => ({ card: 'generic', title: '掷骰判定', kind: 'other' }),
    }))
  }

  if (inventory) {
    ctx.tools.register(defineTool({
      name: 'adjust_inventory',
      description: '记录物品变动。正文里写到获得、交出、消耗、损毁某件物品的回合，必须当回合同步入账，不许隔回合补记。'
        + 'op：add（获得，新物品必须给 name）/ remove（失去）/ set（改数量或备注，只改既有物品）。'
        + '一切引用走物品 id（kebab-case），不要凭名字模糊匹配。'
        + '成批入账按种类分条、各给数量（如 bottled-water×6、canned-food×4），不许打包成一条「物资」——打包的账没法逐件消耗。',
      parameters: {
        changes: {
          type: 'array',
          required: true,
          description: '本回合的全部物品变动',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', required: true, description: 'add | remove | set' },
              id: { type: 'string', required: true, description: '物品 id，kebab-case，稳定不变' },
              name: { type: 'string', description: '显示名；新物品必填' },
              qty: { type: 'integer', description: 'add/remove 的数量（默认 1）；set 的目标数量' },
              note: { type: 'string', description: '备注（状态、来源、用途）' },
              reason: { type: 'string', description: '一句话变动原因，玩家可见' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            changes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  op: { type: 'string', required: true },
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  qty: { type: 'integer', required: true },
                  delta: { type: 'integer', required: true },
                  removed: { type: 'boolean', required: true },
                  note: { type: 'string' },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.changes as AppliedInventoryChange[]).length === 0
            ? '没有有效的物品变动（新物品缺 name、或对不存在的物品 remove/set 会被丢弃）。'
            : (value.changes as AppliedInventoryChange[])
                .map(c => c.removed
                  ? `失去 ${c.name}（已清空）`
                  : `${c.delta >= 0 ? '获得' : '消耗'} ${c.name}${Math.abs(c.delta) > 1 ? `×${Math.abs(c.delta)}` : ''}（现有 ${c.qty}）`)
                .join('\n'),
        }],
        presentationMeta: (_args, value) => ({ kind: 'mechanics/inventory', changes: value.changes }),
      },
      execute(args, exec) {
        if (!exec.agent) throw new Error('adjust_inventory 需要一个归属会话')
        const current = readInventory(inventory, exec.agent.session.events)
        const { applied } = applyInventory(current, args.changes as never)
        return Promise.resolve({ changes: applied })
      },
      presentCall: () => ({ card: 'generic', title: '清点物品', kind: 'other' }),
    }))
  }

  if (progression) {
    const xpLabel = progression.label
    const changeSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        delta: { type: 'integer', required: true },
        reason: { type: 'string', required: true },
        applied: { type: 'integer', required: true },
        before: { type: 'integer', required: true },
        after: { type: 'integer', required: true },
        clamped: { type: 'boolean', required: true },
      },
    } as const

    ctx.tools.register(defineTool({
      name: 'grant_xp',
      description: `上报${xpLabel}变化——每个正戏回合必调，没有变化传 0。本工具在你动笔之前调用：`
        + `只报**往回合已定稿正文**里发生的事件换来的${xpLabel}（通常是上一回合），本回合才打算写的不报、写完等下回合再报——`
        + '等级与属性点一经发放不收回，预报等于把成长赶进度。'
        + `给多少按 persona 里的规则给数字，系统裁单次上限 ±${progression.maxStep}；`
        + '等级由系统按阈值裁定，升级时系统发放属性点并交给玩家自行分配——你不替玩家加点。'
        + ((progression.bonusPointsMax ?? 0) > 0
          ? `剧情奖励属性点用 points 发放（单次最多 ${progression.bonusPointsMax}），同样进玩家的待分配池、由玩家选方向。`
          : ''),
      parameters: {
        amount: { type: 'integer', required: true, description: `往回合已定稿正文换来的${xpLabel}（负数为失去），没有传 0` },
        reason: { type: 'string', required: true, description: '一句话原因，玩家可见' },
        ...((progression.bonusPointsMax ?? 0) > 0
          ? { points: { type: 'integer', description: `剧情奖励属性点（按剧本规则给数字，单次最多 ${progression.bonusPointsMax}），没有传 0 或省略` } }
          : {}),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delta: { type: 'integer', required: true },
            applied: { type: 'integer', required: true },
            before: { type: 'integer', required: true },
            after: { type: 'integer', required: true },
            clamped: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
            levelBefore: { type: 'integer', required: true },
            levelAfter: { type: 'integer', required: true },
            pointsGranted: { type: 'integer', required: true },
            bonusPoints: { type: 'integer', required: true },
            unspent: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderXp({ kind: 'mechanics/xp', ...(value as Omit<XpResult, 'kind'> & { unspent: number }) }, progression),
        }],
        presentationMeta: (_args, value) => ({ kind: 'mechanics/xp', ...(value as object) }),
      },
      execute(args, exec) {
        if (!exec.agent) throw new Error('grant_xp 需要一个归属会话')
        const state = readProgression(exec.agent.session.events)
        const bonus = Number((args as { points?: unknown }).points ?? 0)
        const { state: next, result } = applyXp(state, progression, Number(args.amount), String(args.reason ?? ''), bonus)
        const { kind: _kind, ...rest } = result
        return Promise.resolve({ ...rest, unspent: next.granted - next.spent })
      },
      presentCall: () => ({ card: 'generic', title: `结算${xpLabel}`, kind: 'other' }),
    }))

    ctx.tools.register(defineTool({
      name: 'spend_points',
      description: '【仅当玩家消息里带【加点】块时调用】把玩家未分配的属性点按其写明的分配加到属性上——'
        + '原样落账，不增不减不改动；id 用属性表里的属性 id。系统以玩家消息里的加点请求为准落账'
        + '（你传的分配与之不符时以玩家为准），并校验未分配点数与属性上限，超了整条拒绝并说明。',
      parameters: {
        allocations: {
          type: 'array',
          required: true,
          description: '玩家的分配',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: '属性 id' },
              points: { type: 'integer', required: true, description: '加几点' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            changes: { type: 'array', required: true, items: changeSchema },
            spent: { type: 'integer', required: true },
            unspent: { type: 'integer', required: true },
            rejected: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  points: { type: 'integer', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderSpend(
            value as AllocationOutcome & { unspent: number },
            id => attributes.find(a => a.id === id)?.label ?? id,
          ),
        }],
        // 复用属性 meta 形状：属性投影照常折进去；points 账供经验投影扣池子
        presentationMeta: (_args, value) => ({
          kind: 'mechanics/attributes',
          changes: value.changes,
          points: { spent: value.spent },
        }),
      },
      execute(args, exec) {
        if (!exec.agent) throw new Error('spend_points 需要一个归属会话')
        const events = exec.agent.session.events
        const defs = effectiveNumericDefs(attributes, collectNumericRevisions(events), 'attribute')
        const current = readNumeric(defs, events, isAttributesResult)
        const prog = readProgression(events)
        const unspent = prog.granted - prog.spent
        const proposed = (Array.isArray(args.allocations) ? args.allocations : []) as PointAllocation[]
        const rejectAll = (reason: string) => Promise.resolve({
          changes: [],
          spent: 0,
          unspent,
          rejected: proposed.map(a => ({
            id: String(a?.id ?? ''),
            points: Number.isFinite(Number(a?.points)) ? Math.trunc(Number(a?.points)) : 0,
            reason,
          })),
        })
        // 代码权威：属性点只能由玩家分配。以玩家消息里的加点请求为准，GM 传的只作对照
        const { request, alreadySpent } = playerAllocationRequest(events)
        if (!request) return rejectAll('本回合玩家消息里没有【加点】请求——属性点只能由玩家分配，不能替玩家加')
        // 同一回合只落账一次：GM 重复调用不重复扣（玩家请求还在那条消息里，不能靠它去重）
        if (alreadySpent) return rejectAll('本回合的加点已经落账过，不重复扣')
        const outcome = applyAllocations(current, defs, unspent, request)
        const extra = proposed
          .filter(a => !request.some(r => r.id === a?.id))
          .map(a => ({
            id: String(a?.id ?? ''),
            points: Number.isFinite(Number(a?.points)) ? Math.trunc(Number(a?.points)) : 0,
            reason: '玩家未请求给该属性加点，已忽略（以玩家请求为准）',
          }))
        return Promise.resolve({
          changes: outcome.changes,
          spent: outcome.spent,
          unspent: unspent - outcome.spent,
          rejected: [...outcome.rejected, ...extra],
        })
      },
      presentCall: () => ({ card: 'generic', title: '分配属性点', kind: 'other' }),
    }))
  }

  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    if (resources.length) {
      projectionCtx.sessionProjections.register({
        key: projectionKey('mechanics', config.scope),
        schema: mechanicsSchema,
        init: (): NumericProjState => ({ values: initialState(resources), revisions: [] }),
        // 不认识的事件必须原样返回同一引用，registry 靠 Object.is 判断有没有变化
        apply: (state: NumericProjState, event: { type: string; data: unknown }) => {
          const rolled = applyUpkeepEvent(state, event, resources)
          return rolled === state ? applyNumericEvent(state, event, isMechanicsResult, 'resource') : rolled
        },
        view: (state: NumericProjState) => ({
          defs: effectiveNumericDefs(resources, state.revisions, 'resource'),
          state: state.values,
          groups: config?.groups,
        }),
        stateVersion: 2,
      })
    }
    if (attributes.length) {
      projectionCtx.sessionProjections.register({
        key: projectionKey('attributes', config.scope),
        schema: attributesSchema,
        init: (): NumericProjState => ({ values: initialState(attributes), revisions: [] }),
        apply: (state: NumericProjState, event: { type: string; data: unknown }) =>
          applyNumericEvent(state, event, isAttributesResult, 'attribute'),
        view: (state: NumericProjState) => ({
          defs: effectiveNumericDefs(attributes, state.revisions, 'attribute')
            .map(({ guidance: _g, ...visible }) => visible),
          state: state.values,
        }),
        stateVersion: 2,
      })
    }
    if (inventory) {
      projectionCtx.sessionProjections.register({
        key: projectionKey('inventory', config.scope),
        schema: inventorySchema,
        init: () => initialInventory(inventory.initial),
        apply: (state: InventoryState, event: { type: string; data: unknown }) => {
          const batch = metaOf(event, isInventoryResult)?.changes
          if (!batch?.length) return state
          return foldInventory(
            Object.entries(state).map(([id, v]) => ({ id, ...v, qty: v.qty })),
            [batch],
          )
        },
        view: (state: InventoryState) => ({
          items: Object.entries(state).map(([id, v]) => ({ id, ...v })),
        }),
        stateVersion: 1,
      })
    }
    if (progression) {
      projectionCtx.sessionProjections.register({
        key: projectionKey('progression', config.scope),
        schema: progressionSchema,
        init: (): ProgressionState => initialProgression(),
        // reduceProgression 对不认识的 meta 原样返回同一引用
        apply: (state: ProgressionState, event: { type: string; data: unknown }) =>
          reduceProgression(state, event.type === 'tool/result' ? (event.data as { meta?: unknown }).meta : undefined),
        view: (state: ProgressionState) => progressionView(progression, state),
        stateVersion: 1,
      })
    }
  })
}

/** 资源与属性同构：同一套注册逻辑，仅名字、目录与 meta kind 不同。 */
function registerNumericTool(ctx: Context, opts: {
  tool: string
  title: string
  kindTag: 'mechanics/resources' | 'mechanics/attributes'
  reviseTarget: 'resource' | 'attribute'
  defs: NumericDef[]
  catalogLine: (d: NumericDef) => string
  labelOf: (id: string) => string
  pick: (meta: unknown) => meta is { changes: AppliedChange[] }
  description: string
  /** 每正戏回合必调的工具挂行动块贴身提醒（低频工具不挂，避免噪音） */
  remindActionBlock?: boolean
}) {
  const catalog = opts.defs.map(opts.catalogLine).join('\n')
  ctx.tools.register(defineTool({
    name: opts.tool,
    description: `${opts.description}可用条目：\n${catalog}\n\n`
      + '一个回合把所有变化放在一次调用里提交。增减多少由你按剧情判断，'
      + '系统会裁掉越界的部分并把最终结果告诉你——以裁决后的结果为准继续叙事。'
      + 'reason 写给玩家看，一句话说明为什么变。',
    parameters: {
      changes: {
        type: 'array',
        required: true,
        description: '本回合的全部变化',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'id，必须来自上面的清单' },
            delta: { type: 'integer', required: true, description: '增减量，正数为增' },
            reason: { type: 'string', required: true, description: '一句话说明变化原因，玩家可见' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                delta: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
                applied: { type: 'integer', required: true },
                before: { type: 'integer', required: true },
                after: { type: 'integer', required: true },
                clamped: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: ((value.changes as AppliedChange[]).length === 0
          ? '没有产生有效变化。'
          : (value.changes as AppliedChange[])
              .map((c) => {
                const sign = c.applied > 0 ? '+' : ''
                const note = c.clamped ? `（原提交 ${c.delta}，已按边界裁决）` : ''
                return `${opts.labelOf(c.id)}：${sign}${c.applied} → ${c.after}${note}`
              })
              .join('\n'))
          // 行动块的贴身提醒：本工具在回合固定流程中最后调用，它的返回值是离生成点
          // 最近的文本——实测强收束场景（如亲密戏收在余韵）会把 persona 末尾的契约忘掉
          + (opts.remindActionBlock
            ? '\n（正文写在正式输出中；结尾必须有【行动】块——【行动】独行 + A–D 四行选项。终幕回合除外。）'
            : ''),
      }],
      presentationMeta: (_args, value) => ({ kind: opts.kindTag, changes: value.changes }),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error(`${opts.tool} 需要一个归属会话`)
      const events = exec.agent.session.events
      // 裁决用现行定义：种子 + 场外修订（min/max/maxStep 等边界即时生效）
      const defs = effectiveNumericDefs(opts.defs, collectNumericRevisions(events), opts.reviseTarget)
      const current = readNumeric(defs, events, opts.pick, opts.reviseTarget === 'resource')
      const { applied } = applyChanges(current, defs, args.changes as never)
      return Promise.resolve({ changes: applied })
    },
    presentCall: () => ({ card: 'generic', title: opts.title, kind: 'other' }),
  }))
}

function metaOf<T>(
  event: { type: string; data: unknown },
  pick: (meta: unknown) => meta is T,
): T | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: unknown }).meta
  return pick(meta) ? meta : undefined
}

/** 投影内部状态：数值 + 已落账的定义修订（view 时折出现行定义）。 */
interface NumericProjState {
  values: ResourceState
  revisions: NumericDefRevision[]
}

/** 周期收支声明的运行时形状（事实来源是 progress 包的 report_progress meta；不跨包引类型）。 */
interface UpkeepMetaEntry {
  id: string
  delta: number
  reason: string
  activeAbove?: number
}

/**
 * 周期收支的折叠。report_progress 的 meta 只带**声明**——progress 插件不知道资源当前值，
 * 也不知道现行定义（改过名/改过边界的修订都在这边）。所以 clamp、maxStep 与 activeAbove
 * 全在这里算：这是既有的分工，数值裁决归代码，且只认代码算出来的结果。
 * 与投影约定一致：不该动时返回**同一个引用**，registry 靠 Object.is 判断有没有变化。
 */
function dueUpkeep(values: ResourceState, event: { type: string; data: unknown }): UpkeepMetaEntry[] {
  if (event.type !== 'tool/result') return []
  const meta = (event.data as { meta?: { kind?: string; upkeep?: UpkeepMetaEntry[] } }).meta
  if (meta?.kind !== 'progress/report' || !meta.upkeep?.length) return []
  // activeAbove：值没过线就不滚（"种下之后才生长"）
  return meta.upkeep.filter(e =>
    e.activeAbove === undefined || (values[e.id]?.value ?? 0) > e.activeAbove)
}

function applyUpkeepEvent(
  state: NumericProjState,
  event: { type: string; data: unknown },
  resources: ResourceDef[],
): NumericProjState {
  const due = dueUpkeep(state.values, event)
  if (!due.length) return state
  const defs = effectiveNumericDefs(resources, state.revisions, 'resource')
  const { state: values } = applyChanges(state.values, defs, due)
  return values === state.values ? state : { ...state, values }
}

function applyNumericEvent(
  state: NumericProjState,
  event: { type: string; data: unknown },
  pick: (meta: unknown) => meta is { changes: AppliedChange[] },
  target: 'resource' | 'attribute',
): NumericProjState {
  const revs = revisionsInEvent(event)?.filter(r => r.target === target)
  if (revs?.length) return { ...state, revisions: [...state.revisions, ...revs] }

  const batch = metaOf(event, pick)?.changes
  if (!batch?.length) return state
  const values = { ...state.values }
  for (const change of batch) {
    if (!(change.id in values)) continue
    values[change.id] = { value: change.after, last: { applied: change.applied, reason: change.reason } }
  }
  return { ...state, values }
}

/**
 * 从事件里取数值定义修订。meta kind 'progress/revision' 的事实来源在 progress 包的
 * revise_setting——这里只认 resource/attribute 两类条目，其余忽略。
 */
function revisionsInEvent(event: { type: string; data: unknown }): NumericDefRevision[] | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: { kind?: string; revisions?: unknown[] } }).meta
  if (meta?.kind !== 'progress/revision' || !Array.isArray(meta.revisions)) return undefined
  const hits = (meta.revisions as NumericDefRevision[]).filter(
    r => r && (r.target === 'resource' || r.target === 'attribute') && typeof r.id === 'string',
  )
  return hits.length ? hits : undefined
}

function collectNumericRevisions(events: SessionEvents): NumericDefRevision[] {
  const out: NumericDefRevision[] = []
  for (const event of events) {
    const revs = revisionsInEvent(event)
    if (revs) out.push(...revs)
  }
  return out
}

/**
 * 从会话事件里读出当前数值状态（工具执行时用）。
 *
 * **必须与投影同源**：周期收支只带声明、由折叠方裁决，如果这里看不见它，
 * adjust_resources 就会拿一个偏旧的 before 去算 after，而投影又照单全收——
 * 结果就是"GM 动过的那几条资源，upkeep 被悄悄覆盖掉"（实测 grain 少扣了 8）。
 * 所以这里按事件顺序折叠，走和投影同一个 dueUpkeep 判定。
 */
function readNumeric(
  defs: NumericDef[],
  events: SessionEvents,
  pick: (meta: unknown) => meta is { changes: AppliedChange[] },
  withUpkeep = false,
): ResourceState {
  let values = initialState(defs)
  for (const event of events) {
    const meta = metaOf(event, pick)
    if (meta) {
      for (const change of meta.changes) {
        if (!(change.id in values)) continue
        values = { ...values, [change.id]: { value: change.after, last: { applied: change.applied, reason: change.reason } } }
      }
      continue
    }
    if (!withUpkeep) continue
    const due = dueUpkeep(values, event)
    if (due.length) values = applyChanges(values, defs, due).state
  }
  return values
}

/** 从会话事件里读出经验/等级/点数账（经验 meta + 加点 meta 按序折叠）。 */
function readProgression(events: SessionEvents): ProgressionState {
  const metas: unknown[] = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const meta = (event.data as { meta?: unknown }).meta
    if (isXpResult(meta) || isPointsResult(meta)) metas.push(meta)
  }
  return foldProgression(metas)
}

function readInventory(config: InventoryConfig, events: SessionEvents): InventoryState {
  const batches: AppliedInventoryChange[][] = []
  for (const event of events) {
    const meta = metaOf(event, isInventoryResult)
    if (meta) batches.push(meta.changes)
  }
  return foldInventory(config.initial, batches)
}
