/**
 * 经验与等级——货架第五件。分工：GM 按剧本规则上报经验（同资源条，代码裁单次上限），
 * 等级与属性点由代码按阈值表裁定；属性点由玩家自行分配，加点随下一步行动进回合，
 * GM 只能用 spend_points 原样落账（代码校验未分配池与属性上限）。
 *
 * 状态同样走 tool/result.meta：经验走 kind 'mechanics/xp'；加点复用属性 meta 形状
 * （kind 'mechanics/attributes' + points 账）——属性投影照常折进去，经验投影只扣池子。
 */
import { applyChanges } from './resources.ts'
import {
  isPointsResult,
  isXpResult,
  type AppliedChange,
  type NumericDef,
  type ProgressionConfig,
  type ProgressionState,
  type ResourceState,
  type XpResult,
} from './types.ts'

export function levelOf(xp: number, thresholds: number[]): number {
  let level = 1
  for (const t of thresholds) {
    if (xp >= t) level++
    else break
  }
  return level
}

export function maxLevelOf(config: ProgressionConfig): number {
  return config.thresholds.length + 1
}

/** 经验当作一条数值条裁决：0 起步，封顶在最后一档阈值（满级后不再累积无意义的数字）。 */
export function xpDef(config: ProgressionConfig): NumericDef {
  return {
    id: 'xp',
    min: 0,
    max: config.thresholds[config.thresholds.length - 1],
    initial: 0,
    maxStep: config.maxStep,
  }
}

export function initialProgression(): ProgressionState {
  return { xp: 0, level: 1, granted: 0, spent: 0 }
}

/** 某级的显示名：剧本给了 levelNames 用它，否则 Lv.N */
export function levelLabel(config: Pick<ProgressionConfig, 'levelNames'>, level: number): string {
  return config.levelNames?.[level - 1] ?? `Lv.${level}`
}

/**
 * 裁决一次经验变动：裁单次上限与值域，按阈值算等级，升级发点；另可附带剧情奖励点
 * （裁 bonusPointsMax，进同一个待分配池）。等级只升不降。
 */
export function applyXp(
  state: ProgressionState,
  config: ProgressionConfig,
  delta: number,
  reason: string,
  bonus = 0,
): { state: ProgressionState; result: XpResult } {
  const amount = Number.isFinite(delta) ? Math.trunc(delta) : 0
  const bonusCap = Math.max(0, config.bonusPointsMax ?? 0)
  const bonusPoints = Math.min(bonusCap, Math.max(0, Number.isFinite(bonus) ? Math.trunc(bonus) : 0))
  const before = state.xp
  let after = before
  let applied = 0
  let clamped = false
  if (amount !== 0) {
    const { applied: batch } = applyChanges({ xp: { value: before } }, [xpDef(config)], [{ id: 'xp', delta: amount, reason }])
    const c = batch[0]
    if (c) {
      after = c.after
      applied = c.applied
      clamped = c.clamped
    }
  }
  const levelBefore = state.level
  // 经验可以被扣，已到手的等级与点数不收回
  const levelAfter = Math.max(levelBefore, levelOf(after, config.thresholds))
  const pointsGranted = (levelAfter - levelBefore) * config.pointsPerLevel + bonusPoints
  const result: XpResult = {
    kind: 'mechanics/xp',
    delta: amount,
    applied,
    before,
    after,
    clamped,
    reason,
    levelBefore,
    levelAfter,
    pointsGranted,
    bonusPoints,
  }
  // 工具侧与投影侧只能有一种"经验结果怎么改状态"的定义——折叠函数就是那个定义
  return { state: reduceProgression(state, result), result }
}

export interface PointAllocation {
  id: string
  points: number
}

export interface AllocationOutcome {
  changes: AppliedChange[]
  spent: number
  rejected: { id: string; points: number; reason: string }[]
}

/**
 * 校验并落账玩家的加点：id 必须是属性、点数为正、总数不超未分配池、加完不超属性上限；
 * 不合格的整条拒绝并说明原因。加点不受属性 maxStep 约束——那是给 GM 剧情调整用的闸。
 */
