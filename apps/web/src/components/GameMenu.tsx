/** 一局冒险里的菜单（移植自 Rpgforge）：剧情/状态/角色/旅程/记忆/设定/营地/离开。 */
import type { ReactNode } from 'react'
import { Link } from '../router.tsx'
import { Brand } from './AppShell.tsx'

export type GameSection = 'play' | 'status' | 'characters' | 'history' | 'memory' | 'settings' | 'camp'

const items: { key: GameSection; label: string; en: string; href: (id: string) => string }[] = [
  { key: 'play', label: '剧情', en: 'PLAY', href: id => `/games/${id}/play` },
  { key: 'status', label: '状态', en: 'STATUS', href: id => `/games/${id}/status` },
  { key: 'characters', label: '角色', en: 'PARTY', href: id => `/games/${id}/characters` },
  { key: 'history', label: '旅程', en: 'LOG', href: id => `/games/${id}/history` },
  { key: 'memory', label: '记忆', en: 'MEMO', href: id => `/games/${id}/memory` },
  { key: 'settings', label: '设定', en: 'SCRIPT', href: id => `/games/${id}/settings` },
  { key: 'camp', label: '营地', en: 'CAMP', href: id => `/games/${id}/camp` },
]

export function GameMenuLinks({ gameId, active, className = 'px-menu ml-auto' }: { gameId: string; active?: GameSection; className?: string }) {
  return (
    <nav aria-label="游戏菜单" className={className}>
      {items.map(item => (
        <Link
          aria-current={active === item.key ? 'page' : undefined}
          className={active === item.key ? 'px-menu-link px-menu-link-active' : 'px-menu-link'}
          href={item.href(gameId)}
          key={item.key}
        >
          <span>{item.label}</span>
          <span className="px-menu-en">{item.en}</span>
        </Link>
      ))}
      <Link className="px-menu-link" href="/games" title="离开本局，返回存档列表">
        <span>离开</span>
        <span className="px-menu-en">EXIT</span>
      </Link>
    </nav>
  )
}

export function GameSubpageShell({
  active,
  children,
  eyebrow,
  gameId,
  meta,
  primaryAction,
  subtitle,
  title,
}: {
  active: GameSection
  children: ReactNode
  eyebrow: string
  gameId: string
  meta?: ReactNode
  primaryAction?: ReactNode
  subtitle?: ReactNode
  title: string
}) {
  return (
    <div className="grid gap-4 sm:gap-5">
      <header className="px-topbar">
        <Brand size="text-[0.6rem]" />
        <GameMenuLinks gameId={gameId} active={active} />
      </header>
      <section className="px-panel px-panel-strong px-panel-pad">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0">
            <p className="px-eyebrow">{eyebrow}</p>
            <h1 className="px-heading mt-2 break-words text-2xl sm:text-3xl">{title}</h1>
            {subtitle ? <p className="px-wrap mt-2 text-sm leading-6 text-[color:var(--muted)]">{subtitle}</p> : null}
          </div>
          {meta || primaryAction
            ? (
                <div className="grid min-w-0 gap-2 sm:justify-items-end">
                  {meta}
                  {primaryAction}
                </div>
              )
            : null}
        </div>
      </section>
      {children}
    </div>
  )
}
