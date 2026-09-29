/**
 * 启动入口：拼装存储、模型客户端、内核与 HTTP 服务。单进程——不再有 dsh 网关要等。
 *
 * 数据根沿用旧路径（容器里 /app/runtime/dsh-home，本地 runtime/dsh-home），数据卷不用改：
 *   scenarios/     剧本源（含 versions/ 留档），原样沿用
 *   v2/            新内核的会话日志、存档、设置、凭据
 *   observer-v2.jsonl  被动观测（旧的 observer.jsonl 原样保留作对照基线）
 *   sessions/ save-backups/ .agent-presets/ …  dsh 时代的遗留，只读保留、不迁（用户已批准）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from '@taleforge/engine'
import { DeepSeekClient } from '@taleforge/llm'
import { WORKSHOP_PERSONA, scanCatalog } from '@taleforge/scenario-compiler'
import { SessionStore } from '@taleforge/store'
import { workshopTools } from '@taleforge/workshop'
import { mkdirSync } from 'node:fs'
import { createApp, legacySessionCount } from './app.ts'
import { PlatformConfig } from './config.ts'

const PORT = Number(process.env.PORT ?? 31415)
const HOST = process.env.HOST ?? '0.0.0.0'
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const webDistDir = path.resolve(here, '../../web/dist')
const dataHome = process.env.TALEFORGE_HOME ?? process.env.DSH_HOME ?? path.join(repoRoot, 'runtime/dsh-home')

const scenariosRoot = path.join(dataHome, 'scenarios')
mkdirSync(scenariosRoot, { recursive: true })
const roots = [path.join(repoRoot, 'presets'), scenariosRoot]

const config = new PlatformConfig(dataHome)
const store = new SessionStore(path.join(dataHome, 'v2'))
const llm = new DeepSeekClient({ apiKey: () => config.apiKey(), baseUrl: process.env.DEEPSEEK_BASE_URL })
const workshop = { scenariosRoot, roots }

const engine = new Engine({
  store,
  llm,
  settings: () => config.settings(),
  currentStory: id => scanCatalog(roots).find(e => e.id === id)?.story,
  agentPersona: WORKSHOP_PERSONA,
  agentTools: () => workshopTools(workshop, id => console.log(`[bff] 工坊发布：${id}`)),
  observerLog: path.join(dataHome, 'observer-v2.jsonl'),
})

const entries = scanCatalog(roots)
const live = entries.filter(e => e.story && !e.failed)
console.log(`[bff] 剧本 ${live.length} 部：${live.map(e => e.id).join(', ') || '（无）'}`)
// 坏源不阻塞启动（否则容器无限重启，连修它的界面都打不开），但必须吵到能被看见
for (const e of entries.filter(x => x.failed)) {
  console.error(`[bff] 剧本源损坏：${e.id}${e.degraded ? '（已退回最近一份留档上架，可在详情页回滚或删除）' : '（没有可用留档，未上架）'}\n${e.failed}`)
}
const legacy = legacySessionCount(dataHome)
if (legacy) console.log(`[bff] dsh 时代的旧会话 ${legacy} 个只读保留在 sessions/，新内核不读它们`)

const app = createApp({
  engine,
  store,
  config,
  roots,
  scenariosRoot,
  editMapPath: path.join(dataHome, 'v2', 'edit-sessions.json'),
  repoRoot,
  webDistDir,
})

app.listen(PORT, HOST, () => {
  console.log(`[bff] listening on http://${HOST}:${PORT}（模型 ${config.settings().model}，Key ${config.credentialStatus().configured ? '已配置' : '未配置'}）`)
})
