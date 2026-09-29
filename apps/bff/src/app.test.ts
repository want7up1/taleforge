/**
 * HTTP 层的集成测试：真的起一个服务，走前端会走的那些路由。模型是脚本化的假客户端
 * （packages/engine testkit），不花额度、不出网。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Engine } from '@taleforge/engine'
import { scanCatalog } from '@taleforge/scenario-compiler'
import { SessionStore } from '@taleforge/store'
import { FakeLlm, testStoryInput } from '../../../packages/engine/src/testkit.ts'
import { createApp } from './app.ts'
import { PlatformConfig } from './config.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function boot(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'tf-bff-'))
  const scenariosRoot = path.join(home, 'scenarios')
  mkdirSync(path.join(scenariosRoot, 'kit'), { recursive: true })
  writeFileSync(path.join(scenariosRoot, 'kit', 'story.json'), JSON.stringify(testStoryInput))
  const roots = [scenariosRoot]
  const config = new PlatformConfig(home, env)
  const store = new SessionStore(path.join(home, 'v2'))
  const llm = new FakeLlm()
  const engine = new Engine({
    store,
    llm,
    settings: () => config.settings(),
    currentStory: id => scanCatalog(roots).find(e => e.id === id)?.story,
    agentPersona: 'x',
    agentTools: () => [],
  })
  const app = createApp({ engine, store, config, roots, scenariosRoot, editMapPath: path.join(home, 'v2', 'edit.json'), repoRoot })
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text }
  }
  return { home, engine, store, llm, call, base, close: () => { server.closeAllConnections(); server.close() } }
}

test('开局 → 回合 → 历史：选项在结算事件里，面板在投影里，快照不带隐藏真相', async () => {
  const t = await boot()
  try {
    const { body: created } = await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })
    assert.ok(created.sessionId)
    assert.equal((await t.call('POST', `/app/sessions/${created.sessionId}/prompt`, { text: '（开始）' })).status, 200)
    await t.engine.idle(created.sessionId)
    const { body: history } = await t.call('GET', `/app/sessions/${created.sessionId}/history`)
    const settlement = history.events.find((e: { event: { type: string } }) => e.event.type === 'settlement')
    assert.equal(settlement.event.data.receipt.options.length, 4)
    assert.equal(history.projections.values.mechanics.state.grain.value, 9)
    assert.equal(history.phase, 'playing')
    assert.doesNotMatch(JSON.stringify(history), /镇长是凶手|她认识死者/)
    const { body: sessions } = await t.call('GET', '/app/sessions')
    assert.equal(sessions.items[0].sessionId, created.sessionId)
    assert.equal(sessions.items[0].projections.values.title, '《测试镇》')
  } finally {
    t.close()
  }
})

test('多局并存：开新局不影响旧局；冒险列表带回合与终局态；工坊常驻同一个会话', async () => {
  const t = await boot()
  try {
    const a = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    await t.call('POST', `/app/sessions/${a}/prompt`, { text: '（开始）' })
    await t.engine.idle(a)
    const w = (await t.call('POST', '/app/workshop')).body.sessionId
    const b = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    assert.equal(t.store.exists(a), true, '多存档：旧局还在')
    const { body: games } = await t.call('GET', '/app/games')
    assert.deepEqual(games.items.map((g: { sessionId: string }) => g.sessionId).sort(), [a, b].sort())
    const ga = games.items.find((g: { sessionId: string }) => g.sessionId === a)
    assert.equal(ga.turns, 1)
    assert.equal(ga.phase, 'playing')
    assert.equal(ga.actTitle, '初到')
    assert.equal(ga.title, '《测试镇》')
    assert.equal((await t.call('POST', '/app/workshop')).body.sessionId, w, '工坊常驻同一个会话')
    const { body: story } = await t.call('GET', `/app/sessions/${a}/story`)
    assert.equal(story.title, '测试镇')
    assert.equal(story.cast[0].secret, undefined, '开局快照同样剥掉暗线')
  } finally {
    t.close()
  }
})

test('忙时再发一条 409；重写上一回合保持会话 id', async () => {
  const t = await boot()
  try {
    const id = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    let release!: () => void
    t.llm.hold = new Promise(r => (release = r))
    await t.call('POST', `/app/sessions/${id}/prompt`, { text: '（开始）' })
    const busy = await t.call('POST', `/app/sessions/${id}/prompt`, { text: 'A. 走' })
    assert.equal(busy.status, 409)
    assert.equal(busy.body.error.code, 'busy')
    release()
    t.llm.hold = undefined
    await t.engine.idle(id)
    const retry = await t.call('POST', `/app/sessions/${id}/retry`)
    assert.deepEqual(retry.body, { sessionId: id })
    await t.engine.idle(id)
    assert.equal(t.store.read(id).filter(e => e.type === 'chapter').length, 1)
  } finally {
    t.close()
  }
})

test('存档水晶：带名称备注存档、原地读档、删档；删局时日志归档、存档一并删除', async () => {
  const t = await boot()
  try {
    const id = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    await t.call('POST', `/app/sessions/${id}/prompt`, { text: '（开始）' })
    await t.engine.idle(id)
    const { body: saved } = await t.call('POST', `/app/sessions/${id}/saves`, { label: '进镇之前', note: '钥匙还没拿' })
    assert.equal(saved.label, '进镇之前')
    assert.equal(saved.turns, 1)
    await t.call('POST', `/app/sessions/${id}/prompt`, { text: 'A. 走' })
    await t.engine.idle(id)
    const { body: list } = await t.call('GET', `/app/sessions/${id}/saves`)
    assert.deepEqual(list.items.map((x: { label: string; note?: string }) => [x.label, x.note]), [['进镇之前', '钥匙还没拿']])
    const frames: string[] = []
    t.engine.subscribe(id, f => frames.push(f.type))
    assert.deepEqual((await t.call('POST', `/app/sessions/${id}/saves/${saved.name}/load`)).body, { sessionId: id })
    assert.equal(t.store.read(id).filter(e => e.type === 'chapter').length, 1, '读档：这一局原地回到存档那一刻')
    assert.ok(frames.includes('reset'), '在线的界面收到重置帧')
    assert.equal((await t.call('DELETE', '/app/scenarios/story-kit')).status, 409, '还有冒险用着这部剧本')
    assert.equal((await t.call('DELETE', `/app/sessions/${id}`)).status, 200)
    assert.equal(t.store.exists(id), false)
    assert.equal(t.store.listBackups().length, 0, '删局时它的存档水晶一并删除')
    assert.ok(readdirSync(path.join(t.home, 'v2', 'archive')).some(f => f.startsWith(id)), '日志归档而不是抹掉')
    assert.equal((await t.call('DELETE', '/app/scenarios/story-kit')).status, 200)
    assert.equal(existsSync(path.join(t.home, 'scenarios', 'kit')), false)
  } finally {
    t.close()
  }
})

test('回退到第 N 回合：其后的回合截掉、不重跑，选项回到第 N 回合；从头重开清到开场之前', async () => {
  const t = await boot()
  try {
    const id = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    for (const text of ['（开始）', 'A. 一', 'A. 二']) {
      await t.call('POST', `/app/sessions/${id}/prompt`, { text })
      await t.engine.idle(id)
    }
    assert.deepEqual((await t.call('POST', `/app/sessions/${id}/rewind`, { toTurn: 1 })).body, { sessionId: id })
    const chapters = t.store.read(id).filter(e => e.type === 'chapter')
    assert.deepEqual(chapters.map(c => c.data.turn), [1])
    assert.equal(t.store.read(id).at(-1)!.type, 'turn/end', '回退到的是那一回合结束时（含它的结算与选项）')
    assert.equal((await t.call('POST', `/app/sessions/${id}/rewind`, { toTurn: 5 })).status, 400)
    await t.call('POST', `/app/sessions/${id}/restart`)
    assert.deepEqual(t.store.read(id).map(e => e.type), ['session/created'])
  } finally {
    t.close()
  }
})

test('剧本详情剥掉隐藏真相、人物暗线与设定条目；导出给作者的是全文', async () => {
  const t = await boot()
  try {
    const { body: detail } = await t.call('GET', '/app/scenarios/story-kit')
    assert.equal(detail.world.hidden_truths, undefined)
    assert.equal(detail.cast[0].secret, undefined)
    assert.equal(detail.lore, undefined)
    const { body: exported } = await t.call('GET', '/app/scenarios/story-kit/export')
    assert.match(JSON.stringify(exported), /镇长是凶手/)
    assert.equal((await t.call('GET', '/app/scenarios/../etc')).status, 404)
  } finally {
    t.close()
  }
})

test('场外修订落盘：合并回剧本源成为现行正式版，旧版留档', async () => {
  const t = await boot()
  try {
    const { toolCall } = await import('../../../packages/engine/src/testkit.ts')
    t.llm.queues.offstage.push({ toolCalls: [toolCall('revise_setting', { revisions: [{ target: 'world', text: '雨其实是酸的' }] })] })
    const id = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    await t.call('POST', `/app/sessions/${id}/prompt`, { text: '【场外】雨改成酸雨' })
    await t.engine.idle(id)
    const flush = await t.call('POST', `/app/sessions/${id}/revisions/flush`)
    assert.deepEqual(flush.body, { applied: 1, skipped: [] })
    const story = JSON.parse(readFileSync(path.join(t.home, 'scenarios', 'kit', 'story.json'), 'utf8'))
    assert.match(story.world.overview, /雨其实是酸的/)
    assert.equal((await t.call('GET', '/app/scenarios/story-kit/versions')).body.versions.length, 1)
  } finally {
    t.close()
  }
})

test('设置：Key 写进数据卷（0600）；环境变量遮蔽时只读；模型只放行 DeepSeek 两款', async () => {
  const t = await boot()
  try {
    assert.deepEqual((await t.call('GET', '/app/settings/credentials')).body, { configured: false, writable: true })
    await t.call('PUT', '/app/settings/credentials', { value: 'sk-test' })
    assert.equal((await t.call('GET', '/app/settings/credentials')).body.source, 'file')
    const mode = statSync(path.join(t.home, 'v2', 'credentials.json')).mode & 0o777
    assert.equal(mode, 0o600)
    const models = (await t.call('GET', '/app/settings/models')).body.groups[0].models.map((m: { id: string }) => m.id)
    assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro'])
    assert.equal((await t.call('PUT', '/app/settings/model', { model: 'grok-4' })).status, 400)
    assert.equal((await t.call('PUT', '/app/settings/model', { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'off' })).body.reasoningEffort, 'off')
  } finally {
    t.close()
  }
  const shadowed = await boot({ DEEPSEEK_API_KEY: 'sk-env' })
  try {
    assert.deepEqual((await shadowed.call('GET', '/app/settings/credentials')).body, { configured: true, source: 'env', writable: false })
    assert.equal((await shadowed.call('PUT', '/app/settings/credentials', { value: 'sk-x' })).status, 409)
  } finally {
    shadowed.close()
  }
})

test('旧 dsh 数据一次性导入：凭据与模型设置（退役的模型名换成现行名）', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tf-legacy-'))
  writeFileSync(path.join(home, '.credentials.yaml'), '{ DEEPSEEK_API_KEY: sk-legacy }\n')
  writeFileSync(path.join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: max\n')
  const config = new PlatformConfig(home, {})
  assert.equal(config.apiKey(), 'sk-legacy')
  assert.deepEqual({ model: config.settings().model, effort: config.settings().effort }, { model: 'deepseek-flash', effort: 'max' })
})

test('SSE：连上即收帧，增量、事件、状态帧按单调序号到达', async () => {
  const t = await boot()
  try {
    const id = (await t.call('POST', '/app/sessions', { agentPreset: 'story-kit' })).body.sessionId
    const res = await fetch(`${t.base}/app/sessions/${id}/events`)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const reader = res.body!.getReader()
    const frames: { type: string; seq?: number; event?: { type: string; seq: number } }[] = []
    let buffer = ''
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += new TextDecoder().decode(value)
        for (const block of buffer.split('\n\n').slice(0, -1)) {
          const data = block.split('\n').find(l => l.startsWith('data: '))
          if (data) frames.push(JSON.parse(data.slice(6)))
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
        if (frames.some(f => f.event?.type === 'turn/end')) return
      }
    })()
    await t.call('POST', `/app/sessions/${id}/prompt`, { text: '（开始）' })
    await pump
    await reader.cancel()
    const kinds = new Set(frames.map(f => f.type))
    assert.ok(kinds.has('delta') && kinds.has('event') && kinds.has('state') && kinds.has('phase'))
    const seqs = frames.flatMap(f => (f.event ? [f.event.seq] : f.seq !== undefined ? [f.seq] : []))
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  } finally {
    t.close()
  }
})
