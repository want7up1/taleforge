import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyChanges, foldApplied, initialState } from './resources.ts'
import type { ResourceDef } from './types.ts'

const defs: ResourceDef[] = [
  { id: 'affinity:suwan', label: '苏晚', group: 'affinity', min: 0, max: 100, initial: 35, floor: 10, maxStep: 10 },
  { id: 'stamina', label: '体力', group: 'self', min: 0, max: 100, initial: 100, maxStep: 30 },
]

test('初始状态取剧本声明的初值', () => {
  assert.deepEqual(initialState(defs), {
    'affinity:suwan': { value: 35 },
    'stamina': { value: 100 },
  })
})

test('单步上限把模型的暴涨裁到合理区间', () => {
  const { state, applied } = applyChanges(initialState(defs), defs, [
    { id: 'affinity:suwan', delta: 50, reason: '救了她' },
  ])
  assert.equal(state['affinity:suwan'].value, 45, '35 + 上限 10')
  assert.equal(applied[0].applied, 10)
  assert.ok(applied[0].clamped)
})

test('好感度可以掉，但掉不破底线', () => {
  const { state } = applyChanges(
    { 'affinity:suwan': { value: 12 }, 'stamina': { value: 100 } },
    defs,
    [{ id: 'affinity:suwan', delta: -10, reason: '当众落她面子' }],
  )
  assert.equal(state['affinity:suwan'].value, 10, 'floor 兜住，不归零')
})

test('未声明的资源、非有限数、零变化一律丢弃', () => {
  const before = initialState(defs)
  const { state, applied } = applyChanges(before, defs, [
    { id: 'affinity:unknown', delta: 5, reason: '不存在的人' },
    { id: 'stamina', delta: Number.NaN, reason: '脏数据' },
    { id: 'stamina', delta: 0, reason: '无变化' },
  ])
  assert.deepEqual(state, before)
  assert.equal(applied.length, 0)
})

test('上限同样守住', () => {
  const { state } = applyChanges({ 'stamina': { value: 95 } }, defs, [
    { id: 'stamina', delta: 30, reason: '休整' },
  ])
  assert.equal(state.stamina.value, 100)
})

test('折叠重放得到同一状态——fork 出的支线靠它重算', () => {
  const step1 = applyChanges(initialState(defs), defs, [
    { id: 'affinity:suwan', delta: 8, reason: '并肩逃出大楼' },
    { id: 'stamina', delta: -25, reason: '连续奔逃' },
  ])
  const step2 = applyChanges(step1.state, defs, [
    { id: 'affinity:suwan', delta: 6, reason: '替她挡下一击' },
  ])

  assert.deepEqual(foldApplied(defs, [step1.applied, step2.applied]), step2.state)
  assert.equal(step2.state['affinity:suwan'].value, 49)
  assert.equal(step2.state['affinity:suwan'].last?.reason, '替她挡下一击')
})