export function applyAllocations(
  state: ResourceState,
  defs: NumericDef[],
  unspent: number,
  allocations: PointAllocation[],
): AllocationOutcome {
  const byId = new Map(defs.map(d => [d.id, d]))
  const values: Record<string, number> = {}
  const changes: AppliedChange[] = []
  const rejected: AllocationOutcome['rejected'] = []
  let spent = 0
  for (const a of allocations ?? []) {
    const id = String(a?.id ?? '')
    const points = Number.isFinite(a?.points) ? Math.trunc(a.points) : 0
    const def = byId.get(id)
    if (!def) {
      rejected.push({ id, points, reason: `属性 id 不存在：${id}` })
      continue
    }
    if (points <= 0) {
      rejected.push({ id, points, reason: '点数必须为正整数' })
      continue
    }
    if (spent + points > unspent) {
      rejected.push({ id, points, reason: `未分配点数不足（剩 ${unspent - spent} 点）` })
      continue
    }
    const before = values[id] ?? state[id]?.value ?? def.initial
    if (before + points > def.max) {
      rejected.push({ id, points, reason: `超过上限 ${def.max}（当前 ${before}）` })
      continue
    }
    const after = before + points
    values[id] = after
    spent += points
    changes.push({ id, delta: points, reason: '加点', applied: points, before, after, clamped: false })
  }
  return { changes, spent, rejected }
}

/**
 * 从玩家消息（含 BFF 回合头注入块）里取出加点请求：注入块把玩家写的【加点】行换算成
 * `allocations=[{"id":…,"points":…}]`。spend_points 以它为准落账——属性点只能由玩家分配，
 * GM 传什么都不能改动玩家的请求（代码权威，不靠提示词自觉）。
 */
export function parseAllocationRequest(text: string): PointAllocation[] | undefined {
  const m = /allocations=(\[[^\n]*?\])/.exec(text)
  if (!m) return undefined
  try {
    const parsed: unknown = JSON.parse(m[1])
    if (!Array.isArray(parsed)) return undefined
    const out: PointAllocation[] = []
    for (const a of parsed) {
      const id = typeof (a as PointAllocation)?.id === 'string' ? (a as PointAllocation).id : ''
      const points = Number((a as PointAllocation)?.points)
      if (id && Number.isFinite(points) && points > 0) out.push({ id, points: Math.trunc(points) })
    }
    return out
  } catch {
    return undefined
  }
}

/**
 * 最近一条玩家消息里的加点请求（BFF 回合头注入块携带的 allocations=[…]）；没有即玩家本回合没要求加点。
 * 同时报告这条消息之后是否已经有一笔加点落账——同一回合只许落账一次，GM 重复调用不重复扣。
 */
export function playerAllocationRequest(
  events: readonly { type: string; data: unknown }[],
): { request?: PointAllocation[]; alreadySpent: boolean } {
  let alreadySpent = false
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'tool/result') {
      if (isPointsResult((event.data as { meta?: unknown }).meta)) alreadySpent = true
      continue
    }
    if (event.type !== 'user/message') continue
    const content = (event.data as { content?: { text?: string }[] }).content
    const text = Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('\n') : ''
    const request = parseAllocationRequest(text)
    return request ? { request, alreadySpent } : { alreadySpent }
  }
  return { alreadySpent }
}

/** 投影折叠的一步：不认识的 meta 原样返回同一引用。 */
export function reduceProgression(state: ProgressionState, meta: unknown): ProgressionState {
  if (isXpResult(meta)) {
    return { ...state, xp: meta.after, level: meta.levelAfter, granted: state.granted + meta.pointsGranted }
  }
  if (isPointsResult(meta)) return { ...state, spent: state.spent + meta.points.spent }
  return state
}

export function foldProgression(metas: unknown[]): ProgressionState {
  return metas.reduce(reduceProgression, initialProgression())
}

