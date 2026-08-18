import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { foldHistory, messageOfEvent } from './fold.ts'
import type { ChatMessage, MuxFrame, SessionSummary } from './types.ts'

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [active, setActive] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const { items } = await api.listSessions()
      setSessions(items.filter(s => !s.blank))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  // 切换会话：拉历史 + 订阅 SSE
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setMessages([])
    setStreaming('')
    setError(undefined)

    api.history(active)
      .then(({ events }) => {
        if (!cancelled) setMessages(foldHistory(events))
      })
      .catch(err => setError(String(err)))

    const source = new EventSource(`/app/sessions/${active}/events`)
    source.onmessage = (raw) => {
      const frame = JSON.parse(raw.data) as MuxFrame
      if (frame.type !== 'session/event' || !frame.event) return
      const event = frame.event
      if (event.type === 'turn/start') setRunning(true)
      if (event.type === 'turn/end') setRunning(false)
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk?.type === 'text-delta' && chunk.text) setStreaming(s => s + chunk.text)
        return
      }
      const msg = messageOfEvent(event)
      if (msg) {
        setMessages(prev => (prev.some(m => m.seq === msg.seq) ? prev : [...prev, msg]))
        if (msg.role === 'assistant') setStreaming('')
      }
    }
    source.onerror = () => {
      // EventSource 自动重连；这里不弹错误
    }
    return () => {
      cancelled = true
      source.close()
    }
  }, [active])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const newSession = async () => {
    try {
      const { sessionId } = await api.createSession()
      setActive(sessionId)
      await refreshSessions()
    } catch (err) {
      setError(String(err))
    }
  }

  const send = async () => {
    if (!active || !input.trim()) return
    const text = input
    setInput('')
    try {
      await api.prompt(active, text)
    } catch (err) {
      setError(String(err))
      setInput(text)
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>TaleForge</h1>
        <button onClick={newSession}>+ 新会话</button>
        <ul>
          {sessions.map(s => (
            <li key={s.sessionId}>
              <button
                className={s.sessionId === active ? 'active' : ''}
                onClick={() => setActive(s.sessionId)}
              >
                <span className="preset">{s.agentPreset ?? 'default'}</span>
                <span className="time">{new Date(s.updatedAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="chat">
        {!active && <div className="empty">选择或创建一个会话开始</div>}
        {active && (
          <>
            <div className="messages">
              {messages.map((m, i) => (
                <div key={m.seq ?? `local-${i}`} className={`msg ${m.role}`}>
                  <pre>{m.text}</pre>
                </div>
              ))}
              {streaming && (
                <div className="msg assistant streaming">
                  <pre>{streaming}</pre>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            <div className="composer">
              <textarea
                value={input}
                placeholder="输入行动…"
                onChange={e => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              {running
                ? <button onClick={() => active && void api.cancel(active)}>停止</button>
                : <button onClick={() => void send()} disabled={!input.trim()}>发送</button>}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </main>
    </div>
  )
}
