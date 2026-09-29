/**
 * TaleForge 平台服务：托管 SPA、剧本库、会话与存档、回合入口、SSE 推流。
 * 单进程——v2 起内核（packages/engine）就在本进程里，不再转发 dsh 网关。
 *
 * 路由都在 /app/* 下；SSE 沿用 `{type, seq, time, data}` 的事件信封。多局冒险并存，每局可存多个存档水晶。
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  Engine,
  EngineError,
  foldSession,
  phaseOf,
  publicEvent,
  sessionView,
  type Frame,
} from '@taleforge/engine'
import { applyRevisionsToStory, isStoryId, scanCatalog, type CatalogEntry, type RevisionLike, type Story } from '@taleforge/scenario-compiler'
import type { SessionStore } from '@taleforge/store'
import { listVersions, publishStory, storyDirOf, versionsDirOf, type Config as WorkshopConfig } from '@taleforge/workshop'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { EFFORTS, MODELS, type PlatformConfig } from './config.ts'

export interface AppDeps {
  engine: Engine
  store: SessionStore
  config: PlatformConfig
  /** 剧本源根：仓库种子在前、数据卷在后 */
  roots: string[]
  scenariosRoot: string
  /** 修改对话的映射文件（剧本 id → 会话 id） */
  editMapPath: string
  repoRoot: string
  webDistDir?: string
}

const notFound = (res: Response, message: string) => res.status(404).json({ error: { code: 'not-found', message } })

/** 剧本的玩家可见部分：隐藏真相、人物暗线、设定条目只属于 GM。 */
function publicStory(story: Story): Record<string, unknown> {
  const { hidden_truths: _h, ...world } = story.world
  const { lore: _l, ...rest } = story
  return { ...rest, world, cast: story.cast.map(({ secret: _s, ...visible }) => visible) }
}

const asyncRoute
  = (handler: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(handler(req, res)).catch(next)
    }

