import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lexiconSchema, storySchema } from '@taleforge/scenario-compiler'
import type { StoredEvent } from '@taleforge/store'
import { foldSession } from './fold.ts'
import { inspectTurn } from './observer.ts'
import {
  CHAPTER_BRIEF,
  hotStory,
  loreHits,
  panelLines,
  proseOf,
  renderOffstageMessage,
  renderPlayTail,
  settlementBrief,
} from './prompts.ts'
import { settleToolDef } from './settle.ts'
import { testStory, testStoryInput } from './testkit.ts'

let seq = 0
const ev = (type: string, data: Record<string, unknown>): StoredEvent => ({ type, seq: ++seq, time: 0, data })
const created = (story = testStory()) => ev('session/created', { kind: 'game', title: 'x', model: { model: 'm', effort: 'high' }, story, storyId: story.id })

const stateAfter = (...events: StoredEvent[]) => foldSession([created(), ...events])

test('面板快照：等级、属性、分组、物品栏都在；隐藏资源也给 GM 并标明', () => {
  const lines = panelLines(stateAfter(), testStory())
  assert.deepEqual(lines, [
    '等级：Lv.1（经验 0/20）',
    '属性：机敏3',
    '自身：体力50',
    '队伍：口粮10 倒计时10（隐藏）',
    '物品栏：无名信',
  ])
})

test('尾部顺序：面板在前、本章要求在最后一行（离生成点最近）；玩家原话紧挨着它', () => {
  const tail = renderPlayTail({ state: stateAfter(ev('turn/start', { kind: 'play', turn: 1 })), story: testStory(), input: 'A. 去车站', opening: false })
  const lines = tail.split('\n')
  assert.ok(lines[0].startsWith('【当前面板】'))
  assert.equal(lines.at(-1), CHAPTER_BRIEF)
  assert.equal(lines.at(-2), '【玩家本回合】A. 去车站')
  assert.match(tail, /【剧本提醒】每章都要有雨。/)
  assert.match(tail, /【设定】\n- 旧车站：车站废弃了十年。/, '玩家输入里出现了触发词')
  assert.match(tail, /【主线】第 1 幕《初到》：找到信的主人。下一个主线事件：见到苏晚/)
})

test('分幕提醒替换全局提醒（不是叠加），没写的幕回落全局', () => {
  const input = structuredClone(testStoryInput)
  ;(input.acts[1] as Record<string, unknown>).reminder = '真相幕：雨停了。'
  const story = storySchema.parse(input)
  const atAct2 = stateAfter(ev('turn/start', { kind: 'play', turn: 1 }), ev('settlement', {
    turn: 1,
    receipt: { anchors: { accepted: ['meet-su'], ignored: [] }, upkeep: [], resources: [], attributes: [], inventory: [], options: [], rejected: [], ended: false, advancedTo: 1 },
  }))
  const tail2 = renderPlayTail({ state: atAct2, story, input: 'x', opening: false })
  assert.match(tail2, /【剧本提醒】真相幕：雨停了。/)
  assert.doesNotMatch(tail2, /每章都要有雨/)
  const tail1 = renderPlayTail({ state: stateAfter(), story, input: 'x', opening: false })
  assert.match(tail1, /【剧本提醒】每章都要有雨。/)
})

test('漂移回灌：连续两章强调标记不达标才提（选用 standard 的剧本），达标即撤', () => {
  const chapter = (turn: number, text: string) => [ev('turn/start', { kind: 'play', turn }), ev('chapter', { turn, text, toolRoundsBeforeText: 0, steps: [] })]
  const low = stateAfter(...chapter(1, '没有标记'), ...chapter(2, '也没有**一处**'))
  assert.match(renderPlayTail({ state: low, story: testStory(), input: 'x', opening: false }), /【笔触】上两章强调标记只有 0 处、1 处/)
  const ok = stateAfter(...chapter(1, '没有标记'), ...chapter(2, '**甲**与**乙**'))
  assert.doesNotMatch(renderPlayTail({ state: ok, story: testStory(), input: 'x', opening: false }), /【笔触】/)
})

