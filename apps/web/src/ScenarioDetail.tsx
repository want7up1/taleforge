/**
 * 剧本详情页：介绍与各项设定的玩家可见视图（BFF 已剥暗线；幕结构只露第一幕防剧透）。
 * 动作：开始游戏 / 导出 / 删除；修改剧本走工坊对话。
 */
import { useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import type { StoryDetail } from './types.ts'

interface Props {
  story: StoryDetail
  /** 当前有存档时开始新局需要确认覆盖 */
  hasSave: boolean
  blocked?: boolean
  onStart: () => void
  onDeleted: () => void
  onBack: () => void
  onWorkshop: () => void
}

const MODULE_NAME: Record<string, string> = {
  standard: '标准叙事',
  shuang: '爽文',
  harem: '关系与张力',
  hardcore: '硬核',
}

export function ScenarioDetail({ story, hasSave, blocked, onStart, onDeleted, onBack, onWorkshop }: Props) {
  const [note, setNote] = useState<string>()

  const remove = async () => {
    if (!confirm(`删除《${story.title}》？剧本源与上架版本都会移除，建议先导出留底。`)) return
    setNote('删除中…')
    try {
      await api.deleteScenario(story.id)
      onDeleted()
    } catch (err) {
      setNote(String(err))
    }
  }

  const mech = story.mechanics
  const mechParts = mech
    ? [
        mech.resources?.length ? `资源条 ×${mech.resources.length}` : null,
        mech.attributes?.length ? `属性 ×${mech.attributes.length}` : null,
        mech.checks ? `掷骰判定（${mech.checks.die ?? 'd20'}）` : null,
        mech.inventory ? `物品栏（初始 ${mech.inventory.initial?.length ?? 0} 件）` : null,
      ].filter(Boolean) as string[]
    : []

  return (
    <div className="screen">
      <header className="topbar">
        <Brand />
        <div className="crumbs"><b>{story.title}</b></div>
        <div className="tools">
          <button onClick={onBack} title="返回">←<span className="t"> 返回</span></button>
        </div>
      </header>

      <div className="scroll">
        <div className="column detail">
          <section>
            <h2 className="detail-title">{story.title}</h2>
            <p className="detail-tagline">{story.tagline}</p>
            <div className="tags">
              {story.world.tone.map(t => <span key={t} className="tag">{t}</span>)}
              {story.craft?.modules.map(m => <span key={m} className="tag tag-craft">{MODULE_NAME[m] ?? m}</span>)}
            </div>
            {story.craft?.rating && <p className="muted detail-rating">强度：{story.craft.rating}</p>}
          </section>

          <div className="card-actions detail-actions">
            <button
              disabled={blocked}
              onClick={() => {
                if (hasSave && !confirm('开新局会覆盖当前存档（可先回列表备份），确定吗？')) return
                onStart()
              }}
            >
              {hasSave ? '覆盖并开始 ▸' : '开始游戏 ▸'}
            </button>
            <a className="ghost" href={`/app/scenarios/${story.id}/export`} title="导出剧本源（含 GM 暗线，看了会剧透）">⤓ 导出</a>
            <button className="ghost danger" onClick={() => void remove()}>✕ 删除</button>
            <button className="ghost" onClick={onWorkshop} title="进工坊对话修改本剧本">✎ 去工坊改</button>
          </div>
          {note && <p className="muted">{note}</p>}

          <section>
            <h3 className="section-title">世界</h3>
            <p className="muted detail-overview">{story.world.overview}</p>
          </section>

          <section>
            <h3 className="section-title">主角</h3>
            <p><b>{story.protagonist.name}</b> —— {story.protagonist.identity}</p>
          </section>

          {story.cast.length > 0 && (
            <section>
              <h3 className="section-title">出场人物</h3>
              {story.cast.map(c => (
                <p key={c.id} className="detail-cast"><b>{c.name}</b> —— {c.identity}</p>
              ))}
            </section>
          )}

          <section>
            <h3 className="section-title">结构</h3>
            <p className="muted">
              共 {story.acts.length} 幕。第一幕《{story.acts[0]?.title}》：{story.acts[0]?.objective}
              {story.acts.length > 1 && ' 后续幕保持未知——留给游戏本身。'}
            </p>
            {mechParts.length > 0 && <p className="muted">机制：{mechParts.join('、')}</p>}
          </section>
        </div>
      </div>
    </div>
  )
}
