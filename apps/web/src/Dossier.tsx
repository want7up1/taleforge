/** 卷宗抽屉：剧本静态信息 + 会话统计。全部零成本数据，不依赖任何状态提取。 */
import { useEffect } from 'react'
import type { SessionStats, StoryDetail } from './types.ts'

interface Props {
  story: StoryDetail
  stats?: SessionStats
  focus?: string
  onClose: () => void
}

export function Dossier({ story, stats, focus, onClose }: Props) {
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

        <section>
          <h3>主角</h3>
          <p className="name">{story.protagonist.name}</p>
          <p className="muted">{story.protagonist.identity}</p>
        </section>

        <section>
          <h3>你已知的人</h3>
          {story.cast.map(c => (
            <div key={c.id} className={`cast-row${focused?.id === c.id ? ' on' : ''}`}>
              <p className="name">{c.name}</p>
              <p className="muted">{c.identity}</p>
            </div>
          ))}
        </section>

        <section>
          <h3>世界</h3>
          <p className="muted">{story.world.overview}</p>
          <div className="tags">
            {story.world.tone.map(t => <span key={t} className="tag">{t}</span>)}
          </div>
        </section>

        <section>
          <h3>幕</h3>
          {story.acts.map((act, i) => (
            <div key={act.id} className="act-row">
              <p className="name">{i + 1}. {act.title}</p>
              <p className="muted">{act.objective}</p>
            </div>
          ))}
          <p className="hint">进度追踪将随机制引擎一同上线。</p>
        </section>

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
