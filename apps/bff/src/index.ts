/**
 * TaleForge 平台服务（BFF）：托管 SPA、受控转发 dsh /api、mux→SSE 桥。
 * dsh 网关无认证且只信任 loopback，本服务是唯一对外入口。
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileAll } from '@taleforge/scenario-compiler'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { DshRpcError, onMuxFrame, rpc } from './dsh.ts'
import { startObserver } from './observer.ts'

const PORT = Number(process.env.PORT ?? 31415)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dshHome = process.env.DSH_HOME ?? path.join(repoRoot, 'runtime/dsh-home')

// 启动时把 presets/ 下的剧本源编译进 dsh 的 preset 根（幂等；preset 发现无缓存，立即可用）
// preset 组合文件不支持动态求值，插件路径必须在生成时写死为本机的绝对路径
const compiled = compileAll(
  path.join(repoRoot, 'presets'),
  path.join(dshHome, '.agent-presets'),
  {
    mechanics: path.join(repoRoot, 'packages/mechanics/src/index.ts'),
    progress: path.join(repoRoot, 'packages/progress/src/index.ts'),
  },
)
const live = compiled.filter(c => !c.removed)
const removed = compiled.filter(c => c.removed)
console.log(`[bff] 已编译剧本 ${live.length} 个：${live.map(c => c.id).join(', ') || '（无）'}`)
if (removed.length) console.log(`[bff] 已回收源已删除的剧本：${removed.map(c => c.id).join(', ')}`)

// 被动结构观测：逐回合纯函数检查，只写 observer.jsonl，不干预（护栏 4/6）
startObserver(dshHome)
const app = express()
app.use(express.json({ limit: '1mb' }))

const asyncRoute
  = (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next)
    }

// ---- 设置：模型凭据 ----
// 走 dsh 的 credentials 服务（写入 DSH_HOME/.credentials.yaml，随数据卷持久化且热生效）。
// 环境变量是只读层：一旦 .env 里给了非空值，它会遮蔽此处的写入，届时 writable 为 false。

const API_KEY_REF = 'DEEPSEEK_API_KEY'

interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

app.get('/app/settings/credentials', asyncRoute(async (_req, res) => {
  const { credentials } = await rpc<{ credentials: Record<string, CredentialView> }>(
    'credentials.describe',
    { refs: [API_KEY_REF] },
  )
  res.json(credentials[API_KEY_REF] ?? { configured: false, writable: true })
}))

app.put('/app/settings/credentials', asyncRoute(async (req, res) => {
  const { value } = (req.body ?? {}) as { value?: string }
  const key = value?.trim()
  if (!key) {
    res.status(400).json({ error: { code: 'empty-key', message: 'API Key 不能为空' } })
    return
  }
  await rpc('credentials.set', { ref: API_KEY_REF, value: key })
  res.json({ ok: true })
}))

app.delete('/app/settings/credentials', asyncRoute(async (_req, res) => {
  await rpc('credentials.unset', { ref: API_KEY_REF })
  res.json({ ok: true })
}))

// ---- 设置：模型 ----
// dsh 的 session.selectModel 会顺带把选择写成部署默认。游戏内切换只应影响当前存档，
// 所以这里在切换后把 agent-default-model 的用户层还原回全局默认（该命名空间热生效）。

const MODEL_NS = 'agent-default-model'

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface SettingsNamespaceView {
  ns: string
  value: unknown
  revision: number
}

async function readGlobalModel(): Promise<ModelSelection> {
  const { namespaces } = await rpc<{ namespaces: SettingsNamespaceView[] }>('settings.describe', {})
  const ns = namespaces.find(n => n.ns === MODEL_NS)
  return (ns?.value ?? {}) as ModelSelection
}

async function writeGlobalModel(selection: ModelSelection): Promise<void> {
  await rpc('settings.update', { ns: MODEL_NS, patch: selection })
}

app.get('/app/settings/model', asyncRoute(async (_req, res) => {
  res.json(await readGlobalModel())
}))

app.put('/app/settings/model', asyncRoute(async (req, res) => {
  const selection = (req.body ?? {}) as ModelSelection
  if (!selection.provider || !selection.model) {
    res.status(400).json({ error: { code: 'bad-request', message: '缺少 provider 或 model' } })
    return
  }
  await writeGlobalModel(selection)
  res.json(await readGlobalModel())
}))

/** 某会话可用的模型目录与当前选择。 */
app.get('/app/sessions/:id/model', asyncRoute(async (req, res) => {
  res.json(await rpc('session.models', { sessionId: req.params.id }))
}))

