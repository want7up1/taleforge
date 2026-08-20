import type {
  CredentialStatus,
  HistoryEntry,
  ModelCatalog,
  ModelSelection,
  ProjectionsBlock,
  ScenarioSummary,
  SessionSummary,
  StoryDetail,
} from './types.ts'

async function json<T>(resPromise: Promise<Response>): Promise<T> {
  const res = await resPromise
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  credentialStatus: () => json<CredentialStatus>(fetch('/app/settings/credentials')),

  saveCredential: (value: string) =>
    json<{ ok: true }>(
      fetch('/app/settings/credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      }),
    ),

  clearCredential: () =>
    json<{ ok: true }>(fetch('/app/settings/credentials', { method: 'DELETE' })),

  globalModel: () => json<ModelSelection>(fetch('/app/settings/model')),

  saveGlobalModel: (selection: ModelSelection) =>
    json<ModelSelection>(
      fetch('/app/settings/model', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection),
      }),
    ),

  sessionModel: (sessionId: string) =>
    json<ModelCatalog>(fetch(`/app/sessions/${sessionId}/model`)),

  setSessionModel: (sessionId: string, selection: ModelSelection) =>
    json<{ selected: ModelSelection }>(
      fetch(`/app/sessions/${sessionId}/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection),
      }),
    ),

  listScenarios: () => json<{ items: ScenarioSummary[] }>(fetch('/app/scenarios')),

  scenario: (id: string) => json<StoryDetail>(fetch(`/app/scenarios/${id}`)),

  listSessions: () => json<{ items: SessionSummary[] }>(fetch('/app/sessions')),

  createSession: (agentPreset?: string) =>
    json<{ sessionId: string; agentPreset?: string }>(
      fetch('/app/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(agentPreset ? { agentPreset } : {}),
      }),
    ),

  /** 历史拉取带重试：移动端网络切换/页面恢复时首次请求常挂 */
  history: async (sessionId: string) => {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await json<{
          events: HistoryEntry[]
          hasMore: boolean
          projections?: ProjectionsBlock
          /** 未收尾回合的已产出部分：断点续传用 */
          inflight?: { partial: string; lastChunkSeq: number; startedAt: number }
        }>(
          fetch(`/app/sessions/${sessionId}/history`),
        )
      } catch (err) {
        lastErr = err
        await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)))
      }
    }
    throw lastErr
  },

  prompt: (sessionId: string, text: string) =>
    json<{ accepted: true }>(
      fetch(`/app/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    ),

  cancel: (sessionId: string) =>
    json<{ accepted: true }>(fetch(`/app/sessions/${sessionId}/cancel`, { method: 'POST' })),

  /** 重写上一回合：fork 弃旧线重发同一输入，返回新会话 id */
  retry: (sessionId: string) =>
    json<{ sessionId: string }>(fetch(`/app/sessions/${sessionId}/retry`, { method: 'POST' })),

  /** 取（或创建）常驻工坊会话 */
  workshop: () => json<{ sessionId: string }>(fetch('/app/workshop', { method: 'POST' })),

  /** 重开工坊，丢弃访谈进度 */
  workshopReset: () => json<{ sessionId: string }>(fetch('/app/workshop/reset', { method: 'POST' })),

  /** 修订落盘：把本局场外修订合并回剧本源，下一局生效 */
  flushRevisions: (sessionId: string) =>
    json<{ applied: number; skipped: string[] }>(
      fetch(`/app/sessions/${sessionId}/revisions/flush`, { method: 'POST' }),
    ),

  /** 删除剧本（数据源+编译产出）；有存档在用会被 409 拒绝 */
  deleteScenario: (id: string) =>
    json<{ ok: true }>(fetch(`/app/scenarios/${id}`, { method: 'DELETE' })),

  /** 删除存档 */
  deleteSession: (sessionId: string) =>
    json<{ ok: true }>(fetch(`/app/sessions/${sessionId}`, { method: 'DELETE' })),

  /** 备份存档（服务器快照，随数据卷持久化） */
  backupSession: (sessionId: string) =>
    json<{ name: string }>(fetch(`/app/sessions/${sessionId}/backup`, { method: 'POST' })),

  listBackups: () =>
    json<{ items: { name: string; sessionId: string; backedAt: number; title?: string; agentPreset?: string; turns?: number }[] }>(
      fetch('/app/save-backups'),
    ),

  /** 恢复备份：成为当前唯一存档 */
  restoreBackup: (name: string) =>
    json<{ sessionId: string }>(fetch(`/app/save-backups/${name}/restore`, { method: 'POST' })),

  deleteBackup: (name: string) =>
    json<{ ok: true }>(fetch(`/app/save-backups/${name}`, { method: 'DELETE' })),

  /** 导入剧本：校验失败返回逐条错误（400 也要解析正文，不走通用 json 助手） */
  importStory: async (story: unknown) => {
    const res = await fetch('/app/scenarios/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(story),
    })
    return (await res.json()) as {
      ok: boolean
      id?: string
      title?: string
      issues?: { path: string; message: string }[]
      brief: string
    }
  },
}
