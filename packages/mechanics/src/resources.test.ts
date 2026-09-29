import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyChanges, effectiveNumericDefs, foldApplied, initialState } from './resources.ts'
import { dueUpkeep } from './types.ts'
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

test('周期收支：activeAbove 过线才滚，增减照样过单步与值域裁决', () => {
  const grain = { id: 'grain', label: '口粮', group: 'self' as const, min: 0, max: 100, initial: 5, maxStep: 50 }
  const crop = { id: 'crop', label: '麦苗', group: 'self' as const, min: 0, max: 3, initial: 0, maxStep: 5 }
  const upkeep = [
    { id: 'grain', delta: -10, reason: '日耗' },
    { id: 'crop', delta: 1, reason: '抽穗', activeAbove: 0 },
  ]
  const s0 = initialState([grain, crop])
  const due0 = dueUpkeep(s0, upkeep)
  assert.deepEqual(due0.map(u => u.id), ['grain'], '没种下的麦苗不长')
  const r0 = applyChanges(s0, [grain, crop], due0)
  assert.equal(r0.state.grain.value, 0, '口粮见底停在下限')
  const planted = applyChanges(r0.state, [grain, crop], [{ id: 'crop', delta: 1, reason: '播种' }]).state
  const r1 = applyChanges(planted, [grain, crop], dueUpkeep(planted, upkeep))
  assert.equal(r1.state.crop.value, 2)
})

test('修订改边界只对之后的裁决生效：种子不动', () => {
  const seed = [{ id: 'stamina', min: 0, max: 100, initial: 50, maxStep: 10 }]
  const revised = effectiveNumericDefs(seed, [{ target: 'resource', id: 'stamina', maxStep: 60 }], 'resource')
  assert.equal(seed[0].maxStep, 10)
  assert.equal(applyChanges({ stamina: { value: 40 } }, revised, [{ id: 'stamina', delta: 55, reason: '双修回满' }]).state.stamina.value, 95)
})
