import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyBoundary, lastSeqOf, mergeMessages, messageOfEvent, planResume } from './fold.ts'
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

test('回合头注入块永不显示给玩家——认【回合流程】标记，不认它在不在开头', () => {
  const player = { type: 'text', text: 'A. 拔刀' }
  const flow = { type: 'text', text: '\n\n【回合流程】先调 report_progress……' }
  // 注入块前面可能还有别的段（前导空行等），整块首字符因此不一定是【回合流程】——
  // 前端认标记不认位置，所以带前导内容的情形也要锁住
  const prefixed = { type: 'text', text: '\n\n【经验】grant_xp 每回合都要调。\n【回合流程】先调 report_progress……' }

  for (const [label, block] of [['纯流程块', flow], ['带前导段', prefixed]] as const) {
    const msg = messageOfEvent({
      type: 'user/message', seq: 1, time: 0,
      data: { content: [player, block] },
    } as never)
    assert.equal(msg?.text, 'A. 拔刀', `${label}：只应留下玩家自己的话`)
  }
})

test('玩家自己的话不因含标记以外的方括号被吞掉', () => {
  const msg = messageOfEvent({
    type: 'user/message', seq: 2, time: 0,
    data: { content: [{ type: 'text', text: '【场外】这里的机制怎么算？' }] },
  } as never)
  assert.equal(msg?.text, '【场外】这里的机制怎么算？')
})
