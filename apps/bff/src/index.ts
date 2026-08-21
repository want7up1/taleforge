/**
 * TaleForge 平台服务（BFF）：托管 SPA、受控转发 dsh /api、mux→SSE 桥。
 * dsh 网关无认证且只信任 loopback，本服务是唯一对外入口。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyRevisionsToStory,
  compileAll,
  compileScenario,
  compileWorkshopPreset,
  storySchema,
  type RevisionLike,
} from '@taleforge/scenario-compiler'
import { listVersions, publishStory, versionsDirOf } from '@taleforge/workshop'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { DshRpcError, onMuxFrame, rpc } from './dsh.ts'
import { startObserver } from './observer.ts'

const PORT = Number(process.env.PORT ?? 31415)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dshHome = process.env.DSH_HOME ?? path.join(repoRoot, 'runtime/dsh-home')

// 启动时把剧本源编译进 dsh 的 preset 根（幂等；preset 发现无缓存，立即可用）
// 双源根：仓库 presets/ 是内置种子，数据卷 scenarios/ 是用户内容（工坊产出、修订落盘），后者同 id 覆盖
// preset 组合文件不支持动态求值，插件路径必须在生成时写死为本机的绝对路径
const presetsRoot = path.join(dshHome, '.agent-presets')
const scenariosRoot = path.join(dshHome, 'scenarios')
mkdirSync(scenariosRoot, { recursive: true })
const entries = {
  mechanics: path.join(repoRoot, 'packages/mechanics/src/index.ts'),
  progress: path.join(repoRoot, 'packages/progress/src/index.ts'),
}
const compiled = compileAll([path.join(repoRoot, 'presets'), scenariosRoot], presetsRoot, entries)
compileWorkshopPreset(presetsRoot, {
  workshopEntry: path.join(repoRoot, 'packages/workshop/src/index.ts'),
  scenariosRoot,
  entries,
})
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

// ---- 创作包：说明书下载、剧本导出与导入 ----

/** 创作说明书（兼平台能力契约）。写外发包、给外部 AI、自己手写剧本都用它。 */
app.get('/app/authoring-guide', (_req, res) => {
  res.setHeader('content-type', 'text/markdown; charset=utf-8')
  res.setHeader('content-disposition', 'attachment; filename="AUTHORING.md"')
  res.send(readFileSync(path.join(repoRoot, 'AUTHORING.md'), 'utf8'))
})

/**
 * 导出剧本源（完整版，含 hidden_truths 与 cast[].secret——这是作者视角的文件，
 * 剥密只针对游玩视角）。导出的就是现行正式版。
 */
app.get('/app/scenarios/:id/export', (req, res) => {
  const id = String(req.params.id)
  if (!/^story-[a-z0-9][a-z0-9-]*$/.test(id)) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  const storyPath = path.join(presetsRoot, id, 'story.json')
  if (!existsSync(storyPath)) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${id}.story.json"`)
  res.send(readFileSync(storyPath, 'utf8'))
})

/**
 * 导入剧本：校验（错误逐条返回）→ 写数据卷 → 立即编译上架。同 id 覆盖更新。
 * 手动导入是作者本人的深思熟虑，不走缩水防线（那道防线拦的是 GM 复述丢内容）；
 * 旧版留档照常发生。
 */
app.post('/app/scenarios/import', (req, res) => {
  const result = publishStory({ scenariosRoot, presetsRoot, entries }, req.body, { force: true })
  res.status(result.ok ? 200 : 400).json(result)
})

// ---- 剧本历史版本：覆盖发布自动留档（最近 10 版），可回滚 ----

app.get('/app/scenarios/:id/versions', (req, res) => {
  res.json({ versions: listVersions({ scenariosRoot, presetsRoot, entries }, String(req.params.id)) })
})

