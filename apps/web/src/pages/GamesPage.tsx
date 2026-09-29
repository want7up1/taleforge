/** 读取存档（移植自 Rpgforge 的 LOAD GAME）：全部冒险，最近玩过的在前；继续 / 营地 / 删除。 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { Link } from '../router.tsx'
import type { GameItem } from '../types.ts'
import { ErrorCard, formatDateTime, PHASE_LABEL, useLoad } from './common.tsx'

export function GamesPage() {
  const dialog = usePixelDialog()
  const [state, , setGames] = useLoad(() => api.games().then(r => r.items), [])
  const [deleting, setDeleting] = useState<string>()
  const [actionError, setActionError] = useState<string>()

  const remove = async (g: GameItem) => {
    const typed = await dialog.prompt(`删除这局冒险？剧情与它的全部存档水晶都会从列表里移除，不可恢复。`, {
      title: '删除冒险',
      expect: g.title,
      placeholder: g.title,
      danger: true,
      confirmLabel: '删除',
    })
    if (typed === null) return
    setActionError(undefined)
    setDeleting(g.sessionId)
    try {
      await api.deleteSession(g.sessionId)
      if (state.status === 'ready') setGames(state.data.filter(x => x.sessionId !== g.sessionId))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(undefined)
    }
  }

  return (
    <AppShell>
      <section className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="px-eyebrow">LOAD GAME</p>
          <h1 className="px-heading mt-2 text-3xl sm:text-4xl">冒险存档</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--muted)]">选择一局冒险继续，或进入营地管理存档水晶。</p>
        </div>
        <Link className="px-btn px-btn-primary" href="/games/new">＋ 新的冒险</Link>
      </section>

      {actionError && <section className="px-alert">{actionError}</section>}

      {state.status === 'loading'
        ? <Loading text="正在读取存档…" />
        : state.status === 'error'
          ? <ErrorCard message={state.message} />
          : state.data.length === 0
            ? (
                <section className="px-empty grid gap-3">
                  <p className="text-base font-bold text-[color:var(--foreground)]">存档槽位全空</p>
                  <p>从剧本库挑一部剧本开局，或者先去创作一部。</p>
                  <Link className="px-btn px-btn-primary w-fit" href="/games/new">＋ 新的冒险</Link>
                </section>
              )
            : (
                <section className="grid gap-3">
                  {state.data.map((g, index) => (
                    <article className="save-slot" key={g.sessionId}>
                      <span className="save-slot-index">SLOT {index + 1}</span>
                      <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
                        <div className="min-w-0 pr-14 lg:pr-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="break-words text-lg font-bold">{g.title}</h2>
                            <span className="px-badge px-badge-bright">{PHASE_LABEL[g.phase]}</span>
                            {g.running && <span className="px-badge px-badge-amber">生成中</span>}
                          </div>
                          <p className="px-wrap mt-1.5 text-sm leading-6 text-[color:var(--muted)]">
                            第 {g.turns} 回合{g.actTitle ? ` · ${g.actTitle}` : ''}{g.tagline ? ` · ${g.tagline}` : ''}
                          </p>
                          <p className="mt-1.5 text-xs text-[color:var(--faint)]">更新于 {formatDateTime(g.updatedAt, true)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Link className="px-btn px-btn-primary" href={`/games/${g.sessionId}/play`}>▸ 继续</Link>
                          <Link className="px-btn" href={`/games/${g.sessionId}/camp`}>营地</Link>
                          <button className="px-btn px-btn-danger" disabled={deleting !== undefined} onClick={() => void remove(g)} type="button">
                            {deleting === g.sessionId ? '删除中' : '删除'}
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </section>
              )}
    </AppShell>
  )
}
