/**
 * 资源的裁决与折叠——纯函数，机制引擎的"代码权威"就落在这里。
 * GM 决定加减多少（叙事判断），这里决定实际生效多少（边界守卫）。
 */
import type { AppliedChange, NumericDef, ResourceChange, ResourceState } from './types.ts'

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
