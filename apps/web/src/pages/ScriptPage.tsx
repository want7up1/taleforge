/**
 * 设定页（外观移植自 Rpgforge 的 SCRIPT）：这局开局时锁定的剧本，只读。
 * 改剧本仍走剧本详情页唤起 GM（用户定的唯一入口；表单式看板属于"可视化编辑器"，不做）。
 * 防剧透：人物只列已出场的，幕只列已到和当前的。
 */
import { AppShell, Loading } from '../components/AppShell.tsx'
import { GameSubpageShell } from '../components/GameMenu.tsx'
import { Link } from '../router.tsx'
import { ErrorCard, useLoad } from './common.tsx'
import { loadGame } from './gameData.ts'
import { MODULE_NAME, mechanicsSummary } from './scenarioBits.tsx'

export function ScriptPage({ gameId }: { gameId: string }) {
  const [state] = useLoad(() => loadGame(gameId), [gameId])
  if (state.status !== 'ready') {
    return <AppShell variant="focus">{state.status === 'loading' ? <Loading text="正在读取设定…" /> : <ErrorCard message={state.message} />}</AppShell>
  }
  const { story, values, knownCast } = state.data
  const progress = values.progress
  const actIndex = progress?.actIndex ?? 0
  const acts = (progress?.acts ?? story.acts).slice(0, (progress?.phase === 'ended' ? story.acts.length : actIndex + 1))
  const mech = mechanicsSummary(story)

  return (
    <AppShell variant="focus">
      <GameSubpageShell
        active="settings"
        eyebrow="SCRIPT · 设定"
        gameId={gameId}
        primaryAction={
          <div className="grid w-full gap-2 sm:flex sm:w-fit sm:flex-wrap sm:justify-end">
            <Link className="px-btn w-full sm:w-fit" href={`/library/${story.id}/edit`}>✎ 唤起 GM 修改剧本</Link>
            <Link className="px-btn px-btn-primary w-full sm:w-fit" href={`/games/${gameId}/play`}>▸ 继续冒险</Link>
          </div>
        }
        subtitle={story.tagline}
        title={story.title}
      >
        <section className="px-panel px-panel-strong px-panel-pad">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="px-heading text-base">设定概览</h2>
            {story.world.tone.map(t => <span key={t} className="px-badge">{t}</span>)}
            {story.craft?.modules.map(m => <span key={m} className="px-badge px-badge-amber">{MODULE_NAME[m] ?? m}</span>)}
          </div>
          {story.craft?.rating && <p className="mt-3 text-sm text-[color:var(--muted)]">强度：{story.craft.rating}</p>}
          <p className="mt-3 text-xs leading-5 text-[color:var(--faint)]">这局用的是开局时的剧本版本。修改剧本后，贴身提醒、强度词表、设定条目这几项下一回合就生效，其余从下一局开始。</p>
        </section>

        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-base">世界</h2>
          <p className="px-wrap mt-3 whitespace-pre-wrap text-sm leading-7 text-[color:var(--muted)]">{story.world.overview}</p>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <section className="px-panel px-panel-pad">
            <h2 className="px-heading text-base">主角</h2>
            <p className="mt-3 font-bold">{story.protagonist.name}</p>
            <p className="px-wrap mt-1 text-sm leading-6 text-[color:var(--muted)]">{story.protagonist.identity}</p>
            {story.protagonist.voice && <p className="mt-2 text-xs text-[color:var(--faint)]">叙述：{story.protagonist.voice}</p>}
          </section>
          <section className="px-panel px-panel-pad">
            <h2 className="px-heading text-base">已结识的人</h2>
            <div className="mt-3 grid gap-2">
              {story.cast.filter(c => knownCast.has(c.id)).map(c => (
                <p key={c.id} className="text-sm leading-6"><b>{c.name}</b><span className="text-[color:var(--muted)]"> —— {c.identity}</span></p>
              ))}
              {story.cast.some(c => !knownCast.has(c.id)) && <p className="text-xs text-[color:var(--faint)]">…还有尚未登场的人。</p>}
            </div>
          </section>
        </section>

        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-base">幕</h2>
          <div className="mt-3 grid gap-2">
            {acts.map((a, i) => (
              <article className="px-card" key={a.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <strong>第 {i + 1} 幕 · {a.title}</strong>
                  {i < actIndex || progress?.phase === 'ended' ? <span className="px-badge">已完成</span> : <span className="px-badge px-badge-bright">当前</span>}
                </div>
                <p className="px-wrap mt-2 text-sm leading-6 text-[color:var(--muted)]">{a.objective}</p>
              </article>
            ))}
            {story.acts.length > acts.length && <p className="text-xs text-[color:var(--faint)]">后面还有 {story.acts.length - acts.length} 幕，留给游戏本身。</p>}
          </div>
        </section>

        {mech.length > 0 && (
          <section className="px-panel px-panel-pad">
            <h2 className="px-heading text-base">机制</h2>
            <div className="mt-3 flex flex-wrap gap-2">{mech.map(m => <span className="px-badge" key={m}>{m}</span>)}</div>
          </section>
        )}
      </GameSubpageShell>
    </AppShell>
  )
}
