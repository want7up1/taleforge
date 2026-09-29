import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldHistory, historyBoundary, lastSeqOf, lastTurnDigest, mergeMessages, planResume } from './fold.ts'
import type { ChatMessage, HistoryEntry } from './types.ts'

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): HistoryEntry =>
  ({ event: { type, seq, time: seq, data } })
const msg = (seq: number, text: string, role: ChatMessage['role'] = 'assistant'): ChatMessage =>
  ({ role, text, seq })

test('historyBoundary 取投影基线与末事件 seq 的较大者', () => {
  assert.equal(historyBoundary([], undefined), -1)
  assert.equal(historyBoundary([ev(3, 'turn/start'), ev(7, 'turn/end')], 5), 7)
  assert.equal(historyBoundary([ev(3, 'turn/start')], 9), 9)
})

test('lastSeqOf 找最后一个同类事件', () => {
  const entries = [ev(1, 'turn/start'), ev(4, 'turn/end'), ev(5, 'turn/start')]
  assert.equal(lastSeqOf(entries, 'turn/start'), 5)
  assert.equal(lastSeqOf(entries, 'turn/end'), 4)
  assert.equal(lastSeqOf(entries, 'user/message'), -1)
})

test('mergeMessages：快照内以快照为准，快照后经实时流到的消息保留', () => {
  const folded = [msg(1, '开场'), msg(5, '第二回合')]
  const prev = [msg(1, '开场'), msg(5, '第二回合'), msg(9, '拉取期间到的第三回合')]
  const merged = mergeMessages(folded, prev, 6)
  assert.deepEqual(merged.map(m => m.seq), [1, 5, 9])
  // 本地有而快照没有、且在边界之内的（已被服务端裁掉，如重写回合）不保留
  const stale = mergeMessages(folded, [msg(3, '旧线')], 6)
  assert.deepEqual(stale.map(m => m.seq), [1, 5])
  // 没有额外消息时返回同一引用，避免无谓重渲染
  assert.equal(mergeMessages(folded, folded, 6), folded)
})

test('planResume：离开期间回合已结束 → 不再生成中、正文流清空', () => {
  const plan = planResume({
    entries: [ev(10, 'turn/start'), ev(20, 'turn/end')],
    asOfSeq: 20,
    inflight: undefined,
    liveTurnStart: 10,
    liveTurnEnd: -1, // turn/end 帧在后台期间丢了
    pending: [],
  })
  assert.equal(plan.running, false)
  assert.equal(plan.streaming, '')
  assert.equal(plan.chunkFloor, 20)
})

test('planResume：快照里回合未收尾 → 接上已产出部分并补缓冲分片', () => {
  const plan = planResume({
    entries: [ev(10, 'turn/start')],
    asOfSeq: 14,
    inflight: { partial: '夜色', lastChunkSeq: 14, startedAt: 1 },
    liveTurnStart: 10,
    liveTurnEnd: -1,
    pending: [{ seq: 13, text: '重复的' }, { seq: 15, text: '渐浓' }, { seq: 16, text: '，' }],
  })
  assert.equal(plan.running, true)
  assert.equal(plan.resumedInflight, true)
  assert.equal(plan.streaming, '夜色渐浓，')
  assert.equal(plan.chunkFloor, 14)
})

test('planResume：拉取窗口内实时流已收到 turn/end → 以实时流为准，视为已结束', () => {
  const plan = planResume({
    entries: [ev(10, 'turn/start')],
    asOfSeq: 14,
    inflight: { partial: '夜色', lastChunkSeq: 14, startedAt: 1 },
    liveTurnStart: 10,
    liveTurnEnd: 18,
    pending: [{ seq: 15, text: '渐浓' }],
  })
  assert.equal(plan.running, false)
  assert.equal(plan.streaming, '')
})

test('planResume：拉取窗口内实时流开了新回合 → 保持生成中，正文流只含新回合分片', () => {
  const plan = planResume({
    entries: [ev(10, 'turn/start'), ev(20, 'turn/end')],
    asOfSeq: 20,
    inflight: undefined,
    liveTurnStart: 22,
    liveTurnEnd: 20,
    pending: [{ seq: 19, text: '旧回合残片' }, { seq: 23, text: '新回合' }],
  })
  assert.equal(plan.running, true)
  assert.equal(plan.startedMeanwhile, true)
  assert.equal(plan.resumedInflight, false)
  assert.equal(plan.streaming, '新回合')
})

test('消息流：开局那条不显示；章节是正戏、场外答复与场外提问归场外', () => {
  const msgs = foldHistory([
    ev(1, 'player/input', { text: '（开始）', offstage: false, opening: true }),
    ev(2, 'turn/start', { kind: 'play', turn: 1 }),
    ev(3, 'chapter', { turn: 1, text: '第一章' }),
    ev(4, 'player/input', { text: '这是什么机制？', offstage: true }),
    ev(5, 'reply', { text: '场外答复' }),
    ev(6, 'agent/message', { content: '' }),
  ])
  assert.deepEqual(msgs.map(m => [m.role, m.kind, m.text]), [
    ['assistant', 'play', '第一章'],
    ['user', 'offstage', '这是什么机制？'],
    ['assistant', 'offstage', '场外答复'],
  ])
})

test('结算卡与选项取自最后一章所在回合；之后被取消的回合不清掉它', () => {
  const receipt = (options: string[]) => ({
    anchors: { accepted: [], ignored: [] },
    upkeep: [{ id: 'grain', applied: -1, before: 10, after: 9, reason: '日耗', clamped: false }],
    resources: [], attributes: [], inventory: [], options, rejected: [], ended: false,
  })
  const entries = [
    ev(1, 'turn/start', { kind: 'play', turn: 1 }),
    ev(2, 'chapter', { turn: 1, text: '一' }),
    ev(3, 'settlement', { turn: 1, receipt: receipt(['旧选项']) }),
    ev(4, 'turn/start', { kind: 'play', turn: 2 }),
    ev(5, 'check/rolled', { die: 'd20', roll: 7, outcome: 'fail' }),
    ev(6, 'chapter', { turn: 2, text: '二' }),
    ev(7, 'settlement', { turn: 2, receipt: receipt(['甲', '乙']) }),
    ev(8, 'turn/start', { kind: 'play', turn: 3 }),
    ev(9, 'turn/end', { kind: 'play', turn: 3, reason: 'cancelled' }),
  ]
  const digest = lastTurnDigest(entries)
  assert.deepEqual(digest.options, ['甲', '乙'])
  assert.equal(digest.check?.roll, 7)
  assert.deepEqual(digest.settlement.map(c => c.id), ['grain'])
  assert.deepEqual(lastTurnDigest([]).options, [])
})
