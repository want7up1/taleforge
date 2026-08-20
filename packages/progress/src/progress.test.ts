import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyReport,
  boundaryWarnings,
  effectiveActs,
  foldEvents,
  initialProgress,
  pressureOf,
  remainingAnchors,
  validateRevisions,
} from './index.ts'
import type { ActDef } from './types.ts'

const acts: ActDef[] = [
  {
    id: 'act-1',
    title: '第一幕',
    objective: '目标一',
    anchors: [
      { id: 'a1', text: '锚点一', required: true, signal: '拿到钥匙' },
      { id: 'a2', text: '锚点二', required: true },
      { id: 'a3', text: '可选锚点', required: false },
    ],
  },
  {
    id: 'act-2',
    title: '第二幕',
    objective: '目标二',
    anchors: [{ id: 'b1', text: '终点', required: true }],
  },
]

const turnStart = { type: 'turn/start', data: {} }
const report = (accepted: string[]) => ({
  type: 'tool/result',
  data: { meta: { kind: 'progress/report', accepted } },
})
const revise = (revisions: unknown[]) => ({
  type: 'tool/result',
  data: { meta: { kind: 'progress/revision', revisions } },
})

test('必需锚点未齐不转幕；齐了立即转幕', () => {
  let state = initialProgress()
  let out = applyReport(state, acts, ['a1'])
  assert.deepEqual(out.accepted, ['a1'])
  assert.equal(out.advancedTo, undefined)

  out = applyReport(out.state, acts, ['a2'])
  assert.equal(out.advancedTo, 1, '两个必需锚点齐了应转入第二幕')
  assert.equal(out.state.phase, 'playing')
})

test('末幕必需锚点齐了进入终局', () => {
  let state = initialProgress()
  state = applyReport(state, acts, ['a1', 'a2']).state
  const out = applyReport(state, acts, ['b1'])
  assert.equal(out.ended, true)
  assert.equal(out.state.phase, 'ended')
  // 终局后再上报一律拒绝
  const after = applyReport(out.state, acts, ['a3'])
  assert.equal(after.accepted.length, 0)
  assert.equal(after.ignored[0].reason, '游戏已结局')
})

test('提前上报后续幕、重复上报、未知锚点各按原因拒绝', () => {
  const out = applyReport(initialProgress(), acts, ['b1', 'nope'])
  assert.deepEqual(out.accepted, [])
  assert.equal(out.ignored.find(i => i.id === 'b1')?.reason, '不属于当前幕，不能提前上报')
  assert.equal(out.ignored.find(i => i.id === 'nope')?.reason, '未知锚点')

  const once = applyReport(initialProgress(), acts, ['a1'])
  const twice = applyReport(once.state, acts, ['a1'])
  assert.equal(twice.ignored[0].reason, '已达成过')
  assert.equal(twice.state.achieved.filter(id => id === 'a1').length, 1, '幂等')
})

test('压力分档按停滞回合数：<4 low，≥4 rising，≥8 high；进展即复位', () => {
  const events = [turnStart, report(['a1'])]
  for (let i = 0; i < 7; i++) events.push(turnStart, report([]))
  let state = foldEvents(acts, events)
  assert.equal(pressureOf(state).level, 'rising')

  events.push(turnStart, report([]))
  state = foldEvents(acts, events)
  assert.equal(pressureOf(state).stalledTurns, 8)
  assert.equal(pressureOf(state).level, 'high')

  events.push(turnStart, report(['a2']))
  state = foldEvents(acts, events)
  assert.equal(pressureOf(state).level, 'low', '锚点达成即复位')
})

test('折叠重放得到同一状态——fork 出的支线靠它重算', () => {
  const events = [
    turnStart, report(['a1']),
    turnStart, report([]),
    turnStart, report(['a2']),
    turnStart, report(['b1']),
  ]
  const a = foldEvents(acts, events)
  const b = foldEvents(acts, events)
  assert.deepEqual(a, b)
  assert.equal(a.phase, 'ended')
  assert.equal(a.turn, 4)
})

