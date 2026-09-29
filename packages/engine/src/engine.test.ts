import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { ChatMessage } from '@taleforge/llm'
import { lexiconSchema, storySchema } from '@taleforge/scenario-compiler'
import { EngineError, extractAllocations, publicEvent, type Frame } from './engine.ts'
import type { ChapterData, SettlementData } from './events.ts'
import { FakeLlm, makeEngine, settleCall, testStory, testStoryInput, toolCall, turn } from './testkit.ts'

const types = (events: { type: string }[]) => events.map(e => e.type)
const userOf = (messages: ChatMessage[]) => messages.filter(m => m.role === 'user').map(m => m.content).join('\n')

test('开场回合：正文步 → 结算步 → 回合结束；选项来自结算，结构上不会缺', async () => {
  const { engine, store, llm } = makeEngine()
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  const events = store.read(id)
  assert.deepEqual(types(events).filter(t => t !== 'session/created'), ['player/input', 'turn/start', 'chapter', 'settlement', 'turn/end'])
  assert.equal(events[1].data.opening, true)
  const settlement = events.find(e => e.type === 'settlement')!.data as unknown as SettlementData
  assert.deepEqual(settlement.receipt.options, ['A 选项', 'B 选项', 'C 选项', 'D 选项'])
  assert.deepEqual(llm.calls.map(c => c.kind), ['prose', 'settle'])
  const prose = llm.calls[0].request
  assert.equal(prose.thinking, true)
  assert.equal(prose.toolChoice, 'auto', '开了判定的剧本正文步可以掷骰')
  assert.match(userOf(prose.messages), /【开局】/)
  const settle = llm.calls[1].request
  assert.equal(settle.thinking, false, '思考模式下指定工具会 400，结算步必须关思考')
  assert.deepEqual(settle.toolChoice, { type: 'function', function: { name: 'settle_turn' } })
  assert.equal(engine.view(id).progress?.turn, 1)
})

test('结算步带回正文步的 reasoning_content（带工具时缺了就 400）；工具列表整局稳定', async () => {
  const { engine, llm } = makeEngine()
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, 'A. 去诊所')
  await turn(engine, id, '【场外】这个镇有多大？')
  const settle = llm.calls.filter(c => c.kind === 'settle')[1].request
  const assistant = settle.messages.find(m => m.role === 'assistant') as Extract<ChatMessage, { role: 'assistant' }>
  assert.equal(assistant.reasoning_content, '想一想')
  const tools = llm.calls.map(c => JSON.stringify(c.request.tools))
  assert.equal(new Set(tools).size, 1, '正文、结算、场外请求的工具定义必须逐字节相同——它渲染在提示词最前面')
})

test('掷骰在正文步里发生：代码裁决、写进日志，掷完接着写；首字前工具往返 = 1', async () => {
  const llm = new FakeLlm()
  llm.queues.prose.push(
    { reasoning: '要掷', toolCalls: [toolCall('roll_check', { difficulty: 12, attribute: 'wit', reason: '撬锁' })] },
    req => {
      const tool = req.messages.find(m => m.role === 'tool')
      assert.match(tool!.content, /掷 d20 = 18，机敏 \+3，合计 21，难度 12/)
      const prior = req.messages.find(m => m.role === 'assistant') as Extract<ChatMessage, { role: 'assistant' }>
      assert.equal(prior.reasoning_content, '要掷', '同一回合的工具调用消息也要带回推理')
      return { content: '锁开了。'.repeat(30), reasoning: '写' }
    },
  )
  const { engine, store } = makeEngine({ llm, rolls: [18] })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  const events = store.read(id)
  const check = events.find(e => e.type === 'check/rolled')!.data
  assert.equal(check.roll, 18)
  assert.equal(check.outcome, 'success')
  const chapter = events.find(e => e.type === 'chapter')!.data as unknown as ChapterData
  assert.equal(chapter.toolRoundsBeforeText, 1)
  assert.match(chapter.text, /锁开了/)
})

