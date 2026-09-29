/**
 * 可安装应用的 service worker：只缓存带内容 hash 的静态资源（/assets/*）和字体，让装到桌面的应用启动更快。
 * 其余一律不经过它——接口、事件流（SSE）、页面本身（index.html）都直连服务器，
 * 所以"平台已更新，刷新后才会用上"的检测照常工作，也不会有过期页面卡在缓存里。
 */
const CACHE = 'taleforge-static-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/** index-<hash>.js → "index|.js"：同名资源换了 hash，旧的那份就可以删了 */
const stemOf = pathname => {
  const name = pathname.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  const dash = name.lastIndexOf('-')
  return dash > 0 && dot > dash ? `${name.slice(0, dash)}|${name.slice(dot)}` : name
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/assets/') && !url.pathname.startsWith('/fonts/')) return
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(event.request)
    if (hit) return hit
    const res = await fetch(event.request)
    if (res.ok) {
      await cache.put(event.request, res.clone())
      const stem = stemOf(url.pathname)
      for (const old of await cache.keys()) {
        const p = new URL(old.url).pathname
        if (p !== url.pathname && p.startsWith('/assets/') && stemOf(p) === stem) await cache.delete(old)
      }
    }
    return res
  }))
})
