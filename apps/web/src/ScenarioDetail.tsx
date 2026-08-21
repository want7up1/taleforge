/**
 * 剧本详情页：介绍与各项设定的玩家可见视图（BFF 已剥暗线；幕结构只露第一幕防剧透），
 * 加上这个剧本自己的进行中会话与存档（快照）。修改剧本 = 在本页唤起 GM 对话。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import type { SessionSummary, StoryDetail } from './types.ts'

interface SaveItem {
  name: string
  sessionId: string
  backedAt: number
  title?: string
  agentPreset?: string
  turns?: number
}

interface Props {
  story: StoryDetail
  /** 全平台当前唯一进行中的会话（可能属于别的剧本——开新局/读档都会覆盖它） */
  current?: SessionSummary
  blocked?: boolean
  onStart: () => void
  onResume: (session: SessionSummary) => void
  /** 读档成功后带着恢复出的会话直接进游戏 */
  onLoaded: (sessionId: string) => void
  onEdit: () => void
  onDeleted: () => void
  onRefresh: () => void
  onBack: () => void
}

const MODULE_NAME: Record<string, string> = {
  standard: '标准叙事',
  shuang: '爽文',
  harem: '关系与张力',
  hardcore: '硬核',
}

export function ScenarioDetail({
  story,
  current,
  blocked,
  onStart,
  onResume,
  onLoaded,
  onEdit,
  onDeleted,
  onRefresh,
  onBack,
}: Props) {
  const [saves, setSaves] = useState<SaveItem[]>([])
  const [versions, setVersions] = useState<{ name: string; savedAt: number; chars: number }[]>([])
  const [note, setNote] = useState<string>()
  /** 本剧本自己的进行中会话（current 可能属于别的剧本，那种只用于覆盖确认） */
  const mine = current?.agentPreset === story.id ? current : undefined

  const loadSaves = useCallback(() => {
    api.listSaves()
      .then(r => setSaves(r.items.filter(s => s.agentPreset === story.id)))
      .catch(() => undefined)
    api.listVersions(story.id)
      .then(r => setVersions(r.versions))
      .catch(() => undefined)
  }, [story.id])

  useEffect(() => {
    loadSaves()
  }, [loadSaves])

  const remove = async () => {
    if (!confirm(`删除《${story.title}》？剧本源、上架版本连同它的存档都会移除，建议先导出留底。`)) return
    setNote('删除中…')
    try {
      await api.deleteScenario(story.id)
      onDeleted()
    } catch (err) {
      setNote(String(err))
    }
  }

  const snapshot = async () => {
    if (!mine) return
    setNote('存档中…')
    try {
      await api.saveSnapshot(mine.sessionId)
      setNote('已存档——快照存在服务器上，容器重建不丢')
      loadSaves()
    } catch (err) {
      setNote(String(err))
    }
  }

  const removeSession = async () => {
    if (!mine) return
    if (!confirm('删除进行中的会话？此操作不可撤销（可先存档）。')) return
    try {
      await api.deleteSession(mine.sessionId)
      setNote('会话已删除')
      onRefresh()
    } catch (err) {
      setNote(String(err))
    }
  }

  const load = async (name: string) => {
    if (current && !confirm('读档会覆盖当前进行中的会话，确定吗？')) return
    setNote('读档中…')
    try {
      const { sessionId } = await api.loadSave(name)
      onLoaded(sessionId)
    } catch (err) {
      setNote(String(err))
    }
  }

  const removeSave = async (name: string) => {
    if (!confirm('删除这份存档？')) return
    try {
      await api.deleteSave(name)
      loadSaves()
    } catch (err) {
      setNote(String(err))
    }
  }

  const rollback = async (name: string) => {
    if (!confirm('回滚到这个历史版本？当前版会先自动留档，回滚后还能滚回来。进行中的局仅贴身提醒等热字段随之变化，其余下一局生效。')) return
    setNote('回滚中…')
    try {
      const r = await api.restoreVersion(story.id, name)
      setNote(r.brief)
      onRefresh()
      loadSaves()
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
        mech.progression ? `经验等级（满级 ${(mech.progression.thresholds?.length ?? 0) + 1}，每级 ${mech.progression.pointsPerLevel ?? '?'} 点）` : null,
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
                if (current && !confirm('开新局会覆盖当前进行中的会话（可先存档），确定吗？')) return
                onStart()
              }}
            >
              {current ? '覆盖并开始 ▸' : '开始游戏 ▸'}
            </button>
            <button className="ghost" onClick={onEdit} disabled={blocked} title="唤起 GM 对话修改本剧本">✎ 修改剧本</button>
            <a className="ghost" href={`/app/scenarios/${story.id}/export`} title="导出剧本源（含 GM 暗线，看了会剧透）">⤓ 导出</a>
            <button className="ghost danger" onClick={() => void remove()}>✕ 删除</button>
          </div>
          {note && <p className="muted">{note}</p>}

          {mine && (
            <section>
              <h3 className="section-title">进行中</h3>
              <div className="saves">
                <div className="save-row-wrap">
                  <button className="save-row" onClick={() => onResume(mine)}>
                    <span className="save-title">{mine.projections?.values.title ?? '未命名进度'}</span>
                    <span className="save-meta">{new Date(mine.updatedAt).toLocaleString()} · 点击继续</span>
                  </button>
                  <div className="save-actions">
                    <button className="ghost" onClick={() => void snapshot()} title="快照当前进度">⤓ 存档</button>
                    <button className="ghost danger" onClick={() => void removeSession()} title="删除进行中的会话">✕ 删除</button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {saves.length > 0 && (
            <section>
              <h3 className="section-title">存档</h3>
              <div className="saves">
                {saves.map(s => (
                  <div key={s.name} className="save-row-wrap">
                    <div className="save-row static">
                      <span className="save-title">{s.title ?? s.sessionId.slice(0, 16)}</span>
                      <span className="save-meta">
                        {s.turns !== undefined && `${s.turns} 回合 · `}
                        {new Date(s.backedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="save-actions">
                      <button className="ghost" onClick={() => void load(s.name)}>↻ 读档</button>
                      <button className="ghost danger" onClick={() => void removeSave(s.name)}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {versions.length > 0 && (
            <section>
              <h3 className="section-title">剧本历史版本</h3>
              <div className="saves">
                {versions.map(v => (
                  <div key={v.name} className="save-row-wrap">
                    <div className="save-row static">
                      <span className="save-title">{new Date(v.savedAt).toLocaleString()}</span>
                      <span className="save-meta">{Math.round(v.chars / 1000)}k 字符 · 覆盖发布前的自动留档</span>
                    </div>
                    <div className="save-actions">
                      <button className="ghost" onClick={() => void rollback(v.name)}>↩ 回滚</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

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
