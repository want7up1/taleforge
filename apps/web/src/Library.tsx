/** 主界面 = 游戏列表：继续冒险、剧本卡（点击进详情）、存档备份区。工坊与设置在顶栏。 */
import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import type { CredentialStatus, ScenarioSummary, SessionSummary } from './types.ts'

interface BackupItem {
  name: string
  sessionId: string
  backedAt: number
  title?: string
  agentPreset?: string
  turns?: number
}

interface Props {
  scenarios: ScenarioSummary[]
  sessions: SessionSummary[]
  credential?: CredentialStatus
  error?: string
  onOpenScenario: (id: string) => void
  onResume: (session: SessionSummary) => void
  onSettings: () => void
  onWorkshop: () => void
  onRefresh: () => void
}

export function Library({
  scenarios,
  sessions,
  credential,
  error,
  onOpenScenario,
  onResume,
  onSettings,
  onWorkshop,
  onRefresh,
}: Props) {
  const blocked = credential && !credential.configured
  const current = sessions[0]
  const [backups, setBackups] = useState<BackupItem[]>([])
  const [note, setNote] = useState<string>()

  const loadBackups = useCallback(() => {
    api.listBackups().then(r => setBackups(r.items)).catch(() => undefined)
  }, [])

  useEffect(() => {
    loadBackups()
  }, [loadBackups])

  const backupCurrent = async () => {
    if (!current) return
    setNote('备份中…')
    try {
      await api.backupSession(current.sessionId)
      setNote('已备份——快照存在服务器上，容器重建不丢')
      loadBackups()
    } catch (err) {
      setNote(String(err))
    }
  }

  const deleteCurrent = async () => {
    if (!current) return
    if (!confirm('删除当前存档？此操作不可撤销（可先备份）。')) return
    try {
      await api.deleteSession(current.sessionId)
      setNote('存档已删除')
      onRefresh()
    } catch (err) {
      setNote(String(err))
    }
  }

  const restore = async (name: string) => {
    if (current && !confirm('恢复备份会覆盖当前存档，确定吗？')) return
    setNote('恢复中…')
    try {
      await api.restoreBackup(name)
      setNote('已恢复为当前存档')
      onRefresh()
    } catch (err) {
      setNote(String(err))
    }
  }

  const removeBackup = async (name: string) => {
    if (!confirm('删除这份备份？')) return
    try {
      await api.deleteBackup(name)
      loadBackups()
    } catch (err) {
      setNote(String(err))
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <Brand />
        <div className="crumbs"><b>游戏</b></div>
        <div className="tools">
          <button onClick={onWorkshop} disabled={blocked} title="剧本工坊：创作新剧本、修改已有剧本、导入导出">
            ✎<span className="t"> 工坊</span>
          </button>
          <button className={blocked ? 'attention' : ''} onClick={onSettings}>
            ▧<span className="t"> 设置{blocked ? ' ·未配置' : ''}</span>
          </button>
        </div>
      </header>

      <div className="scroll">
        <div className="column">
          {blocked && (
            <div className="gate">
              还没有配置 DeepSeek API Key，游戏无法开始。
              <button className="ghost" onClick={onSettings}>前往设置</button>
            </div>
          )}

          {current && (
            <>
              <h2 className="section-title">继续冒险</h2>
              <div className="saves">
                <div className="save-row-wrap">
                  <button className="save-row" onClick={() => onResume(current)}>
                    <span className="save-title">
                      {current.projections?.values.title ?? '未命名存档'}
                    </span>
                    <span className="save-meta">
                      {scenarios.find(sc => sc.id === current.agentPreset)?.name ?? current.agentPreset}
                      {' · '}
                      {new Date(current.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <div className="save-actions">
                    <button className="ghost" onClick={() => void backupCurrent()} title="快照当前存档">⤓ 备份</button>
                    <button className="ghost danger" onClick={() => void deleteCurrent()} title="删除当前存档">✕ 删除</button>
                  </div>
                </div>
              </div>
            </>
          )}

          <h2 className="section-title">剧本</h2>
          <div className="cards">
            {scenarios.map(sc => (
              <article
                key={sc.id}
                className="card card-clickable"
                onClick={() => onOpenScenario(sc.id)}
                role="button"
              >
                <h3>{sc.name}</h3>
                <p>{sc.description}</p>
                <span className="card-enter">查看详情 ▸</span>
              </article>
            ))}
            {scenarios.length === 0 && (
              <p className="dim">暂无剧本——去顶栏「✎ 工坊」创作一部，或在工坊里导入现成的 story.json。</p>
            )}
          </div>

          {backups.length > 0 && (
            <>
              <h2 className="section-title">存档备份</h2>
              <div className="saves">
                {backups.map(b => (
                  <div key={b.name} className="save-row-wrap">
                    <div className="save-row static">
                      <span className="save-title">{b.title ?? b.sessionId.slice(0, 16)}</span>
                      <span className="save-meta">
                        {scenarios.find(sc => sc.id === b.agentPreset)?.name ?? b.agentPreset ?? '未知剧本'}
                        {b.turns !== undefined && ` · ${b.turns} 回合`}
                        {' · '}
                        {new Date(b.backedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="save-actions">
                      <button className="ghost" onClick={() => void restore(b.name)}>↻ 恢复</button>
                      <button className="ghost danger" onClick={() => void removeBackup(b.name)}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {note && <p className="muted">{note}</p>}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
