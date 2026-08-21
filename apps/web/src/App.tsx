import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import { History } from './History.tsx'
import { Library } from './Library.tsx'
import { Play } from './Play.tsx'
import { ScenarioDetail } from './ScenarioDetail.tsx'
import { Settings } from './Settings.tsx'
import { Workshop } from './Workshop.tsx'
import type { CredentialStatus, ScenarioSummary, SessionSummary, StoryDetail } from './types.ts'

type View = 'library' | 'settings' | 'play' | 'history' | 'workshop' | 'scenario' | 'edit'

/**
 * 挂载前捕获的初始 hash。刷新恢复必须用它而不是现读 location.hash：下面的 hash 同步
 * effect 先于恢复 effect 执行，首轮就会把 #/play 改写成 #/library，现读只能读到改写后
 * 的值（实测如此——刷新因此永远退回剧本库）。
 */
const initialHash = location.hash
/** 要先拉数据才能进的界面：恢复完成前不许 hash 同步 effect 改写地址 */
const needsAsyncRestore = (hash: string) =>
  hash === '#/play' || hash === '#/history' || hash === '#/workshop'
  || hash.startsWith('#/scenario/') || hash.startsWith('#/edit/')

export function App() {
  const [view, setView] = useState<View>(initialHash === '#/settings' ? 'settings' : 'library')
  const restoring = useRef(needsAsyncRestore(initialHash))
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [credential, setCredential] = useState<CredentialStatus>()
  const [active, setActive] = useState<string>()
  const [workshopId, setWorkshopId] = useState<string>()
  const [story, setStory] = useState<StoryDetail>()
  /** 详情页正在查看的剧本 */
  const [detail, setDetail] = useState<StoryDetail>()
  /** 详情页唤起的修改对话（按剧本记账，防止串到别的剧本） */
  const [edit, setEdit] = useState<{ scenarioId: string; sessionId: string }>()
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
    if (restoring.current) return
    const target
      = view === 'scenario' && detail ? `#/scenario/${detail.id}`
        : view === 'edit' && detail ? `#/edit/${detail.id}`
          : `#/${view}`
    if (location.hash !== target) location.hash = target
  }, [view, detail])

  /** 进入某剧本的修改对话：详情与会话就绪后切视图 */
  const openEdit = useCallback(async (scenarioStory: StoryDetail) => {
    setError(undefined)
    const { sessionId } = await api.editSession(scenarioStory.id)
    setEdit({ scenarioId: scenarioStory.id, sessionId })
    setView('edit')
  }, [])

  useEffect(() => {
    const onHash = () => {
      if (location.hash.startsWith('#/scenario/')) {
        const id = location.hash.slice('#/scenario/'.length)
        if (detail?.id === id) return setView('scenario')
        api.scenario(id).then((s) => {
          setDetail(s)
          setView('scenario')
        }).catch(() => setView('library'))
        return
      }
      if (location.hash.startsWith('#/edit/')) {
        const id = location.hash.slice('#/edit/'.length)
        if (detail?.id === id && edit?.scenarioId === id) return setView('edit')
        void Promise.all([api.scenario(id), api.editSession(id)])
          .then(([s, es]) => {
            setDetail(s)
            setEdit({ scenarioId: id, sessionId: es.sessionId })
            setView('edit')
          })
          .catch(() => setView('library'))
        return
      }
      const v = location.hash.replace(/^#\//, '') as View
      if (!['library', 'settings', 'play', 'history', 'workshop'].includes(v)) return setView('library')
      // 需要前置状态的界面缺状态时回退剧本库
      if ((v === 'play' || v === 'history') && !active) return setView('library')
      if (v === 'workshop' && !workshopId) return setView('library')
      setView(v)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [active, workshopId, detail, edit])

  // 刷新/深链恢复：带着 #/play、#/history、#/workshop、#/scenario/<id>、#/edit/<id> 打开时，
  // 先拉齐前置状态再进对应界面（#/settings 在初始 state 里直接进）。
  // 恢复结束前 hash 同步 effect 保持沉默，否则恢复目标在挂载瞬间就被改写掉。
  useEffect(() => {
    if (!restoring.current) return
    const done = (restored: boolean) => {
      restoring.current = false
      // 恢复不成（会话/剧本已不在）：地址静默改回剧本库，不多留一条浏览历史
      if (!restored) history.replaceState(null, '', '#/library')
    }
    if (initialHash === '#/play' || initialHash === '#/history') {
      api.listSessions().then(async ({ items }) => {
        const live = items.filter(s => !s.blank)[0]
        if (!live) return done(false)
        await enterSession(live.sessionId, live.agentPreset)
        if (initialHash === '#/history') setView('history')
        done(true)
      }).catch(() => done(false))
    } else if (initialHash === '#/workshop') {
      void enterWorkshop().then(done)
    } else if (initialHash.startsWith('#/scenario/')) {
      const id = initialHash.slice('#/scenario/'.length)
      api.scenario(id).then((s) => {
        setDetail(s)
        setView('scenario')
        done(true)
      }).catch(() => done(false))
    } else if (initialHash.startsWith('#/edit/')) {
      const id = initialHash.slice('#/edit/'.length)
      api.scenario(id).then(async (s) => {
        setDetail(s)
        await openEdit(s)
        done(true)
      }).catch(() => done(false))
    } else {
      done(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openScenario = async (id: string) => {
    try {
      setError(undefined)
      setDetail(await api.scenario(id))
      setView('scenario')
    } catch (err) {
      setError(String(err))
    }
  }

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

  const enterWorkshop = async (): Promise<boolean> => {
    try {
      setError(undefined)
      const { sessionId } = await api.workshop()
      setWorkshopId(sessionId)
      setView('workshop')
      return true
    } catch (err) {
      setError(String(err))
      return false
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

  if (view === 'edit' && detail && edit?.scenarioId === detail.id) {
    return (
      <Workshop
        sessionId={edit.sessionId}
        title={`修改 · ${detail.title}`}
        opening={`我要修改剧本《${detail.title}》（id：${detail.id}）。请先用工具读取它的现行正式版，简要确认核心设定，然后等我说要改哪里；发布前把变更点列给我确认。`}
        showKit={false}
        exitLabel="返回剧本"
        resetConfirm="重开会丢弃这段修改对话（已发布的修改不受影响），确定吗？"
        onExit={() => {
          // 修改可能已发布：回详情页前重新拉一次现行正式版
          void api.scenario(detail.id).then(setDetail).catch(() => undefined)
          setView('scenario')
          void refresh()
        }}
        onReset={() => {
          void api.editSessionReset(detail.id)
            .then(({ sessionId }) => setEdit({ scenarioId: detail.id, sessionId }))
            .catch(err => setError(String(err)))
        }}
      />
    )
  }

  if (view === 'scenario' && detail) {
    return (
      <ScenarioDetail
        story={detail}
        current={sessions[0]}
        blocked={credential && !credential.configured}
        onStart={() => void startScenario(detail.id)}
        onResume={s => void resumeSession(s)}
        onLoaded={(sessionId) => {
          void enterSession(sessionId, detail.id)
          void refresh()
        }}
        onEdit={() => void openEdit(detail).catch(err => setError(String(err)))}
        onDeleted={() => {
          setDetail(undefined)
          setEdit(undefined)
          setView('library')
          void refresh()
        }}
        onRefresh={() => void refresh()}
        onBack={() => setView('library')}
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
      onOpenScenario={id => void openScenario(id)}
      onResume={s => void resumeSession(s)}
      onSettings={() => setView('settings')}
      onWorkshop={() => void enterWorkshop()}
    />
  )
}
