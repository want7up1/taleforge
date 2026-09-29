/**
 * 记忆页（外观移植自 Rpgforge 的 MEMO）：GM 眼里的"前情"——后台整理的前情提要、仍以原文放在上下文里的
 * 最近几章、场外往来记录。Rpgforge 这页还有上下文诊断，那是观测面板（护栏 4），不搬。
 */
import { AppShell, Loading } from '../components/AppShell.tsx'
import { GameSubpageShell } from '../components/GameMenu.tsx'
import { StoryMarkdown } from '../components/StoryMarkdown.tsx'
import { Link } from '../router.tsx'
import { EmptyText, ErrorCard, Metric, useLoad } from './common.tsx'
import { loadGame } from './gameData.ts'

export function MemoryPage({ gameId }: { gameId: string }) {
  const [state] = useLoad(() => loadGame(gameId), [gameId])
  if (state.status !== 'ready') {
    return <AppShell variant="focus">{state.status === 'loading' ? <Loading text="正在读取记忆…" /> : <ErrorCard message={state.message} />}</AppShell>
  }
  const { recap, turns, offstage, story } = state.data
  const windowFrom = (recap?.through ?? 0) + 1
  const windowTurns = turns.filter(t => t.turn >= windowFrom)

  return (
    <AppShell variant="focus">
      <GameSubpageShell
        active="memory"
        eyebrow="MEMO · 记忆"
        gameId={gameId}
        primaryAction={<Link className="px-btn px-btn-primary w-full sm:w-fit" href={`/games/${gameId}/play`}>▸ 继续冒险</Link>}
        subtitle="GM 写下一章时回看的东西：更早的剧情整理成前情提要，最近几章保留原文。数值与进度不靠它们，每回合另有面板。"
        title={story.title}
      >
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
          <Metric label="前情提要覆盖" value={recap ? `1–${recap.through}` : '—'} />
          <Metric label="原文章节" value={windowTurns.length} />
          <Metric label="场外往来" value={offstage.length} />
        </section>

        <section className="px-panel px-panel-strong px-panel-pad">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="px-heading text-base">前情提要</h2>
            {recap && <span className="px-badge">第 1–{recap.through} 回合</span>}
          </div>
          <div className="mt-3">
            {recap
              ? <StoryMarkdown className="text-sm" content={recap.text} />
              : <EmptyText>还没有前情提要——章节攒够之后，会在你读正文时自动整理，不占等待时间。</EmptyText>}
          </div>
        </section>

        <section className="px-panel px-panel-pad">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="px-heading text-base">原文章节</h2>
            {windowTurns.length > 0 && <span className="px-badge">第 {windowTurns[0].turn}–{windowTurns[windowTurns.length - 1].turn} 回合</span>}
          </div>
          <p className="mt-2 text-sm leading-6 text-[color:var(--muted)]">这些回合的正文原样放在 GM 的上下文里；全文在「旅程」里看。</p>
          <ul className="mt-3 grid gap-1 pl-4 text-sm leading-6 text-[color:var(--muted)]">
            {windowTurns.map(t => <li className="px-wrap list-disc" key={t.turn}>第 {t.turn} 回合{t.input ? `：${t.input}` : '：开场'}</li>)}
          </ul>
        </section>

        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-base">场外往来</h2>
          {offstage.length === 0
            ? <div className="mt-3"><EmptyText>还没有在场外和 GM 说过话。</EmptyText></div>
            : (
                <div className="mt-3 grid gap-3">
                  {offstage.map((o, i) => (
                    <div className="grid gap-2" key={i}>
                      <div className="dialogue-row dialogue-row-player"><span className="dialogue-name">▸ 你</span><p className="dialogue-bubble">{o.ask}</p></div>
                      <div className="dialogue-row"><span className="dialogue-name">▸ GM</span><p className="dialogue-bubble">{o.reply}</p></div>
                    </div>
                  ))}
                </div>
              )}
        </section>
      </GameSubpageShell>
    </AppShell>
  )
}