app.post('/app/scenarios/:id/versions/:name/restore', (req, res) => {
  const id = String(req.params.id)
  const name = String(req.params.name)
  const file = path.join(versionsDirOf({ scenariosRoot, presetsRoot, entries }, id), name)
  if (!/^v-\d+\.json$/.test(name) || !existsSync(file)) {
    res.status(404).json({ error: { code: 'not-found', message: '没有这个历史版本' } })
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
  const result = publishStory({ scenariosRoot, presetsRoot, entries }, story, { force: true })
  res.status(result.ok ? 200 : 400).json(result)
})

/**
 * 删除剧本：数据卷源 + 编译产出一并移除。仓库已无内置种子，全部剧本
 * 都在数据根，删除语义干净。有会话正玩着的剧本不许删（会话恢复依赖 preset）；
 * 该剧本的存档快照与修改对话级联清除，不留孤儿。
 */
app.delete('/app/scenarios/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id)
  if (!/^story-[a-z0-9][a-z0-9-]*$/.test(id)) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  const { items } = await rpc<{ items: SessionListItem[] }>('session.list', {})
  const inUse = items.some(s => !s.blank && s.agentPreset === id && locateSession(s.sessionId) !== undefined)
  if (inUse) {
    res.status(409).json({ error: { code: 'in-use', message: '这个剧本正在游玩中——先在剧本页删除进行中的会话（可先存档）' } })
    return
  }
  rmSync(path.join(scenariosRoot, id.replace(/^story-/, '')), { recursive: true, force: true })
  rmSync(path.join(presetsRoot, id), { recursive: true, force: true })
  // 级联：该剧本的存档快照
  for (const e of readdirSync(backupsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !BACKUP_NAME.test(e.name)) continue
    try {
      const meta = JSON.parse(readFileSync(path.join(backupsRoot, e.name, 'backup-meta.json'), 'utf8')) as BackupMeta
      if (meta.agentPreset === id) rmSync(path.join(backupsRoot, e.name), { recursive: true, force: true })
    } catch { /* 无 meta 的残目录不动它 */ }
  }
  // 级联：该剧本的修改对话
  const editMap = readEditMap()
  if (editMap[id]) {
    const found = locateSession(editMap[id])
    if (found) rmSync(found.dir, { recursive: true, force: true })
    presetCache.delete(editMap[id])
    const fresh = readEditMap()
    delete fresh[id]
    writeEditMap(fresh)
  }
  console.log(`[bff] 已删除剧本 ${id}（含其存档与修改对话）`)
  res.json({ ok: true })
}))

// ---- 会话与存档：删除 / 存档（快照）/ 读档 ----

const backupsRoot = path.join(dshHome, 'save-backups')
mkdirSync(backupsRoot, { recursive: true })

/** 在 sessions/<bucket>/<id> 结构里定位会话目录。 */
function locateSession(sessionId: string): { dir: string; bucket: string } | undefined {
  const root = path.join(dshHome, 'sessions')
  if (!existsSync(root)) return undefined
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const dir = path.join(root, bucket.name, sessionId)
    if (existsSync(dir)) return { dir, bucket: bucket.name }
  }
  return undefined
}

interface BackupMeta {
  sessionId: string
  bucket: string
  backedAt: number
  title?: string
  agentPreset?: string
  turns?: number
}

// ---- 剧本修改对话：详情页唤起 GM 改剧本，按剧本各自常驻一个会话（工坊 preset，带读写剧本源的工具） ----

const editMapPath = path.join(dshHome, 'edit-sessions.json')

function readEditMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(editMapPath, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function writeEditMap(map: Record<string, string>): void {
  writeFileSync(editMapPath, JSON.stringify(map))
}

/**
 * 修改对话是否还活着。session.create 返回和目录落盘之间有延迟，
 * 不能只按磁盘即时裁决：dsh 内存里仍是 blank 的会话同样视为活着。
 * 映射条目只在替换/删除时清理，这里只判活不动映射。
 */
async function editSessionAlive(sessionId: string): Promise<boolean> {
  if (locateSession(sessionId) !== undefined) return true
  const { items } = await rpc<{ items: SessionListItem[] }>('session.list', {})
  const found = items.find(s => s.sessionId === sessionId)
  return found !== undefined && found.blank
}

/** 单存档清理时除目标会话外必须保住的：常驻工坊 + 各剧本的修改对话（宁多保不误删）。 */
async function protectedSessions(): Promise<string[]> {
  const workshop = await latestWorkshopId().catch(() => undefined)
  return [...(workshop ? [workshop] : []), ...Object.values(readEditMap())]
}

app.delete('/app/sessions/:id', asyncRoute(async (req, res) => {
  const sessionId = String(req.params.id)
  if ((await presetOf(sessionId).catch(() => undefined)) === 'workshop') {
    res.status(400).json({ error: { code: 'not-a-save', message: '工坊会话不是游戏会话' } })
    return
  }
  const found = locateSession(sessionId)
  if (!found) {
    res.status(404).json({ error: { code: 'not-found', message: '会话不存在' } })
    return
  }
  rmSync(found.dir, { recursive: true, force: true })
  presetCache.delete(sessionId)
  console.log(`[bff] 已删除会话 ${sessionId}`)
  res.json({ ok: true })
}))

/** 存档：把会话整目录快照进数据卷 save-backups/，容器重建不丢。 */
app.post('/app/sessions/:id/backup', asyncRoute(async (req, res) => {
  const sessionId = String(req.params.id)
  const found = locateSession(sessionId)
  if (!found) {
    res.status(404).json({ error: { code: 'not-found', message: '会话不存在' } })
    return
  }
  const { items } = await rpc<{ items: (SessionListItem & { projections?: { values?: { title?: string; sessionStats?: { turns?: number } } } })[] }>('session.list', {})
  const summary = items.find(s => s.sessionId === sessionId)
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}__${sessionId}`
  const dest = path.join(backupsRoot, name)
  cpSync(found.dir, dest, { recursive: true })
  const meta: BackupMeta = {
    sessionId,
    bucket: found.bucket,
    backedAt: Date.now(),
    ...(summary?.projections?.values?.title ? { title: summary.projections.values.title } : {}),
    ...(summary?.agentPreset ? { agentPreset: summary.agentPreset } : {}),
    ...(summary?.projections?.values?.sessionStats?.turns !== undefined
      ? { turns: summary.projections.values.sessionStats.turns }
      : {}),
  }
  writeFileSync(path.join(dest, 'backup-meta.json'), JSON.stringify(meta))
  console.log(`[bff] 已备份存档 ${sessionId} → ${name}`)
  res.json({ name })
}))

const BACKUP_NAME = /^[0-9TZ\-]+__session-[a-z0-9-]+$/

app.get('/app/save-backups', (_req, res) => {
  const items = readdirSync(backupsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && BACKUP_NAME.test(e.name))
    .map((e) => {
      try {
        const meta = JSON.parse(readFileSync(path.join(backupsRoot, e.name, 'backup-meta.json'), 'utf8')) as BackupMeta
        return { name: e.name, ...meta }
      } catch {
        return { name: e.name, sessionId: e.name.split('__')[1] ?? '', bucket: '', backedAt: 0 }
      }
    })
    .sort((a, b) => b.backedAt - a.backedAt)
  res.json({ items })
})

/** 读档：快照拷回原位并成为当前唯一会话（单存档语义不变，工坊与修改对话保留）。 */
app.post('/app/save-backups/:name/restore', asyncRoute(async (req, res) => {
  const name = String(req.params.name)
  const src = path.join(backupsRoot, name)
  if (!BACKUP_NAME.test(name) || !existsSync(src)) {
    res.status(404).json({ error: { code: 'not-found', message: '存档不存在' } })
    return
  }
  const meta = JSON.parse(readFileSync(path.join(src, 'backup-meta.json'), 'utf8')) as BackupMeta
  const target = path.join(dshHome, 'sessions', meta.bucket, meta.sessionId)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(src, target, { recursive: true })
  rmSync(path.join(target, 'backup-meta.json'), { force: true })
  pruneSessions(new Set([meta.sessionId, ...(await protectedSessions())]))
  console.log(`[bff] 已读档 ${name} → ${meta.sessionId}`)
  res.json({ sessionId: meta.sessionId })
}))

app.delete('/app/save-backups/:name', (req, res) => {
  const name = String(req.params.name)
  if (!BACKUP_NAME.test(name)) {
    res.status(404).json({ error: { code: 'not-found', message: '存档不存在' } })
    return
  }
  rmSync(path.join(backupsRoot, name), { recursive: true, force: true })
  res.json({ ok: true })
})

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

/** 物理删除 keep 之外的全部会话日志。dsh 没有删除 RPC，只能动文件。 */
function pruneSessions(keep: Set<string>): number {
  const root = path.join(dshHome, 'sessions')
  if (!existsSync(root)) return 0
  let removed = 0
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketDir = path.join(root, bucket.name)
    for (const entry of readdirSync(bucketDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue
      rmSync(path.join(bucketDir, entry.name), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

interface SessionListItem {
  sessionId: string
  updatedAt: number
  blank: boolean
  agentPreset?: string
}

/** 常驻工坊会话（不含剧本修改对话，它们同样是 workshop preset 但按剧本记账）。 */
async function latestWorkshopId(): Promise<string | undefined> {
  const editIds = new Set(Object.values(readEditMap()))
  const { items } = await rpc<{ items: SessionListItem[] }>('session.list', {})
  return items
    .filter(s => s.agentPreset === 'workshop' && !editIds.has(s.sessionId) && locateSession(s.sessionId) !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId
}

app.get('/app/sessions', asyncRoute(async (_req, res) => {
  const { items } = await rpc<{ items: (SessionSummaryLite & { agentPreset?: string })[] }>('session.list', {})
  // 只认最近一个真正玩过的游戏存档；工坊会话不是存档，不在此暴露。
  // dsh 对已知会话有内存记忆，物理删除后 session.list 仍会返回——按磁盘目录实存过滤
  const live = items
    .filter(s => !s.blank && s.agentPreset !== 'workshop' && locateSession(s.sessionId) !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 1)
  res.json({ items: live })
}))

/**
 * 剧本会话开局即定名：dsh 的自动标题模型会把回合头注入块也读进摘要
 * （实测标题变成"（开始）回合流程与序幕设定"），而手动 rename 会
 * 明确取代自动生成（session-title 的 supersede 语义）。失败不阻塞开局。
 */
async function nameStorySession(sessionId: string, presetId?: string): Promise<void> {
  if (!presetId?.startsWith('story-')) return
  try {
    const story = JSON.parse(
      readFileSync(path.join(presetsRoot, presetId, 'story.json'), 'utf8'),
    ) as { title?: string }
    if (story.title) await rpc('session.rename', { sessionId, title: `《${story.title}》` })
  } catch (err) {
    console.log(`[bff] 开局定名失败（不影响游戏）：${String(err)}`)
  }
}

app.post('/app/sessions', asyncRoute(async (req, res) => {
  const { agentPreset } = (req.body ?? {}) as { agentPreset?: string }
  const shielded = await protectedSessions()
  const created = await rpc<{ sessionId: string }>('session.create', agentPreset ? { agentPreset } : {})
  await nameStorySession(created.sessionId, agentPreset)
  // 单存档：新局一旦建立，旧局连同调试残留一并清除；工坊与修改对话保留
  const keep = new Set([created.sessionId, ...shielded])
  const removed = pruneSessions(keep)
  if (removed > 0) console.log(`[bff] 开新局，清除旧存档 ${removed} 个`)
  res.json(created)
}))

// ---- 工坊：对话创作剧本 ----

/** 取当前工坊会话，没有就建一个。工坊常驻单会话，与游戏存档并存。 */
app.post('/app/workshop', asyncRoute(async (_req, res) => {
  const existing = await latestWorkshopId()
  if (existing) {
    res.json({ sessionId: existing })
    return
  }
  const created = await rpc<{ sessionId: string }>('session.create', { agentPreset: 'workshop' })
  res.json(created)
}))

/** 重开工坊（丢弃当前访谈进度），游戏会话与各剧本的修改对话不受影响。 */
app.post('/app/workshop/reset', asyncRoute(async (_req, res) => {
  const { items } = await rpc<{ items: SessionListItem[] }>('session.list', {})
  const game = items
    .filter(s => !s.blank && s.agentPreset !== 'workshop' && locateSession(s.sessionId) !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId
  const editIds = Object.values(readEditMap())
  const created = await rpc<{ sessionId: string }>('session.create', { agentPreset: 'workshop' })
  pruneSessions(new Set([created.sessionId, ...editIds, ...(game ? [game] : [])]))
  res.json(created)
}))

/** 取（或创建）某剧本的修改对话：详情页"修改剧本"唤起，锚定该剧本常驻。 */
app.post('/app/scenarios/:id/edit-session', asyncRoute(async (req, res) => {
  const id = String(req.params.id)
  if (!/^story-[a-z0-9][a-z0-9-]*$/.test(id) || !existsSync(path.join(presetsRoot, id, 'story.json'))) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  const existing = readEditMap()[id]
  if (existing && await editSessionAlive(existing)) {
    res.json({ sessionId: existing })
    return
  }
  const created = await rpc<{ sessionId: string }>('session.create', { agentPreset: 'workshop' })
  writeEditMap({ ...readEditMap(), [id]: created.sessionId })
  res.json(created)
}))

/** 重开某剧本的修改对话（丢弃对话进度，已发布的修改不受影响）。 */
app.post('/app/scenarios/:id/edit-session/reset', asyncRoute(async (req, res) => {
  const id = String(req.params.id)
  if (!/^story-[a-z0-9][a-z0-9-]*$/.test(id)) {
    res.status(404).json({ error: { code: 'not-found', message: '剧本不存在' } })
    return
  }
  const old = readEditMap()[id]
  const created = await rpc<{ sessionId: string }>('session.create', { agentPreset: 'workshop' })
  if (old) {
    const found = locateSession(old)
    if (found) rmSync(found.dir, { recursive: true, force: true })
    presetCache.delete(old)
  }
  writeEditMap({ ...readEditMap(), [id]: created.sessionId })
  res.json(created)
}))

/**
 * 修订落盘：把这局积累的场外修订合并回剧本源（写进数据卷 scenarios/，
 * 成为现行正式版），并立即重编译。只对未来的新局生效，本局不受影响。
 */
app.post('/app/sessions/:id/revisions/flush', asyncRoute(async (req, res) => {
  const sessionId = req.params.id
  const history = await rpc<{ projections?: { values: { progress?: { revisions?: RevisionLike[] } | null } } }>(
    'session.history',
    { sessionId, maxMessages: 1 },
  )
  const revisions = history.projections?.values.progress?.revisions ?? []
  if (revisions.length === 0) {
    res.status(400).json({ error: { code: 'no-revisions', message: '本局没有可落盘的修订' } })
    return
  }
  const { items } = await rpc<{ items: SessionListItem[] }>('session.list', {})
  const presetId = items.find(s => s.sessionId === sessionId)?.agentPreset
  if (!presetId || !/^story-[a-z0-9][a-z0-9-]*$/.test(presetId)) {
    res.status(400).json({ error: { code: 'not-a-story', message: '该会话不属于任何剧本' } })
    return
  }
  // 现行正式版快照就在编译产出的 preset 里
  const source = storySchema.parse(
    JSON.parse(readFileSync(path.join(presetsRoot, presetId, 'story.json'), 'utf8')),
  )
  const { story: merged, applied, skipped } = applyRevisionsToStory(source, revisions)
  const outDir = path.join(scenariosRoot, presetId.replace(/^story-/, ''))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'story.json'), JSON.stringify(merged, null, 2))
  compileScenario(outDir, presetsRoot, entries)
  console.log(`[bff] 修订落盘：${presetId} 合并 ${applied} 条（跳过 ${skipped.length}）`)
  res.json({ applied, skipped: skipped.map(s => s.reason) })
}))

/** 前端消费的事件白名单：消息、回合边界、工具 meta。 */
const HISTORY_KEEP = new Set(['user/message', 'turn/start', 'turn/end'])

app.get('/app/sessions/:id/history', asyncRoute(async (req, res) => {
  const payload: Record<string, unknown> = { sessionId: req.params.id }
  if (req.query.beforeSeq) payload.beforeSeq = Number(req.query.beforeSeq)
  if (req.query.maxMessages) payload.maxMessages = Number(req.query.maxMessages)
  const result = await rpc<{
    events: { event: { type: string; seq: number; time: number; data: Record<string, unknown> } }[]
    [key: string]: unknown
  }>('session.history', payload)
  // 原始日志 95% 是流式分片与请求快照（每回合都带整份 persona），整包下发在移动端
  // 会直接拉挂（实测 failed to fetch 的根因）。只保留前端真正消费的部分：
  const events = result.events.flatMap(({ event }) => {
    if (HISTORY_KEEP.has(event.type)) return [{ event }]
    if (event.type === 'assistant/message') {
      // 剥掉 reasoning 块，只留玩家可见正文
      const message = event.data.message as { content?: { type?: string }[] } | undefined
      const content = (message?.content ?? []).filter(b => b?.type === 'text')
      return [{ event: { ...event, data: { message: { content } } } }]
    }
    if (event.type === 'tool/result' && event.data?.meta) {
      return [{ event: { type: event.type, seq: event.seq, time: event.time, data: { meta: event.data.meta } } }]
    }
    return []
  })
  // 未收尾的回合：把已产出的可见分片拼成 partial 一并下发——玩家中途离开再回来，
  // 从断点接上继续流，不必等整回合完成
  let inflight: { partial: string; lastChunkSeq: number; startedAt: number } | undefined
  const lastStart = result.events.findLastIndex(e => e.event.type === 'turn/start')
  if (lastStart >= 0 && !result.events.slice(lastStart).some(e => e.event.type === 'turn/end')) {
    let partial = ''
    let lastChunkSeq = -1
    for (const { event } of result.events.slice(lastStart)) {
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk as { type?: string; text?: string } | undefined
        if (chunk?.type === 'text-delta' && chunk.text) {
          partial += chunk.text
          lastChunkSeq = event.seq
        }
      }
      // 回合中途已定稿的消息会进正文流，与实时行为一致：清掉已被它吸收的分片
      if (event.type === 'assistant/message') {
        const message = event.data.message as { content?: { type?: string; text?: string }[] } | undefined
        if ((message?.content ?? []).some(b => b?.type === 'text' && b.text)) partial = ''
      }
    }
    inflight = { partial, lastChunkSeq, startedAt: result.events[lastStart].event.time }
  }

  res.json({ ...result, events, ...(inflight ? { inflight } : {}) })
}))

/**
 * 回合头机械注入：所有贴身提醒原本都挂在工具返回值上——GM 一旦整回合不调工具，
 * 提醒通道整个断流（实测 37 回合里 6 个强场面回合完全跳过固定流程）。把固定流程
 * 追加为玩家消息的第二个文本块，回合开头就贴在生成点旁，不再依赖工具被调用。
 * 前端按【回合流程】前缀隐藏此块；场外消息与工坊会话不注入。
 */
const TURN_FLOW_REMINDER = '【回合流程】先调 report_progress——每一回合都要调，只报往回合正文里已经达成的锚点（本回合才打算写的不算，下回合再报），无进展传空数组；有机制面板则接着用相应工具把本回合的全部变化结清；然后写正文，结尾必须有【行动】块（系统宣布终幕的回合除外）。'

const presetCache = new Map<string, string | undefined>()
async function presetOf(sessionId: string): Promise<string | undefined> {
  if (presetCache.has(sessionId)) return presetCache.get(sessionId)
  const { items } = await rpc<{ items: SessionListItem[] }>('session.list', {})
  for (const s of items) presetCache.set(s.sessionId, s.agentPreset)
  return presetCache.get(sessionId)
}

/**
 * 剧本贴身提醒（craft.reminder / acts[].reminder）：长局里正文先例的权重会压过
 * persona 深处的声明（实测 30+ 回合后 rating 直接失效——推理里复述得出来，落笔
 * 跟着旧文风走），把剧本自己声明的短提醒拼进回合头注入块，贴住生成点。
 * 分幕提醒按会话当前幕现挑现注：只注当前幕那段，未到的幕天然防剧透；没写的幕
 * 回落到 craft.reminder。每回合现读现取：修改剧本重新发布后，进行中的局下一
 * 回合就吃到新文本，不受会话锁定影响。
 */
function reminderOf(presetId: string, actIndex: number | undefined): string | undefined {
  try {
    const story = JSON.parse(
      readFileSync(path.join(presetsRoot, presetId, 'story.json'), 'utf8'),
    ) as { craft?: { reminder?: string }; acts?: { reminder?: string }[] }
    const staged = actIndex !== undefined ? story.acts?.[actIndex]?.reminder?.trim() : undefined
    const text = staged || story.craft?.reminder?.trim()
    return text || undefined
  } catch {
    return undefined
  }
}

interface NumericSnapshot {
  defs: { id: string; label: string; group?: 'affinity' | 'self' | 'world' }[]
  state: Record<string, { value: number }>
  groups?: { self?: string; affinity?: string; world?: string }
}
interface ProjectionValues {
  mechanics?: NumericSnapshot | null
  attributes?: NumericSnapshot | null
  inventory?: { items: { name: string; qty: number }[] } | null
  progress?: { actIndex: number } | null
  progression?: { label: string; xp: number; level: number; next: number | null; unspent: number; levelNames?: string[] } | null
}

/**
 * 玩家加点行 → spend_points 参数。前端用属性显示名写【加点】行（玩家看得懂），这里按
 * 投影里的现行属性名录（与界面同源，含改名修订）换算成 id，作为机械指令贴进回合头。
 */
function allocationHint(playerText: string, attributes: NumericSnapshot | null | undefined): string | undefined {
  const line = playerText.split('\n').map(l => l.trim()).find(l => l.startsWith('【加点】'))
  if (!line) return undefined
  const defs = attributes?.defs ?? []
  const allocations: { id: string; points: number }[] = []
  const unknown: string[] = []
  // 条目以顿号/逗号分隔，每条"显示名 +N"（显示名可含空格）；同一属性写多次合并
  for (const part of line.slice('【加点】'.length).split(/[、,，;；]/)) {
    const m = /^(.+?)\s*\+\s*(\d+)\s*$/.exec(part.trim())
    if (!m) continue
    const def = defs.find(d => d.label === m[1] || d.id === m[1])
    if (!def) {
      unknown.push(m[1])
      continue
    }
    const points = Number(m[2])
    const hit = allocations.find(a => a.id === def.id)
    if (hit) hit.points += points
    else allocations.push({ id: def.id, points })
  }
  return `【加点】玩家本回合分配属性点——固定流程第 2 步第一件事调 spend_points 原样落账：allocations=${JSON.stringify(allocations)}`
    + (unknown.length ? `（无法对应属性：${unknown.join('、')}，忽略）` : '')
}

/**
 * 面板即时快照，随回合头注入（治"GM 忘了物品栏里有什么"与延迟结算）：
 * 机制状态折叠在会话事件里，长局中初始清单早被上下文稀释——GM 会在正文里
 * 发明装备（实测：物品栏躺着钢管，正文抡了五回合不存在的折叠椅）。每回合把
 * 全量数值与物品清单贴到生成点旁，账实相符就有了对照物。hidden 资源一并给
 * GM（本块玩家侧被前端隐藏，与 hidden 的界面约定一致）。
 */
function panelLines(values: ProjectionValues): string[] {
  const lines: string[] = []
  const numeric = (snap: NumericSnapshot | null | undefined): Map<string, string[]> => {
    const byGroup = new Map<string, string[]>()
    for (const def of snap?.defs ?? []) {
      const value = snap?.state[def.id]?.value
      if (value === undefined) continue
      const group = def.group ?? ''
      if (!byGroup.has(group)) byGroup.set(group, [])
      byGroup.get(group)!.push(`${def.label}${value}`)
    }
    return byGroup
  }
  const prog = values.progression
  if (prog) {
    const name = prog.levelNames?.[prog.level - 1]
    lines.push(`等级：${name ? `${name}（Lv.${prog.level}）` : `Lv.${prog.level}`}（${prog.label} ${prog.xp}${prog.next !== null && prog.next !== undefined ? `/${prog.next}` : '，满级'}）`
      + (prog.unspent > 0 ? `，未分配属性点 ${prog.unspent}` : ''))
  }
  const attrs = [...numeric(values.attributes).values()].flat()
  if (attrs.length) lines.push(`属性：${attrs.join(' ')}`)
  const groupTitle = { self: '自身', affinity: '好感', world: '队伍' } as const
  for (const [group, parts] of numeric(values.mechanics)) {
    const title = values.mechanics?.groups?.[group as keyof typeof groupTitle]
      ?? groupTitle[group as keyof typeof groupTitle] ?? group
    lines.push(`${title}：${parts.join(' ')}`)
  }
  const items = values.inventory?.items ?? []
  if (items.length) {
    lines.push(`物品栏：${items.map(i => (i.qty > 1 ? `${i.name}×${i.qty}` : i.name)).join('、')}`)
  }
  return lines
}

/** 正戏回合头注入块：平台固定流程 + 面板快照 + 加点指令 + 剧本贴身提醒。非剧本会话返回 undefined。 */
async function turnHeadBlock(sessionId: string, playerText: string): Promise<{ type: string; text: string } | undefined> {
  const preset = await presetOf(sessionId).catch(() => undefined)
  if (!preset?.startsWith('story-')) return undefined
  let panel = ''
  let alloc = ''
  let actIndex: number | undefined
  try {
    const history = await rpc<{ projections?: { values: ProjectionValues } }>(
      'session.history',
      { sessionId, maxMessages: 1 },
    )
    const values = history.projections?.values ?? {}
    actIndex = values.progress?.actIndex
    // 只有开了经验等级的剧本才有 spend_points；没开的剧本即便玩家手打【加点】也不注入
    const hint = values.progression ? allocationHint(playerText, values.attributes) : undefined
    if (hint) alloc = `\n${hint}`
    // grant_xp 的"每回合必调"也要贴在生成点旁——只写在 persona 里的机械规则，低事件回合会被跳过
    if (values.progression) {
      alloc += `\n【经验】grant_xp 每个正戏回合都要调（只报往回合已定稿正文换来的${values.progression.label}，没有传 0）。`
    }
    const lines = panelLines(values)
    if (lines.length) {
      panel = `\n【当前面板】${lines.join('；')}。`
        + '面板是即时真值：正文中的装备物品必须与物品栏一致（新到手先入账再用）；'
        + '本回合的一切增减当回合结算，含每回合底噪，不许延后补账。'
    }
  } catch (err) {
    // 快照拿不到就只注流程与提醒——注入永远不能挡住回合本身；但要留痕，否则加点指令静默丢失没人知道
    console.warn(`[bff] 回合头快照拉取失败（${sessionId}）：${String(err)}`)
  }
  const reminder = reminderOf(preset, actIndex)
  return {
    type: 'text',
    text: `\n\n${TURN_FLOW_REMINDER}${alloc}${panel}${reminder ? `\n【剧本提醒】${reminder}` : ''}`,
  }
}

app.post('/app/sessions/:id/prompt', asyncRoute(async (req, res) => {
  const { text, mode } = (req.body ?? {}) as { text?: string; mode?: 'queue' | 'steer' }
  if (!text?.trim()) {
    res.status(400).json({ error: { code: 'empty-prompt', message: '内容不能为空' } })
    return
  }
  const content: { type: string; text: string }[] = [{ type: 'text', text }]
  if (!text.trimStart().startsWith('【场外】')) {
    const block = await turnHeadBlock(String(req.params.id), text)
    if (block) content.push(block)
  }
  res.json(await rpc('session.prompt', {
    sessionId: req.params.id,
    mode: mode ?? 'queue',
    content,
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
      && typeof (b as { text?: unknown }).text === 'string'
      // 回合头注入块不算玩家原话（重写重发时要还原原始输入）
      && !(b as { text: string }).text.trimStart().startsWith('【回合流程】'))
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

  const shielded = await protectedSessions()
  const protect = (id: string) => new Set([id, ...shielded])

  if (turnEnds.length >= 2 && lastUserText) {
    const anchor = turnEnds[turnEnds.length - 2].seq
    const { sessionId: child } = await rpc<{ sessionId: string }>('session.fork', { sessionId, atSeq: anchor })
    const removed = pruneSessions(protect(child))
    console.log(`[bff] 重写回合：fork@${anchor} → ${child}，清除旧线 ${removed} 个`)
    const content: { type: string; text: string }[] = [{ type: 'text', text: lastUserText }]
    // 注入块按子会话算：父会话此时已被裁掉/删除，它的面板是被弃回合的终态，不是重写起点的状态。
    // 子会话继承父会话的 preset，先种进缓存，不依赖 session.list 是否已经列出它
    const parentPreset = await presetOf(String(sessionId)).catch(() => undefined)
    if (parentPreset) presetCache.set(child, parentPreset)
    if (!lastUserText.trimStart().startsWith('【场外】')) {
      const block = await turnHeadBlock(child, lastUserText)
      if (block) content.push(block)
    }
    await rpc('session.prompt', { sessionId: child, mode: 'queue', content })
    res.json({ sessionId: child })
    return
  }

  // 只有开场一回合（或取不到输入）：重开同一剧本的新局，开场消息由前端照常补发
  const { items } = await rpc<{ items: { sessionId: string; agentPreset?: string }[] }>('session.list', {})
  const preset = items.find(s => s.sessionId === sessionId)?.agentPreset
  const created = await rpc<{ sessionId: string }>('session.create', preset ? { agentPreset: preset } : {})
  await nameStorySession(created.sessionId, preset)
  pruneSessions(protect(created.sessionId))
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
  // 心跳用具名事件而不是 SSE 注释：注释到不了页面脚本，前端要靠它判断连接是否已经静默断流
  const heartbeat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25_000)

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
