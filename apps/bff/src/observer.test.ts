import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectTurn, type ObservedEvent } from './observer.ts'

const turnStart: ObservedEvent = { type: 'turn/start', data: {} }
const turnEnd = (kind = 'completed', turn = 1): ObservedEvent =>
  ({ type: 'turn/end', data: { turn, reason: { kind } } })
const user = (text: string): ObservedEvent =>
  ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const call = (name: string): ObservedEvent => ({ type: 'tool/call', data: { name } })
const assistant = (text: string, reasoning = ''): ObservedEvent => ({
  type: 'assistant/message',
  data: {
    message: {
      content: [
        ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
        ...(text ? [{ type: 'text', text }] : []),
      ],
    },
  },
})

const PLAY_OK = '### 场景\n正文带**落点**。\n\n【行动】\nA. 一\nB. 二\nC. 三\nD. 四'

test('合规正戏回合：零违规，锚点与标记入 info', () => {
  const r = inspectTurn('s', [
    turnStart, user('A. 前进'),
    call('report_progress'),
    { type: 'tool/result', data: { meta: { kind: 'progress/report', accepted: ['a1'] } } },
    call('adjust_resources'),
    assistant(PLAY_OK, '内心盘算'),
    turnEnd(),
  ])
  assert.deepEqual(r.violations, [])
  assert.equal(r.kind, 'play')
  assert.deepEqual(r.info.anchors, ['a1'])
  assert.equal(r.info.markers, 1)
})

test('正戏违规：工具次序错、缺行动块、选项不足', () => {
  const wrongOrder = inspectTurn('s', [
    turnStart, user('走'), call('adjust_resources'), call('report_progress'), assistant(PLAY_OK), turnEnd(),
  ])
  assert.match(wrongOrder.violations[0], /首个工具是 adjust_resources/)

  const noBlock = inspectTurn('s', [
    turnStart, user('走'), call('report_progress'), assistant('只有正文没有块'), turnEnd(),
  ])
  assert.ok(noBlock.violations.includes('缺少行动块'))

  const fewOptions = inspectTurn('s', [
    turnStart, user('走'), call('report_progress'), assistant('正文\n【行动】\nA. 一\nB. 二'), turnEnd(),
  ])
  assert.ok(fewOptions.violations.some(v => v.includes('行动选项不足')))
})

test('终幕回合：不要求行动块，反过来有块才违规', () => {
  const ending = inspectTurn('s', [
    turnStart, user('迎接结局'), call('report_progress'), assistant('尾声。\n\n——剧终——'), turnEnd(),
  ])
  assert.deepEqual(ending.violations, [])
  assert.equal(ending.info.ending, true)

  const bad = inspectTurn('s', [
    turnStart, user('迎接结局'), call('report_progress'), assistant(`尾声——剧终——\n${PLAY_OK}`), turnEnd(),
  ])
  assert.ok(bad.violations.includes('终幕回合仍有行动块'))
})

test('场外协议：格式、行动块、正戏工具三查', () => {
  const ok = inspectTurn('s', [
    turnStart, user('【场外】问个问题'), assistant('（场外）答。'), turnEnd(),
  ])
  assert.equal(ok.kind, 'offstage')
  assert.deepEqual(ok.violations, [])

  const bad = inspectTurn('s', [
    turnStart, user('【场外】重写'), call('report_progress'), call('adjust_resources'),
    assistant(PLAY_OK), turnEnd(),
  ])
  assert.equal(bad.kind, 'offstage')
  assert.ok(bad.violations.includes('场外答复未以（场外）开头'))
  assert.ok(bad.violations.includes('场外回合出现了行动块'))
  assert.ok(bad.violations.includes('场外回合调用了正戏工具'))
})

test('通道翻车：完成但正文空、推理非空——单独一条违规', () => {
  const r = inspectTurn('s', [
    turnStart, user('A. 前进'), assistant('', '整回合的正文全在这里【行动】A...'), turnEnd(),
  ])
  assert.equal(r.violations.length, 1)
  assert.match(r.violations[0], /正文写进了推理通道/)
})

test('非正常结束只记原因，不做内容检查', () => {
  const r = inspectTurn('s', [turnStart, user('走'), turnEnd('interrupted', 7)])
  assert.equal(r.kind, 'aborted')
  assert.equal(r.reason, 'interrupted')
  assert.equal(r.turn, 7)
  assert.deepEqual(r.violations, [])
})
