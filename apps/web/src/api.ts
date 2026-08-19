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

  history: (sessionId: string) =>
    json<{ events: HistoryEntry[]; hasMore: boolean; projections?: ProjectionsBlock }>(
      fetch(`/app/sessions/${sessionId}/history`),
    ),

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
}
