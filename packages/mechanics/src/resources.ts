/**
 * 资源的裁决与折叠——纯函数，机制引擎的"代码权威"就落在这里。
 * GM 决定加减多少（叙事判断），这里决定实际生效多少（边界守卫）。
 */
import { dueUpkeep, isAttributesResult, isMechanicsResult, metaOf, revisionsInEvent } from './types.ts'
import type { AppliedChange, NumericDef, NumericDefRevision, ResourceChange, ResourceState } from './types.ts'

export function initialState(defs: NumericDef[]): ResourceState {
  const state: ResourceState = {}
  for (const def of defs) state[def.id] = { value: clamp(def.initial, def) }
  return state
}

function clamp(value: number, def: NumericDef): number {
  const low = Math.max(def.min, def.floor ?? def.min)
  return Math.min(def.max, Math.max(low, value))
}

/**
 * 裁决一批调整。未知 id 与非有限数直接丢弃——宁可这一笔不生效，
 * 也不让脏数据进状态（护栏：严格 schema + 纯 upsert，不做模糊兜底）。
 */
export function applyChanges(
  state: ResourceState,
  defs: NumericDef[],
  changes: ResourceChange[],
): { state: ResourceState; applied: AppliedChange[] } {
  const byId = new Map(defs.map(d => [d.id, d]))
  const next: ResourceState = { ...state }
  const applied: AppliedChange[] = []

  for (const change of changes) {
    const def = byId.get(change.id)
    if (!def || !Number.isFinite(change.delta) || change.delta === 0) continue

    const before = next[change.id]?.value ?? clamp(def.initial, def)
    // 先卡单步上限，再卡值域——两道独立护栏
    const stepped = Math.sign(change.delta) * Math.min(Math.abs(change.delta), def.maxStep)
    const after = clamp(before + stepped, def)
    const real = after - before

    applied.push({
      ...change,
      applied: real,
      before,
      after,
      clamped: real !== change.delta,
    })
    next[change.id] = { value: after, last: { applied: real, reason: change.reason } }
  }

  return { state: next, applied }
}

/** 把一串已裁决的变化按顺序折回状态——projection 重放与 fork 重算都走这里。 */
export function foldApplied(defs: NumericDef[], batches: AppliedChange[][]): ResourceState {
  const state = initialState(defs)
  for (const batch of batches) {
    for (const change of batch) {
      if (!(change.id in state)) continue
      state[change.id] = {
        value: change.after,
        last: { applied: change.applied, reason: change.reason },
      }
    }
  }
  return state
}

/**
 * 现行有效的数值定义 = 剧本种子 + 修订按序覆盖（只允许 edit 既有条目）。
 * 修订只对未来生效：过去的裁决以落账的 after 为准，不追溯重算。
 */
export function effectiveNumericDefs<T extends NumericDef & { label?: string; guidance?: string }>(
  seed: T[],
  revisions: import('./types.ts').NumericDefRevision[],
  target: 'resource' | 'attribute',
): T[] {
  const out = seed.map(d => ({ ...d }))
  for (const r of revisions) {
    if (r.target !== target) continue
    const def = out.find(d => d.id === r.id)
    if (!def) continue
    if (r.label !== undefined) def.label = r.label
    if (r.guidance !== undefined) def.guidance = r.guidance
    if (r.min !== undefined) def.min = r.min
    if (r.max !== undefined) def.max = r.max
    if (r.maxStep !== undefined && r.maxStep > 0) def.maxStep = r.maxStep
    if (r.floor !== undefined) def.floor = r.floor
  }
  return out
}

// ---- 事件折叠：投影、工具执行、离线回归共用的唯一一条重放路径 ----

/** 折叠中的数值状态：当前值 + 已落账的定义修订（view 时折出现行定义）。 */
export interface NumericProjState {
  values: ResourceState
  revisions: NumericDefRevision[]
}

/** 该 target 的落账 meta 由哪个工具写：资源看 adjust_resources，属性看 adjust_attributes（spend_points 复用后者）。 */
function pickOf(target: 'resource' | 'attribute'): (meta: unknown) => meta is { changes: AppliedChange[] } {
  return target === 'resource' ? isMechanicsResult : isAttributesResult
}

/**
 * 用一个会话事件推进数值状态。**这是唯一的一份实现**——投影的 apply、工具执行前读当前值、
 * scripts/refold.ts 的离线回归全部走这里。
 *
 * 曾经是两份：工具侧一个全量重放、投影侧一个增量 apply。两份就会分叉，且已经分叉过——
 * 工具侧起初看不见周期收支，于是拿一个偏旧的 before 去算 after，投影又照单全收，
 * 结果 GM 动过的那几条资源把 upkeep 悄悄覆盖掉（实测 grain 少扣 8）。补上之后仍留了一处
 * 更细的分叉：工具侧拿"最终定义"重放全部历史 upkeep，投影侧拿"当时定义"逐步演进——
 * 中途修订过 maxStep/max 的资源会算出两个值。现在统一成"当时定义"（修订只对未来生效）。
 *
 * 与投影 registry 的约定：不认识的事件必须返回**同一个引用**（它靠 Object.is 判断有无变化）。
 */
export function reduceNumericEvent(
  state: NumericProjState,
  event: { type: string; data: unknown },
  seed: NumericDef[],
  target: 'resource' | 'attribute',
): NumericProjState {
  // 1) 定义修订：此后的裁决与显示都按新定义走（只对未来生效，不追溯重算已落的账）
  const revisions = revisionsInEvent(event)?.filter(r => r.target === target)
  if (revisions?.length) return { ...state, revisions: [...state.revisions, ...revisions] }

  // 2) 工具落的账：以裁决当时算出的 after 为准，不重算
  const batch = metaOf(event, pickOf(target))?.changes
  if (batch?.length) {
    let values = state.values
    for (const change of batch) {
      if (!(change.id in values)) continue
      if (values === state.values) values = { ...state.values }
      values[change.id] = { value: change.after, last: { applied: change.applied, reason: change.reason } }
    }
    return values === state.values ? state : { ...state, values }
  }

  // 3) 周期收支：report_progress 只带声明，clamp / maxStep / activeAbove 一律在这边算
  if (target === 'resource') {
    const due = dueUpkeep(state.values, event)
    if (due.length) {
      const { state: values } = applyChanges(state.values, effectiveNumericDefs(seed, state.revisions, 'resource'), due)
      if (values !== state.values) return { ...state, values }
    }
  }

  return state
}

/** 从整段会话事件重放数值状态（工具执行、离线回归用）。与投影同一个 reducer。 */
export function foldNumericEvents(
  seed: NumericDef[],
  events: readonly { type: string; data: unknown }[],
  target: 'resource' | 'attribute',
): NumericProjState {
  let state: NumericProjState = { values: initialState(seed), revisions: [] }
  for (const event of events) state = reduceNumericEvent(state, event, seed, target)
  return state
}