/** 切换当前存档的模型；随后还原全局默认，避免影响以后新开的游戏。 */
app.put('/app/sessions/:id/model', asyncRoute(async (req, res) => {
  const selection = (req.body ?? {}) as ModelSelection
  if (!selection.provider || !selection.model) {
    res.status(400).json({ error: { code: 'bad-request', message: '缺少 provider 或 model' } })
    return
  }
  const globalBefore = await readGlobalModel()
  const result = await rpc('session.selectModel', { sessionId: req.params.id, ...selection })
  if (globalBefore.provider && globalBefore.model) {
    await writeGlobalModel(globalBefore).catch((err) => {
      console.warn('[bff] 还原全局默认模型失败:', err)
    })
  }
  res.json(result)
}))

// ---- 会话管理 ----

app.get('/app/health', asyncRoute(async (_req, res) => {
  try {
    await rpc('session.list', {})
    res.json({ ok: true, dsh: true })
  } catch {
    res.json({ ok: true, dsh: false })
  }
}))

/** 剧本列表：dsh preset 目录中 story- 前缀的即为剧本。 */
app.get('/app/scenarios', asyncRoute(async (_req, res) => {
  const { presets } = await rpc<{ presets: { id: string; name: string; description?: string }[] }>(
    'agentPreset.list',
    {},
  )
  res.json({ items: presets.filter(p => p.id.startsWith('story-')) })
}))

/**
 * 单个剧本的玩家可见信息。隐藏真相与人物暗线只属于 GM 提示词，
 * 这里必须剥掉——发给前端等于直接剧透。
 */
app.get('/app/scenarios/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id)
  // 只接受编译器生成的剧本 id 形态，杜绝路径穿越
  if (!/^story-[a-z0-9][a-z0-9-]*$/.test(id)) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  const storyPath = path.join(dshHome, '.agent-presets', id, 'story.json')
  if (!existsSync(storyPath)) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  const story = JSON.parse(readFileSync(storyPath, 'utf8')) as {
    world: { hidden_truths?: unknown }
    cast?: { id: string; name: string; identity: string; secret?: string }[]
    [key: string]: unknown
  }
  const { hidden_truths: _dropped, ...world } = story.world
  res.json({
    ...story,
    world,
    cast: (story.cast ?? []).map(({ secret: _secret, ...visible }) => visible),
  })
}))

/**
 * 单存档模式：整个平台同时只保留一个存档。
 * 开新局即取代旧局；存档管理（多存档、分支）等项目成型后再谈。
 */
interface SessionSummaryLite {
  sessionId: string
  updatedAt: number
  blank: boolean
}

