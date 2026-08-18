/**
 * 资源的裁决与折叠——纯函数，机制引擎的"代码权威"就落在这里。
 * GM 决定加减多少（叙事判断），这里决定实际生效多少（边界守卫）。
 */
import type { AppliedChange, ResourceChange, ResourceDef, ResourceState } from './types.ts'

export function initialState(defs: ResourceDef[]): ResourceState {
  const state: ResourceState = {}
  for (const def of defs) state[def.id] = { value: clamp(def.initial, def) }
  return state
}

function clamp(value: number, def: ResourceDef): number {
  const low = Math.max(def.min, def.floor ?? def.min)
  return Math.min(def.max, Math.max(low, value))
}

/**
 * 裁决一批调整。未知 id 与非有限数直接丢弃——宁可这一笔不生效，
 * 也不让脏数据进状态（护栏：严格 schema + 纯 upsert，不做模糊兜底）。
 */
export function applyChanges(
  state: ResourceState,
  defs: ResourceDef[],
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
export function foldApplied(defs: ResourceDef[], batches: AppliedChange[][]): ResourceState {
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
