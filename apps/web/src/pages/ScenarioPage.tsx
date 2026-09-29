/**
 * 剧本详情（Rpgforge 外观）：开始冒险、唤起 GM 修改、导出、删除；这部剧本的冒险；历史版本回滚；
 * 玩家可见的设定（BFF 已剥暗线；幕结构只露第一幕防剧透）。
 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { Link, navigate } from '../router.tsx'
import type { CredentialStatus } from '../types.ts'
import { ErrorCard, formatDateTime, PHASE_LABEL, useLoad } from './common.tsx'
import { MODULE_NAME, mechanicsSummary } from './scenarioBits.tsx'

export function ScenarioPage({ scenarioId, credential }: { scenarioId: string; credential?: CredentialStatus }) {
  const dialog = usePixelDialog()
  const [state, reload] = useLoad(async () => {
    const [story, games, versions] = await Promise.all([
      api.scenario(scenarioId),
      api.games(),
      api.listVersions(scenarioId),
    ])
    return { story, games: games.items.filter(g => g.storyId === scenarioId), versions: versions.versions }
  }, [scenarioId])
  const [note, setNote] = useState<string>()
  const [pending, setPending] = useState(false)
  const blocked = credential !== undefined && !credential.configured

  if (state.status !== 'ready') {
    return <AppShell>{state.status === 'loading' ? <Loading text="正在读取剧本…" /> : <ErrorCard message={state.message} />}</AppShell>
  }
  const { story, games, versions } = state.data

  const start = async () => {
    setPending(true)
    try {
      const { sessionId } = await api.createSession(story.id)
      navigate(`/games/${sessionId}/play`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
      setPending(false)
    }
  }

  const remove = async () => {
    const typed = await dialog.prompt(`删除《${story.title}》？剧本源与它的修改对话会一起移除，不可恢复，建议先导出留底。`, {
      title: '删除剧本',
      expect: story.title,
      placeholder: story.title,
      danger: true,
      confirmLabel: '删除',
    })
    if (typed === null) return
    try {
      await api.deleteScenario(story.id)
      navigate('/library', { replace: true })
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  const rollback = async (name: string) => {
    if (!(await dialog.confirm('回滚到这个历史版本？当前版会先自动留档，回滚后还能滚回来。进行中的冒险只有贴身提醒等热字段随之变化，其余下一局生效。', { confirmLabel: '回滚' }))) return
    try {
      const r = await api.restoreVersion(story.id, name)
      setNote(r.brief)
      reload()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  const mech = mechanicsSummary(story)

  return (
    <AppShell>
      <section className="px-panel px-panel-strong px-panel-pad">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0">
            <p className="px-eyebrow">SCRIPT · 剧本</p>
            <h1 className="px-heading mt-2 break-words text-2xl sm:text-3xl">{story.title}</h1>
            <p className="px-wrap mt-2 text-sm leading-6 text-[color:var(--muted)]">{story.tagline}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {story.world.tone.map(t => <span className="px-badge" key={t}>{t}</span>)}
              {story.craft?.modules.map(m => <span className="px-badge px-badge-amber" key={m}>{MODULE_NAME[m] ?? m}</span>)}
            </div>
            {story.craft?.rating && <p className="mt-2 text-xs text-[color:var(--muted)]">强度：{story.craft.rating}</p>}
          </div>
          <div className="grid w-full gap-2 sm:w-fit">
            <button className="px-btn px-btn-primary" disabled={pending || blocked} onClick={() => void start()} type="button">{pending ? '开局中…' : '▸ 开始新冒险'}</button>
            <Link className="px-btn" href={`/library/${story.id}/edit`}>✎ 唤起 GM 修改剧本</Link>
            <a className="px-btn" href={`/app/scenarios/${story.id}/export`} title="导出剧本源（含 GM 暗线，看了会剧透）">⇩ 导出</a>
          </div>
        </div>
      </section>
      {note && <p className="px-status">{note}</p>}

      <section className="px-panel px-panel-pad">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="px-heading text-base">这部剧本的冒险</h2>
          <span className="px-badge">{games.length} 局</span>
        </div>
        {games.length === 0
          ? <p className="mt-3 text-sm text-[color:var(--muted)]">还没有用这部剧本开过局。</p>
          : (
              <div className="mt-3 grid gap-2">
                {games.map(g => (
                  <Link className="save-slot" href={`/games/${g.sessionId}/play`} key={g.sessionId}>
                    <span className="flex flex-wrap items-center gap-2">
                      <strong>第 {g.turns} 回合{g.actTitle ? ` · ${g.actTitle}` : ''}</strong>
                      <span className="px-badge">{PHASE_LABEL[g.phase]}</span>
                    </span>
                    <span className="text-xs text-[color:var(--muted)]">更新于 {formatDateTime(g.updatedAt, true)}</span>
                  </Link>
                ))}
              </div>
            )}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-base">世界</h2>
          <p className="px-wrap mt-3 whitespace-pre-wrap text-sm leading-7 text-[color:var(--muted)]">{story.world.overview}</p>
        </section>
        <section className="px-panel px-panel-pad grid content-start gap-3">
          <div>
            <h2 className="px-heading text-base">主角</h2>
            <p className="mt-2 text-sm leading-6"><b>{story.protagonist.name}</b><span className="text-[color:var(--muted)]"> —— {story.protagonist.identity}</span></p>
          </div>
          {story.cast.length > 0 && (
            <div>
              <h2 className="px-heading text-base">出场人物</h2>
              <div className="mt-2 grid gap-1">
                {story.cast.map(c => <p className="text-sm leading-6" key={c.id}><b>{c.name}</b><span className="text-[color:var(--muted)]"> —— {c.identity}</span></p>)}
              </div>
            </div>
          )}
          <div>
            <h2 className="px-heading text-base">结构</h2>
            <p className="mt-2 text-sm leading-6 text-[color:var(--muted)]">
              共 {story.acts.length} 幕。第一幕《{story.acts[0]?.title}》：{story.acts[0]?.objective}
              {story.acts.length > 1 && ' 后续幕保持未知——留给游戏本身。'}
            </p>
            {mech.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{mech.map(m => <span className="px-badge" key={m}>{m}</span>)}</div>}
          </div>
        </section>
      </section>

      {versions.length > 0 && (
        <section className="px-panel px-panel-pad">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="px-heading text-base">历史版本</h2>
            <span className="px-badge">{versions.length} 版</span>
          </div>
          <div className="mt-3 grid gap-2">
            {versions.map(v => (
              <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[color:var(--border)] bg-[color:var(--input)] p-3" key={v.name}>
                <span className="text-sm">{formatDateTime(v.savedAt, true)} <span className="text-xs text-[color:var(--muted)]">· {Math.round(v.chars / 1000)}k 字符 · 覆盖发布前的自动留档</span></span>
                <button className="px-btn" onClick={() => void rollback(v.name)} type="button">↩ 回滚</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="px-fold border-[color:var(--danger-border)]">
        <summary className="text-[color:var(--danger-text)]">危险操作</summary>
        <div className="px-fold-body grid gap-3">
          <p className="text-sm leading-6 text-[color:var(--muted)]">删除剧本会移除剧本源与它的修改对话。还有冒险用着这部剧本时不能删——先在「读取存档」里删掉那些冒险。</p>
          <button className="px-btn px-btn-danger w-full sm:w-fit" onClick={() => void remove()} type="button">✕ 删除剧本</button>
        </div>
      </details>
    </AppShell>
  )
}
