/** 页面外壳（移植自 Rpgforge）：普通页带顶栏导航；标题画面、聚焦页、游玩页不带。 */
import type { ReactNode } from 'react'
import { Link } from '../router.tsx'

interface Props {
  children: ReactNode
  variant?: 'default' | 'title' | 'focus' | 'gameplay'
}

export function Brand({ size = 'text-xs' }: { size?: string }) {
  return (
    <Link href="/" className={`px-brand px-font ${size}`} title="返回标题画面">
      <span aria-hidden="true" className="text-[color:var(--amber)]">▓▓</span>
      TALEFORGE
    </Link>
  )
}

export function AppShell({ children, variant = 'default' }: Props) {
  const isGameplay = variant === 'gameplay'
  const bare = variant === 'title' || variant === 'focus' || isGameplay

  return (
    <main
      className={
        isGameplay
          ? 'h-screen h-[100dvh] overflow-hidden px-0'
          : 'min-h-screen px-3 py-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-8 sm:py-6 lg:px-14'
      }
    >
      <section
        className={
          isGameplay
            ? 'mx-auto flex h-full w-full flex-col overflow-hidden'
            : 'mx-auto flex w-full max-w-7xl flex-col gap-4 sm:gap-6'
        }
      >
        {bare
          ? null
          : (
              <header className="px-topbar">
                <Brand />
                <nav aria-label="全站导航" className="px-menu ml-auto">
                  <Link className="px-menu-link" href="/games">
                    <span>冒险</span>
                    <span className="px-menu-en">LOAD</span>
                  </Link>
                  <Link className="px-menu-link" href="/games/new">
                    <span>新建</span>
                    <span className="px-menu-en">NEW</span>
                  </Link>
                  <Link className="px-menu-link" href="/library">
                    <span>剧本</span>
                    <span className="px-menu-en">LIBRARY</span>
                  </Link>
                  <Link className="px-menu-link" href="/settings">
                    <span>设置</span>
                    <span className="px-menu-en">SYSTEM</span>
                  </Link>
                </nav>
              </header>
            )}
        {children}
      </section>
    </main>
  )
}

/** 读取中 / 出错 的统一占位 */
export function Loading({ text }: { text: string }) {
  return (
    <section className="px-panel px-panel-pad text-sm text-[color:var(--muted)]">
      <span className="px-caret" aria-hidden="true" /> {text}
    </section>
  )
}