test('设定条目：触发词精确匹配（含别名），不命中不注入，最多 6 条', () => {
  const lore = testStory().lore!
  assert.deepEqual(loreHits(lore, ['他走上站台']).map(e => e.id), ['station'])
  assert.deepEqual(loreHits(lore, ['他走上了站']), [], '不做模糊匹配')
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, title: `t${i}`, triggers: ['雨'], text: 'x' }))
  assert.equal(loreHits(many, ['雨']).length, 6)
})

test('热字段：重新发布后提醒、词表、分幕提醒、设定条目下一回合生效；其余锁在开局快照', () => {
  const snapshot = testStory()
  const input = structuredClone(testStoryInput)
  input.craft.reminder = '新提醒'
  input.title = '改了标题'
  ;(input.acts[0] as Record<string, unknown>).reminder = '第一幕新提醒'
  input.lore = []
  const hot = hotStory(snapshot, storySchema.parse(input))
  assert.equal(hot.craft.reminder, '新提醒')
  assert.equal(hot.acts[0].reminder, '第一幕新提醒')
  assert.deepEqual(hot.lore, [])
  assert.equal(hot.title, '测试镇', '非热字段不动')
  ;(input.craft as Record<string, unknown>).lexicons = ['harbor-talk']
  assert.deepEqual(hotStory(snapshot, storySchema.parse(input)).craft.lexicons, ['harbor-talk'], '选用的词库也是热字段')
  assert.equal(hotStory(snapshot, undefined), snapshot)
})

test('结算指令：机制细则全在这里——完成信号、guidance、隐藏条、周期收支、物品、经验、选项个数', () => {
  const brief = settlementBrief(stateAfter(), testStory(), { finale: false })
  assert.match(brief, /meet-su：见到苏晚｜完成信号：苏晚与林说上了话/)
  assert.match(brief, /find-key：找到旧钥匙（可选）/)
  assert.match(brief, /stamina（体力，当前 50，0–100，单次最多 ±20）：奔跑 -10，休息 \+20/)
  assert.match(brief, /doom（倒计时.*玩家看不见但照样记账/)
  assert.match(brief, /周期收支已由系统自动结算（每日口粮：口粮 -1），不要重复记/)
  assert.match(brief, /现有物品：letter（无名信）/)
  assert.match(brief, /xp（经验）：推进主线 \+20/)
  assert.match(brief, /options（给玩家的 4 个下一步行动）/)
  assert.match(brief, /属性主要靠玩家用属性点加点成长/)
})

test('正文步的固定前缀不背机制细则：guidance、完成信号只在结算步', async () => {
  const { renderPersona } = await import('@taleforge/scenario-compiler')
  const persona = renderPersona(testStory())
  assert.doesNotMatch(persona, /奔跑 -10|完成信号|推进主线 \+20/)
  assert.match(persona, /危险行动必掷/, '判定在正文步里掷，规则要在')
  assert.match(persona, /资源（体力、口粮）/, '隐藏条不出现在正文步的面板清单里')
})

test('settle_turn：引用既有条目的 id 全是 enum，选项上限等于剧本声明', () => {
  const def = settleToolDef(testStory(), stateAfter()).function.parameters
  const props = def.properties!
  assert.deepEqual(props.anchors.items?.enum, ['meet-su', 'find-key'])
  assert.deepEqual(props.resources.items?.properties?.id.enum, ['stamina', 'grain', 'doom'])
  assert.deepEqual(props.attributes.items?.properties?.id.enum, ['wit'])
  assert.deepEqual(props.inventory.items?.properties?.op.enum, ['gain', 'lose', 'consume', 'destroy'])
  assert.equal(props.options.maxItems, 4)
  assert.deepEqual(def.required, ['anchors', 'resources', 'attributes', 'inventory', 'xp', 'options'])
  const bare = storySchema.parse({ ...structuredClone(testStoryInput), mechanics: undefined, craft: { modules: [], action_options: 3 } })
  assert.deepEqual(Object.keys(settleToolDef(bare, foldSession([created(bare)])).function.parameters.properties!), ['anchors', 'options'])
})

