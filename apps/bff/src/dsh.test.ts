/**
 * mux 桥的连接唯一性。listeners 是全进程共享的一个 Set，多开一条 WS 就等于把每一帧
 * 分发两遍——SSE 桥把 assistant/chunk 发两次，前端拦不住（去重看的是 seq > chunkFloor，
 * 而 chunkFloor 只在拉历史时推进），玩家看到的正文每段重复一遍。
 *
 * 触发时序很现实：dsh 重启 → mux 断开、排一个退避重连（最长 15s）→ 前端 SSE 也断了、
 * 3s 后重连 → BFF 收到新订阅者。旧写法此刻看到 `!ws` 就再开一条。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'

// dsh.ts 在模块加载时读 DSH_API_BASE，所以先起桩服务、再动态 import
const server = new WebSocketServer({ port: 0 })
await new Promise<void>(resolve => server.once('listening', resolve))
const { port } = server.address() as { port: number }
process.env.DSH_API_BASE = `http://127.0.0.1:${port}`

const sockets = new Set<ServerSocket>()
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

const { onMuxFrame } = await import('./dsh.ts')

const settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.())

test('断线重连期间来了新订阅者：仍然只有一条 mux 连接，每帧只分发一次', async (t) => {
  t.after(() => {
    for (const s of sockets) s.terminate()
    server.close()
  })

  let hits = 0
  const offFirst = onMuxFrame(() => { hits++ })          // 相当于 startObserver
  await settle(200)
  assert.equal(sockets.size, 1, '首次订阅应连上且只连一条')

  // dsh 重启：服务端把连接掐掉，BFF 侧排起退避重连
  for (const s of sockets) s.terminate()
  await settle(50)
  // 退避还没到，玩家的 SSE 重连进来了 —— 这里是旧写法开出第二条连接的口子
  const offSecond = onMuxFrame(() => { hits++ })
  await settle(800)

  assert.equal(sockets.size, 1, '重连后仍然只能有一条连接')

  for (const s of sockets) {
    s.send(JSON.stringify({ type: 'session/event', sessionId: 'x', event: { type: 'turn/start' } }))
  }
  await settle(200)
  assert.equal(hits, 2, '一帧只该喂给两个 listener 各一次')

  offFirst()
  offSecond()
})
