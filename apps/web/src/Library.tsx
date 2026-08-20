/** 标题页：剧本选择、存档续玩、创作包导入导出。 */
import { useRef, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import type { CredentialStatus, ScenarioSummary, SessionSummary } from './types.ts'

interface Props {
  scenarios: ScenarioSummary[]
  sessions: SessionSummary[]
  credential?: CredentialStatus
  error?: string
  onStart: (scenarioId: string) => void
  onResume: (session: SessionSummary) => void
  onSettings: () => void
  onWorkshop: () => void
  /** 导入成功后刷新剧本列表 */
  onRefresh: () => void
}

export function Library({
  scenarios,
  sessions,
  credential,
  error,
  onStart,
  onResume,
  onSettings,
  onWorkshop,
  onRefresh,
}: Props) {
  const blocked = credential && !credential.configured
  const current = sessions[0]
  const fileRef = useRef<HTMLInputElement>(null)
  const [importNote, setImportNote] = useState<string>()

  const importFile = async (file: File) => {
    setImportNote('导入中…')
    try {
      const story = JSON.parse(await file.text()) as unknown
      const result = await api.importStory(story)
      if (result.ok) {
        setImportNote(`《${result.title}》已导入并上架`)
        onRefresh()
      } else {
        setImportNote(`校验失败 ${result.issues?.length ?? 0} 处：\n`
          + (result.issues ?? []).map(i => `· ${i.path}：${i.message}`).join('\n'))
      }
    } catch (err) {
      setImportNote(`导入失败：${String(err)}`)
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <Brand />
        <div className="crumbs"><b>剧本库</b></div>
        <div className="tools">
          <button className={blocked ? 'attention' : ''} onClick={onSettings}>
            ▧ 设置{blocked ? ' ·未配置' : ''}
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

          {/* 单存档：有进度时先给「继续」，开新局需要明确覆盖 */}
          {current && (
            <>
              <h2 className="section-title">继续冒险</h2>
              <div className="saves">
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
              </div>
            </>
          )}

          <h2 className="section-title">{current ? '重新开始' : '开始新的冒险'}</h2>
          {current && (
            <p className="hint">
              平台目前只保留一个存档。开新局会覆盖上面这个进度，暂时无法找回。
            </p>
          )}
          <div className="cards">
            {scenarios.map(sc => (
              <article key={sc.id} className="card">
                <h3>{sc.name}</h3>
                <p>{sc.description}</p>
                <div className="card-actions">
                  <button
                    onClick={() => {
                      if (current && !confirm('开新局会覆盖当前存档，确定吗？')) return
                      onStart(sc.id)
                    }}
                    disabled={blocked}
                  >
                    {current ? '覆盖并重新开始' : '开始 ▸'}
                  </button>
                  <a className="ghost export-link" href={`/app/scenarios/${sc.id}/export`} title="导出剧本源（含 GM 暗线，看了会剧透）">
                    ⤓ 导出
                  </a>
                </div>
              </article>
            ))}
            {scenarios.length === 0 && <p className="dim">暂无剧本。</p>}

            {/* 工坊：对话创作新剧本，与游戏存档互不影响 */}
            <article className="card workshop-card">
              <h3>✎ 剧本工坊</h3>
              <p>和工坊 agent 对话——从零创作新剧本，或直接说"改某某剧本"修改任何已有剧本，发布即生效。</p>
              <button onClick={onWorkshop} disabled={blocked}>进入工坊 ▸</button>
            </article>

            {/* 创作包：说明书 + 导入——自己写或交给外部 AI 写，导入即上架 */}
            <article className="card workshop-card">
              <h3>⤒ 创作包</h3>
              <p>导出创作说明书，自己（或让别的 AI）照着写一份 story.json，导入即校验上架；同 id 导入是覆盖更新。</p>
              <div className="card-actions">
                <a className="ghost" href="/app/authoring-guide">⤓ 创作说明书</a>
                <button onClick={() => fileRef.current?.click()}>导入剧本 ⤒</button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void importFile(file)
                    e.target.value = ''
                  }}
                />
              </div>
              {importNote && <p className="muted import-note">{importNote}</p>}
            </article>
          </div>

          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
