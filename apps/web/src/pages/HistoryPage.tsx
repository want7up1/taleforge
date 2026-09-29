/**
 * 旅程页（外观移植自 Rpgforge 的 LOG · 旅程图卷）：逐回合折叠，玩家行动 / 剧情 / 关键变化，
 * 可只看行动或只看剧情；每一回合都能"回到这里"（Rpgforge 的后悔药：其后的回合截掉、原稿留档）。
 */
import { useState } from 'react'
import { api } from '../api.ts'
import type { CastMember } from '../cast.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { CharacterModal } from '../components/CharacterModal.tsx'
import { GameSubpageShell } from '../components/GameMenu.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { StoryMarkdown } from '../components/StoryMarkdown.tsx'
import { Link, navigate } from '../router.tsx'
import { EmptyText, ErrorCard, useLoad } from './common.tsx'
import { digestLines, loadGame } from './gameData.ts'

type ViewMode = 'all' | 'actions' | 'story'
type ExpandMode = 'latest' | 'all' | 'none'

export function HistoryPage({ gameId }: { gameId: string }) {
  const [state] = useLoad(() => loadGame(gameId), [gameId])
  const dialog = usePixelDialog()
  const [view, setView] = useState<ViewMode>('all')
  const [expand, setExpand] = useState<ExpandMode>('latest')
  const [selected, setSelected] = useState<CastMember>()
  const [error, setError] = useState<string>()

  if (state.status !== 'ready') {
    return <AppShell variant="focus">{state.status === 'loading' ? <Loading text="正在读取旅程图卷…" /> : <ErrorCard message={state.message} />}</AppShell>
  }
  const { turns, story, values, knownCast } = state.data
  const known = story.cast.filter(c => knownCast.has(c.id))
  const last = turns[turns.length - 1]?.turn

  const rewindTo = async (turn: number) => {
    const ok = await dialog.confirm(`回到第 ${turn} 回合结束时？之后的 ${last! - turn} 个回合会被移除（原稿留档），你从第 ${turn} 回合的抉择重新选。`, { confirmLabel: '回到这里', danger: true })
    if (!ok) return
    try {
      await api.rewind(gameId, turn)
      navigate(`/games/${gameId}/play`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pill = (on: boolean) => (on ? 'px-btn px-btn-primary' : 'px-btn')

  return (
    <AppShell variant="focus">
      <GameSubpageShell
        active="history"
        eyebrow="LOG · 旅程"
        gameId={gameId}
        primaryAction={<Link className="px-btn px-btn-primary w-full sm:w-fit" href={`/games/${gameId}/play`}>▸ 继续冒险</Link>}
        subtitle={`共 ${turns.length} 个回合`}
        title={story.title}
      >
        {error && <section className="px-alert">{error}</section>}
        <section className="px-panel px-panel-pad">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="px-heading text-base">旅程图卷</h2>
            <span className="px-badge">{turns.length} 回合</span>
          </div>
          <div className="mb-4 grid gap-2">
            <div className="flex flex-wrap gap-2" aria-label="历史显示内容">
              <button className={pill(view === 'all')} onClick={() => setView('all')} type="button">全部</button>
              <button className={pill(view === 'actions')} onClick={() => setView('actions')} type="button">只看行动</button>
              <button className={pill(view === 'story')} onClick={() => setView('story')} type="button">只看剧情</button>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="历史展开方式">
              <button className={pill(expand === 'latest')} onClick={() => setExpand('latest')} type="button">最新</button>
              <button className={pill(expand === 'all')} onClick={() => setExpand('all')} type="button">展开全部</button>
              <button className={pill(expand === 'none')} onClick={() => setExpand('none')} type="button">折叠全部</button>
            </div>
          </div>
          {turns.length === 0
            ? <EmptyText>暂无历史回合。</EmptyText>
            : turns.map(t => {
                const facts = digestLines(t.digest, values)
                return (
                  <details className="px-fold mb-3" key={`${t.turn}-${expand}`} open={expand === 'all' || (expand === 'latest' && t.turn === last)}>
                    <summary>
                      <span className="font-bold">第 {t.turn} 回合</span>
                      {t.turn === 1 && <span className="ml-2 text-xs text-[color:var(--muted)]">开场</span>}
                      {t.ending && <span className="ml-2 text-xs text-[color:var(--amber)]">结局</span>}
                    </summary>
                    <div className="grid gap-3 border-t-2 border-[color:var(--border)] pt-3">
                      {view !== 'story' && t.input && (
                        <div className="px-card px-card-green text-sm leading-6">
                          <div className="px-label">玩家行动</div>
                          <p className="px-wrap mt-1 whitespace-pre-wrap text-[color:var(--muted)]">&gt; {t.input}</p>
                        </div>
                      )}
                      {view !== 'actions' && (
                        <div className="px-card text-sm leading-7">
                          <div className="px-label">剧情</div>
                          <StoryMarkdown characters={known} className="mt-2 text-sm" content={t.text} onCharacterClick={setSelected} />
                        </div>
                      )}
                      {facts.length > 0 && (
                        <div className="px-card px-card-green">
                          <h3 className="px-label">关键变化</h3>
                          <ul className="mt-2 grid gap-1 pl-4 text-sm leading-6 text-[color:var(--muted)]">
                            {facts.map((f, i) => <li className="px-wrap list-disc" key={i}>{f}</li>)}
                          </ul>
                        </div>
                      )}
                      {t.turn !== last && (
                        <button className="px-btn w-fit text-xs" onClick={() => void rewindTo(t.turn)} type="button">↩ 回到这一回合</button>
                      )}
                    </div>
                  </details>
                )
              })}
        </section>
        <CharacterModal character={selected} role="出场人物" onClose={() => setSelected(undefined)} />
      </GameSubpageShell>
    </AppShell>
  )
}
