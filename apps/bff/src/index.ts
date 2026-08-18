/**
 * TaleForge 平台服务（BFF）：托管 SPA、受控转发 dsh /api、mux→SSE 桥。
 * dsh 网关无认证且只信任 loopback，本服务是唯一对外入口。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileAll } from '@taleforge/scenario-compiler'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { DshRpcError, onMuxFrame, rpc } from './dsh.ts'

const PORT = Number(process.env.PORT ?? 31415)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dshHome = process.env.DSH_HOME ?? path.join(repoRoot, 'runtime/dsh-home')

// 启动时把 presets/ 下的剧本源编译进 dsh 的 preset 根（幂等；preset 发现无缓存，立即可用）
const compiled = compileAll(path.join(repoRoot, 'presets'), path.join(dshHome, '.agent-presets'))
const live = compiled.filter(c => !c.removed)
const removed = compiled.filter(c => c.removed)
console.log(`[bff] 已编译剧本 ${live.length} 个：${live.map(c => c.id).join(', ') || '（无）'}`)
if (removed.length) console.log(`[bff] 已回收源已删除的剧本：${removed.map(c => c.id).join(', ')}`)
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

app.get('/app/sessions', asyncRoute(async (_req, res) => {
  res.json(await rpc('session.list', {}))
}))

app.post('/app/sessions', asyncRoute(async (req, res) => {
  const { agentPreset } = (req.body ?? {}) as { agentPreset?: string }
  res.json(await rpc('session.create', agentPreset ? { agentPreset } : {}))
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

app.post('/app/sessions/:id/fork', asyncRoute(async (req, res) => {
  const { atSeq } = (req.body ?? {}) as { atSeq?: number }
  const payload: Record<string, unknown> = { sessionId: req.params.id }
  if (typeof atSeq === 'number') payload.atSeq = atSeq
  res.json(await rpc('session.fork', payload))
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
