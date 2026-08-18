/**
 * TaleForge 平台服务（BFF）：托管 SPA、受控转发 dsh /api、mux→SSE 桥。
 * dsh 网关无认证且只信任 loopback，本服务是唯一对外入口。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { DshRpcError, onMuxFrame, rpc } from './dsh.ts'

const PORT = Number(process.env.PORT ?? 8790)
const app = express()
app.use(express.json({ limit: '1mb' }))

const asyncRoute
  = (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next)
    }

// ---- 会话管理 ----

app.get('/app/health', asyncRoute(async (_req, res) => {
  try {
    await rpc('session.list', {})
    res.json({ ok: true, dsh: true })
  } catch {
    res.json({ ok: true, dsh: false })
  }
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