/** 物理删除除 keepId 外的全部会话日志。dsh 没有删除 RPC，只能动文件。 */
function pruneSessions(keepId?: string): number {
  const root = path.join(dshHome, 'sessions')
  if (!existsSync(root)) return 0
  let removed = 0
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketDir = path.join(root, bucket.name)
    for (const entry of readdirSync(bucketDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keepId) continue
      rmSync(path.join(bucketDir, entry.name), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

app.get('/app/sessions', asyncRoute(async (_req, res) => {
  const { items } = await rpc<{ items: SessionSummaryLite[] }>('session.list', {})
  // 只认最近一个真正玩过的存档，其余一律不暴露
  const live = items
    .filter(s => !s.blank)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 1)
  res.json({ items: live })
}))

app.post('/app/sessions', asyncRoute(async (req, res) => {
  const { agentPreset } = (req.body ?? {}) as { agentPreset?: string }
  const created = await rpc<{ sessionId: string }>('session.create', agentPreset ? { agentPreset } : {})
  // 单存档：新局一旦建立，旧局连同调试残留一并清除
  const removed = pruneSessions(created.sessionId)
  if (removed > 0) console.log(`[bff] 开新局，清除旧存档 ${removed} 个`)
  res.json(created)
}))

app.get('/app/sessions/:id/history', asyncRoute(async (req, res) => {
  const payload: Record<string, unknown> = { sessionId: req.params.id }
  if (req.query.beforeSeq) payload.beforeSeq = Number(req.query.beforeSeq)
  if (req.query.maxMessages) payload.maxMessages = Number(req.query.maxMessages)
  res.json(await rpc('session.history', payload))
}))

app.post('/app/sessions/:id/prompt', asyncRoute(async (req, res) => {
  const { text, mode } = (req.body ?? {}) as { text?: string; mode?: 'queue' | 'steer' }
  if (!text?.trim()) {
    res.status(400).json({ error: { code: 'empty-prompt', message: '内容不能为空' } })
    return
  }
  res.json(await rpc('session.prompt', {
    sessionId: req.params.id,
    mode: mode ?? 'queue',
    content: [{ type: 'text', text }],
  }))
}))

app.post('/app/sessions/:id/cancel', asyncRoute(async (req, res) => {
  res.json(await rpc('session.cancel', { sessionId: req.params.id }))
}))

// 分支存档在单存档模式下关闭；dsh 侧的 fork 能力仍在，等存档管理成型再开放
app.post('/app/sessions/:id/fork', (_req, res) => {
  res.status(409).json({
    error: { code: 'single-save-mode', message: '当前为单存档模式，分支功能暂未开放' },
  })
})

/**
 * 重写上一回合：fork 到上一个回合边界、弃旧线、原样重发玩家输入。
 * session.fork 的 atSeq 语义：切点是 atSeq 起的第一个 turn/end——传上上个
 * turn/end 的 seq 正好把最后一回合裁掉。只有开场一回合时退化为重开新局。
 */
interface HistoryEventLite {
  event: { type: string; seq: number; data: { content?: unknown; reason?: unknown } }
}

const textOfBlocks = (blocks: unknown): string =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null
      && (b as { type?: unknown }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('')

app.post('/app/sessions/:id/retry', asyncRoute(async (req, res) => {
  const sessionId = req.params.id
  const { events } = await rpc<{ events: HistoryEventLite[] }>('session.history', { sessionId })
  const flat = events.map(e => e.event)
  const lastStart = flat.findLastIndex(e => e.type === 'turn/start')
  if (lastStart < 0) {
    res.status(400).json({ error: { code: 'no-turn', message: '还没有可重写的回合' } })
    return
  }
  const lastUserText = textOfBlocks(flat.slice(lastStart).find(e => e.type === 'user/message')?.data.content)
  const turnEnds = flat.filter(e => e.type === 'turn/end')

  if (turnEnds.length >= 2 && lastUserText) {
    const anchor = turnEnds[turnEnds.length - 2].seq
    const { sessionId: child } = await rpc<{ sessionId: string }>('session.fork', { sessionId, atSeq: anchor })
    const removed = pruneSessions(child)
    console.log(`[bff] 重写回合：fork@${anchor} → ${child}，清除旧线 ${removed} 个`)
    await rpc('session.prompt', { sessionId: child, mode: 'queue', content: [{ type: 'text', text: lastUserText }] })
    res.json({ sessionId: child })
    return
  }

  // 只有开场一回合（或取不到输入）：重开同一剧本的新局，开场消息由前端照常补发
  const { items } = await rpc<{ items: { sessionId: string; agentPreset?: string }[] }>('session.list', {})
  const preset = items.find(s => s.sessionId === sessionId)?.agentPreset
  const created = await rpc<{ sessionId: string }>('session.create', preset ? { agentPreset: preset } : {})
  pruneSessions(created.sessionId)
  console.log(`[bff] 重写开场：重开新局 ${created.sessionId}`)
  res.json({ sessionId: created.sessionId })
}))

// ---- mux → SSE 桥 ----

app.get('/app/sessions/:id/events', (req, res) => {
  const sessionId = req.params.id
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  res.write(': connected\n\n')

  const unsubscribe = onMuxFrame((frame) => {
    if (frame.sessionId !== sessionId) return
    res.write(`data: ${JSON.stringify(frame)}\n\n`)
  })
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})

// ---- SPA 静态托管（生产模式；开发时由 Vite dev server 提供） ----

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
if (existsSync(webDist)) {
  app.use(express.static(webDist))
  app.get(/^\/(?!app\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'))
  })
}

// ---- 错误映射 ----

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof DshRpcError) {
    const status = err.code === 'dsh-unreachable' ? 502 : err.code === 'bad-request' ? 400 : 500
    res.status(status).json({ error: { code: err.code, message: err.message, details: err.details } })
    return
  }
  console.error('[bff] 未处理错误:', err)
  res.status(500).json({ error: { code: 'internal', message: String(err) } })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bff] listening on http://0.0.0.0:${PORT}`)
})
