/**
 * 幕进度的纯裁决逻辑：达成上报的校验、转幕与终幕（代码权威，GM 无权决定）、
 * 压力分档（阈值 4/8 回合，沿用 Rpgforge act_pacing 的实测初值）、修订折叠。
 * 全部从事件重放可得——fork 出的支线靠同一套折叠重算。
 */
import type {
  ActDef,
  AnchorDef,
  PressureLevel,
  ProgressState,
  Revision,
} from './types.ts'
import { isReportMeta, isRevisionMeta } from './types.ts'

export function initialProgress(): ProgressState {
  return { actIndex: 0, achieved: [], turn: 0, lastProgressTurn: 0, phase: 'playing', revisions: [] }
}

/** 现行有效的幕结构 = 剧本种子 + anchor 类修订按序覆盖。 */
export function effectiveActs(seed: ActDef[], revisions: Revision[]): ActDef[] {
  const acts = seed.map(a => ({ ...a, anchors: a.anchors.map(x => ({ ...x })) }))
  for (const r of revisions) {
    if (r.target !== 'anchor') continue
    const act = acts.find(a => a.id === r.act)
    if (!act) continue
    if (r.op === 'add' && !act.anchors.some(x => x.id === r.id)) {
      act.anchors.push({ id: r.id, text: r.text ?? '', required: r.required ?? true, signal: r.signal })
    }
    if (r.op === 'edit') {
      const anchor = act.anchors.find(x => x.id === r.id)
      if (anchor) {
        if (r.text !== undefined) anchor.text = r.text
        if (r.signal !== undefined) anchor.signal = r.signal
        if (r.required !== undefined) anchor.required = r.required
      }
    }
    if (r.op === 'remove') act.anchors = act.anchors.filter(x => x.id !== r.id)
  }
  return acts
}

export interface ReportOutcome {
  state: ProgressState
  accepted: string[]
  ignored: { id: string; reason: string }[]
  /** 本次上报触发了转幕，值为新的 actIndex */
  advancedTo?: number
  /** 本次上报使游戏进入终幕 */
  ended: boolean
}

/**
 * 裁决一次进度上报。只认当前幕的锚点——提前上报后续幕会被拒绝，
 * 防止跳幕；重复上报幂等忽略。必需锚点齐了立即转幕/终幕。
 */
export function applyReport(state: ProgressState, acts: ActDef[], ids: string[]): ReportOutcome {
  if (state.phase === 'ended' || acts.length === 0) {
    return { state, accepted: [], ignored: ids.map(id => ({ id, reason: '游戏已结局' })), ended: false }
  }
  const current = acts[Math.min(state.actIndex, acts.length - 1)]
  const accepted: string[] = []
  const ignored: { id: string; reason: string }[] = []
  for (const id of [...new Set(ids)]) {
    if (state.achieved.includes(id) || accepted.includes(id)) {
      ignored.push({ id, reason: '已达成过' })
    } else if (current.anchors.some(a => a.id === id)) {
      accepted.push(id)
    } else if (acts.some(a => a.anchors.some(x => x.id === id))) {
      ignored.push({ id, reason: '不属于当前幕，不能提前上报' })
    } else {
      ignored.push({ id, reason: '未知锚点' })
    }
  }

  const achieved = [...state.achieved, ...accepted]
  let actIndex = state.actIndex
  let phase: ProgressState['phase'] = state.phase
  let advancedTo: number | undefined
  let ended = false
  // 必需锚点齐了就前进；全可选的幕会直接穿过（剧本作者的选择）
  while (phase === 'playing') {
    const act = acts[actIndex]
    const requiredDone = act.anchors.filter(a => a.required).every(a => achieved.includes(a.id))
    if (!requiredDone) break
    if (actIndex >= acts.length - 1) {
      phase = 'ended'
      ended = true
      break
    }
    actIndex++
    advancedTo = actIndex
  }

  const progressed = accepted.length > 0 || advancedTo !== undefined || ended
  const next: ProgressState = {
    ...state,
    achieved,
    actIndex,
    phase,
    lastProgressTurn: progressed ? state.turn : state.lastProgressTurn,
  }
  return { state: next, accepted, ignored, advancedTo, ended }
}

export function pressureOf(state: ProgressState): { level: PressureLevel; stalledTurns: number } {
  const stalledTurns = Math.max(0, state.turn - state.lastProgressTurn)
  const level: PressureLevel = stalledTurns >= 8 ? 'high' : stalledTurns >= 4 ? 'rising' : 'low'
  return { level, stalledTurns }
}

/** 单事件归约：turn/start 计回合，两种 tool/result.meta 各自落账。投影与工具读态共用。 */
export function reduceEvent(
  state: ProgressState,
  event: { type: string; data: unknown },
  seed: ActDef[],
): ProgressState {
  if (event.type === 'turn/start') return { ...state, turn: state.turn + 1 }
  if (event.type !== 'tool/result') return state
  const meta = (event.data as { meta?: unknown }).meta
  if (isRevisionMeta(meta)) {
    return { ...state, revisions: [...state.revisions, ...meta.revisions] }
  }
  if (isReportMeta(meta)) {
    return applyReport(state, effectiveActs(seed, state.revisions), meta.accepted).state
  }
  return state
}

/** 从会话事件读出当前进度（工具执行时用；进程内缓存不随 fork 复制，一律重放）。 */
export function foldEvents(
  seed: ActDef[],
  events: readonly { type: string; data: unknown }[],
): ProgressState {
  let state = initialProgress()
  for (const event of events) state = reduceEvent(state, event, seed)
  return state
}

/** 当前幕尚未达成的锚点，必需在前。 */
export function remainingAnchors(state: ProgressState, acts: ActDef[]): AnchorDef[] {
  const act = acts[Math.min(state.actIndex, Math.max(acts.length - 1, 0))]
  if (!act) return []
  return act.anchors
    .filter(a => !state.achieved.includes(a.id))
    .sort((a, b) => Number(b.required) - Number(a.required))
}
