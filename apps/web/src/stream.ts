/**
 * 会话事件流（SSE）的连接管理。EventSource 只保证"连着的时候收帧"：页面切后台被冻结、
 * 手机锁屏、网络切换，都会让连接在服务端早已断开而客户端对象仍显示 OPEN，此后再也
 * 收不到任何帧（实测：回合结束帧丢失，界面停在切出前的画面、秒表永远跑下去）。
 * 这不是移动端专属问题——桌面端网络抖动、服务重启同样会断流。这里补三件事：
 * 1. 回前台 / bfcache 恢复 / 网络恢复时强制重建连接；
 * 2. 心跳看门狗：服务端每 25s 发一个 ping 事件，前台 60s 没收到任何帧就重连（静默断流）；
 * 3. 每次连接建立（含重连）后回调 onLive——调用方借此重拉历史，补齐断线期间漏掉的事件。
 */
const STALE_MS = 60_000
const WATCHDOG_MS = 30_000
/** SSE 完全连不上（被代理拦截等）时也要让调用方拉到历史，不至于白屏 */
const BOOT_FALLBACK_MS = 2_500
/** 服务端把连接置为 CLOSED（非 2xx 响应）后 EventSource 不再自动重试，这里手动重建 */
const RETRY_MS = 3_000

export interface SessionStream {
  /** 立即重建连接；连上后照常触发 onLive */
  reconnect(): void
  close(): void
}

export function openSessionStream(opts: {
  sessionId: string
  onFrame: (raw: MessageEvent<string>) => void
  /** 连接建立后调用；reconnect=false 表示本次挂载的首次连接 */
  onLive: (reconnect: boolean) => void
}): SessionStream {
  let source: EventSource | undefined
  let lastBeat = Date.now()
  let everOpened = false
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const beat = () => {
    lastBeat = Date.now()
  }

  const connect = () => {
    if (closed) return
    source?.close()
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    const es = new EventSource(`/app/sessions/${opts.sessionId}/events`)
    source = es
    es.onopen = () => {
      beat()
      const reconnect = everOpened
      everOpened = true
      opts.onLive(reconnect)
    }
    es.onmessage = (raw) => {
      beat()
      opts.onFrame(raw as MessageEvent<string>)
    }
    es.addEventListener('ping', beat)
    // EventSource 自带断线重试（readyState 回到 CONNECTING）；只有 CLOSED 才需要手动重建
    es.onerror = () => {
      if (closed || source !== es || es.readyState !== EventSource.CLOSED) return
      retryTimer = setTimeout(connect, RETRY_MS)
    }
  }

  /** 回前台/网络恢复：不管连接看起来活没活，一律重建——半死连接从外面看不出来 */
  const resume = () => {
    if (closed || document.visibilityState === 'hidden' || !everOpened) return
    connect()
  }
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) resume()
  }
  const watchdog = () => {
    if (closed || document.visibilityState === 'hidden') return
    if (Date.now() - lastBeat > STALE_MS) connect()
  }

  document.addEventListener('visibilitychange', resume)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('online', resume)
  const watchdogTimer = setInterval(watchdog, WATCHDOG_MS)
  const bootTimer = setTimeout(() => {
    if (closed || everOpened) return
    // 首连迟迟不开：先让调用方拉历史；之后若真连上了按重连处理，再补一次
    everOpened = true
    opts.onLive(false)
  }, BOOT_FALLBACK_MS)

  connect()

  return {
    reconnect: connect,
    close() {
      closed = true
      clearTimeout(bootTimer)
      clearInterval(watchdogTimer)
      if (retryTimer) clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('online', resume)
      source?.close()
      source = undefined
    },
  }
}
