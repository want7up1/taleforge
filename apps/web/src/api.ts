import type { HistoryEntry, ScenarioSummary, SessionSummary } from './types.ts'

async function json<T>(resPromise: Promise<Response>): Promise<T> {
  const res = await resPromise
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listScenarios: () => json<{ items: ScenarioSummary[] }>(fetch('/app/scenarios')),

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
    json<{ events: HistoryEntry[]; hasMore: boolean }>(fetch(`/app/sessions/${sessionId}/history`)),

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
}
