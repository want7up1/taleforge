/** 主界面 = 游戏列表：继续冒险一行 + 剧本卡（点击进详情）。会话与存档的管理都在剧本详情页。 */
import { Brand } from './Brand.tsx'
import type { CredentialStatus, ScenarioSummary, SessionSummary } from './types.ts'

interface Props {
  scenarios: ScenarioSummary[]
  sessions: SessionSummary[]
  credential?: CredentialStatus
  error?: string
  onOpenScenario: (id: string) => void
  onResume: (session: SessionSummary) => void
  onSettings: () => void
  onWorkshop: () => void
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
}: Props) {
  const blocked = credential && !credential.configured
  const current = sessions[0]

  return (
    <div className="screen">
      <header className="topbar">
        <Brand />
        <div className="crumbs"><b>游戏</b></div>
        <div className="tools">
          <button onClick={onWorkshop} disabled={blocked} title="剧本工坊：创作新剧本、导入剧本">
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
                <button className="save-row" onClick={() => onResume(current)}>
                  <span className="save-title">
                    {current.projections?.values.title ?? '未命名进度'}
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

          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
