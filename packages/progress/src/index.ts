/**
 * 幕进度引擎（底座能力，所有剧本都挂）。
 *
 * 判定分工：锚点是否达成由 GM 上报（它是剧情的作者，不设第三个裁判），
 * 但上报是每回合强制的机械流程；转幕与终幕由代码裁定，GM 只承接叙事。
 * 防漏报三道保险：每回合必调、返回值列出未完成锚点与完成信号、停滞计数分档加压。
 *
 * 状态走 tool/result.meta + projection 折叠（同机制引擎：dsh 事件白名单不认自定义类型）。
 * 设定修订也在此落账：场外由 GM 调 revise_setting，修订只对未来生效、效力高于剧本原文。
 */
import type { Context } from '@deepseek-ai/cordis'
// 副作用导入：把 tools / sessionProjections 挂上 Context
import '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  applyReport,
  effectiveActs,
  foldEvents,
  initialProgress,
  pressureOf,
  reduceEvent,
  remainingAnchors,
} from './progress.ts'
import type { ActDef, ProgressState, Revision } from './types.ts'

export * from './progress.ts'
export * from './types.ts'

const anchorSchema = z.object({
  id: z.string(),
  text: z.string(),
  required: z.boolean(),
  signal: z.string().optional(),
})

const progressViewSchema = z.object({
  acts: z.array(z.object({
    id: z.string(),
    title: z.string(),
    objective: z.string(),
    anchors: z.array(anchorSchema),
  })),
  actIndex: z.number(),
  achieved: z.array(z.string()),
  turn: z.number(),
  phase: z.enum(['playing', 'ended']),
  pressure: z.object({ level: z.enum(['low', 'rising', 'high']), stalledTurns: z.number() }),
  revisions: z.array(z.record(z.string(), z.unknown())),
})

export type ProgressView = z.infer<typeof progressViewSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 幕进度快照：当前幕、锚点达成、压力、终局态、现行修订 */
    progress: ProgressView | null
  }
}

export interface Config {
  /** 幕结构种子，由剧本编译器写入 */
  acts: ActDef[]
  /** 出场人物名录，供修订校验与显示 */
  cast?: { id: string; name: string }[]
  /** 机制条目名录（资源/属性），供数值定义修订的校验、显示与边界联动提醒 */
  numeric?: {
    resources?: { id: string; label: string; maxStep?: number }[]
    attributes?: { id: string; label: string; maxStep?: number }[]
  }
}

