import type {
  CredentialStatus,
  GameItem,
  HistoryEntry,
  SaveItem,
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
  /** build 是前端 bundle 的文件名：服务端换版本时它会变，用来提示玩家刷新 */
  health: () => json<{ ok: boolean; engine?: boolean; llm?: boolean; build?: string }>(fetch('/app/health')),

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

  /** 全局模型目录：当前只配置 DeepSeek（flash / pro）。 */
  modelCatalog: () =>
    json<Pick<ModelCatalog, 'groups'>>(fetch('/app/settings/models')),

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
          inflight?: { kind: 'play' | 'offstage' | 'agent'; partial: string; lastChunkSeq: number; startedAt: number; phase?: string }
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

  /** 重写上一回合：截断日志重发同一输入（原稿归档），会话 id 不变 */
  retry: (sessionId: string) =>
    json<{ sessionId: string }>(fetch(`/app/sessions/${sessionId}/retry`, { method: 'POST' })),

  /** 取（或创建）常驻工坊会话（AI 访谈写剧本） */
  workshop: () => json<{ sessionId: string }>(fetch('/app/workshop', { method: 'POST' })),

  /** 重开工坊，丢弃访谈进度 */
  workshopReset: () => json<{ sessionId: string }>(fetch('/app/workshop/reset', { method: 'POST' })),

  /** 取（或创建）某剧本的修改对话（详情页唤起 GM 改剧本） */
  editSession: (scenarioId: string) =>
    json<{ sessionId: string }>(fetch(`/app/scenarios/${scenarioId}/edit-session`, { method: 'POST' })),

  /** 重开某剧本的修改对话 */
  editSessionReset: (scenarioId: string) =>
    json<{ sessionId: string }>(fetch(`/app/scenarios/${scenarioId}/edit-session/reset`, { method: 'POST' })),

  /** 修订落盘：把本局场外修订合并回剧本源，下一局生效 */
  flushRevisions: (sessionId: string) =>
    json<{ applied: number; skipped: string[] }>(
      fetch(`/app/sessions/${sessionId}/revisions/flush`, { method: 'POST' }),
    ),

  /** 删除剧本（数据源+编译产出+其存档与修改对话）；正在游玩会被 409 拒绝 */
  deleteScenario: (id: string) =>
    json<{ ok: true }>(fetch(`/app/scenarios/${id}`, { method: 'DELETE' })),

  /** 剧本历史版本（覆盖发布自动留档，最近 10 版） */
  listVersions: (id: string) =>
    json<{ versions: { name: string; savedAt: number; chars: number }[] }>(
      fetch(`/app/scenarios/${id}/versions`),
    ),

  /** 回滚到某个历史版本（当前版会先自动留档，回滚可再回滚） */
  restoreVersion: (id: string, name: string) =>
    json<{ ok: boolean; brief: string }>(
      fetch(`/app/scenarios/${id}/versions/${name}/restore`, { method: 'POST' }),
    ),

  /** 全部冒险，最近玩过的在前 */
  games: () => json<{ items: GameItem[] }>(fetch('/app/games')),

  /** 这局冒险开局时锁定的剧本（玩家可见部分） */
  sessionStory: (sessionId: string) => json<StoryDetail>(fetch(`/app/sessions/${sessionId}/story`)),

  /** 删除一局冒险（日志归档，存档水晶一并删除） */
  deleteSession: (sessionId: string) =>
    json<{ ok: true }>(fetch(`/app/sessions/${sessionId}`, { method: 'DELETE' })),

  saves: (sessionId: string) => json<{ items: SaveItem[] }>(fetch(`/app/sessions/${sessionId}/saves`)),

  createSave: (sessionId: string, label: string, note: string) =>
    json<SaveItem>(
      fetch(`/app/sessions/${sessionId}/saves`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, note }),
      }),
    ),

  /** 读档：这一局原地恢复到存档那一刻 */
  loadSave: (sessionId: string, name: string) =>
    json<{ sessionId: string }>(fetch(`/app/sessions/${sessionId}/saves/${name}/load`, { method: 'POST' })),

  deleteSave: (sessionId: string, name: string) =>
    json<{ ok: true }>(fetch(`/app/sessions/${sessionId}/saves/${name}`, { method: 'DELETE' })),

  /** 回退到第 toTurn 回合结束时（其后的回合截掉），不重跑 */
  rewind: (sessionId: string, toTurn: number) =>
    json<{ sessionId: string }>(
      fetch(`/app/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toTurn }),
      }),
    ),

  /** 从头重开这一局（存档水晶不受影响） */
  restart: (sessionId: string) =>
    json<{ sessionId: string }>(fetch(`/app/sessions/${sessionId}/restart`, { method: 'POST' })),

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