test('anchor 修订改写现行幕结构：增删改齐全，且只对折叠生效不动种子', () => {
  const revisions = [
    { target: 'anchor', act: 'act-1', op: 'remove', id: 'a2' },
    { target: 'anchor', act: 'act-1', op: 'add', id: 'a4', text: '新锚点', required: true, signal: '新信号' },
    { target: 'anchor', act: 'act-1', op: 'edit', id: 'a1', required: false },
  ] as const
  const effective = effectiveActs(acts, revisions as never)
  const ids = effective[0].anchors.map(a => a.id)
  assert.ok(!ids.includes('a2') && ids.includes('a4'))
  assert.equal(effective[0].anchors.find(a => a.id === 'a1')?.required, false)
  assert.equal(acts[0].anchors.length, 3, '种子不被修改')

  // 修订后：a4 是唯一必需锚点，达成即转幕
  const state = foldEvents(acts, [revise(revisions as never), turnStart, report(['a4'])])
  assert.equal(state.actIndex, 1)
})

test('修订校验：目标不存在与缺字段被拒绝，合法条目规范化落账', () => {
  const { accepted, rejected } = validateRevisions(
    [
      { target: 'world', text: '天空变成红色' },
      { target: 'cast', id: 'ghost', text: '不存在的人' },
      { target: 'cast', id: 'su-wan', text: '她更强硬' },
      { target: 'anchor', act: 'act-9', op: 'add', id: 'x' },
      { target: 'anchor', act: 'act-1', op: 'edit', id: 'nope', text: 'x' },
      { target: 'direction', text: '' },
      { target: 'wat' },
    ],
    acts,
    [{ id: 'su-wan', name: '苏晚' }],
  )
  assert.equal(accepted.length, 2)
  assert.equal(rejected.length, 5)
  assert.deepEqual(accepted[0], { target: 'world', text: '天空变成红色' })
})

test('remainingAnchors 只列未达成，必需在前', () => {
  const state = applyReport(initialProgress(), acts, ['a1']).state
  const remaining = remainingAnchors(state, acts)
  assert.deepEqual(remaining.map(a => a.id), ['a2', 'a3'])
})

test('全可选的幕会被直接穿过', () => {
  const softActs: ActDef[] = [
    { id: 's1', title: '软幕', objective: '', anchors: [{ id: 'o1', text: '', required: false }] },
    { id: 's2', title: '硬幕', objective: '', anchors: [{ id: 'h1', text: '', required: true }] },
  ]
  const out = applyReport(initialProgress(), softActs, [])
  assert.equal(out.state.actIndex, 1, '无必需锚点的幕在首次上报时穿过')
})

test('数值定义修订校验：未知 id 拒绝、空字段拒绝、合法条目规范化', () => {
  const numeric = { resources: [{ id: 'hp', label: '体力' }], attributes: [{ id: 'str', label: '力量' }] }
  const { accepted, rejected } = validateRevisions(
    [
      { target: 'resource', id: 'hp', guidance: '新语义', max: 80 },
      { target: 'resource', id: 'nope', max: 10 },
      { target: 'attribute', id: 'str', maxStep: 2 },
      { target: 'attribute', id: 'str' },
      { target: 'resource', id: 'hp', maxStep: 0 },
    ],
    acts,
    [],
    numeric,
  )
  assert.equal(accepted.length, 2)
  assert.equal(rejected.length, 3)
  assert.deepEqual(accepted[0], { target: 'resource', id: 'hp', guidance: '新语义', max: 80 })
  // dsh 无损 JSON 约束：未给的字段必须整个省略，不能是 undefined 键
  for (const entry of accepted) {
    assert.ok(!Object.values(entry).includes(undefined), 'accepted 里不得携带 undefined 键')
  }
})

test('边界联动提醒：只改语义不动边界要警告，动了边界或非数值目标不警告', () => {
  const numeric = { resources: [{ id: 'stamina', label: '体力', maxStep: 25 }], attributes: [] }
  const warn = boundaryWarnings(
    [{ target: 'resource', id: 'stamina', guidance: '双修体力回满' }] as never,
    numeric,
  )
  assert.equal(warn.length, 1)
  assert.match(warn[0], /±25/)
  assert.match(warn[0], /maxStep/)

  const none = boundaryWarnings(
    [
      { target: 'resource', id: 'stamina', guidance: '回满', maxStep: 100 },
      { target: 'world', text: 'x' },
    ] as never,
    numeric,
  )
  assert.deepEqual(none, [])
})
