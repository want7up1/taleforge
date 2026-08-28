/** 剧本库：剧本卡列表，点击进详情。主页是标题画面（Title），这里只管挑剧本。 */
import { Brand } from './Brand.tsx'
import type { CredentialStatus, ScenarioSummary } from './types.ts'

interface Props {
  scenarios: ScenarioSummary[]
  credential?: CredentialStatus
  error?: string
  onOpenScenario: (id: string) => void
  onWorkshop: () => void
  onSettings: () => void
  onBack: () => void
}

export function Library({
  scenarios,
  credential,
  error,
  onOpenScenario,
  onWorkshop,
  onSettings,
  onBack,
}: Props) {
  const blocked = credential && !credential.configured

  return (
    <div className="screen">
      <header className="topbar">
        <Brand />
        <div className="crumbs">
          <b>剧本库</b>
          {scenarios.length > 0 && <span>{scenarios.length} 部</span>}
        </div>
        <div className="tools">
          <button onClick={onWorkshop} disabled={blocked} title="剧本工坊：创作新剧本、导入剧本">
            ✎<span className="t"> 工坊</span>
          </button>
          <button onClick={onBack} title="返回主菜单">←<span className="t"> 主菜单</span></button>
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
