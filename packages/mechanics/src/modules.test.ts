import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCheck, rollDie } from './check.ts'
import { applyInventory, foldInventory, initialInventory } from './inventory.ts'
import { applyChanges, effectiveNumericDefs, initialState } from './resources.ts'
import type { AttributeDef } from './types.ts'

// ---- 判定 ----

test('rollDie 覆盖三种骰型的值域', () => {
  for (let i = 0; i < 50; i++) {
    const d20 = rollDie('d20', s => 1 + Math.floor(Math.random() * s))
    assert.ok(d20 >= 1 && d20 <= 20)
    const two = rollDie('2d6', s => 1 + Math.floor(Math.random() * s))
    assert.ok(two >= 2 && two <= 12)
  }
  assert.equal(rollDie('2d6', () => 6), 12, '2d6 是两次掷的和')
})

test('判定裁决：总值过线成功，d20 天然 20/1 压过一切修正', () => {
  const base = { die: 'd20' as const, difficulty: 15, attrValue: 3, modifier: 2, reason: '撬门' }
  assert.equal(resolveCheck({ ...base, roll: 10 }).outcome, 'success')   // 10+3+2=15 达线
  assert.equal(resolveCheck({ ...base, roll: 9 }).outcome, 'fail')       // 14 < 15
  assert.equal(resolveCheck({ ...base, roll: 20 }).outcome, 'crit-success')
  assert.equal(resolveCheck({ ...base, roll: 1, attrValue: 99 }).outcome, 'crit-fail', '天然 1 必败')
  // 非 d20 没有暴击惯例
  assert.equal(resolveCheck({ die: 'd100', roll: 100, difficulty: 50, attrValue: 0, modifier: 0, reason: 'x' }).outcome, 'success')
})

test('属性表复用数值引擎：单步上限与值域同样生效', () => {
  const defs: AttributeDef[] = [
    { id: 'str', label: '力量', min: 0, max: 20, initial: 3, maxStep: 1, guidance: 'x' },
  ]
  const { state, applied } = applyChanges(initialState(defs), defs, [
    { id: 'str', delta: 5, reason: '突破' },
  ])
  assert.equal(applied[0].applied, 1, '属性单步默认 1，+5 被裁到 +1')
  assert.equal(state.str.value, 4)
})

// ---- 物品栏 ----

test('物品栏 upsert：新增须给名、重复 add 叠加数量', () => {
  const init = initialInventory([{ id: 'axe', name: '消防斧', qty: 1 }])
  const r1 = applyInventory(init, [
    { op: 'add', id: 'fuel', name: '汽油', qty: 2, reason: '搜刮' },
    { op: 'add', id: 'ghost' },                       // 新物品没给 name：丢弃
    { op: 'add', id: 'axe', qty: 1 },                 // 既有物品可省 name
  ])
  assert.equal(r1.applied.length, 2)
  assert.equal(r1.state.fuel.qty, 2)
  assert.equal(r1.state.axe.qty, 2)
})

test('物品栏 remove/set：减到零即移除，set 只改既有物品', () => {
  const init = initialInventory([{ id: 'fuel', name: '汽油', qty: 2 }])
  const r = applyInventory(init, [
    { op: 'remove', id: 'fuel', qty: 2, reason: '烧了' },
    { op: 'remove', id: 'nope' },                     // 不存在：丢弃
    { op: 'set', id: 'nope2', name: 'x', qty: 3 },    // set 不创建：丢弃
  ])
  assert.equal(r.applied.length, 1)
  assert.equal(r.applied[0].removed, true)
  assert.ok(!('fuel' in r.state))
})

test('物品栏折叠重放与逐步应用一致——fork 重算走它', () => {
  const initial = [{ id: 'axe', name: '消防斧', qty: 1 }]
  const b1 = applyInventory(initialInventory(initial), [
    { op: 'add', id: 'fuel', name: '汽油', qty: 3 },
  ])
  const b2 = applyInventory(b1.state, [
    { op: 'remove', id: 'fuel', qty: 1 },
    { op: 'set', id: 'axe', note: '卷刃了' },
  ])
  const folded = foldInventory(initial, [b1.applied, b2.applied])
  assert.deepEqual(folded, b2.state)
  assert.equal(folded.fuel.qty, 2)
  assert.equal(folded.axe.note, '卷刃了')
})

// ---- 数值定义修订 ----

test('现行定义 = 种子 + 修订覆盖；裁决按新边界，种子不动', () => {
  const seed = [
    { id: 'dep', label: '依赖', min: 0, max: 100, initial: 0, maxStep: 20, guidance: '旧语义' },
  ]
  const defs = effectiveNumericDefs(
    seed,
    [{ target: 'resource', id: 'dep', max: 39, guidance: '封顶 39，卡死双修门槛' }],
    'resource',
  )
  const { applied } = applyChanges(initialState(defs), defs, [{ id: 'dep', delta: 50, reason: 'x' }])
  assert.equal(applied[0].after, 20, '单步 20 先裁')
  const r2 = applyChanges({ dep: { value: 30 } }, defs, [{ id: 'dep', delta: 20, reason: 'x' }])
  assert.equal(r2.applied[0].after, 39, '修订后的上限 39 生效')
  assert.equal(seed[0].max, 100, '种子不被修改')
  assert.equal(defs[0].guidance, '封顶 39，卡死双修门槛')
})