test('结算裁决：周期收支先滚、资源按边界裁、物品四种动作、经验升级发点、锚点转幕', async () => {
  const llm = new FakeLlm()
  llm.queues.settle.push({
    toolCalls: [settleCall({
      anchors: ['meet-su', 'find-key'],
      resources: [{ id: 'stamina', delta: -50, reason: '狂奔' }, { id: 'ghost', delta: 5, reason: 'x' }],
      attributes: [{ id: 'wit', delta: 1, reason: '破解了暗号' }],
      inventory: [
        { op: 'gain', id: 'old-key', name: '旧钥匙', reason: '从井里捞出' },
        { op: 'consume', id: 'letter', reason: '烧掉了信' },
        { op: 'lose', id: 'nothing', reason: '不存在的东西' },
      ],
      xp: { amount: 25, reason: '见到了关键人物' },
      options: ['A. 问苏晚', 'B、去镇公所', '去车站', '去车站', '回旅馆', '多余的第五条'],
    })],
  })
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  const s = store.read(id).find(e => e.type === 'settlement')!.data as unknown as SettlementData
  const r = s.receipt
  assert.deepEqual(r.upkeep.map(c => [c.id, c.after]), [['grain', 9]])
  assert.deepEqual(r.resources.map(c => [c.id, c.applied, c.after]), [['stamina', -20, 30]], '单步上限 20 裁掉超出部分')
  assert.ok(r.rejected.some(x => /ghost/.test(x)))
  assert.deepEqual(r.inventory.map(c => [c.op, c.id, c.removed]), [['add', 'old-key', false], ['remove', 'letter', true]])
  assert.ok(r.rejected.some(x => /物品变动无效/.test(x)))
  assert.equal(r.xp?.levelAfter, 2)
  assert.equal(r.xp?.unspent, 2)
  assert.deepEqual(r.options, ['问苏晚', '去镇公所', '去车站', '回旅馆'], '去编号、去重、截到声明的个数')
  assert.equal(r.advancedTo, 1)
  const types2 = types(store.read(id))
  assert.ok(types2.includes('act/advanced'))
  const view = engine.view(id)
  assert.equal(view.progress?.actIndex, 1)
  assert.equal(view.mechanics?.state.stamina.value, 30)
  assert.deepEqual(view.inventory?.items.map(i => i.id), ['old-key'])
  assert.equal(view.progression?.unspent, 2)
})

test('下一章接住上一章的结算：转幕、升级进尾部；固定前缀换到新的当前幕', async () => {
  const llm = new FakeLlm()
  llm.queues.settle.push({ toolCalls: [settleCall({ anchors: ['meet-su'], xp: { amount: 25, reason: 'x' }, options: ['a', 'b', 'c', 'd'] })] })
  const { engine } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, 'A. 走')
  const prose = llm.calls.filter(c => c.kind === 'prose')[1].request
  const user = userOf(prose.messages)
  assert.match(user, /【转幕】.*第 2 幕《真相》/)
  assert.match(user, /【升级】上一章结束时升到 Lv.2/)
  const system = prose.messages[0].content as string
  assert.match(system, /第 1 幕《初到》（已完成）/)
  assert.match(system, /第 2 幕《真相》（当前）/)
  assert.doesNotMatch(system, /见到苏晚/, '已完成的幕不再占篇幅')
})

