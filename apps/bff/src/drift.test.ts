import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driftNotes, intensityHits } from './drift.ts'
import type { TurnFact } from './drift.ts'

const play = (markers: number, text = '正文'): TurnFact => ({ kind: 'play', markers, text })
const off = (): TurnFact => ({ kind: 'offstage', markers: 0, text: '（场外）答疑' })

test('达标就不注入——闭环不是第八条常驻提醒', () => {
  assert.deepEqual(driftNotes([play(3), play(2), play(4)]), [])
})

test('单回合掉到 0 不提醒：那是正常波动，过度反应会逼出反弹', () => {
  assert.deepEqual(driftNotes([play(0), play(3)]), [])
})

test('连续两回合低于下限才提醒，且把两回合的实际处数按时间顺序报出来', () => {
  const notes = driftNotes([play(0), play(1)])
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^【笔触】/)
  assert.match(notes[0], /1 处、0 处/, '应按时间顺序念：先上上回合再上回合')
})

test('场外回合不算进连续段——它本来就不写正文', () => {
  // 夹着场外：真正的正戏是 0 和 1，仍应触发
  assert.equal(driftNotes([play(0), off(), play(1)]).length, 1)
  // 正戏只有一个，另一个是场外，样本不足不提醒
  assert.deepEqual(driftNotes([play(0), off()]), [])
})

test('恢复达标后立刻撤销提醒', () => {
  assert.deepEqual(driftNotes([play(2), play(0), play(0)]), [])
})

test('intensityHits 数的是命中次数，同一个词出现多次都算', () => {
  assert.equal(intensityHits('他的肉棒抵着她，肉棒又进了一分', ['肉棒']), 2)
  assert.equal(intensityHits('含蓄的描写', ['肉棒', '淫水']), 0)
  assert.equal(intensityHits('随便什么', []), 0)
})

test('剧本没声明词表就不查这一项', () => {
  assert.deepEqual(driftNotes([play(3), play(3), play(3)], []), [])
})

test('连续三个正戏回合零命中才提醒强度', () => {
  const words = ['肉棒', '淫水']
  const bland = play(3, '他们含蓄地相拥')
  assert.deepEqual(driftNotes([bland, bland], words), [], '样本不足两回合不提')
  const notes = driftNotes([bland, bland, bland], words)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^【强度】/)
  // 中间任一回合命中过就不算连续
  assert.deepEqual(driftNotes([bland, play(3, '肉棒'), bland], words), [])
})

test('两项可以同时触发，各占一行', () => {
  const bland = play(0, '含蓄')
  const notes = driftNotes([bland, bland, bland], ['肉棒'])
  assert.equal(notes.length, 2)
  assert.match(notes[0], /【笔触】/)
  assert.match(notes[1], /【强度】/)
})