export function createApp(deps: AppDeps): express.Express {
  const { engine, store, config } = deps
  const workshop: WorkshopConfig = { scenariosRoot: deps.scenariosRoot, roots: deps.roots }
  const catalog = (): CatalogEntry[] => scanCatalog(deps.roots)
  const storyById = (id: string): Story | undefined => catalog().find(e => e.id === id)?.story

  const app = express()
  app.use(express.json({ limit: '2mb' }))

  // ---- 设置：凭据与模型 ----

  app.get('/app/settings/credentials', (_req, res) => {
    res.json(config.credentialStatus())
  })

  app.put('/app/settings/credentials', (req, res) => {
    const key = String((req.body as { value?: string } | undefined)?.value ?? '').trim()
    if (!key) {
      res.status(400).json({ error: { code: 'empty-key', message: 'API Key 不能为空' } })
      return
    }
    if (!config.credentialStatus().writable) {
      res.status(409).json({ error: { code: 'env-shadowed', message: 'API Key 由启动环境变量提供，界面改不动' } })
      return
    }
    config.saveApiKey(key)
    res.json({ ok: true })
  })

  app.delete('/app/settings/credentials', (_req, res) => {
    config.clearApiKey()
    res.json({ ok: true })
  })

  const catalogView = () => ({
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: MODELS.map(m => ({ ...m, reasoning: { efforts: EFFORTS, defaultEffort: 'high' } })),
    }],
  })
  const selection = (model: string, effort: string) => ({ provider: 'deepseek', model, reasoningEffort: effort })

  app.get('/app/settings/model', (_req, res) => {
    const s = config.settings()
    res.json(selection(s.model, s.effort))
  })

  app.put('/app/settings/model', (req, res) => {
    const body = (req.body ?? {}) as { model?: string; reasoningEffort?: string }
    try {
      const s = config.saveSettings({
        ...body.model ? { model: body.model } : {},
        ...body.reasoningEffort ? { effort: body.reasoningEffort as never } : {},
      })
      res.json(selection(s.model, s.effort))
    } catch (err) {
      res.status(400).json({ error: { code: 'bad-request', message: String(err instanceof Error ? err.message : err) } })
    }
  })

  /** 模型目录：平台只兼容 DeepSeek（flash / pro），推理强度四档（off 即关思考）。 */
  app.get('/app/settings/models', (_req, res) => {
    res.json(catalogView())
  })

  app.get('/app/sessions/:id/model', asyncRoute((req, res) => {
    const view = engine.view(String(req.params.id))
    res.json({ current: selection(view.model.model, view.model.effort), routable: true, ...catalogView() })
  }))

  /** 只改这一局：写一条 model/selected 事件，不动全局默认。 */
  app.put('/app/sessions/:id/model', asyncRoute((req, res) => {
    const body = (req.body ?? {}) as { model?: string; reasoningEffort?: string }
    if (!MODELS.some(m => m.id === body.model) || !EFFORTS.some(e => e.id === body.reasoningEffort)) {
      res.status(400).json({ error: { code: 'bad-request', message: '不支持的模型或推理强度' } })
      return
    }
    engine.selectModel(String(req.params.id), { model: body.model!, effort: body.reasoningEffort as never })
    res.json({ selected: selection(body.model!, body.reasoningEffort!) })
  }))

  // ---- 平台状态 ----

  /**
   * 前端构建标识：dist/index.html 引用的 bundle 文件名（带内容 hash）。页面开着不动就一直跑
   * 加载时那份 JS，部署新版后界面操作都不会重新取 JS——挂进 health，前端比对到变化就提示刷新。
   */
  const buildId = (() => {
    try {
      const html = readFileSync(path.join(deps.webDistDir ?? '', 'index.html'), 'utf8')
      return /assets\/([\w.-]+\.js)/.exec(html)?.[1] ?? 'dev'
    } catch {
      return 'dev'
    }
  })()

  app.get('/app/health', (_req, res) => {
    res.json({ ok: true, engine: true, llm: config.credentialStatus().configured, build: buildId })
  })

  // ---- 剧本库 ----

  app.get('/app/scenarios', (_req, res) => {
    res.json({
      items: catalog().flatMap(e => (e.story ? [{ id: e.id, name: e.story.title, description: e.story.tagline }] : [])),
    })
  })

  /** 创作说明书（兼平台能力契约）。写外发包、给外部 AI、自己手写剧本都用它。 */
  app.get('/app/authoring-guide', (_req, res) => {
    res.setHeader('content-type', 'text/markdown; charset=utf-8')
    res.setHeader('content-disposition', 'attachment; filename="AUTHORING.md"')
    res.send(readFileSync(path.join(deps.repoRoot, 'AUTHORING.md'), 'utf8'))
  })

  /** 导出剧本源（完整版，含 hidden_truths 与 cast[].secret——作者视角的文件）。导出的就是现行正式版。 */
  app.get('/app/scenarios/:id/export', (req, res) => {
    const entry = catalog().find(e => e.id === String(req.params.id))
    const file = entry ? path.join(entry.dir, 'story.json') : ''
    if (!entry || !existsSync(file)) {
      notFound(res, '剧本不存在')
      return
    }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${entry.id}.story.json"`)
    res.send(readFileSync(file, 'utf8'))
  })

  /** 导入剧本：校验（错误逐条返回）→ 写数据卷 → 立即上架。手动导入不走缩水防线，旧版照常留档。 */
  app.post('/app/scenarios/import', (req, res) => {
    const result = publishStory(workshop, req.body, { force: true })
    res.status(result.ok ? 200 : 400).json(result)
  })

  app.get('/app/scenarios/:id/versions', (req, res) => {
    res.json({ versions: listVersions(workshop, String(req.params.id)) })
  })

  app.post('/app/scenarios/:id/versions/:name/restore', (req, res) => {
    const id = String(req.params.id)
    const name = String(req.params.name)
    if (!isStoryId(id) || !/^v-\d+\.json$/.test(name)) {
      notFound(res, '没有这个历史版本')
      return
    }
    const file = path.join(versionsDirOf(workshop, id), name)
    if (!existsSync(file)) {
      notFound(res, '没有这个历史版本')
      return
    }
    let story: unknown
    try {
      story = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      res.status(500).json({ error: { code: 'corrupt-version', message: '历史版本文件损坏，无法回滚' } })
      return
    }
    // 回滚也是一次覆盖发布：当前版先自动留档，所以回滚本身也可再回滚
    const result = publishStory(workshop, story, { force: true })
    res.status(result.ok ? 200 : 400).json(result)
  })

  /** 剧本的玩家可见信息：隐藏真相、人物暗线与设定条目只属于 GM，下发前端等于剧透。 */
  app.get('/app/scenarios/:id', (req, res) => {
    const story = storyById(String(req.params.id))
    if (!story) {
      notFound(res, '剧本不存在')
      return
    }
    res.json(publicStory(story))
  })

  // ---- 冒险（游戏会话）：多局并存，每局可存多个存档水晶 ----

  interface Listed { id: string; updatedAt: number; kind: string; storyId?: string; title: string; scenarioId?: string }
  const listed = (): Listed[] => store.list().map(s => ({
    id: s.id,
    updatedAt: s.updatedAt,
    kind: String(s.created.kind ?? ''),
    title: String(s.created.title ?? ''),
    ...typeof s.created.storyId === 'string' ? { storyId: s.created.storyId } : {},
    ...typeof s.created.scenarioId === 'string' ? { scenarioId: s.created.scenarioId } : {},
  }))

  const readEditMap = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(deps.editMapPath, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  const writeEditMap = (map: Record<string, string>) => writeFileSync(deps.editMapPath, JSON.stringify(map))

  /**
   * 存档列表要的每局概况（回合、终局态、当前幕）得折叠整份日志才知道。按文件 mtime 缓存：
   * 没动过的局不重算，存档页不会因为局多而变慢。
   */
  interface GameSummary { turns: number; phase: string; actTitle?: string; tagline?: string }
  const summaries = new Map<string, { mtime: number; value: GameSummary }>()
  const summaryOf = (s: Listed): GameSummary => {
    const hit = summaries.get(s.id)
    if (hit && hit.mtime === s.updatedAt) return hit.value
    const state = foldSession(store.read(s.id))
    const view = sessionView(state)
    const value: GameSummary = {
      turns: state.chapters[state.chapters.length - 1]?.turn ?? 0,
      phase: phaseOf(state),
      ...view.progress?.acts[view.progress.actIndex] ? { actTitle: view.progress.acts[view.progress.actIndex].title } : {},
      ...state.created.story ? { tagline: state.created.story.tagline } : {},
    }
    summaries.set(s.id, { mtime: s.updatedAt, value })
    return value
  }

  const gameItem = (s: Listed) => ({
    sessionId: s.id,
    title: s.title,
    storyId: s.storyId,
    updatedAt: s.updatedAt,
    running: engine.isRunning(s.id),
    ...summaryOf(s),
  })

  const gameOr404 = (res: Response, id: string): Listed | undefined => {
    const s = listed().find(x => x.id === id && x.kind === 'game')
    if (!s) notFound(res, '这局冒险不存在')
    return s
  }

  /** 全部冒险，最近玩过的在前。 */
  app.get('/app/games', (_req, res) => {
    res.json({ items: listed().filter(s => s.kind === 'game').map(gameItem) })
  })

  /** 兼容旧接口：只给最近一局。 */
  app.get('/app/sessions', (_req, res) => {
    const game = listed().find(s => s.kind === 'game')
    res.json({
      items: game
        ? [{ sessionId: game.id, updatedAt: game.updatedAt, running: engine.isRunning(game.id), blank: false, agentPreset: game.storyId, projections: { asOfSeq: 0, values: { title: game.title } } }]
        : [],
    })
  })

  /** 开一局新冒险。多局并存：不影响其他进行中的冒险。 */
  app.post('/app/sessions', (req, res) => {
    const id = String((req.body as { agentPreset?: string } | undefined)?.agentPreset ?? '')
    const story = storyById(id)
    if (!story) {
      notFound(res, '剧本不存在')
      return
    }
    res.json({ sessionId: engine.createGame(story), agentPreset: id })
  })

  /** 这局冒险开局时锁定的剧本（玩家可见部分）：界面显示人物、世界都以它为准，不跟着剧本源变。 */
  app.get('/app/sessions/:id/story', asyncRoute((req, res) => {
    const story = engine.state(String(req.params.id)).created.story
    if (!story) {
      notFound(res, '这不是游戏会话')
      return
    }
    res.json(publicStory(story))
  }))

  /**
   * 删除一局：日志挪进 archive/（只归档不删——整局正文是对照"改动前后写得怎样"的语料），
   * 这局的存档水晶一并删除。
   */
  app.delete('/app/sessions/:id', (req, res) => {
    const id = String(req.params.id)
    const s = listed().find(x => x.id === id)
    if (!s) {
      notFound(res, '会话不存在')
      return
    }
    if (s.kind !== 'game') {
      res.status(400).json({ error: { code: 'not-a-save', message: '工坊会话不是游戏会话' } })
      return
    }
    engine.cancel(id)
    store.archive(id)
    for (const b of store.backupsOf(id)) store.removeBackup(b.name)
    summaries.delete(id)
    console.log(`[bff] 已删除冒险 ${id}（日志归档，存档水晶一并删除）`)
    res.json({ ok: true })
  })

  // ---- 存档水晶：某一局在某个时刻的整份日志；读档 = 这一局原地恢复到那一刻 ----

  const saveView = (b: ReturnType<typeof store.listBackups>[number]) => ({
    name: b.name,
    label: b.label ?? b.title ?? '未命名存档',
    ...b.note ? { note: b.note } : {},
    backedAt: b.backedAt,
    turns: b.turns ?? 0,
  })

  app.get('/app/sessions/:id/saves', (req, res) => {
    const id = String(req.params.id)
    if (!gameOr404(res, id)) return
    res.json({ items: store.backupsOf(id).map(saveView) })
  })

  app.post('/app/sessions/:id/saves', asyncRoute((req, res) => {
    const id = String(req.params.id)
    if (!gameOr404(res, id)) return
    if (engine.isRunning(id)) {
      res.status(409).json({ error: { code: 'busy', message: 'GM 还在写这一回合——写完再存档' } })
      return
    }
    const body = (req.body ?? {}) as { label?: string; note?: string }
    const state = engine.state(id)
    const turns = state.chapters[state.chapters.length - 1]?.turn ?? 0
    const label = String(body.label ?? '').trim() || `第 ${turns} 回合`
    const note = String(body.note ?? '').trim()
    const meta = store.backup(id, {
      title: state.created.title,
      ...state.created.storyId ? { storyId: state.created.storyId } : {},
      turns,
      label,
      ...note ? { note } : {},
    })
    console.log(`[bff] 已存档 ${id} → ${meta.name}（${label}）`)
    res.json(saveView(meta))
  }))

  app.post('/app/sessions/:id/saves/:name/load', asyncRoute(async (req, res) => {
    const id = String(req.params.id)
    const name = String(req.params.name)
    if (!gameOr404(res, id)) return
    if (!store.backupsOf(id).some(b => b.name === name)) {
      notFound(res, '存档不存在')
      return
    }
    if (engine.isRunning(id)) {
      engine.cancel(id)
      await engine.idle(id)
    }
    store.restore(name)
    summaries.delete(id)
    engine.notifyReset(id)
    console.log(`[bff] 已读档 ${name} → ${id}`)
    res.json({ sessionId: id })
  }))

  app.delete('/app/sessions/:id/saves/:name', (req, res) => {
    const id = String(req.params.id)
    const name = String(req.params.name)
    if (!store.backupsOf(id).some(b => b.name === name)) {
      notFound(res, '存档不存在')
      return
    }
    store.removeBackup(name)
    res.json({ ok: true })
  })

  // ---- 删除剧本：源 + 修改对话一并移除；还有冒险用着它就拒绝 ----

  app.delete('/app/scenarios/:id', (req, res) => {
    const id = String(req.params.id)
    const entry = catalog().find(e => e.id === id)
    if (!entry) {
      notFound(res, '剧本不存在')
      return
    }
    if (path.resolve(path.dirname(entry.dir)) !== path.resolve(deps.scenariosRoot)) {
      res.status(400).json({ error: { code: 'seed', message: '这是仓库内置的种子剧本，不能在界面里删除' } })
      return
    }
    const games = listed().filter(s => s.kind === 'game' && s.storyId === id)
    if (games.length) {
      res.status(409).json({ error: { code: 'in-use', message: `这部剧本还有 ${games.length} 局冒险——先在「读取存档」里删掉它们` } })
      return
    }
    rmSync(entry.dir, { recursive: true, force: true })
    const map = readEditMap()
    if (map[id]) {
      if (store.exists(map[id])) store.remove(map[id])
      delete map[id]
      writeEditMap(map)
    }
    console.log(`[bff] 已删除剧本 ${id}（含其修改对话）`)
    res.json({ ok: true })
  })

  // ---- 工坊与修改对话 ----

  const latestWorkshop = () => listed().find(s => s.kind === 'workshop')

  app.post('/app/workshop', (_req, res) => {
    res.json({ sessionId: latestWorkshop()?.id ?? engine.createAgent('workshop') })
  })

  /** 重开工坊：旧访谈归档，游戏会话与各剧本的修改对话不受影响。 */
  app.post('/app/workshop/reset', (_req, res) => {
    const sessionId = engine.createAgent('workshop')
    for (const s of listed()) {
      if (s.kind === 'workshop' && s.id !== sessionId) {
        engine.cancel(s.id)
        store.archive(s.id)
      }
    }
    res.json({ sessionId })
  })

  app.post('/app/scenarios/:id/edit-session', (req, res) => {
    const id = String(req.params.id)
    if (!storyById(id)) {
      notFound(res, '剧本不存在')
      return
    }
    const existing = readEditMap()[id]
    if (existing && store.exists(existing)) {
      res.json({ sessionId: existing })
      return
    }
    const sessionId = engine.createAgent('edit', id)
    writeEditMap({ ...readEditMap(), [id]: sessionId })
    res.json({ sessionId })
  })

  app.post('/app/scenarios/:id/edit-session/reset', (req, res) => {
    const id = String(req.params.id)
    if (!isStoryId(id)) {
      notFound(res, '剧本不存在')
      return
    }
    const old = readEditMap()[id]
    const sessionId = engine.createAgent('edit', id)
    if (old && store.exists(old)) {
      engine.cancel(old)
      store.remove(old)
    }
    writeEditMap({ ...readEditMap(), [id]: sessionId })
    res.json({ sessionId })
  })

  /** 修订落盘：把这局的场外修订合并回剧本源，成为现行正式版（旧版自动留档），下一局生效。 */
  app.post('/app/sessions/:id/revisions/flush', asyncRoute((req, res) => {
    const state = engine.state(String(req.params.id))
    const revisions = state.progress.revisions as RevisionLike[]
    if (revisions.length === 0) {
      res.status(400).json({ error: { code: 'no-revisions', message: '本局没有可落盘的修订' } })
      return
    }
    const source = state.created.storyId ? storyById(state.created.storyId) : undefined
    if (!source) {
      res.status(400).json({ error: { code: 'not-a-story', message: '该会话不属于任何现存剧本' } })
      return
    }
    const { story: merged, applied, skipped } = applyRevisionsToStory(source, revisions)
    const result = publishStory(workshop, merged, { force: true })
    if (!result.ok) {
      res.status(500).json({ error: { code: 'publish-failed', message: result.brief } })
      return
    }
    console.log(`[bff] 修订落盘：${source.id} 合并 ${applied} 条（跳过 ${skipped.length}），写入 ${storyDirOf(workshop, source.id)}`)
    res.json({ applied, skipped: skipped.map(s => s.reason) })
  }))

  // ---- 回合 ----

  app.get('/app/sessions/:id/history', asyncRoute((req, res) => {
    const id = String(req.params.id)
    if (!store.exists(id)) {
      notFound(res, '会话不存在')
      return
    }
    const events = store.read(id)
    const state = foldSession(events)
    const inflight = engine.inflight(id)
    res.json({
      events: events.map(e => ({ event: publicEvent(e) })),
      hasMore: false,
      projections: { asOfSeq: events.at(-1)?.seq ?? 0, values: engine.view(id) },
      phase: state.created.kind === 'game' ? phaseOf(state) : undefined,
      ...inflight ? { inflight } : {},
    })
  }))

  app.post('/app/sessions/:id/prompt', asyncRoute((req, res) => {
    const { text } = (req.body ?? {}) as { text?: string }
    engine.prompt(String(req.params.id), String(text ?? ''))
    res.json({ accepted: true })
  }))

  app.post('/app/sessions/:id/cancel', (req, res) => {
    engine.cancel(String(req.params.id))
    res.json({ accepted: true })
  })

  // 分支不开放：存档水晶已经覆盖"留一个点、之后回来"的需要（"重写""回退"内部用截断实现，不算分支）
  app.post('/app/sessions/:id/fork', (_req, res) => {
    res.status(409).json({ error: { code: 'no-fork', message: '不开放分支：用营地的存档水晶留档，再读档回来' } })
  })

  /** 回退到第 toTurn 回合结束时（其后的回合截掉、原稿归档），不重跑，玩家重新选择。 */
  app.post('/app/sessions/:id/rewind', asyncRoute(async (req, res) => {
    const id = String(req.params.id)
    const toTurn = Number((req.body as { toTurn?: unknown } | undefined)?.toTurn)
    if (!Number.isInteger(toTurn) || toTurn < 0) {
      res.status(400).json({ error: { code: 'bad-request', message: 'toTurn 必须是非负整数' } })
      return
    }
    await engine.rewind(id, toTurn)
    res.json({ sessionId: id })
  }))

  /** 从头重开这一局：回退到第 0 回合，界面随后补发开场。存档水晶不受影响。 */
  app.post('/app/sessions/:id/restart', asyncRoute(async (req, res) => {
    const id = String(req.params.id)
    await engine.rewind(id, 0)
    res.json({ sessionId: id })
  }))

  /** 重写上一回合：截断日志到上一回合的玩家输入之前（原稿归档），原样重发。会话 id 不变。 */
  app.post('/app/sessions/:id/retry', asyncRoute(async (req, res) => {
    const id = String(req.params.id)
    await engine.retry(id)
    res.json({ sessionId: id })
  }))

  // ---- SSE ----

  app.get('/app/sessions/:id/events', (req, res) => {
    const id = String(req.params.id)
    if (!store.exists(id)) {
      notFound(res, '会话不存在')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    const unsubscribe = engine.subscribe(id, (frame: Frame) => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    })
    // 心跳用具名事件而不是 SSE 注释：注释到不了页面脚本，前端要靠它判断连接是否已经静默断流
    const heartbeat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  // ---- SPA 静态托管（生产模式；开发时由 Vite dev server 提供） ----

  if (deps.webDistDir && existsSync(deps.webDistDir)) {
    app.use(express.static(deps.webDistDir))
    app.get(/^\/(?!app\/).*/, (_req, res) => {
      res.sendFile(path.join(deps.webDistDir!, 'index.html'))
    })
  }

  // ---- 错误映射 ----

  const STATUS: Record<string, number> = { 'busy': 409, 'ended': 409, 'not-found': 404, 'bad-request': 400, 'no-turn': 400 }
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof EngineError) {
      res.status(STATUS[err.code] ?? 400).json({ error: { code: err.code, message: err.message } })
      return
    }
    console.error('[bff] 未处理错误：', err)
    res.status(500).json({ error: { code: 'internal', message: String(err) } })
  })

  return app
}

/** 旧版 dsh 的数据只读保留：给启动日志用，提示有多少旧局留在原地。 */
export function legacySessionCount(dataHome: string): number {
  const root = path.join(dataHome, 'sessions')
  if (!existsSync(root)) return 0
  let n = 0
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (bucket.isDirectory()) n += readdirSync(path.join(root, bucket.name)).length
  }
  return n
}