test('终幕：末幕必需锚点齐了宣布终幕；下一章写结局、不再结算，局面进入剧终', async () => {
  const llm = new FakeLlm()
  llm.queues.settle.push(
    { toolCalls: [settleCall({ anchors: ['meet-su'], options: ['a', 'b', 'c', 'd'] })] },
    { toolCalls: [settleCall({ anchors: ['expose'], options: ['认罪之后', 'b', 'c', 'd'] })] },
  )
  llm.queues.prose.push({ content: '开场。'.repeat(20) }, { content: '对质。'.repeat(20) }, req => {
    assert.match(userOf(req.messages), /【终幕】/)
    return { content: `结局。\n\n——剧终——` }
  })
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, 'A. 对质')
  assert.ok(types(store.read(id)).includes('ending/declared'))
  assert.equal(engine.view(id).progress?.phase, 'finale', '结局章还没写：玩家还要选最后一步')
  await turn(engine, id, 'A. 认罪之后')
  const last = store.read(id).filter(e => e.type === 'chapter').at(-1)!.data as unknown as ChapterData
  assert.equal(last.ending, true)
  assert.equal(llm.calls.filter(c => c.kind === 'settle').length, 2, '结局章不结算')
  assert.equal(engine.view(id).progress?.phase, 'ended')
  assert.throws(() => engine.prompt(id, 'A. 再来'), (e: unknown) => e instanceof EngineError && e.code === 'ended')
})

test('结算步两次都拿不到合法调用：只落周期收支，选项为空，观测记一条违规', async () => {
  const llm = new FakeLlm()
  llm.queues.settle.push({ content: '我忘了调工具' }, { toolCalls: [toolCall('settle_turn', '不是对象')] })
  llm.queues.settle[1] = { toolCalls: [{ id: 'x', type: 'function', function: { name: 'settle_turn', arguments: '{坏的' } }] }
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  const s = store.read(id).find(e => e.type === 'settlement')!.data as unknown as SettlementData
  assert.match(s.failed!, /JSON/)
  assert.deepEqual(s.receipt.options, [])
  assert.equal(engine.view(id).mechanics?.state.grain.value, 9, '每个正戏回合的周期收支由代码保证')
  const log = readFileSync(path.join(store.root, 'observer-v2.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.match(log.at(-1).violations.join(), /结算步失败/)
})

test('场外：只认 revise_setting，修订落账后下一章尾部出现现行修订；场外不结算', async () => {
  const llm = new FakeLlm()
  llm.queues.offstage.push(
    { toolCalls: [toolCall('revise_setting', { revisions: [{ target: 'direction', text: '节奏放慢' }, { target: 'cast', id: 'nobody', text: 'x' }] })] },
    req => {
      assert.match(req.messages.at(-1)!.content as string, /已落账 1 条修订[\s\S]*第 2 条被拒绝：人物 id 不存在/)
      return { content: '好，之后放慢。' }
    },
  )
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, '【场外】节奏太快了')
  const events = store.read(id)
  assert.ok(types(events).includes('revision'))
  assert.equal(events.filter(e => e.type === 'settlement').length, 1)
  assert.equal(events.find(e => e.type === 'reply')!.data.text, '好，之后放慢。')
  await turn(engine, id, 'A. 走')
  assert.match(userOf(llm.calls.filter(c => c.kind === 'prose')[1].request.messages), /【现行修订】[\s\S]*\[走向\] 节奏放慢/)
  assert.equal(engine.state(id).offstage.length, 1)
})

test('加点：【加点】行按显示名换算、由代码直接落账（不经过模型），尾部让正文写成长的体感', async () => {
  const llm = new FakeLlm()
  llm.queues.settle.push({ toolCalls: [settleCall({ xp: { amount: 25, reason: 'x' }, options: ['a', 'b', 'c', 'd'] })] })
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, 'A. 走\n【加点】机敏 +2、运气 +1')
  const input = store.read(id).filter(e => e.type === 'player/input').at(-1)!.data
  assert.equal(input.text, 'A. 走', '【加点】行不留在玩家原话里')
  assert.deepEqual(input.allocations, [{ id: 'wit', points: 2 }])
  const pts = store.read(id).find(e => e.type === 'points/spent')!.data
  assert.equal(pts.spent, 2)
  assert.equal(engine.view(id).attributes?.state.wit.value, 5)
  assert.equal(engine.view(id).progression?.unspent, 0)
  assert.match(userOf(llm.calls.filter(c => c.kind === 'prose')[1].request.messages), /【加点】玩家刚把属性点加在：机敏 \+2/)
})

