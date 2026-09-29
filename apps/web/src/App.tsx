/**
 * 路由表与全站状态（平台健康、API Key、前端构建过期提示）。页面布局整体移植自 Rpgforge。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { CampPage } from './pages/CampPage.tsx'
import { CharactersPage } from './pages/CharactersPage.tsx'
import { EditPage } from './pages/EditPage.tsx'
import { GamesPage } from './pages/GamesPage.tsx'
import { HistoryPage } from './pages/HistoryPage.tsx'
import { LibraryPage } from './pages/LibraryPage.tsx'
import { MemoryPage } from './pages/MemoryPage.tsx'
import { NewGamePage } from './pages/NewGamePage.tsx'
import { PlayPage } from './pages/PlayPage.tsx'
import { ScenarioPage } from './pages/ScenarioPage.tsx'
import { ScriptPage } from './pages/ScriptPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { StatusPage } from './pages/StatusPage.tsx'
import { TitlePage, type PlatformHealth } from './pages/TitlePage.tsx'
import { matchPath, navigate, usePath } from './router.tsx'
import type { CredentialStatus } from './types.ts'

// 旧版是 hash 路由（#/play、#/library……）：书签和旧标签页进来一律回标题画面
if (location.hash.startsWith('#/')) history.replaceState(null, '', '/')

export function App() {
  const path = usePath()
  const [credential, setCredential] = useState<CredentialStatus>()
  const [health, setHealth] = useState<PlatformHealth>('checking')
  /** 服务端换了前端构建：页面开着不动就一直跑旧 JS，得提示刷新（只提示，不自动刷——正文读到一半被刷掉更糟） */
  const [stale, setStale] = useState(false)
  const baseBuild = useRef<string | undefined>(undefined)

  const refreshCredential = useCallback(() => {
    api.credentialStatus().then(setCredential).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshCredential()
    const check = async () => {
      if (document.hidden) return
      try {
        const { ok, build } = await api.health()
        setHealth(ok ? 'online' : 'offline')
        if (!build) return
        if (baseBuild.current === undefined) baseBuild.current = build
        else if (build !== baseBuild.current) setStale(true)
      } catch {
        setHealth('offline')
      }
    }
    void check()
    const timer = setInterval(() => void check(), 60_000)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [refreshCredential])

  const page = route(path, credential, health, refreshCredential)

  return (
    <>
      {stale && (
        <div className="update-bar">
          平台已更新，当前页面还在用旧版本——刷新后才会用上新功能与修复。
          <button className="px-btn px-btn-amber min-h-7 px-2 py-0.5 text-xs" onClick={() => location.reload()} type="button">立即刷新</button>
        </div>
      )}
      {page}
    </>
  )
}

function route(path: string, credential: CredentialStatus | undefined, health: PlatformHealth, onCredential: () => void) {
  const game = (section: string) => matchPath(`/games/:id/${section}`, path)?.id
  let id: string | undefined
  if (path === '/' || path === '') return <TitlePage health={health} credential={credential} />
  if (path === '/games') return <GamesPage />
  if (path === '/games/new') return <NewGamePage credential={credential} />
  if ((id = game('play'))) return <PlayPage key={id} gameId={id} />
  if ((id = game('status'))) return <StatusPage key={id} gameId={id} />
  if ((id = game('characters'))) return <CharactersPage key={id} gameId={id} />
  if ((id = game('history'))) return <HistoryPage key={id} gameId={id} />
  if ((id = game('memory'))) return <MemoryPage key={id} gameId={id} />
  if ((id = game('settings'))) return <ScriptPage key={id} gameId={id} />
  if ((id = game('camp'))) return <CampPage key={id} gameId={id} />
  if ((id = matchPath('/games/:id', path)?.id)) return <Redirect to={`/games/${id}/play`} />
  if (path === '/library') return <LibraryPage />
  if ((id = matchPath('/library/:id/edit', path)?.id)) return <EditPage key={id} scenarioId={id} />
  if ((id = matchPath('/library/:id', path)?.id)) return <ScenarioPage key={id} scenarioId={id} credential={credential} />
  if (path === '/workshop') return <Redirect to="/games/new" />
  if (path === '/settings') return <SettingsPage credential={credential} onChanged={onCredential} />
  return <Redirect to="/" />
}

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to])
  return null
}