test('场外消息：同一份稳定部分 + 场外协议与场外记录', () => {
  const state = stateAfter(
    ev('player/input', { text: '上次那个问题', offstage: true }),
    ev('turn/start', { kind: 'offstage', turn: 0 }),
    ev('reply', { text: '答过了', steps: [] }),
  )
  const msg = renderOffstageMessage(state, testStory(), '还有一个问题')
  assert.match(msg, /【场外】/)
  assert.match(msg, /【场外记录】（最近几次）\n玩家：上次那个问题\n你：答过了/)
  assert.ok(msg.trimEnd().endsWith('【玩家的场外消息】还有一个问题'))
})

test('模型偶尔自带的【行动】块从正文里剥掉', () => {
  assert.equal(proseOf('正文。\n\n【行动】\nA. 走\nB. 跑'), '正文。')
  assert.equal(proseOf('提到【行动】二字的正文'), '提到【行动】二字的正文')
})

test('观测：合规正戏回合零违规，记篇幅、标记、选项、缓存命中；选项不足与结算失败各记一条', () => {
  const usage = { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 900, cacheMissTokens: 100 }
  const turnEvents = (options: string[], failed?: string) => [
    ev('turn/start', { kind: 'play', turn: 3 }),
    ev('chapter', { turn: 3, text: '**甲**正文', toolRoundsBeforeText: 0, steps: [{ model: 'm', ms: 10, firstTextMs: 3, usage }] }),
    ev('settlement', { turn: 3, receipt: { anchors: { accepted: ['a'], ignored: [] }, upkeep: [], resources: [], attributes: [], inventory: [], options, rejected: [], ended: false }, ...failed ? { failed } : {}, step: { model: 'm', ms: 5, usage } }),
    ev('turn/end', { kind: 'play', turn: 3, reason: 'completed' }),
  ]
  const ok = inspectTurn('s', turnEvents(['a', 'b', 'c', 'd']))
  assert.deepEqual(ok.violations, [])
  assert.equal(ok.info.markers, 1)
  assert.equal(ok.info.options, 4)
  assert.equal(ok.info.cacheHitRate, 0.9)
  assert.equal(ok.info.firstTextMs, 3)
  assert.deepEqual(inspectTurn('s', turnEvents(['a', 'b'])).violations, ['行动选项不足（2/4）'])
  assert.deepEqual(inspectTurn('s', turnEvents([], '超时')).violations, ['结算步失败：超时'])
  const aborted = inspectTurn('s', [ev('turn/start', { kind: 'play', turn: 1 }), ev('turn/end', { kind: 'play', turn: 1, reason: 'cancelled' })])
  assert.equal(aborted.kind, 'aborted')
})

test('绑定人物的数值条：人物登场前不进面板快照、不进结算指令；登场那一章起才出现', () => {
  const input = structuredClone(testStoryInput)
  ;(input.mechanics.resources as Record<string, unknown>[]).push({ id: 'trust-su', label: '苏晚·信任', group: 'affinity', min: 0, max: 100, initial: 5, maxStep: 10, guidance: '并肩 +5', revealWith: 'su' })
  const story = storySchema.parse(input)
  const created2 = ev('session/created', { kind: 'game', title: 'x', model: { model: 'm', effort: 'high' }, story, storyId: story.id })
  const before = foldSession([created2, ev('turn/start', { kind: 'play', turn: 1 }), ev('chapter', { turn: 1, text: '车站空无一人。', toolRoundsBeforeText: 0, steps: [] })])
  assert.doesNotMatch(panelLines(before, story).join(), /苏晚·信任/)
  const briefBefore = settlementBrief(before, story, { finale: false })
  assert.doesNotMatch(briefBefore, /trust-su/)
  assert.match(briefBefore, /另有 1 条绑定在还没登场的人物身上/)
  const after = foldSession([created2, ev('turn/start', { kind: 'play', turn: 1 }), ev('chapter', { turn: 1, text: '晚晴……不，苏晚晴站在月台上。', toolRoundsBeforeText: 0, steps: [] })])
  assert.match(panelLines(after, story).join(), /苏晚·信任5/)
  assert.match(settlementBrief(after, story, { finale: false }), /trust-su（苏晚·信任/)
})