test('extractAllocations：认显示名也认 id，同一属性合并，认不出的忽略', () => {
  const defs = [{ id: 'str', label: '力量' }, { id: 'agi', label: '敏捷' }]
  assert.deepEqual(extractAllocations('A. 出发\n【加点】力量 +1、str +2，敏捷+1、魅力 +3', defs), {
    text: 'A. 出发',
    allocations: [{ id: 'str', points: 3 }, { id: 'agi', points: 1 }],
  })
  assert.deepEqual(extractAllocations('没有加点', defs), { text: '没有加点', allocations: [] })
})

test('重写上一回合：截断日志后重跑同一输入；原稿进归档，章节数不变', async () => {
  const { engine, store, llm } = makeEngine()
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, 'B. 去车站')
  const before = store.read(id).filter(e => e.type === 'chapter').at(-1)!.data.text
  const frames: Frame[] = []
  engine.subscribe(id, f => frames.push(f))
  await engine.retry(id)
  await engine.idle(id)
  const chapters = store.read(id).filter(e => e.type === 'chapter')
  assert.equal(chapters.length, 2)
  assert.notEqual(chapters[1].data.text, before)
  assert.equal(store.read(id).filter(e => e.type === 'player/input').at(-1)!.data.text, 'B. 去车站')
  assert.ok(frames.some(f => f.type === 'reset'), '界面要收到重置帧再重拉历史')
  assert.ok(readdirSync(path.join(store.root, 'archive')).some(f => f.includes('rewrite')))
  assert.equal(llm.calls.filter(c => c.kind === 'prose').length, 3)
  assert.equal(engine.view(id).progress?.turn, 2, '重写的回合沿用原来的回合号')
})

test('取消：正文步中止 → 回合以 cancelled 收尾，不留半章；下一回合沿用同一个回合号', async () => {
  const llm = new FakeLlm()
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  llm.hold = new Promise(() => undefined)
  engine.prompt(id, 'A. 走')
  assert.throws(() => engine.prompt(id, 'B. 跑'), (e: unknown) => e instanceof EngineError && e.code === 'busy')
  await new Promise(r => setTimeout(r, 10))
  engine.cancel(id)
  await engine.idle(id)
  const end = store.read(id).at(-1)!
  assert.equal(end.type, 'turn/end')
  assert.equal(end.data.reason, 'cancelled')
  assert.equal(store.read(id).filter(e => e.type === 'chapter').length, 1)
  llm.hold = undefined
  await turn(engine, id, 'A. 走')
  assert.equal(engine.view(id).progress?.turn, 2)
})

test('前情提要：窗口攒满 K+N 章后台并进提要；下一章只带提要 + 最近 K 章原文', async () => {
  const llm = new FakeLlm()
  const { engine } = makeEngine({ llm, settings: { recentChapters: 2, recapEvery: 2 } })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  for (const a of ['A. 一', 'A. 二', 'A. 三']) await turn(engine, id, a)
  assert.equal(llm.calls.filter(c => c.kind === 'recap').length, 1)
  const recapReq = llm.calls.find(c => c.kind === 'recap')!.request
  assert.match(userOf(recapReq.messages), /第 1 回合[\s\S]*第 2 回合/)
  assert.doesNotMatch(userOf(recapReq.messages), /第 3 回合/)
  assert.equal(recapReq.toolChoice, 'none')
  assert.equal(engine.state(id).recap?.through, 2)
  await turn(engine, id, 'A. 四')
  const user = userOf(llm.calls.filter(c => c.kind === 'prose').at(-1)!.request.messages)
  assert.match(user, /【前情提要】（第 1–2 回合）\n前情：他们来到了镇上。/)
  assert.doesNotMatch(user, /——第 2 回合——/)
  assert.match(user, /——第 3 回合——[\s\S]*——第 4 回合——/)
})

