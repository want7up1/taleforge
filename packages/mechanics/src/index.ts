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
import { applyChanges, effectiveNumericDefs, foldApplied, initialState } from './resources.ts'
import {
  isAttributesResult,
  isInventoryResult,
  isMechanicsResult,
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
  type ResourceDef,
  type ResourceState,
} from './types.ts'

export * from './check.ts'
export * from './inventory.ts'
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

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 玩家可见的资源快照 */
    mechanics: { defs: ResourceDef[]; state: ResourceState; groups?: GroupTitles } | null
    /** 属性表快照 */
    attributes: { defs: Omit<AttributeDef, 'guidance'>[]; state: ResourceState } | null
    /** 物品栏快照 */
    inventory: { items: { id: string; name: string; qty: number; note?: string }[] } | null
  }
}

export interface Config {
  resources?: ResourceDef[]
  attributes?: AttributeDef[]
  checks?: CheckConfig
  inventory?: InventoryConfig
  /** 侧栏分组标题自定义（strip/panel/hidden 的选位在各资源的 display 字段上） */
  groups?: GroupTitles
}

export const name = 'taleforge-mechanics'
export const inject = ['tools']

type SessionEvents = readonly { type: string; data: unknown }[]

export function apply(ctx: Context, config: Config) {
  const resources = config?.resources ?? []
  const attributes = config?.attributes ?? []
  const checks = config?.checks
  const inventory = config?.inventory

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

  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    if (resources.length) {
      projectionCtx.sessionProjections.register({
        key: 'mechanics',
        schema: mechanicsSchema,
        init: (): NumericProjState => ({ values: initialState(resources), revisions: [] }),
        // 不认识的事件必须原样返回同一引用，registry 靠 Object.is 判断有没有变化
        apply: (state: NumericProjState, event: { type: string; data: unknown }) =>
          applyNumericEvent(state, event, isMechanicsResult, 'resource'),
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
        key: 'attributes',
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
        key: 'inventory',
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
      const current = readNumeric(defs, events, opts.pick)
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

/** 从会话事件里读出当前数值状态（工具执行时用，进程内缓存不随 fork 复制）。 */
function readNumeric(
  defs: NumericDef[],
  events: SessionEvents,
  pick: (meta: unknown) => meta is { changes: AppliedChange[] },
): ResourceState {
  const batches: AppliedChange[][] = []
  for (const event of events) {
    const meta = metaOf(event, pick)
    if (meta) batches.push(meta.changes)
  }
  return foldApplied(defs, batches)
}

function readInventory(config: InventoryConfig, events: SessionEvents): InventoryState {
  const batches: AppliedInventoryChange[][] = []
  for (const event of events) {
    const meta = metaOf(event, isInventoryResult)
    if (meta) batches.push(meta.changes)
  }
  return foldInventory(config.initial, batches)
}
