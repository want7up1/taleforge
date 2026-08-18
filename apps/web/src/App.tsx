import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { foldHistory, messageOfEvent } from './fold.ts'
import { parseTurn } from './turn.ts'
import type { ChatMessage, MuxFrame, ScenarioSummary, SessionSummary } from './types.ts'

function sessionTitle(s: SessionSummary): string {
  return s.projections?.values.title ?? new Date(s.updatedAt).toLocaleString()
}

export function App() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [active, setActive] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const bottomRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [{ items: sessionItems }, { items: scenarioItems }] = await Promise.all([
        api.listSessions(),
        api.listScenarios(),
      ])
      setSessions(sessionItems.filter(s => !s.blank))
      setScenarios(scenarioItems)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 切换会话：拉历史 + 订阅 SSE
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setMessages([])
    setStreaming('')
    setRunning(false)
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
      if (event.type === 'turn/end') {
        setRunning(false)
        void refresh()
      }
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk?.type === 'text-delta' && chunk.text) setStreaming(s => s + chunk.text)
        if (chunk?.type === 'finish') {
          const failure = (chunk as { reason?: { failure?: { message?: string } } }).reason?.failure
          if (failure?.message) setError(failure.message)
        }
        return
      }
      const msg = messageOfEvent(event)
      if (msg) {
        setMessages(prev => (prev.some(m => m.seq === msg.seq) ? prev : [...prev, msg]))
        if (msg.role === 'assistant') setStreaming('')
      }
    }
    return () => {
      cancelled = true
      source.close()
    }
  }, [active, refresh])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const startScenario = async (scenarioId: string) => {
    try {
      setError(undefined)
      const { sessionId } = await api.createSession(scenarioId)
      setActive(sessionId)
      // 开局：任意首条消息触发 GM 按剧本开场
      await api.prompt(sessionId, '（开始）')
    } catch (err) {
      setError(String(err))
    }
  }

  const send = async (text: string) => {
    if (!active || !text.trim()) return
    setError(undefined)
    try {
      await api.prompt(active, text)
    } catch (err) {
      setError(String(err))
    }
  }

  const sendInput = async () => {
    const text = input
    setInput('')
    await send(text)
  }

  const forkFrom = async (atSeq: number) => {
    if (!active) return
    try {
      setError(undefined)
      const { sessionId } = await api.fork(active, atSeq)
      await refresh()
      setActive(sessionId)
    } catch (err) {
      setError(String(err))
    }
  }

  // 最后一条 GM 消息的行动选项（叙事中剥离选项块）
  const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant')
  const currentOptions
    = !running && !streaming && lastAssistantIndex >= 0
      ? parseTurn(messages[lastAssistantIndex].text).options
      : []

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>TaleForge</h1>
        <button className="home" onClick={() => setActive(undefined)}>剧本库</button>
        <div className="section">存档</div>
        <ul>
          {sessions.map(s => (
            <li key={s.sessionId}>
              <button
                className={s.sessionId === active ? 'active' : ''}
                onClick={() => setActive(s.sessionId)}
              >
                <span className="preset">{sessionTitle(s)}</span>
                <span className="time">
                  {scenarios.find(sc => sc.id === s.agentPreset)?.name ?? s.agentPreset}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="chat">
        {!active && (
          <div className="library">
            <h2>选择一个剧本，开始新的冒险</h2>
            <div className="cards">
              {scenarios.map(sc => (
                <div key={sc.id} className="card">
                  <h3>{sc.name}</h3>
                  <p>{sc.description}</p>
                  <button onClick={() => void startScenario(sc.id)}>开始冒险</button>
                </div>
              ))}
              {scenarios.length === 0 && <p className="dim">暂无剧本（presets/ 目录为空或 dsh 未启动）</p>}
            </div>
          </div>
        )}
        {active && (
          <>
            <div className="messages">
              {messages.map((m, i) => {
                if (m.role === 'user') {
                  return (
                    <div key={m.seq ?? `local-${i}`} className="msg user">
                      <pre>{m.text}</pre>
                    </div>
                  )
                }
                const { narrative } = parseTurn(m.text)
                return (
                  <div key={m.seq ?? `local-${i}`} className="msg assistant">
                    <pre>{narrative}</pre>
                    {typeof m.seq === 'number' && (
                      <button
                        className="fork"
                        title="从这一回合开一条新支线存档"
                        onClick={() => void forkFrom(m.seq!)}
                      >
                        从此处分支
                      </button>
                    )}
                  </div>
                )
              })}
              {streaming && (
                <div className="msg assistant streaming">
                  <pre>{streaming}</pre>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            {currentOptions.length > 0 && (
              <div className="options">
                {currentOptions.map(o => (
                  <button key={o.key} onClick={() => void send(`${o.key}. ${o.label}`)}>
                    <b>{o.key}</b> {o.label}
                  </button>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                value={input}
                placeholder="或自由行动…"
                onChange={e => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendInput()
                  }
                }}
              />
              {running
                ? <button onClick={() => active && void api.cancel(active)}>停止</button>
                : <button onClick={() => void sendInput()} disabled={!input.trim()}>发送</button>}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </main>
    </div>
  )
}
