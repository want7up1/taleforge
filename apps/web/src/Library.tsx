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
}

export function Library({
  scenarios,
  sessions,
  credential,
  error,
  onStart,
  onResume,
  onSettings,
}: Props) {
  const blocked = credential && !credential.configured

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

          <h2 className="section-title">开始新的冒险</h2>
          <div className="cards">
            {scenarios.map(sc => (
              <article key={sc.id} className="card">
                <h3>{sc.name}</h3>
                <p>{sc.description}</p>
                <button onClick={() => onStart(sc.id)} disabled={blocked}>开始 ▸</button>
              </article>
            ))}
            {scenarios.length === 0 && <p className="dim">暂无剧本。</p>}
          </div>

          {sessions.length > 0 && (
            <>
              <h2 className="section-title">继续冒险</h2>
              <div className="saves">
                {sessions.map(s => (
                  <button key={s.sessionId} className="save-row" onClick={() => onResume(s)}>
                    <span className="save-title">
                      {s.projections?.values.title ?? '未命名存档'}
                    </span>
                    <span className="save-meta">
                      {scenarios.find(sc => sc.id === s.agentPreset)?.name ?? s.agentPreset}
                      {' · '}
                      {new Date(s.updatedAt).toLocaleString()}
                      {s.parentSessionId ? ' · 分支' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
