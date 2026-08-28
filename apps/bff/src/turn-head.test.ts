/**
 * 回合头注入的组装。这段逻辑每个正戏回合都跑一次，坏了就是整局的提醒通道失灵，
 * 而它此前一行测试都没有——项目历史上的事故偏偏集中在这里（投影 key 分片、
 * 前缀判断落空、注入块混进玩家原话）。锁住的是那些已经出过事的性质。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allocationHint, panelLines, projectionOf, renderTurnHead } from './turn-head.ts'
import type { ProjectionValues } from './turn-head.ts'

const mechanics = {
  defs: [
    { id: 'stamina', label: '体力', group: 'self' as const },
    { id: 'affinity:suwan', label: '苏晚', group: 'affinity' as const },
    { id: 'corruption', label: '堕落', group: 'self' as const },
  ],
  state: { 'stamina': { value: 70 }, 'affinity:suwan': { value: 42 }, 'corruption': { value: 8 } },
}

test('投影 key 按剧本分片后照样认得出来（认前缀不认全等）', () => {
  const sharded: ProjectionValues = { 'mechanics:story-diwan': mechanics }
  assert.equal(projectionOf<typeof mechanics>(sharded, 'mechanics')?.state.stamina.value, 70)
  // 裸 key 仍接受：单剧本部署与旧存档
  assert.equal(projectionOf<typeof mechanics>({ mechanics }, 'mechanics')?.state.stamina.value, 70)
  assert.equal(projectionOf(sharded, 'inventory'), undefined)
  // 前缀相同的别的 key 不该被误认
  assert.equal(projectionOf({ 'mechanicsx:y': mechanics }, 'mechanics'), undefined)
})

test('面板快照：分组标题、物品栏、等级都在，hidden 资源也给 GM', () => {
  const lines = panelLines({
    'mechanics:story-x': mechanics,
    'inventory:story-x': { items: [{ name: '钢管', qty: 1 }, { name: '罐头', qty: 3 }] },
    'progression:story-x': { label: '进化点', xp: 120, level: 2, next: 300, unspent: 2, levelNames: ['凡人', '觉醒者', '异能者'] },
  })
  const text = lines.join('；')
  assert.match(text, /体力70/)
  assert.match(text, /苏晚42/)
  // hidden 选位的资源同样喂给 GM——玩家侧由前端整块隐藏，与 hidden 的界面约定一致
  assert.match(text, /堕落8/)
  assert.match(text, /钢管、罐头×3/)
  assert.match(text, /觉醒者（Lv\.2）/)
  assert.match(text, /进化点 120\/300/)
  assert.match(text, /未分配属性点 2/)
})

test('拿不到面板快照时不崩：只留流程与提醒，且不产出空面板段', () => {
  const text = renderTurnHead({ values: {}, playerText: '往前走' })
  assert.match(text, /【回合流程】/)
  assert.doesNotMatch(text, /【当前面板】/)
  assert.doesNotMatch(text, /【经验】/)
})

test('创作简报排在注入块最后一行，离生成点最近', () => {
  const text = renderTurnHead({ values: {}, playerText: '继续' })
  // 记账（流程/面板/提醒）在前，"写一整章"贴在最后——生成点最近的位置留给正文的形状
  assert.ok(text.includes('【本章】'))
  assert.ok(text.lastIndexOf('【本章】') > text.indexOf('【回合流程】'), '创作简报在流程之后')
})

test('【加点】行按属性显示名换算成 id，未知属性忽略并说明', () => {
  const attributes = {
    defs: [{ id: 'str', label: '力量' }, { id: 'per', label: '感知' }],
    state: { str: { value: 5 }, per: { value: 3 } },
  }
  const hint = allocationHint('【加点】力量 +2、感知 +1、玄学 +5', attributes)
  assert.ok(hint)
  assert.match(hint, /"id":"str","points":2/)
  assert.match(hint, /"id":"per","points":1/)
  assert.match(hint, /无法对应属性：玄学/)
  // 同一属性写两次要合并
  assert.match(allocationHint('【加点】力量 +1、力量 +2', attributes)!, /"id":"str","points":3/)
  assert.equal(allocationHint('往前走', attributes), undefined, '没有【加点】行就不注入')
})

test('没开经验等级的剧本：玩家手打【加点】也不注入指令', () => {
  const text = renderTurnHead({
    values: { 'attributes:story-x': { defs: [{ id: 'str', label: '力量' }], state: { str: { value: 5 } } } },
    playerText: '【加点】力量 +2',
  })
  assert.doesNotMatch(text, /spend_points/)
  assert.doesNotMatch(text, /【经验】/)
})

test('开了经验等级：加点指令与 grant_xp 的每回合必调都贴上', () => {
  const text = renderTurnHead({
    values: {
      'attributes:story-x': { defs: [{ id: 'str', label: '力量' }], state: { str: { value: 5 } } },
      'progression:story-x': { label: '进化点', xp: 10, level: 1, next: 100, unspent: 3 },
    },
    playerText: '【加点】力量 +2\n然后往前走',
  })
  assert.match(text, /spend_points/)
  assert.match(text, /【经验】grant_xp 每个正戏回合都要调/)
  assert.match(text, /进化点/)
})

test('分幕提醒替换全局提醒（不是叠加），没写的幕回落全局', () => {
  const story = {
    craft: { reminder: '每回合必须有末世底噪。' },
    acts: [{ reminder: '序幕：世界还正常，不写底噪。' }, {}],
  }
  const prologue = renderTurnHead({ values: { 'progress:story-x': { actIndex: 0 } }, playerText: '走', story })
  assert.match(prologue, /序幕：世界还正常/)
  assert.doesNotMatch(prologue, /末世底噪/, '两条互斥的要求叠在一起会自相矛盾')

  const act2 = renderTurnHead({ values: { 'progress:story-x': { actIndex: 1 } }, playerText: '走', story })
  assert.match(act2, /末世底噪/, '没写提醒的幕回落 craft.reminder')

  // 拿不到进度投影时也回落全局
  assert.match(renderTurnHead({ values: {}, playerText: '走', story }), /末世底噪/)
})

test('漂移回灌：连续不达标才提，达标即撤，且排在最后', () => {
  const story = { craft: { modules: ['standard'], reminder: '保持文风。' } }
  const slack = [
    { kind: 'play' as const, markers: 0, text: '一段没有标记的正文' },
    { kind: 'play' as const, markers: 1, text: '又一段' },
  ]
  const text = renderTurnHead({ values: {}, playerText: '走', story, recent: slack })
  assert.match(text, /【笔触】/)
  assert.ok(text.indexOf('【剧本提醒】') < text.indexOf('【笔触】'), '漂移回灌排在最后')

  const fine = [
    { kind: 'play' as const, markers: 3, text: '有标记的正文' },
    { kind: 'play' as const, markers: 2, text: '也有' },
  ]
  assert.doesNotMatch(renderTurnHead({ values: {}, playerText: '走', story, recent: fine }), /【笔触】/)
})

test('强调标记的回灌以剧本选用 standard 为前提——平台不替剧本决定文风', () => {
  const slack = [
    { kind: 'play' as const, markers: 0, text: '一段没有标记的正文' },
    { kind: 'play' as const, markers: 0, text: '又一段' },
  ]
  // 只要底座结构、不选任何工艺模块的剧本，从没承诺过要用强调标记
  const bare = renderTurnHead({ values: {}, playerText: '走', story: { craft: { modules: [] } }, recent: slack })
  assert.doesNotMatch(bare, /【笔触】/)
  // 选了 standard 就照常回灌（"每回合 2–4 处"正是写在那个模块里的）
  const std = renderTurnHead({ values: {}, playerText: '走', story: { craft: { modules: ['standard'] } }, recent: slack })
  assert.match(std, /【笔触】/)
})
