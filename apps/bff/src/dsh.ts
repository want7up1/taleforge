/**
 * dsh /api 网关客户端。
 * 协议依据 dsh 源码 packages/host/apiproxy/src/api/{rpc,sessions,events}.ts：
 * - unary：POST /api/<method>，body 为 ClientRequest，响应为 ServerResponse
 * - 流式：只下行 WebSocket /api/events.mux，帧为 MuxFrame（可能包在 server-request 信封里）
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const DSH_BASE = process.env.DSH_API_BASE ?? 'http://127.0.0.1:3090'
const DSH_WS_BASE = DSH_BASE.replace(/^http/, 'ws')

export class DshRpcError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'DshRpcError'
    this.code = code
    this.details = details
  }
}

interface RpcResultOk {
  ok: true
  value: unknown
}
interface RpcResultErr {
  ok: false
  error: { code: string; message: string; details?: unknown }
}

export async function rpc<T>(method: string, payload: unknown): Promise<T> {
  return post(`/api/${method}`, method, payload)
}

async function post<T>(path: string, method: string, payload: unknown): Promise<T> {
  const rpcId = randomUUID()
  let res: Response
  try {
    res = await fetch(`${DSH_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
  } catch (cause) {
    throw new DshRpcError('dsh-unreachable', `dsh 网关无法访问（${DSH_BASE}）：${String(cause)}`)
  }
  if (res.status === 404 || res.status === 405) {
    throw new DshRpcError('channel-unavailable', `dsh 没有这条路由：${path}（插件未安装？）`)
  }
  if (!res.ok) {
    throw new DshRpcError('transport', `dsh ${method}: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { result?: RpcResultOk | RpcResultErr }
  const result = body?.result
  if (!result || result.ok !== true) {
    const err = result && 'error' in result ? result.error : undefined
    throw new DshRpcError(err?.code ?? 'internal', err?.message ?? `dsh ${method} 返回了无法解析的响应`, err?.details)
  }
  return result.value as T
}

// ---- mux 事件桥：单条共享 WS，按 sessionId 扇出 ----

export interface MuxFrame {
  type: string
  sessionId?: string
  [key: string]: unknown
}

type FrameListener = (frame: MuxFrame) => void

const listeners = new Set<FrameListener>()
let ws: WebSocket | undefined
/** 排好队的重连；它在场就说明"连接这件事已经有人管了"，别再开第二条 */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectDelay = 500
let loggedUnknownShape = false

function extractFrame(raw: WebSocket.RawData): MuxFrame | undefined {
  let msg: unknown
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return undefined
  }
  if (typeof msg !== 'object' || msg === null) return undefined
  const m = msg as Record<string, unknown>
  // 窄形式 / server-request 信封：真正的帧在 payload 里
  const payload = m.payload as Record<string, unknown> | undefined
  if (payload && typeof payload.type === 'string') return payload as MuxFrame
  // 帧本体直接就是消息
  if (typeof m.type === 'string' && (m.type as string).includes('/')) return m as MuxFrame
  if (!loggedUnknownShape) {
    loggedUnknownShape = true
    console.warn('[dsh-mux] 未识别的帧形状（仅提示一次）:', JSON.stringify(msg).slice(0, 500))
  }
  return undefined
}

/**
 * 连接 mux。**同时只能有一条**：listeners 是共享的，第二条连接会让同一帧被分发两遍——
 * SSE 桥把每个 assistant/chunk 发两次，前端的 `seq > chunkFloor` 拦不住同 seq 的重复
 * （chunkFloor 只在拉历史时推进），玩家看到的正文就是每段重复一遍；observer 那边则是
 * 回合事件重复入 buffer、统计失真。
 *
 * 旧写法的漏洞在于 close 里 `ws = undefined` 之后要等退避定时器，而这期间来一个新订阅者
 * （dsh 重启时前端 SSE 也在重连，正好撞上）就会看到 `!ws` 再开一条。实测：断开后累计 3 条
 * 连接、活跃 2 条、每帧触发 4 次回调。所以这里认两个状态——已有连接、或已排好重连。
 * 新订阅者到来时不必干等退避（最长 15s）：把排队的重连提前执行即可，唯一性照旧。
 */
function connectMux(): void {
  if (ws) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  ws = new WebSocket(`${DSH_WS_BASE}/api/events.mux`)
  ws.on('open', () => {
    reconnectDelay = 500
    console.log('[dsh-mux] 已连接')
  })
  ws.on('message', (raw) => {
    const frame = extractFrame(raw)
    if (!frame) return
    for (const listener of listeners) listener(frame)
  })
  ws.on('error', (err) => {
    console.warn('[dsh-mux] 连接错误:', err.message)
  })
  ws.on('close', () => {
    ws = undefined
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connectMux()
    }, reconnectDelay)
    // unref：这条定时器不该拦着进程退出（BFF 有 http server 保活；测试里没有）
    reconnectTimer.unref?.()
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000)
  })
}

export function onMuxFrame(listener: FrameListener): () => void {
  listeners.add(listener)
  // 唯一性由 connectMux 自己守；这里只管"确保连接这件事有人在做"
  connectMux()
  return () => listeners.delete(listener)
}
