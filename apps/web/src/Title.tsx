/**
 * 标题画面（主页）：无顶栏，像素 logo + 竖排主菜单 + 平台状态灯，借自 Rpgforge 的标题画面形态。
 * 单存档下"继续冒险"只有一条；剧本卡下沉到「剧本库」页；不做全局存档页（存档仍归剧本详情页）。
 */
import { useRef, type KeyboardEvent } from 'react'
import type { CredentialStatus, ScenarioSummary, SessionSummary } from './types.ts'

export type PlatformHealth = 'checking' | 'online' | 'offline'

interface Props {
  current?: SessionSummary
  scenarios: ScenarioSummary[]
  credential?: CredentialStatus
  health: PlatformHealth
  error?: string
  onResume: (session: SessionSummary) => void
  onLibrary: () => void
  onWorkshop: () => void
  onSettings: () => void
}

export function Title({
  current,
  scenarios,
  credential,
  health,
  error,
  onResume,
  onLibrary,
  onWorkshop,
  onSettings,
}: Props) {
  const navRef = useRef<HTMLElement>(null)
  const blocked = credential !== undefined && !credential.configured
  const currentName = current?.projections?.values.title
    ?? scenarios.find(s => s.id === current?.agentPreset)?.name
    ?? '未命名进度'

  /** 上下键换行、Enter 进入——标题画面的老规矩 */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>('.title-menu-item:not(:disabled)') ?? [],
    )
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    e.preventDefault()
    items[next].focus()
  }

  const led = health === 'checking' ? 'led blink' : health === 'offline' || blocked ? 'led off' : 'led on'
  const status = health === 'checking'
    ? '正在检查平台连接…'
    : health === 'offline'
      ? '平台离线——dsh 运行时未就绪'
      : blocked
        ? '平台在线 · 未配置 DeepSeek API Key'
        : `平台在线 · DeepSeek Key 已配置${credential?.source === 'env' ? '（环境变量）' : ''}`

  return (
    <div className="screen title-shell">
      <div className="scroll">
        <div className="title-screen">
          <div className="title-inner">
            <div className="title-head">
              <img className="title-logo-img" src="/logo-180.png" alt="" />
              <p className="eyebrow">AI GAME MASTER · TEXT RPG</p>
              <h1 className="title-logo">TALE<wbr />FORGE</h1>
              <p className="title-tagline">— 剧 本 机 器 —</p>
            </div>

            <nav ref={navRef} aria-label="主菜单" className="title-menu" onKeyDown={onKeyDown}>
              {current && (
                <button className="title-menu-item" onClick={() => onResume(current)}>
                  <span>
                    继续冒险
                    <span className="title-menu-sub">◂ {currentName} ▸</span>
                  </span>
                </button>
              )}
              <button className="title-menu-item" onClick={onLibrary}>
                <span>
                  剧本库
                  <span className="title-menu-sub">{scenarios.length > 0 ? `${scenarios.length} 部` : '空'}</span>
                </span>
              </button>
              <button
                className="title-menu-item"
                onClick={onWorkshop}
                disabled={blocked}
                title={blocked ? '先配置 API Key' : '创作新剧本、导入剧本'}
              >
                <span>工坊</span>
              </button>
              <button className={`title-menu-item${blocked ? ' attention' : ''}`} onClick={onSettings}>
                <span>
                  设置
                  {blocked && <span className="title-menu-sub">未配置 API Key</span>}
                </span>
              </button>
            </nav>

            {!current && scenarios.length > 0 && (
              <p className="title-note">还没有进行中的冒险——去剧本库挑一部开局。</p>
            )}
            {scenarios.length === 0 && (
              <p className="title-note">剧本库还是空的——先去工坊创作或导入一部。</p>
            )}
            {error && <div className="error">{error}</div>}

            <footer className="title-foot">
              <span aria-hidden="true" className={led} />
              <span>{status}</span>
            </footer>
          </div>
        </div>
      </div>
    </div>
  )
}
