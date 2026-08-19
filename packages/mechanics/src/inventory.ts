/**
 * 物品栏的裁决与折叠——id 引用 + 纯 upsert（护栏 3：不做模糊文本匹配）。
 * 不合法的条目整条丢弃：宁可这一笔不生效，也不让脏数据进状态。
 */
import type {
  AppliedInventoryChange,
  InventoryChange,
  InventoryItemDef,
  InventoryState,
} from './types.ts'

/** dsh 要求工具输出无损 JSON：undefined 键必须整个省略，本文件所有对象构造遵守此约 */
const withNote = (note?: string): { note?: string } => (note === undefined ? {} : { note })
const withReason = (reason?: string): { reason?: string } => (reason === undefined ? {} : { reason })

export function initialInventory(items: InventoryItemDef[]): InventoryState {
  const state: InventoryState = {}
  for (const item of items) {
    state[item.id] = { name: item.name, qty: Math.max(1, item.qty), ...withNote(item.note) }
  }
  return state
}

export function applyInventory(
  state: InventoryState,
  changes: InventoryChange[],
): { state: InventoryState; applied: AppliedInventoryChange[] } {
  const next: InventoryState = { ...state }
  const applied: AppliedInventoryChange[] = []

  for (const change of changes) {
    const existing = next[change.id]
    const qtyArg = Number.isFinite(change.qty) ? Math.trunc(change.qty as number) : undefined

    if (change.op === 'add') {
      const delta = Math.max(1, qtyArg ?? 1)
      if (!existing && !change.name) continue // 新物品必须给名字
      const name = change.name ?? existing!.name
      const qty = (existing?.qty ?? 0) + delta
      next[change.id] = { name, qty, ...withNote(change.note ?? existing?.note) }
      applied.push({
        op: 'add', id: change.id, name, qty, delta, removed: false,
        ...withNote(change.note), ...withReason(change.reason),
      })
      continue
    }

    if (change.op === 'remove') {
      if (!existing) continue // 移除不存在的物品：丢弃，不猜
      const delta = -Math.max(1, qtyArg ?? 1)
      const qty = existing.qty + delta
      if (qty <= 0) {
        delete next[change.id]
        applied.push({
          op: 'remove', id: change.id, name: existing.name, qty: 0, delta: -existing.qty,
          removed: true, ...withReason(change.reason),
        })
      } else {
        next[change.id] = { ...existing, qty }
        applied.push({
          op: 'remove', id: change.id, name: existing.name, qty, delta,
          removed: false, ...withReason(change.reason),
        })
      }
      continue
    }

    if (change.op === 'set') {
      if (!existing) continue // set 只改既有物品；创建一律走 add
      const qty = qtyArg ?? existing.qty
      if (qty <= 0) {
        delete next[change.id]
        applied.push({
          op: 'set', id: change.id, name: existing.name, qty: 0, delta: -existing.qty,
          removed: true, ...withReason(change.reason),
        })
      } else {
        const name = change.name ?? existing.name
        next[change.id] = { name, qty, ...withNote(change.note ?? existing.note) }
        applied.push({
          op: 'set', id: change.id, name, qty, delta: qty - existing.qty,
          removed: false, ...withNote(change.note), ...withReason(change.reason),
        })
      }
    }
  }

  return { state: next, applied }
}

/** 按已裁决的变化重放——projection 与 fork 重算都走这里，qty 取落账的最终值。 */
export function foldInventory(
  initial: InventoryItemDef[],
  batches: AppliedInventoryChange[][],
): InventoryState {
  const state = initialInventory(initial)
  for (const batch of batches) {
    for (const change of batch) {
      if (change.removed) {
        delete state[change.id]
      } else {
        state[change.id] = {
          name: change.name,
          qty: change.qty,
          ...withNote(change.note ?? state[change.id]?.note),
        }
      }
    }
  }
  return state
}