export const name = 'taleforge-progress'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const seed = config?.acts ?? []
  if (seed.length === 0) return
  const cast = config?.cast ?? []

  const readState = (events: readonly { type: string; data: unknown }[]): ProgressState =>
    foldEvents(seed, events)

  ctx.tools.register(defineTool({
    name: 'report_progress',
    description: '每个正戏回合的第一个动作。对照幕结构里各锚点的「完成信号」，'
      + '上报本回合剧情中真实达成的锚点 id；一个都没有就传空数组。'
      + '返回当前幕、未完成锚点与节奏指示——以返回内容为准推进剧情。'
      + '只认当前幕的锚点；达成标准是完成信号真实发生，不是"接近了"。',
    parameters: {
      achieved: {
        type: 'array',
        required: true,
        description: '本回合真实达成的锚点 id 列表，可为空数组',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'array', required: true, items: { type: 'string' } },
          phase: { type: 'string', required: true },
          actIndex: { type: 'integer', required: true },
          brief: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value as { brief: string }).brief,
      }],
      presentationMeta: (_args, value) => ({
        kind: 'progress/report',
        accepted: (value as { accepted: string[] }).accepted,
      }),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('report_progress 需要一个归属会话')
      const state = readState(exec.agent.session.events)
      const acts = effectiveActs(seed, state.revisions)
      const outcome = applyReport(state, acts, (args.achieved as string[]) ?? [])
      const brief = renderBrief(outcome, acts, state.revisions, cast)
      return Promise.resolve({
        accepted: outcome.accepted,
        phase: outcome.state.phase,
        actIndex: outcome.state.actIndex,
        brief,
      })
    },
    presentCall: () => ({ card: 'generic', title: '上报剧情进度', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'revise_setting',
    description: '【场外专用】修订剧本设定，玩家在场外明确要求修改时调用。'
      + '修订立即落账、只对未来剧情生效、效力高于剧本原文。'
      + 'target 取值：world（世界设定补充/覆盖）、cast（修改某人物，需 id）、'
      + 'direction（剧情走向/风格指令）、anchor（增删改锚点，需 act、op、id）、'
      + 'resource / attribute（修改既有数值条目的语义或边界，需 id，'
      + '可改 label/guidance/min/max/maxStep/floor；不支持中途增删条目）。',
    parameters: {
      revisions: {
        type: 'array',
        required: true,
        description: '本次修订条目',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', required: true, description: 'world | cast | direction | anchor | resource | attribute' },
            id: { type: 'string', description: 'cast：人物 id；anchor：锚点 id；resource/attribute：条目 id' },
            act: { type: 'string', description: 'anchor 专用：所属幕 id' },
            op: { type: 'string', description: 'anchor 专用：add | edit | remove' },
            text: { type: 'string', description: '修订内容（world/cast/direction 必填；anchor 为锚点描述）' },
            signal: { type: 'string', description: 'anchor 专用：完成信号' },
            required: { type: 'boolean', description: 'anchor 专用：是否必需' },
            label: { type: 'string', description: 'resource/attribute：新显示名' },
            guidance: { type: 'string', description: 'resource/attribute：新的数值语义（何时加减多少、区段含义）' },
            min: { type: 'integer', description: 'resource/attribute：新下限' },
            max: { type: 'integer', description: 'resource/attribute：新上限' },
            maxStep: { type: 'integer', description: 'resource/attribute：新单步上限' },
            floor: { type: 'integer', description: 'resource 专用：新下限护栏' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'integer', required: true },
          rejected: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          revisions: {
            type: 'array',
            required: true,
            description: '规范化后落账的修订条目',
            items: { type: 'object', additionalProperties: true, properties: {} },
          },
          brief: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value as { brief: string }).brief,
      }],
      presentationMeta: (_args, value) => ({
        kind: 'progress/revision',
        revisions: (value as unknown as { revisions: Revision[] }).revisions,
      }),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('revise_setting 需要一个归属会话')
      const state = readState(exec.agent.session.events)
      const acts = effectiveActs(seed, state.revisions)
      const { accepted, rejected } = validateRevisions(
        (args.revisions as Record<string, unknown>[]) ?? [],
        acts,
        cast,
        config?.numeric,
      )
      const lines = [
        accepted.length ? `已落账 ${accepted.length} 条修订，即刻生效，此后正戏必须遵守。` : '没有可落账的修订。',
        ...rejected.map(r => `第 ${r.index + 1} 条被拒绝：${r.reason}`),
        ...boundaryWarnings(accepted, config?.numeric),
      ]
      return Promise.resolve({
        applied: accepted.length,
        rejected,
        revisions: accepted,
        brief: lines.join('\n'),
      })
    },
    presentCall: () => ({ card: 'generic', title: '修订剧本设定', kind: 'other' }),
  }))

  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register({
      key: 'progress',
      schema: progressViewSchema,
      init: () => initialProgress(),
      // 不认识的事件必须原样返回同一引用，registry 靠 Object.is 判断有没有变化
      apply: (state: ProgressState, event: { type: string; data: unknown }) =>
        reduceEvent(state, event, seed),
      view: (state: ProgressState): ProgressView => ({
        acts: effectiveActs(seed, state.revisions),
        actIndex: state.actIndex,
        achieved: state.achieved,
        turn: state.turn,
        phase: state.phase,
        pressure: pressureOf(state),
        revisions: state.revisions as unknown as Record<string, unknown>[],
      }),
      stateVersion: 1,
    })
  })
}

/**
 * 边界联动提醒：修订只改了数值语义（guidance）而没动边界时，裁决仍按旧 maxStep
 * 裁剪——实测"双修体力回满"落账后，+55 被 maxStep=25 卡成 +25，语义永远兑现不了。
 */
