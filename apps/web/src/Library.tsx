/** 标题页：剧本选择与存档续玩。 */
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
}: Props) {
  const blocked = credential && !credential.configured
  const current = sessions[0]

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">TALEFORGE</span>
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
                <button
                  onClick={() => {
                    if (current && !confirm('开新局会覆盖当前存档，确定吗？')) return
                    onStart(sc.id)
                  }}
                  disabled={blocked}
                >
                  {current ? '覆盖并重新开始' : '开始 ▸'}
                </button>
              </article>
            ))}
            {scenarios.length === 0 && <p className="dim">暂无剧本。</p>}

            {/* 工坊：对话创作新剧本，与游戏存档互不影响 */}
            <article className="card workshop-card">
              <h3>✎ 剧本工坊</h3>
              <p>和工坊 agent 对话，从零创作一部新剧本——访谈、发布、立即可玩。</p>
              <button onClick={onWorkshop} disabled={blocked}>进入工坊 ▸</button>
            </article>
          </div>

          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