test('上下文稳定部分只往后追加：下一回合的消息以上一回合的稳定部分为前缀（缓存）', async () => {
  const { engine, llm } = makeEngine()
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  await turn(engine, id, 'A. 一')
  await turn(engine, id, 'A. 二')
  const [, second, third] = llm.calls.filter(c => c.kind === 'prose').map(c => c.request.messages[1].content as string)
  const stable2 = second.slice(0, second.indexOf('\n\n【当前面板】'))
  assert.ok(third.startsWith(stable2), '第 3 回合的 user 消息必须以第 2 回合的稳定部分开头')
  const sys = llm.calls.filter(c => c.kind === 'prose').map(c => c.request.messages[0].content)
  assert.equal(new Set(sys).size, 1, '同一幕里固定前缀逐字节不变')
})

test('手写开场章：直接作为第 1 回合，不调正文模型；结算照样给出选项', async () => {
  const story = storySchema.parse({ ...structuredClone(testStoryInput), opening: { ...testStoryInput.opening, chapter: '雨下了一整夜。'.repeat(40) } })
  const { engine, store, llm } = makeEngine()
  const id = engine.createGame(story)
  await turn(engine, id, '（开始）')
  assert.deepEqual(llm.calls.map(c => c.kind), ['settle'])
  const chapter = store.read(id).find(e => e.type === 'chapter')!.data as unknown as ChapterData
  assert.equal(chapter.handwritten, true)
  assert.match(userOf(llm.calls[0].request.messages), /【开场章（作者亲笔，已经呈现给玩家）】\n雨下了一整夜/)
  assert.equal(llm.calls[0].request.messages.filter(m => m.role === 'assistant').length, 0, '没有模型生成的 assistant 消息可回传')
})

test('正文写进推理通道（可见正文为空）：原地再写一遍', async () => {
  const llm = new FakeLlm()
  llm.queues.prose.push({ content: '', reasoning: '整章都在这里' }, { content: '这次写对了。'.repeat(10) })
  const { engine, store } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  assert.match(store.read(id).find(e => e.type === 'chapter')!.data.text as string, /这次写对了/)
})

test('发给界面的事件不带剧本快照（隐藏真相）、推理与结算原始参数', async () => {
  const { engine, store } = makeEngine()
  const id = engine.createGame(testStory())
  await turn(engine, id, '（开始）')
  const out = store.read(id).map(publicEvent)
  const text = JSON.stringify(out)
  assert.doesNotMatch(text, /镇长是凶手|她认识死者/)
  assert.doesNotMatch(text, /想一想/)
  assert.ok(!('args' in out.find(e => e.type === 'settlement')!.data))
})

test('推流：正文增量带单调序号，事件帧与状态帧都到；进行中可取断点', async () => {
  const llm = new FakeLlm()
  let inflightSeen: unknown
  const { engine } = makeEngine({ llm })
  const id = engine.createGame(testStory())
  const frames: Frame[] = []
  engine.subscribe(id, (f) => {
    frames.push(f)
    if (f.type === 'delta' && !inflightSeen) inflightSeen = engine.inflight(id)
  })
  await turn(engine, id, '（开始）')
  const seqs = frames.flatMap(f => (f.type === 'delta' || f.type === 'phase' ? [f.seq] : f.type === 'event' ? [f.event.seq] : []))
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事件与增量共用一条单调序列')
  assert.ok(frames.some(f => f.type === 'state'))
  assert.ok((inflightSeen as { partial: string }).partial.length > 0)
  assert.equal(engine.inflight(id), undefined)
})

