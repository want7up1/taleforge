import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import { History } from './History.tsx'
import { Library } from './Library.tsx'
import { Play } from './Play.tsx'
import { Settings } from './Settings.tsx'
import { Workshop } from './Workshop.tsx'
import type { CredentialStatus, ScenarioSummary, SessionSummary, StoryDetail } from './types.ts'

type View = 'library' | 'settings' | 'play' | 'history' | 'workshop'

export function App() {
  const [view, setView] = useState<View>('library')
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [credential, setCredential] = useState<CredentialStatus>()
  const [active, setActive] = useState<string>()
  const [workshopId, setWorkshopId] = useState<string>()
  const [story, setStory] = useState<StoryDetail>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const [{ items: sessionItems }, { items: scenarioItems }, cred] = await Promise.all([
        api.listSessions(),
        api.listScenarios(),
        api.credentialStatus(),
      ])
      setSessions(sessionItems.filter(s => !s.blank))
      setScenarios(scenarioItems)
      setCredential(cred)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ---- hash 路由：每个界面一条浏览器历史，前进/后退可用 ----

  useEffect(() => {
    const target = `#/${view}`
    if (location.hash !== target) location.hash = target
  }, [view])

  useEffect(() => {
    const onHash = () => {
      const v = location.hash.replace(/^#\//, '') as View
      if (!['library', 'settings', 'play', 'history', 'workshop'].includes(v)) return setView('library')
      // 需要前置状态的界面缺状态时回退剧本库
      if ((v === 'play' || v === 'history') && !active) return setView('library')
      if (v === 'workshop' && !workshopId) return setView('library')
      setView(v)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [active, workshopId])

  // 刷新/深链恢复：带着 #/play 或 #/workshop 打开时直接回到对应界面
  useEffect(() => {
    const initial = location.hash
    if (initial === '#/play' || initial === '#/history') {
      void api.listSessions().then(({ items }) => {
        const live = items.filter(s => !s.blank)[0]
        if (live) void enterSession(live.sessionId, live.agentPreset)
      }).catch(() => undefined)
    } else if (initial === '#/workshop') {
      void enterWorkshop()
    } else if (initial === '#/settings') {
      setView('settings')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const enterSession = useCallback(async (sessionId: string, presetId?: string) => {
    setActive(sessionId)
    setView('play')
    if (presetId) {
      api.scenario(presetId).then(setStory).catch(() => setStory(undefined))
    }
  }, [])

  const startScenario = async (scenarioId: string) => {
    try {
      setError(undefined)
      // 开场消息由 Play 在事件流连上后补发，这里只负责建档进屏
      const { sessionId } = await api.createSession(scenarioId)
      await enterSession(sessionId, scenarioId)
      void refresh()
    } catch (err) {
      setError(String(err))
      setView('library')
    }
  }

  const resumeSession = async (session: SessionSummary) => {
    await enterSession(session.sessionId, session.agentPreset)
  }

  const enterWorkshop = async () => {
    try {
      setError(undefined)
      const { sessionId } = await api.workshop()
      setWorkshopId(sessionId)
      setView('workshop')
    } catch (err) {
      setError(String(err))
    }
  }

  if (view === 'play' && active) {
    return (
      <Play
        sessionId={active}
        story={story}
        onExit={() => {
          setView('library')
          void refresh()
        }}
        onOpenHistory={() => setView('history')}
        onSessionReplaced={(next) => {
          setActive(next)
          void refresh()
        }}
      />
    )
  }

  if (view === 'history' && active) {
    return (
      <History
        sessionId={active}
        story={story}
        onBack={() => setView('play')}
      />
    )
  }

  if (view === 'workshop' && workshopId) {
    return (
      <Workshop
        sessionId={workshopId}
        onExit={() => {
          setView('library')
          void refresh()
        }}
        onReset={() => {
          void api.workshopReset().then(({ sessionId }) => setWorkshopId(sessionId)).catch(err => setError(String(err)))
        }}
      />
    )
  }

  if (view === 'settings') {
    return (
      <div className="screen">
        <header className="topbar">
          <Brand />
          <div className="crumbs"><b>设置</b></div>
          <div className="tools">
            <button onClick={() => setView('library')}>← 剧本库</button>
          </div>
        </header>
        <div className="scroll">
          <div className="column">
            <Settings status={credential} onSaved={() => void refresh()} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <Library
      scenarios={scenarios}
      sessions={sessions}
      credential={credential}
      error={error}
      onStart={id => void startScenario(id)}
      onResume={s => void resumeSession(s)}
      onSettings={() => setView('settings')}
      onWorkshop={() => void enterWorkshop()}
      onRefresh={() => void refresh()}
    />
  )
}