/** 玩家可见的等级快照（投影 view）。 */
export interface ProgressionView {
  label: string
  xp: number
  level: number
  maxLevel: number
  /** 当前等级的起点阈值（画进度条用） */
  prev: number
  /** 下一级阈值；满级为 null */
  next: number | null
  unspent: number
  pointsPerLevel: number
  /** 各级显示名（剧本声明了才有）；界面据此把 Lv.N 换成 C/B/A… */
  levelNames?: string[]
  display?: 'strip' | 'panel'
}

export function progressionView(config: ProgressionConfig, state: ProgressionState): ProgressionView {
  const maxLevel = maxLevelOf(config)
  const view: ProgressionView = {
    label: config.label,
    xp: state.xp,
    level: state.level,
    maxLevel,
    prev: state.level > 1 ? config.thresholds[state.level - 2] : 0,
    next: state.level < maxLevel ? config.thresholds[state.level - 1] : null,
    unspent: state.granted - state.spent,
    pointsPerLevel: config.pointsPerLevel,
  }
  // dsh 要求工具/投影输出无损 JSON：可选字段不给就整个省略
  if (config.levelNames) view.levelNames = config.levelNames
  if (config.display) view.display = config.display
  return view
}

/** 回给 GM 的经验裁决文本：升级要写成剧情瞬间、不替玩家加点。 */
export function renderXp(result: XpResult & { unspent: number }, config: ProgressionConfig): string {
  const { label } = config
  const next = result.levelAfter < maxLevelOf(config) ? config.thresholds[result.levelAfter - 1] : null
  const where = `${result.after}${next !== null ? `/${next}` : '（满级）'}`
  const lv = (n: number) => (config.levelNames ? `${levelLabel(config, n)}（Lv.${n}）` : `Lv.${n}`)
  const lines: string[] = []
  if (result.applied === 0) {
    // 提交了却一分没加：只可能是已封顶（满级后不再累积）
    lines.push(result.delta !== 0
      ? `${label}未增加：已满级，不再累积（原提交 ${result.delta}；当前 ${where}，${lv(result.levelAfter)}）。`
      : `本回合${label}无变化（当前 ${where}，${lv(result.levelAfter)}）。`)
  } else {
    const sign = result.applied > 0 ? '+' : ''
    const note = result.clamped ? `（原提交 ${result.delta}，已按边界裁决）` : ''
    lines.push(`${label} ${sign}${result.applied} → ${where}${note}，${lv(result.levelAfter)}${next !== null ? `，距下一级还差 ${next - result.after}` : ''}。`)
  }
  const levelPoints = result.pointsGranted - result.bonusPoints
  if (levelPoints > 0) {
    lines.push(`【升级】${lv(result.levelBefore)} → ${lv(result.levelAfter)}，发放 ${levelPoints} 点属性点，由玩家自行分配。`
      + '本回合正文要把升级写成可感的瞬间（怎么写按剧本规则），不出现数字；不要替玩家加点。')
  }
  if (result.bonusPoints > 0) {
    lines.push(`【奖励点】发放 ${result.bonusPoints} 点剧情奖励属性点，进玩家的待分配池——方向由玩家在卷宗里选，你不替玩家加。`)
  }
  if (result.pointsGranted > 0) {
    lines.push(`当前未分配 ${result.unspent} 点。`)
  } else if (result.unspent > 0) {
    lines.push(`玩家还有 ${result.unspent} 点属性点未分配（由玩家在卷宗里加点，你不用处理）。`)
  }
  return lines.join('\n')
}

/** 回给 GM 的加点落账文本。 */
export function renderSpend(
  outcome: AllocationOutcome & { unspent: number },
  labelOf: (id: string) => string,
): string {
  const lines: string[] = []
  if (outcome.changes.length) {
    lines.push(`加点已落账：${outcome.changes.map(c => `${labelOf(c.id)} +${c.applied} → ${c.after}`).join('，')}；剩余未分配 ${outcome.unspent} 点。`
      + '正文里用一两句写出这份成长的体感即可，不出现数字。')
  } else {
    lines.push('没有落账任何加点。')
  }
  for (const r of outcome.rejected) lines.push(`「${r.id} +${r.points}」被拒绝：${r.reason}`)
  return lines.join('\n')
}