test('工坊对话：工具往返写进日志，重建历史时每条 assistant 消息都带回推理', async () => {
  const llm = new FakeLlm()
  llm.queues.agent.push(
    { reasoning: '先看看', toolCalls: [toolCall('list_stories', {})] },
    { content: '现在有一部剧本。', reasoning: '说一句' },
    req => {
      const assistants = req.messages.filter(m => m.role === 'assistant') as Extract<ChatMessage, { role: 'assistant' }>[]
      assert.deepEqual(assistants.map(a => a.reasoning_content), ['先看看', '说一句'])
      assert.equal(req.messages.filter(m => m.role === 'tool').length, 1)
      return { content: '好的。' }
    },
  )
  const { engine, store } = makeEngine({ llm })
  ;(engine as unknown as { deps: { agentTools: () => unknown[] } }).deps.agentTools = () => [{
    def: { type: 'function', function: { name: 'list_stories', description: 'x', parameters: { type: 'object', properties: {} } } },
    run: async () => ({ text: '- story-kit《测试镇》' }),
  }]
  const id = engine.createAgent('workshop')
  await turn(engine, id, '你好')
  await turn(engine, id, '改一下')
  assert.deepEqual(types(store.read(id)).filter(t => t === 'agent/message' || t === 'tool/result'), ['agent/message', 'tool/result', 'agent/message', 'agent/message'])
  assert.equal(llm.calls[0].request.messages[0].content, '你是工坊。')
})

test('会话级换模型：写一条事件，之后的请求都用它；关思考时正文步照样能掷骰', async () => {
  const { engine, llm } = makeEngine()
  const id = engine.createGame(testStory())
  engine.selectModel(id, { model: 'deepseek-v4-pro', effort: 'off' })
  await turn(engine, id, '（开始）')
  const prose = llm.calls[0].request
  assert.equal(prose.model, 'deepseek-v4-pro')
  assert.equal(prose.thinking, false)
  assert.equal(prose.reasoningEffort, undefined)
  assert.equal(engine.view(id).model.model, 'deepseek-v4-pro')
})

test('场外问题不需要剧本声明判定也能跑；没开判定的剧本正文步不让调工具', async () => {
  const input = structuredClone(testStoryInput) as Record<string, unknown>
  const mech = { ...(input.mechanics as Record<string, unknown>) }
  delete mech.checks
  const story = storySchema.parse({ ...input, mechanics: mech })
  const { engine, llm } = makeEngine()
  const id = engine.createGame(story)
  await turn(engine, id, '（开始）')
  assert.equal(llm.calls[0].request.toolChoice, 'none')
  assert.ok(!llm.calls[0].request.tools!.some(t => t.function.name === 'roll_check'))
})

test('词库：剧本声明了才进固定前缀，正文、结算、场外同一份；改了词库下一回合就用新版；缺的跳过', async () => {
  let words = ['檐溜', '雨脚']
  const lexicons = () => [lexiconSchema.parse({ format: 'taleforge.lexicon.v1', id: 'rain', title: '雨', groups: [{ label: '雨', words }] })]
  const declared = storySchema.parse({ ...structuredClone(testStoryInput), craft: { ...testStoryInput.craft, lexicons: ['rain', 'not-imported'] } })
  const { engine, llm } = makeEngine({ story: declared, lexicons })
  const id = engine.createGame(declared)
  await turn(engine, id, '（开始）')
  const system = (kind: string) => llm.calls.filter(c => c.kind === kind).at(-1)!.request.messages[0].content as string
  assert.match(system('prose'), /# 用词库（本剧本选用）[\s\S]*- 雨：檐溜、雨脚/)
  assert.equal(system('settle'), system('prose'), '结算步与正文步同一份固定前缀（缓存）')
  assert.doesNotMatch(system('prose'), /not-imported/, '还没导入的词库运行时跳过')
  words = ['檐溜', '雨脚', '水汽']
  await turn(engine, id, 'A. 走')
  assert.match(system('prose'), /- 雨：檐溜、雨脚、水汽/, '词库现读：重新导入后下一回合就是新版')

  const plain = makeEngine({ lexicons })
  const other = plain.engine.createGame(testStory())
  await turn(plain.engine, other, '（开始）')
  assert.doesNotMatch(plain.llm.calls[0].request.messages[0].content as string, /用词库/, '剧本没声明就没有（无隐藏默认）')
})