test('旧剧本里写着 grant_xp、adjust_resources、"回执会告诉你"：结算指令附一句新旧对照；新剧本不附', () => {
  assert.doesNotMatch(settlementBrief(stateAfter(), testStory(), { finale: false }), /旧版的工具名/)
  const input = structuredClone(testStoryInput)
  input.craft.rules = ['结算铁律：性场景当回合必须用工具落账——grant_xp（一对一 +1、points+1），不要再调adjust_resources重复记。']
  const story = storySchema.parse(input)
  const brief = settlementBrief(foldSession([ev('session/created', { kind: 'game', title: 'x', model: { model: 'm', effort: 'high' }, story, storyId: story.id })]), story, { finale: false })
  assert.match(brief, /旧版的工具名[\s\S]*xp\.points/)
})

test('词库：强度提醒触发时，从选用的词库里挑最近几章没出现过的词附在后面', () => {
  const lexicon = lexiconSchema.parse({
    format: 'taleforge.lexicon.v1',
    id: 'rain',
    title: '雨',
    groups: [{ label: '雨', words: ['檐溜', '雨脚', '水汽'] }],
  })
  const chapter = (turn: number, text: string) => [ev('turn/start', { kind: 'play', turn }), ev('chapter', { turn, text, toolRoundsBeforeText: 0, steps: [] })]
  const bland = stateAfter(...chapter(1, '**甲**与**乙**，雨脚很密'), ...chapter(2, '**甲**与**乙**'), ...chapter(3, '**甲**与**乙**'))
  const tail = renderPlayTail({ state: bland, story: testStory(), input: 'x', opening: false, lexicons: [lexicon] })
  const line = tail.split('\n').find(l => l.startsWith('【强度】'))!
  assert.match(line, /词库里这几章没用过的：/)
  assert.match(line, /檐溜/)
  assert.doesNotMatch(line, /雨脚/, '最近几章用过的不再推')
  const none = renderPlayTail({ state: bland, story: testStory(), input: 'x', opening: false })
  assert.doesNotMatch(none, /词库里/, '没选词库就只有事实本身')
})

test('选项不原地打转：结算指令原样摆出玩家刚做的事和上一回合的选项，并要求从这一章的结尾往下走', () => {
  const chapter = (turn: number, text: string) => [ev('turn/start', { kind: 'play', turn }), ev('chapter', { turn, text, toolRoundsBeforeText: 0, steps: [] })]
  const receipt = (options: string[]) => ({ anchors: { accepted: [], ignored: [] }, upkeep: [], resources: [], attributes: [], inventory: [], options, rejected: [], ended: false })
  const opening = stateAfter(ev('player/input', { text: '（开始）' }), ...chapter(1, '第一章'))
  const first = settlementBrief(opening, testStory(), { finale: false })
  assert.match(first, /从这一章的结尾往下走：结尾刚出现的东西/)
  assert.doesNotMatch(first, /不原地打转/, '开场章没有"上一步"，（开始）也不是玩家的行动')
  const second = stateAfter(
    ev('player/input', { text: '（开始）' }), ...chapter(1, '第一章'),
    ev('settlement', { turn: 1, receipt: receipt(['逼她把昨天看到的说清楚', '退到铁门边守住退路']) }),
    ev('player/input', { text: 'A. 逼她把昨天看到的说清楚' }), ...chapter(2, '第二章'),
  )
  const brief = settlementBrief(second, testStory(), { finale: false })
  assert.match(brief, /玩家这一步刚做的是「逼她把昨天看到的说清楚」/, '选项字母去掉')
  assert.match(brief, /上一回合给过的是「逼她把昨天看到的说清楚」「退到铁门边守住退路」——不要把它们换个说法再给一遍/)
  assert.match(brief, /同一件事换个说法、换个角度都不算新动作/)
})
