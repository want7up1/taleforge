/** 卷宗抽屉：剧本静态信息 + 幕进度 + 会话统计。数据全部来自投影与剧本详情。 */
import { useEffect } from 'react'
import { MeterPanel } from './Meters.tsx'
import type {
  AttributesSnapshot,
  InventorySnapshot,
  MechanicsSnapshot,
  ProgressSnapshot,
  SessionStats,
  StoryDetail,
} from './types.ts'

interface Props {
  story: StoryDetail
  stats?: SessionStats
  mechanics?: MechanicsSnapshot
  attributes?: AttributesSnapshot
  inventory?: InventorySnapshot
  progress?: ProgressSnapshot
  /** 防剧透：已在正文出场的人物 id 集合 */
  knownCast?: Set<string>
  focus?: string
  onClose: () => void
  /** 修订落盘：合并回剧本源，下一局生效 */
  onFlushRevisions?: () => void
  flushNote?: string
}

export function Dossier({ story, stats, mechanics, attributes, inventory, progress, knownCast, focus, onClose, onFlushRevisions, flushNote }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const focused = focus ? story.cast.find(c => c.name === focus) : undefined

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <h2>卷宗</h2>
          <button className="ghost" onClick={onClose}>关闭 ✕</button>
        </div>

        {focused && (
          <section className="focus-card">
            <h3>{focused.name}</h3>
            <p>{focused.identity}</p>
          </section>
        )}

        {mechanics && <MeterPanel snapshot={mechanics} knownCast={knownCast} />}

        {attributes && attributes.defs.length > 0 && (
          <section>
            <h3>属性</h3>
            <div className="attr-table">
              {attributes.defs.map(d => (
                <div key={d.id} className="attr-row">
                  <span>{d.label}</span>
                  <b>{attributes.state[d.id]?.value ?? d.initial}</b>
                </div>
              ))}
            </div>
          </section>
        )}

        {inventory && inventory.items.length > 0 && (
          <section>
            <h3>物品</h3>
            {inventory.items.map(it => (
              <div key={it.id} className="inv-row">
                <span className="name">{it.name}</span>
                {it.qty > 1 && <b className="inv-qty">×{it.qty}</b>}
                {it.note && <span className="muted">{it.note}</span>}
              </div>
            ))}
          </section>
        )}

        <section>
          <h3>主角</h3>
          <p className="name">{story.protagonist.name}</p>
          <p className="muted">{story.protagonist.identity}</p>
        </section>

        <section>
          <h3>你已知的人</h3>
          {/* 防剧透：只列正文中真实出场过的人物 */}
          {story.cast.filter(c => !knownCast || knownCast.has(c.id)).map(c => (
            <div key={c.id} className={`cast-row${focused?.id === c.id ? ' on' : ''}`}>
              <p className="name">{c.name}</p>
              <p className="muted">{c.identity}</p>
            </div>
          ))}
          {knownCast && story.cast.some(c => !knownCast.has(c.id)) && (
            <p className="dim">…还有尚未遇到的人。</p>
          )}
        </section>

        <section>
          <h3>世界</h3>
          <p className="muted">{story.world.overview}</p>
          <div className="tags">
            {story.world.tone.map(t => <span key={t} className="tag">{t}</span>)}
          </div>
        </section>

        <section>
          <h3>幕{progress?.phase === 'ended' ? ' · 剧终' : ''}</h3>
          {(progress?.acts ?? story.acts).map((act, i) => {
            const isCurrent = progress ? progress.phase === 'playing' && i === progress.actIndex : false
            const isPast = progress ? i < progress.actIndex || progress.phase === 'ended' : false
            // 防剧透：未到的幕只露序号，标题与目标都是剧透
            if (progress && !isCurrent && !isPast) {
              return (
                <div key={act.id} className="act-row">
                  <p className="name dim">第 {i + 1} 幕：？？？</p>
                </div>
              )
            }
            return (
              <div key={act.id} className={`act-row${isCurrent ? ' on' : ''}`}>
                <p className="name">{isPast ? '✓ ' : ''}{act.title}{isCurrent ? '（当前）' : ''}</p>
                <p className="muted">{act.objective}</p>
                {isCurrent && (
                  <ul className="anchor-list">
                    {act.anchors.map(a => (
                      <li key={a.id} className={progress!.achieved.includes(a.id) ? 'done' : ''}>
                        {progress!.achieved.includes(a.id) ? '✓' : '○'} {a.text}{a.required ? '' : '（可选）'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </section>

        {progress && progress.revisions.length > 0 && (
          <section>
            <h3>场外修订</h3>
            {progress.revisions.filter(r => r.target !== 'anchor').map((r, i) => (
              <p key={i} className="muted">
                [{{ world: '世界', cast: '人物', direction: '走向', resource: '资源', attribute: '属性' }[r.target] ?? r.target}] {r.text ?? r.guidance ?? `${r.id ?? ''} 边界调整`}
              </p>
            ))}
            {onFlushRevisions && (
              <button className="ghost" onClick={onFlushRevisions}>⇩ 落盘到剧本（下一局生效）</button>
            )}
            {flushNote && <p className="muted">{flushNote}</p>}
          </section>
        )}

        {stats && (
          <section>
            <h3>本局</h3>
            <div className="metrics">
              <div><b>{stats.turns}</b><span>回合</span></div>
              <div><b>{Math.round(stats.llmMs / 1000)}s</b><span>生成耗时</span></div>
              <div><b>{stats.decodeTokens}</b><span>产出 token</span></div>
            </div>
          </section>
        )}
      </aside>
    </>
  )
}
