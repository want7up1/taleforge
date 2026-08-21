import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyAllocations,
  applyXp,
  foldProgression,
  initialProgression,
  levelOf,
  progressionView,
} from './progression.ts'
import { initialState } from './resources.ts'
import type { AttributeDef, ProgressionConfig } from './types.ts'

const config: ProgressionConfig = {
  label: '经验',
  guidance: 'x',
  maxStep: 40,
  thresholds: [40, 100, 200],
  pointsPerLevel: 2,
}
const attrs: AttributeDef[] = [
  { id: 'str', label: '力量', min: 0, max: 5, initial: 3, maxStep: 1, guidance: 'x' },
  { id: 'agi', label: '敏捷', min: 0, max: 5, initial: 2, maxStep: 1, guidance: 'x' },
]

test('levelOf 按阈值表算等级，表长+1 为满级', () => {
  assert.equal(levelOf(0, config.thresholds), 1)
  assert.equal(levelOf(39, config.thresholds), 1)
  assert.equal(levelOf(40, config.thresholds), 2)
  assert.equal(levelOf(150, config.thresholds), 3)
  assert.equal(levelOf(999, config.thresholds), 4)
})

test('applyXp：裁单次上限、升级发点、经验封顶在最后一档', () => {
  const s0 = initialProgression()
  const r1 = applyXp(s0, config, 100, '大胜')
  assert.equal(r1.result.applied, 40, '单次上限 40')
  assert.equal(r1.result.clamped, true)
  assert.equal(r1.result.levelAfter, 2)
  assert.equal(r1.result.pointsGranted, 2)
  assert.equal(r1.state.granted, 2)

  const r2 = applyXp(r1.state, config, 0, '')
  assert.equal(r2.result.applied, 0)
  assert.equal(r2.result.pointsGranted, 0)
  assert.equal(r2.state.level, 2)

  // 一次跨两级：40 + 40 = 80 → 不到 100；再 +40 → 120 过 100 升 3 级
  const r3 = applyXp(applyXp(r2.state, config, 40, 'x').state, config, 40, 'y')
  assert.equal(r3.state.xp, 120)
  assert.equal(r3.state.level, 3)
  assert.equal(r3.state.granted, 4)

  // 封顶：200 是最后一档，满级 4
  let s = r3.state
  for (let i = 0; i < 5; i++) s = applyXp(s, config, 40, 'z').state
  assert.equal(s.xp, 200)
  assert.equal(s.level, 4)
  assert.equal(s.granted, 6)
})

test('applyXp：经验可扣但等级与点数不收回', () => {
  const up = applyXp(initialProgression(), config, 40, 'x').state
  const down = applyXp(up, config, -40, '惩罚')
  assert.equal(down.state.xp, 0)
  assert.equal(down.state.level, 2, '等级只升不降')
  assert.equal(down.result.pointsGranted, 0)
  assert.equal(down.state.granted, 2)
})

test('applyAllocations：校验池子、上限、id；合格的不受 maxStep 约束', () => {
  const state = initialState(attrs)
  const r = applyAllocations(state, attrs, 3, [
    { id: 'str', points: 2 },            // 3 → 5，一次加 2（maxStep=1 不管加点）
    { id: 'str', points: 1 },            // 已到上限 5
    { id: 'agi', points: 1 },            // 池子还剩 1，通过
    { id: 'agi', points: 1 },            // 池子用完
    { id: 'luck', points: 1 },           // 不存在
  ])
  assert.deepEqual(r.changes.map(c => [c.id, c.applied, c.after]), [['str', 2, 5], ['agi', 1, 3]])
  assert.equal(r.spent, 3)
  assert.equal(r.rejected.length, 3)
  assert.match(r.rejected[0].reason, /上限/)
  assert.match(r.rejected[1].reason, /不足/)
  assert.match(r.rejected[2].reason, /不存在/)
})

test('折叠：经验与加点 meta 混合重放，未分配 = 发放 - 已花', () => {
  const a = applyXp(initialProgression(), config, 40, 'x')
  const b = applyXp(a.state, config, 40, 'y')
  const spend = { kind: 'mechanics/attributes', changes: [], points: { spent: 1 } }
  const folded = foldProgression([a.result, { kind: 'other' }, spend, b.result])
  assert.equal(folded.xp, 80)
  assert.equal(folded.level, 2)
  assert.equal(folded.granted, 2)
  assert.equal(folded.spent, 1)
  const view = progressionView(config, folded)
  assert.equal(view.unspent, 1)
  assert.equal(view.prev, 40)
  assert.equal(view.next, 100)
  assert.equal(view.maxLevel, 4)
  assert.ok(!('display' in view), '未声明 display 不输出该键（无损 JSON）')
})