export function boundaryWarnings(
  accepted: Revision[],
  numeric?: Config['numeric'],
): string[] {
  const warnings: string[] = []
  for (const r of accepted) {
    if (r.target !== 'resource' && r.target !== 'attribute') continue
    if (r.guidance === undefined) continue
    if (r.min !== undefined || r.max !== undefined || r.maxStep !== undefined || r.floor !== undefined) continue
    const known = (r.target === 'resource' ? numeric?.resources : numeric?.attributes)?.find(n => n.id === r.id)
    const cap = known?.maxStep
    warnings.push(`注意：「${r.id}」只改了语义未动边界${cap !== undefined ? `（现行单次上限 ±${cap}）` : ''}——`
      + '若新语义要求的单次变动会超过该上限（如"回满""清零"），请立刻再发一笔修订同步调整 maxStep/min/max，否则裁决会按旧边界裁剪，新语义永远无法兑现。')
  }
  return warnings
}

/** 校验修订条目：不合法的整条拒绝并说明原因，合法的规范化落账。 */
export function validateRevisions(
  entries: Record<string, unknown>[],
  acts: ActDef[],
  cast: { id: string; name: string }[],
  numeric?: Config['numeric'],
): { accepted: Revision[]; rejected: { index: number; reason: string }[] } {
  const accepted: Revision[] = []
  const rejected: { index: number; reason: string }[] = []
  const intOrUndef = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined)
  const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
  entries.forEach((raw, index) => {
    const target = raw.target
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (target === 'resource' || target === 'attribute') {
      const id = String(raw.id ?? '')
      const known = (target === 'resource' ? numeric?.resources : numeric?.attributes) ?? []
      if (!known.some(n => n.id === id)) {
        return rejected.push({ index, reason: `${target} id 不存在：${id}（中途增删条目走落盘+新局）` }) && undefined
      }
      // dsh 要求工具输出是无损 JSON：对象里不能出现值为 undefined 的键，未给的字段必须整个省略
      const fields = compact({
        label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined,
        guidance: typeof raw.guidance === 'string' && raw.guidance.trim() ? raw.guidance.trim() : undefined,
        min: intOrUndef(raw.min),
        max: intOrUndef(raw.max),
        maxStep: intOrUndef(raw.maxStep),
        floor: target === 'resource' ? intOrUndef(raw.floor) : undefined,
      })
      if (Object.keys(fields).length === 0) {
        return rejected.push({ index, reason: '至少给一个要修改的字段（label/guidance/min/max/maxStep/floor）' }) && undefined
      }
      if (typeof fields.maxStep === 'number' && fields.maxStep <= 0) {
        return rejected.push({ index, reason: 'maxStep 必须为正' }) && undefined
      }
      accepted.push({ target, id, ...fields } as Revision)
      return
    }
    if (target === 'world' || target === 'direction') {
      if (!text) return rejected.push({ index, reason: 'text 不能为空' }) && undefined
      accepted.push({ target, text })
      return
    }
    if (target === 'cast') {
      const id = String(raw.id ?? '')
      if (!cast.some(c => c.id === id)) return rejected.push({ index, reason: `人物 id 不存在：${id}` }) && undefined
      if (!text) return rejected.push({ index, reason: 'text 不能为空' }) && undefined
      accepted.push({ target: 'cast', id, text })
      return
    }
    if (target === 'anchor') {
      const actId = String(raw.act ?? '')
      const op = raw.op
      const id = String(raw.id ?? '')
      const act = acts.find(a => a.id === actId)
      if (!act) return rejected.push({ index, reason: `幕 id 不存在：${actId}` }) && undefined
      if (op !== 'add' && op !== 'edit' && op !== 'remove') {
        return rejected.push({ index, reason: `op 必须是 add/edit/remove：${String(op)}` }) && undefined
      }
      const exists = act.anchors.some(a => a.id === id)
      if (op === 'add' && exists) return rejected.push({ index, reason: `锚点已存在：${id}` }) && undefined
      if (op !== 'add' && !exists) return rejected.push({ index, reason: `锚点不存在：${id}` }) && undefined
      if (op === 'add' && !text) return rejected.push({ index, reason: '新增锚点必须给 text' }) && undefined
      accepted.push({
        target: 'anchor',
        act: actId,
        op,
        id,
        ...compact({
          text: text || undefined,
          signal: typeof raw.signal === 'string' ? raw.signal : undefined,
          required: typeof raw.required === 'boolean' ? raw.required : undefined,
        }),
      })
      return
    }
    rejected.push({ index, reason: `未知 target：${String(target)}` })
  })
  return { accepted, rejected }
}

