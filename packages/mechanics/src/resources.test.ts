import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyChanges, foldApplied, foldNumericEvents, initialState } from './resources.ts'
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

/** 造一条 report_progress 落下的 meta 事件（形状由 progress 包定，跨包契约测试锁在 contract.test.ts）。 */
const upkeepEvent = (upkeep: { id: string; delta: number; reason: string; activeAbove?: number }[]) => ({
  type: 'tool/result',
  data: { meta: { kind: 'progress/report', accepted: [], upkeep, upkeepTurn: 1 } },
})

test('周期收支：走真的折叠路径，activeAbove 与上下限都在里面裁', () => {
  const grain = { id: 'grain', label: '口粮', group: 'self' as const, min: 0, max: 100, initial: 20, maxStep: 50, guidance: 'g' }
  const crop = { id: 'crop', label: '麦苗', group: 'self' as const, min: 0, max: 3, initial: 0, maxStep: 5, guidance: 'g' }
  const upkeep = [
    { id: 'grain', delta: -10, reason: '日耗' },
    // activeAbove：没种下（0）就不长
    { id: 'crop', delta: 1, reason: '抽穗', activeAbove: 0 },
  ]

  const one = foldNumericEvents([grain, crop], [upkeepEvent(upkeep)], 'resource')
  assert.equal(one.values.grain.value, 10)
  assert.equal(one.values.crop.value, 0, '麦苗未种下不该滚')

  // 种下之后（值 > 0）才开始长；口粮见底但不为负，麦苗到上限就停
  const sown = [
    upkeepEvent(upkeep),
    { type: 'tool/result', data: { meta: { kind: 'mechanics/resources', changes: [{ id: 'crop', delta: 1, reason: '播种', applied: 1, before: 0, after: 1, clamped: false }] } } },
    upkeepEvent(upkeep),
    upkeepEvent(upkeep),
    upkeepEvent(upkeep),
  ]
  const grown = foldNumericEvents([grain, crop], sown, 'resource')
  assert.equal(grown.values.crop.value, 3, '种下后每回合 +1，到上限停住')
  assert.equal(grown.values.grain.value, 0, '口粮见底但不为负')
})

test('周期收支按"当时的定义"结算：中途改了边界，只影响之后的回合', () => {
  const grain = { id: 'grain', label: '口粮', group: 'self' as const, min: 0, max: 100, initial: 50, maxStep: 10, guidance: 'g' }
  const rolls = [
    upkeepEvent([{ id: 'grain', delta: -30, reason: '日耗' }]),
    // 场外把单步上限放开
    { type: 'tool/result', data: { meta: { kind: 'progress/revision', revisions: [{ target: 'resource', id: 'grain', maxStep: 50 }] } } },
    upkeepEvent([{ id: 'grain', delta: -30, reason: '日耗' }]),
  ]

  const { values } = foldNumericEvents([grain], rolls, 'resource')
  // 第一次按旧上限只扣得动 10（50→40），修订之后才扣得满 30（40→10）。
  // 若拿"最终定义"重放全部历史（工具侧曾经的做法），两次都按 50 裁，会得出 0——那正是分叉。
  assert.equal(values.grain.value, 10)
})