test('parseAllocationRequest：从回合头注入块取玩家的加点请求，脏数据整条丢弃', async () => {
  const { parseAllocationRequest } = await import('./progression.ts')
  const text = '【回合流程】……\n【加点】玩家本回合分配属性点——固定流程第 2 步第一件事调 spend_points 原样落账：allocations=[{"id":"str","points":2},{"id":"agi","points":0},{"points":1},{"id":"luck","points":"x"}]（无法对应属性：运气，忽略）\n【当前面板】等级：Lv.2'
  assert.deepEqual(parseAllocationRequest(text), [{ id: 'str', points: 2 }])
  assert.equal(parseAllocationRequest('A. 出发\n【加点】体魄 +1'), undefined, '玩家原话里没有换算后的请求就不算')
  assert.equal(parseAllocationRequest('allocations=[not json'), undefined)
})

test('playerAllocationRequest：取最近一条玩家消息里的请求，并识别同回合已落账过', async () => {
  const { playerAllocationRequest } = await import('./progression.ts')
  const user = (text: string) => ({ type: 'user/message', data: { content: [{ type: 'text', text: 'A. 出发' }, { type: 'text', text }] } })
  const spend = { type: 'tool/result', data: { meta: { kind: 'mechanics/attributes', changes: [], points: { spent: 1 } } } }
  const other = { type: 'tool/result', data: { meta: { kind: 'mechanics/xp', after: 1, levelAfter: 1, pointsGranted: 0 } } }
  const req = '【回合流程】…\n【加点】…：allocations=[{"id":"str","points":1}]'
  assert.deepEqual(playerAllocationRequest([user(req), other]), { request: [{ id: 'str', points: 1 }], alreadySpent: false })
  assert.deepEqual(playerAllocationRequest([user(req), spend, other]), { request: [{ id: 'str', points: 1 }], alreadySpent: true })
  // 上一回合落过账不算本回合：以最近一条玩家消息为界
  assert.deepEqual(playerAllocationRequest([user(req), spend, user(req)]), { request: [{ id: 'str', points: 1 }], alreadySpent: false })
  assert.deepEqual(playerAllocationRequest([user('【回合流程】…没有加点')]), { alreadySpent: false })
  assert.deepEqual(playerAllocationRequest([]), { alreadySpent: false })
})

test('剧情奖励点：裁 bonusPointsMax 进同一个池；levelNames 取显示名', async () => {
  const { applyXp, levelLabel, progressionView, renderXp } = await import('./progression.ts')
  const cfg = { ...config, bonusPointsMax: 5, levelNames: ['C', 'B', 'A', 'S'] }
  const r = applyXp(initialProgression(), cfg, 1, '结合', 9)
  assert.equal(r.result.bonusPoints, 5, '奖励点裁到单次上限')
  assert.equal(r.result.pointsGranted, 5, '没升级时发放 = 奖励点')
  assert.equal(r.state.granted, 5)
  const view = progressionView(cfg, r.state)
  assert.equal(view.unspent, 5)
  assert.deepEqual(view.levelNames, ['C', 'B', 'A', 'S'])
  assert.equal(levelLabel(cfg, 1), 'C')
  assert.equal(levelLabel(config, 1), 'Lv.1')
  // 升级 + 奖励点同回合：总发放 = 升级点 + 奖励点，GM 文本两项分开说
  const up = applyXp(r.state, cfg, 40, '大胜', 2)
  assert.equal(up.result.pointsGranted, 2 + 2)
  const text = renderXp({ ...up.result, unspent: 9 }, cfg)
  assert.match(text, /【升级】C（Lv.1） → B（Lv.2），发放 2 点/)
  assert.match(text, /【奖励点】发放 2 点/)
  // 没开放奖励点的剧本：points 一律裁成 0
  assert.equal(applyXp(initialProgression(), config, 0, '', 3).result.bonusPoints, 0)
})
