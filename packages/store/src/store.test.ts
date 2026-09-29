import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isSessionId, parseLog, SessionStore } from './index.ts'

const fresh = () => new SessionStore(mkdtempSync(path.join(tmpdir(), 'tf-store-')))

test('建会话即写 session/created；追加事件 seq 单调递增', () => {
  const store = fresh()
  const id = store.create({ kind: 'game', storyId: 'story-x' })
  assert.ok(isSessionId(id))
  store.append(id, 'player/input', { text: 'A' })
  const events = store.read(id)
  assert.deepEqual(events.map(e => e.type), ['session/created', 'player/input'])
  assert.deepEqual(events.map(e => e.seq), [1, 2])
  assert.equal(store.list()[0].created.storyId, 'story-x')
})

test('流式增量占用序号但不落盘：下一条事件的 seq 跳过它们', () => {
  const store = fresh()
  const id = store.create({ kind: 'game' })
  store.nextSeq(id)
  store.nextSeq(id)
  const ev = store.append(id, 'chapter', { text: '…' })
  assert.equal(ev.seq, 4)
})

test('残缺尾行（进程在写一半时被杀）被丢弃，其余照常', () => {
  const log = `${JSON.stringify({ type: 'a', seq: 1, time: 0, data: {} })}\n{"type":"b","se`
  assert.deepEqual(parseLog(log).map(e => e.type), ['a'])
  assert.throws(() => parseLog(`{bad\n${JSON.stringify({ type: 'a', seq: 1, time: 0, data: {} })}\n`))
})

test('截断：保留切点之前的事件，原稿进归档，seq 水位不回退', () => {
  const store = fresh()
  const id = store.create({ kind: 'game' })
  store.append(id, 'player/input', { text: '1' })
  const cut = store.append(id, 'player/input', { text: '2' })
  store.append(id, 'chapter', { text: '被弃的一章' })
  store.truncate(id, cut.seq)
  assert.deepEqual(store.read(id).map(e => e.data.text ?? null), [null, '1'])
  assert.ok(store.append(id, 'player/input', { text: '2b' }).seq > 4)
  assert.equal(readdirSync(path.join(store.root, 'archive')).length, 1)
})

test('存档与读档：快照拷回原 id；读档后日志与存档时一致', () => {
  const store = fresh()
  const id = store.create({ kind: 'game' })
  store.append(id, 'chapter', { text: '第一章' })
  const meta = store.backup(id, { title: '《测试》', turns: 1 })
  store.append(id, 'chapter', { text: '第二章' })
  assert.equal(store.listBackups()[0].title, '《测试》')
  assert.equal(store.restore(meta.name), id)
  assert.deepEqual(store.read(id).map(e => e.data.text ?? null), [null, '第一章'])
  store.removeBackup(meta.name)
  assert.equal(store.listBackups().length, 0)
})

test('归档：挪出 sessions/ 但不删；列表里不再出现', () => {
  const store = fresh()
  const a = store.create({ kind: 'game' })
  const b = store.create({ kind: 'workshop' })
  store.archive(a)
  assert.deepEqual(store.list().map(s => s.id), [b])
  assert.equal(readdirSync(path.join(store.root, 'archive')).length, 1)
})

test('非法 id 一律拒绝（路径穿越）', () => {
  const store = fresh()
  assert.throws(() => store.read('../etc/passwd'))
  assert.equal(store.exists('../x'), false)
})

test('并发追加不串行：每行都是完整 JSON', () => {
  const store = fresh()
  const id = store.create({ kind: 'game' })
  for (let i = 0; i < 50; i++) store.append(id, 'x', { i, pad: 'x'.repeat(5000) })
  appendFileSync(path.join(store.root, 'sessions', `${id}.jsonl`), '')
  assert.equal(store.read(id).length, 51)
})
