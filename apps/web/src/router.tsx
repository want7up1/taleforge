/**
 * 路径路由（History API）：页面结构照搬 Rpgforge 的 /games/:id/play 这类地址。
 * 不引路由库——整站十几条路由，一个订阅 + 一个匹配函数就够了。
 * 平台服务对非 /app 路径一律回 index.html，所以任何页面都能直接刷新、直接分享地址。
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

export { matchPath } from './paths.ts'

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname)
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname) return
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  for (const listener of listeners) listener()
  window.scrollTo(0, 0)
}

/** 站内链接：普通左键在页内切换，修饰键 / 新窗口照浏览器默认行为。 */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return
    e.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={handle} {...rest} />
}
