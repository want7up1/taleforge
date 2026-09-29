/**
 * 营地（外观移植自 Rpgforge 的 CAMP）：当前局面、存档水晶（带名称备注存档 / 读档 / 删档 / 从头重开）、
 * 营火日志（前情提要）、导出剧本、危险篝火（删除这一局）。
 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { GameSubpageShell } from '../components/GameMenu.tsx'
import { levelLabel } from '../components/Meters.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { Link, navigate } from '../router.tsx'
import type { SaveItem } from '../types.ts'
import { ErrorCard, formatDateTime, Metric, PHASE_LABEL, useLoad } from './common.tsx'
import { loadGame, type GameData } from './gameData.ts'

export function CampPage({ gameId }: { gameId: string }) {
  const [state, reload] = useLoad(async () => {
    const [data, saves] = await Promise.all([loadGame(gameId), api.saves(gameId)])
    return { data, saves: saves.items }
  }, [gameId])
  return (
    <AppShell variant="focus">
      {state.status === 'loading'
        ? <Loading text="正在读取营地…" />
        : state.status === 'error'
          ? <ErrorCard message={state.message} />
          : <CampView gameId={gameId} data={state.data.data} saves={state.data.saves} onChanged={reload} />}
    </AppShell>
  )
}

function CampView({ gameId, data, saves, onChanged }: { gameId: string; data: GameData; saves: SaveItem[]; onChanged: () => void }) {
  const dialog = usePixelDialog()
  const { story, values, turns, recap } = data
  const progress = values.progress
  const phase = progress?.phase ?? 'playing'
  const turnNo = turns[turns.length - 1]?.turn ?? 0
  const act = progress?.acts[progress.actIndex]
  const [deleteError, setDeleteError] = useState<string>()

  const deleteGame = async () => {
    const typed = await dialog.prompt(`删除这局冒险？剧情与它的全部存档水晶都会从列表里移除，不可恢复。`, {
      title: '删除冒险',
      expect: story.title,
      placeholder: story.title,
      danger: true,
      confirmLabel: '删除',
    })
    if (typed === null) return
    try {
      await api.deleteSession(gameId)
      navigate('/games', { replace: true })
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <GameSubpageShell
      active="camp"
      eyebrow="CAMP · 营地"
      gameId={gameId}
      meta={<span className="px-badge px-badge-bright">{PHASE_LABEL[phase]}</span>}
      primaryAction={
        <div className="grid w-full gap-2 sm:flex sm:w-fit sm:flex-wrap sm:justify-end">
          <a className="px-btn w-full sm:w-fit" href={`/app/scenarios/${story.id}/export`}>⇩ 导出剧本</a>
          <Link className="px-btn px-btn-primary w-full sm:w-fit" href={`/games/${gameId}/play`}>{turnNo > 0 ? '▸ 继续冒险' : '▸ 开始冒险'}</Link>
        </div>
      }
      subtitle={story.tagline}
      title={story.title}
    >
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Metric label="回合" value={turnNo} />
        <Metric label="幕" value={progress ? `${progress.actIndex + 1}/${progress.acts.length}` : '—'} />
        <Metric label="存档" value={saves.length} />
        <Metric label={values.progression ? '等级' : '场外修订'} value={values.progression ? levelLabel(values.progression, values.progression.level) : (progress?.revisions.length ?? 0)} />
      </section>

      <section className="px-panel px-panel-strong px-panel-pad">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="px-heading text-base">当前局面</h2>
              {phase !== 'playing' && <span className="px-badge px-badge-amber">{PHASE_LABEL[phase]}</span>}
            </div>
            <p className="mt-1 text-sm leading-6 text-[color:var(--muted)]">{story.protagonist.name} · {story.protagonist.identity}</p>
            {act && <p className="mt-1 text-sm leading-6 text-[color:var(--muted)]">第 {(progress?.actIndex ?? 0) + 1} 幕 · {act.title} —— {act.objective}</p>}
          </div>
          <Link className="px-btn w-full sm:w-fit" href={`/games/${gameId}/status`}>查看状态 STATUS ▸</Link>
        </div>
      </section>

      <SaveCrystals gameId={gameId} turnNo={turnNo} title={story.title} saves={saves} onChanged={onChanged} />

      <section className="px-panel px-panel-strong px-panel-pad">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="px-heading text-base">营火日志</h2>
            {recap && <span className="px-badge">第 1–{recap.through} 回合</span>}
          </div>
          <Link className="px-btn w-full sm:w-fit" href={`/games/${gameId}/memory`}>打开记忆 MEMO ▸</Link>
        </div>
        <article className="px-card px-card-green mt-4">
          <p className="px-wrap max-h-56 overflow-auto whitespace-pre-wrap text-sm leading-6 text-[color:var(--muted)]">
            {recap?.text || '暂无前情提要。章节攒够之后，会在你读正文时自动整理。'}
          </p>
        </article>
      </section>

      <details className="px-fold border-[color:var(--danger-border)]">
        <summary className="text-[color:var(--danger-text)]">危险篝火 · 危险操作</summary>
        <div className="px-fold-body grid gap-3">
          <p className="text-sm leading-6 text-[color:var(--muted)]">删除会把这局冒险从列表里移除，它的存档水晶一并删除。剧本本身不受影响。</p>
          {deleteError && <div className="px-alert">{deleteError}</div>}
          <button className="px-btn px-btn-danger w-full sm:w-fit" onClick={() => void deleteGame()} type="button">✕ 删除这局冒险</button>
        </div>
      </details>
    </GameSubpageShell>
  )
}

function SaveCrystals({ gameId, turnNo, title, saves, onChanged }: { gameId: string; turnNo: number; title: string; saves: SaveItem[]; onChanged: () => void }) {
  const dialog = usePixelDialog()
  const defaultName = () => `第 ${turnNo} 回合 · ${formatDateTime(Date.now())}`
  const [label, setLabel] = useState(defaultName)
  const [note, setNote] = useState('')
  const [op, setOp] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()

  const run = async (key: string, pending: string, done: string, fn: () => Promise<unknown>) => {
    setOp(key)
    setStatus(pending)
    setError(undefined)
    try {
      await fn()
      setStatus(done)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus(undefined)
    } finally {
      setOp(undefined)
    }
  }

  const create = () => run('create', '正在创建存档…', '存档已创建。', async () => {
    await api.createSave(gameId, label.trim(), note.trim())
    setLabel(defaultName())
    setNote('')
  })

  const load = async (s: SaveItem) => {
    if (!(await dialog.confirm(`读取「${s.label}」会把这局冒险恢复到第 ${s.turns} 回合，当前进度被覆盖（其他存档不受影响）。确定读取？`, { confirmLabel: '读取' }))) return
    await run(`load-${s.name}`, '正在读取存档…', '已恢复到存档那一刻。', async () => {
      await api.loadSave(gameId, s.name)
      navigate(`/games/${gameId}/play`)
    })
  }

  const remove = async (s: SaveItem) => {
    if (!(await dialog.confirm(`删除存档「${s.label}」？`, { confirmLabel: '删除', danger: true }))) return
    await run(`delete-${s.name}`, '正在删除存档…', '存档已删除。', () => api.deleteSave(gameId, s.name))
  }

  const restart = async () => {
    const typed = await dialog.prompt('从头重开会清空这局的全部回合（原稿留档），存档水晶保持不变。', {
      title: '重新开始',
      expect: title,
      placeholder: title,
      danger: true,
      confirmLabel: '重新开始',
    })
    if (typed === null) return
    await run('restart', '正在重新开始…', '已重新开始。', async () => {
      await api.restart(gameId)
      navigate(`/games/${gameId}/play`)
    })
  }

  return (
    <section className="px-panel px-panel-strong px-panel-pad">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="px-heading text-base">存档水晶</h2>
            <span className="px-badge">{saves.length} 个存档</span>
          </div>
          <p className="mt-1 text-sm leading-6 text-[color:var(--muted)]">把这局冒险此刻的进度封进水晶，之后随时读回来。不会保存或改动剧本本身。</p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="px-label">存档名称</span>
              <input className="px-input" disabled={op !== undefined} onChange={e => setLabel(e.target.value)} value={label} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="px-label">备注</span>
              <textarea className="px-input min-h-24 resize-y leading-6" disabled={op !== undefined} onChange={e => setNote(e.target.value)} placeholder="可选" value={note} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button className="px-btn px-btn-primary" disabled={op !== undefined || !label.trim()} onClick={() => void create()} type="button">
                {op === 'create' ? '创建中…' : '◈ 创建存档'}
              </button>
              <button className="px-btn px-btn-amber" disabled={op !== undefined} onClick={() => void restart()} type="button">
                {op === 'restart' ? '重开中…' : '↺ 从头重开这一局'}
              </button>
            </div>
            {status && <p className="px-status">{status}</p>}
            {error && <p className="px-alert">{error}</p>}
          </div>
        </div>
        <div className="grid content-start gap-3">
          {saves.length === 0
            ? <p className="px-empty">暂无存档。</p>
            : saves.map((s, index) => (
                <article className="save-slot" key={s.name}>
                  <span className="save-slot-index">SAVE {index + 1}</span>
                  <div className="flex flex-col gap-2 pr-12 sm:flex-row sm:items-start sm:justify-between sm:pr-0">
                    <div className="min-w-0">
                      <h3 className="font-bold">{s.label}</h3>
                      <p className="mt-1 text-xs text-[color:var(--muted)]">第 {s.turns} 回合 · {formatDateTime(s.backedAt)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="px-btn" disabled={op !== undefined} onClick={() => void load(s)} type="button">{op === `load-${s.name}` ? '读取中…' : '读取'}</button>
                      <button className="px-btn px-btn-danger" disabled={op !== undefined} onClick={() => void remove(s)} type="button">{op === `delete-${s.name}` ? '删除中…' : '删除'}</button>
                    </div>
                  </div>
                  {s.note && <p className="px-wrap whitespace-pre-wrap text-sm leading-6 text-[color:var(--muted)]">{s.note}</p>}
                </article>
              ))}
        </div>
      </div>
    </section>
  )
}