/** 回给 GM 的进度简报——它是每回合的"平台注入通道"，压缩后也不丢。 */
export function renderBrief(
  outcome: ReturnType<typeof applyReport>,
  acts: ActDef[],
  revisions: Revision[],
  cast: { id: string; name: string }[],
): string {
  const lines: string[] = []
  const state = outcome.state

  if (outcome.accepted.length) lines.push(`锚点达成：${outcome.accepted.join('、')}`)
  for (const ig of outcome.ignored) lines.push(`「${ig.id}」被拒绝：${ig.reason}`)

  if (outcome.ended) {
    lines.push('【终幕】全部主线锚点已达成。本回合就是结局：收束主线与人物关系，写出终幕；'
      + '结尾另起一行独写「——剧终——」；本回合不写行动块。')
  } else if (state.phase === 'ended') {
    lines.push('游戏已结局，不再推进剧情。')
  } else {
    const act = acts[state.actIndex]
    if (outcome.advancedTo !== undefined) {
      lines.push(`【转幕】上一幕锚点已齐，进入《${act.title}》——随剧情自然收束转场。`)
    }
    lines.push(`当前：第 ${state.actIndex + 1} 幕《${act.title}》（第 ${state.turn} 回合）`)
    lines.push(`本幕目标：${act.objective}`)
    const remaining = remainingAnchors(state, acts)
    if (remaining.length) {
      lines.push('待达成锚点：')
      for (const a of remaining) {
        lines.push(`- [${a.id}] ${a.text}${a.required ? '（必需）' : '（可选）'}${a.signal ? `｜完成信号：${a.signal}` : ''}`)
      }
    }
    const pressure = pressureOf(state)
    if (pressure.level === 'rising') {
      lines.push(`节奏：已 ${pressure.stalledTurns} 回合无主线进展——本回合至少一个行动选项直指某个未完成锚点。`)
    } else if (pressure.level === 'high') {
      lines.push(`节奏：停滞 ${pressure.stalledTurns} 回合——本回合必须把剧情推进到某个未完成锚点完成信号的临界点；`
        + '行动选项 A 必须是主线前进位，不允许四个选项全是横向行动。')
    }
  }

  const active = revisions.filter(r => r.target !== 'anchor')
  if (active.length) {
    lines.push('现行修订（效力高于剧本原文）：')
    for (const r of active) {
      if (r.target === 'world') lines.push(`- [世界] ${r.text}`)
      if (r.target === 'direction') lines.push(`- [走向] ${r.text}`)
      if (r.target === 'cast') {
        const who = cast.find(c => c.id === r.id)?.name ?? r.id
        lines.push(`- [人物·${who}] ${r.text}`)
      }
      if (r.target === 'resource' || r.target === 'attribute') {
        const parts: string[] = []
        if (r.label !== undefined) parts.push(`改名「${r.label}」`)
        if (r.min !== undefined || r.max !== undefined) parts.push(`区间 ${r.min ?? '原'}–${r.max ?? '原'}`)
        if (r.maxStep !== undefined) parts.push(`单步 ±${r.maxStep}`)
        if (r.floor !== undefined) parts.push(`下限护栏 ${r.floor}`)
        if (r.guidance !== undefined) parts.push(`语义改为：${r.guidance}`)
        lines.push(`- [${r.target === 'resource' ? '资源' : '属性'}·${r.id}] ${parts.join('；')}`)
      }
    }
  }

  // 输出契约的贴身提醒：工具返回值是离生成点最近的文本，契约在 persona 末尾会被两次
  // 工具调用挤远——实测开场回合因此漏掉行动块。凡正戏回合都在此重申，终幕回合除外。
  if (!outcome.ended && state.phase === 'playing') {
    lines.push('提醒：本回合正文结尾必须有【行动】块——独占一行的【行动】加 A. B. C. D. 四行具体选项，缺了玩家无法继续。')
  }
  return lines.join('\n')
}
