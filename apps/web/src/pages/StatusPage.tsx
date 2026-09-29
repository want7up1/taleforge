/**
 * 状态页（外观移植自 Rpgforge 的 STATUS）：主角、当前局面、数值、等级与属性、物品、本幕进度、现行修订。
 * Rpgforge 的"地点/NPC 登记/任务/线索/文字关系"来自事后 LLM 提取，TaleForge 不记这些，这里换成自己的面板数据。
 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { GameSubpageShell } from '../components/GameMenu.tsx'
import { levelLabel, levelPct, MeterPanel, placementOf } from '../components/Meters.tsx'
import { Link } from '../router.tsx'
import { CompactField, EmptyText, ErrorCard, Metric, PHASE_LABEL, useLoad } from './common.tsx'
import { loadGame, type GameData } from './gameData.ts'

export function StatusPage({ gameId }: { gameId: string }) {
  const [state] = useLoad(() => loadGame(gameId), [gameId])
  return (
    <AppShell variant="focus">
      {state.status === 'loading'
        ? <Loading text="正在读取角色状态…" />
        : state.status === 'error' ? <ErrorCard message={state.message} /> : <StatusView gameId={gameId} data={state.data} />}
    </AppShell>
  )
}

const REVISION_LABEL: Record<string, string> = { world: '世界', cast: '人物', direction: '走向', resource: '资源', attribute: '属性', anchor: '锚点' }

function StatusView({ gameId, data }: { gameId: string; data: GameData }) {
  const { values, story, knownCast } = data
  const { mechanics, attributes, inventory, progress, progression, sessionStats } = values
  const act = progress ? progress.acts[progress.actIndex] : undefined
  const required = act?.anchors.filter(a => a.required) ?? []
  const done = required.filter(a => progress?.achieved.includes(a.id)).length
  const phase = progress?.phase ?? 'playing'
  const revisions = (progress?.revisions ?? []).filter(r => r.target !== 'anchor')
  const [flushNote, setFlushNote] = useState<string>()

  const flush = async () => {
    setFlushNote('落盘中…')
    try {
      const r = await api.flushRevisions(gameId)
      setFlushNote(`已落盘 ${r.applied} 条${r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''}——下一局从修订版开始`)
    } catch (err) {
      setFlushNote(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <GameSubpageShell
      active="status"
      eyebrow="STATUS · 状态"
      gameId={gameId}
      meta={phase !== 'playing' ? <span className="px-badge px-badge-amber">{PHASE_LABEL[phase]}</span> : undefined}
      primaryAction={<Link className="px-btn px-btn-primary w-full sm:w-fit" href={`/games/${gameId}/play`}>▸ 继续冒险</Link>}
      subtitle={story.protagonist.identity}
      title={story.protagonist.name}
    >
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Metric label="回合" value={sessionStats?.turns ?? 0} />
        <Metric label="当前幕" value={progress ? `${progress.actIndex + 1}/${progress.acts.length}` : '—'} />
        <Metric label="本幕锚点" value={required.length ? `${done}/${required.length}` : '—'} />
        <Metric label={progression ? '等级' : '修订'} value={progression ? levelLabel(progression, progression.level) : revisions.length} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="px-panel px-panel-strong px-panel-pad">
          <h2 className="px-heading text-base">主角</h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <CompactField label="姓名" value={story.protagonist.name} />
            <CompactField label="身份" value={story.protagonist.identity} />
          </div>
        </section>
        <section className="px-panel px-panel-strong px-panel-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="px-heading text-base">当前局面</h2>
            <span className="px-badge px-badge-bright">第 {sessionStats?.turns ?? 0} 回合</span>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <CompactField label="当前幕" value={act ? `第 ${(progress?.actIndex ?? 0) + 1} 幕 · ${act.title}` : '—'} />
            <CompactField label="本幕进度" value={required.length ? `${done}/${required.length} 个主线事件` : '—'} />
            <CompactField label="目标" value={act?.objective ?? '—'} />
            <CompactField label="节奏" value={progress ? (progress.pressure.level === 'low' ? '平稳' : `已停滞 ${progress.pressure.stalledTurns} 回合`) : '—'} />
          </div>
        </section>
      </section>

      {act && (
        <section className="px-panel px-panel-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="px-heading text-base">本幕</h2>
            <span className="px-badge">{act.title}</span>
          </div>
          {/* 防剧透：只列当前幕；未到的幕连标题都不出 */}
          <ul className="anchor-list">
            {act.anchors.map(a => (
              <li key={a.id} className={progress?.achieved.includes(a.id) ? 'done' : ''}>
                {progress?.achieved.includes(a.id) ? '✓' : '○'} {a.text}{a.required ? '' : '（可选）'}
              </li>
            ))}
          </ul>
        </section>
      )}

      {mechanics && mechanics.defs.some(d => placementOf(d) !== 'hidden') && (
        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-base">数值</h2>
          <div className="mt-3"><MeterPanel snapshot={mechanics} knownCast={knownCast} /></div>
        </section>
      )}

      {(progression || (attributes && attributes.defs.length > 0)) && (
        <section className="grid gap-4 xl:grid-cols-2">
          {progression && (
            <section className="px-panel px-panel-pad">
              <h2 className="px-heading text-base">等级</h2>
              <div className="mt-3 flex flex-wrap items-baseline gap-2">
                <b className="text-lg text-[color:var(--phosphor)]">{levelLabel(progression, progression.level)}</b>
                <span className="text-sm text-[color:var(--muted)]">{progression.label} {progression.xp}{progression.next !== null ? ` / ${progression.next}` : '（满级）'}</span>
              </div>
              <div className="level-track"><i style={{ width: `${levelPct(progression)}%` }} /></div>
              {progression.unspent > 0 && <p className="text-sm text-[color:var(--amber)]">还有 {progression.unspent} 点属性点未分配——在游玩页的手账里加点。</p>}
            </section>
          )}
          {attributes && attributes.defs.length > 0 && (
            <section className="px-panel px-panel-pad">
              <h2 className="px-heading text-base">属性</h2>
              <div className="attr-table mt-3">
                {attributes.defs.map(d => (
                  <div key={d.id} className="attr-row"><span>{d.label}</span><b>{attributes.state[d.id]?.value ?? d.initial}</b></div>
                ))}
              </div>
            </section>
          )}
        </section>
      )}

      {inventory && (
        <section className="px-panel px-panel-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="px-heading text-base">物品</h2>
            <span className="px-badge">{inventory.items.length} 种</span>
          </div>
          <div className="mt-3">
            {inventory.items.length === 0
              ? <EmptyText>两手空空。</EmptyText>
              : inventory.items.map(it => (
                  <div key={it.id} className="inv-row">
                    <span>{it.name}</span>
                    {it.qty > 1 && <b className="inv-qty">×{it.qty}</b>}
                    {it.note && <span className="text-xs text-[color:var(--muted)]">{it.note}</span>}
                  </div>
                ))}
          </div>
        </section>
      )}

      {revisions.length > 0 && (
        <section className="px-panel px-panel-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="px-heading text-base">场外修订</h2>
            <button className="px-btn" onClick={() => void flush()} type="button">⇩ 落盘到剧本（下一局生效）</button>
          </div>
          <div className="mt-3 grid gap-2">
            {revisions.map((r, i) => (
              <article className="px-card" key={i}>
                <span className="px-badge">{REVISION_LABEL[r.target] ?? r.target}</span>
                <p className="px-wrap mt-2 text-sm leading-6 text-[color:var(--muted)]">{r.text ?? r.guidance ?? `${r.id ?? ''} 边界调整`}</p>
              </article>
            ))}
          </div>
          {flushNote && <p className="px-status mt-3">{flushNote}</p>}
        </section>
      )}
    </GameSubpageShell>
  )
}
