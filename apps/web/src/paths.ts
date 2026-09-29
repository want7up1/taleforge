/** 路径模式匹配（纯函数，router.tsx 用；单测在 paths.test.ts）。 */
/** `/games/:id/play` 这类模式匹配路径；不匹配返回 undefined。 */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const a = pattern.split('/').filter(Boolean)
  const b = path.replace(/\/+$/, '').split('/').filter(Boolean)
  if (a.length !== b.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return undefined
  }
  return params
}
