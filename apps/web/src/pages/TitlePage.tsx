/**
 * 标题画面（移植自 Rpgforge）：logo + 竖排主菜单 + 最近冒险存档槽，底部平台状态灯。上下键换行、Enter 进入。
 */
import { useRef, type KeyboardEvent } from 'react'
import { api } from '../api.ts'
import { AppShell } from '../components/AppShell.tsx'
import { Link } from '../router.tsx'
import type { CredentialStatus } from '../types.ts'
import { formatDateTime, PHASE_LABEL, useLoad } from './common.tsx'

export type PlatformHealth = 'checking' | 'online' | 'offline'

export function TitlePage({ health, credential }: { health: PlatformHealth; credential?: CredentialStatus }) {
  const [games] = useLoad(() => api.games().then(r => r.items), [])
  const navRef = useRef<HTMLElement>(null)
  const recent = games.status === 'ready' ? games.data.slice(0, 3) : []
  const latest = recent[0]
  const blocked = credential !== undefined && !credential.configured

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(navRef.current?.querySelectorAll<HTMLAnchorElement>('.title-menu-item') ?? [])
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLAnchorElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    e.preventDefault()
    items[next].focus()
  }

  const led = health === 'checking' ? 'px-led px-led-blink' : health === 'offline' || blocked ? 'px-led px-led-off' : 'px-led px-led-on'
  const status = health === 'checking'
    ? '正在检查平台连接…'
    : health === 'offline'
      ? '平台离线——服务没有响应'
      : blocked
        ? '平台在线 · 未配置 DeepSeek API Key'
        : `平台在线 · DeepSeek Key 已配置${credential?.source === 'env' ? '（环境变量）' : ''}`

  return (
    <AppShell variant="title">
      <div className="title-screen">
        <div className="grid w-full max-w-2xl gap-8 px-2">
          <div className="grid justify-items-center gap-3 text-center">
            <img className="h-20 w-20 [image-rendering:pixelated]" src="/logo-180.png" alt="" />
            <p className="px-eyebrow">AI GAME MASTER · TEXT RPG</p>
            <h1 className="title-logo">TALE<wbr />FORGE</h1>
            <p className="text-xs tracking-[0.35em] text-[color:var(--faint)]">— 剧 本 机 器 —</p>
          </div>

          {games.status === 'loading' && (
            <p className="text-center text-sm text-[color:var(--muted)]"><span className="px-caret" aria-hidden="true" /> 正在读取存档…</p>
          )}
          {games.status === 'error' && <p className="px-alert">{games.message}</p>}

          <nav aria-label="主菜单" className="grid gap-1 border-2 border-[color:var(--border)] bg-[color:var(--panel)] p-2" onKeyDown={onKeyDown} ref={navRef}>
            {latest && (
              <Link className="title-menu-item" href={`/games/${latest.sessionId}/play`}>
                <span>
                  继续冒险
                  <span className="ml-2 text-xs text-[color:var(--amber)]">◂ {latest.title} ▸</span>
                </span>
              </Link>
            )}
            <Link className="title-menu-item" href="/games/new"><span>新的冒险</span></Link>
            <Link className="title-menu-item" href="/games"><span>读取存档</span></Link>
            <Link className="title-menu-item" href="/library"><span>剧本库</span></Link>
            <Link className="title-menu-item" href="/settings">
              <span>
                系统设置
                {blocked && <span className="ml-2 text-xs text-[color:var(--amber)]">未配置 API Key</span>}
              </span>
            </Link>
          </nav>

          {recent.length > 0 && (
            <section className="grid gap-2">
              <p className="px-label text-center">最近冒险</p>
              <div className="grid gap-2">
                {recent.map((g, index) => (
                  <Link className="save-slot" href={`/games/${g.sessionId}/play`} key={g.sessionId}>
                    <span className="save-slot-index">SLOT {index + 1}</span>
                    <span className="flex flex-wrap items-center gap-2 pr-16">
                      <strong className="min-w-0 break-words">{g.title}</strong>
                      <span className="px-badge">{PHASE_LABEL[g.phase]}</span>
                    </span>
                    <span className="text-xs text-[color:var(--muted)]">
                      第 {g.turns} 回合{g.actTitle ? ` · ${g.actTitle}` : ''} · {formatDateTime(g.updatedAt)}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <footer className="flex items-center justify-center gap-2 text-xs text-[color:var(--muted)]">
            <span aria-hidden="true" className={led} />
            <span>{status}</span>
          </footer>
        </div>
      </div>
    </AppShell>
  )
}
