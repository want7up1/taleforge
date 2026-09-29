/**
 * 与工坊 agent 的对话（外观移植自 Rpgforge 的访谈记录 + 命令行）：AI 访谈写新剧本、详情页唤起 GM 改剧本
 * 都用它。断线重拉、断点续传与游玩页同一套逻辑（planResume）。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api.ts'
import { foldHistory, lastSeqOf, mergeMessages, messageOfEvent, planResume } from '../fold.ts'
import { openSessionStream } from '../stream.ts'
import type { ChatMessage, StreamFrame } from '../types.ts'
import { StoryMarkdown } from './StoryMarkdown.tsx'

interface Props {
  sessionId: string
  /** 空会话自动发送的第一条消息 */
  opening: string
  /** 对方的称呼：访谈里是"工坊"，改剧本时是"GM" */
  agentLabel: string
  placeholder: string
}

export function ChatView({ sessionId, opening, agentLabel, placeholder }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<string>()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const opened = useRef<string | undefined>(undefined)
  const histReady = useRef(false)
  const chunkFloor = useRef(-1)
  const pendingChunks = useRef<{ seq: number; text: string }[]>([])
  const liveTurnStart = useRef(-1)
  const liveTurnEnd = useRef(-1)

  useEffect(() => {
    let cancelled = false
    let syncToken = 0
    setMessages([])
    setStreaming('')
    setRunning(false)
    setError(undefined)
    histReady.current = false
    chunkFloor.current = -1
    pendingChunks.current = []
    liveTurnStart.current = -1
    liveTurnEnd.current = -1

    const sync = async () => {
      const token = ++syncToken
      histReady.current = false
      let result: Awaited<ReturnType<typeof api.history>>
      try {
        result = await api.history(sessionId)
      } catch (err) {
        if (cancelled || token !== syncToken) return
        histReady.current = true
        setError(String(err))
        return
      }
      if (cancelled || token !== syncToken) return
      const { events, projections, inflight } = result
      const plan = planResume({
        entries: events,
        asOfSeq: projections?.asOfSeq,
        inflight,
        liveTurnStart: liveTurnStart.current,
        liveTurnEnd: liveTurnEnd.current,
        pending: pendingChunks.current,
      })
      chunkFloor.current = plan.chunkFloor
      pendingChunks.current = []
      setStreaming(plan.streaming)
      setRunning(plan.running)
      setPhase(plan.running ? inflight?.phase : undefined)
      setMessages(prev => mergeMessages(foldHistory(events), prev, plan.boundary))
      const lastStart = lastSeqOf(events, 'turn/start')
      liveTurnStart.current = Math.max(liveTurnStart.current, lastStart)
      liveTurnEnd.current = Math.max(liveTurnEnd.current, lastSeqOf(events, 'turn/end'))
      histReady.current = true
      if (lastStart < 0 && opened.current !== sessionId) {
        opened.current = sessionId
        api.prompt(sessionId, opening).catch(err => setError(String(err)))
      }
    }

    const stream = openSessionStream({
      sessionId,
      onLive: () => void sync(),
      onFrame: (raw) => {
        const frame = JSON.parse(raw.data) as StreamFrame
        if (frame.type === 'phase') {
          setPhase(frame.phase)
          return
        }
        if (frame.type === 'delta') {
          setPhase(undefined)
          if (!histReady.current) pendingChunks.current.push({ seq: frame.seq, text: frame.text })
          else if (frame.seq > chunkFloor.current) setStreaming(s => s + frame.text)
          return
        }
        if (frame.type === 'reset') {
          setMessages([])
          void sync()
          return
        }
        if (frame.type !== 'event') return
        const event = frame.event
        if (event.type === 'turn/start') {
          liveTurnStart.current = event.seq
          setRunning(true)
          setStreaming('')
          setError(undefined)
        }
        if (event.type === 'turn/end') {
          liveTurnEnd.current = event.seq
          setRunning(false)
          setPhase(undefined)
          setStreaming('')
          const data = event.data as { reason?: string; error?: string }
          if (data.reason === 'error' && data.error) setError(data.error)
        }
        const msg = messageOfEvent(event)
        if (msg) {
          setMessages(prev => (prev.some(m => m.seq === msg.seq) ? prev : [...prev, msg]))
          if (msg.role === 'assistant') setStreaming('')
        }
      },
    })
    return () => {
      cancelled = true
      stream.close()
    }
  }, [sessionId, opening])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const send = async () => {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setError(undefined)
    try {
      await api.prompt(sessionId, text)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <section className="px-panel px-panel-pad grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="px-label">对话记录 · {messages.length} 条</p>
        {running && <span className="px-badge px-badge-amber">{phase ?? '思考中'}…</span>}
      </div>
      <div className="max-h-[60vh] min-h-[12rem] overflow-auto pr-1" ref={listRef}>
        {messages.map((m, i) => (
          <div className={m.role === 'user' ? 'dialogue-row dialogue-row-player' : 'dialogue-row'} key={m.seq ?? i}>
            <span className="dialogue-name">{m.role === 'user' ? '▸ 你' : `▸ ${agentLabel}`}</span>
            {m.role === 'user'
              ? <p className="dialogue-bubble">{m.text}</p>
              : <div className="dialogue-bubble"><StoryMarkdown className="text-sm" content={m.text} /></div>}
          </div>
        ))}
        {(streaming || (running && !streaming)) && (
          <div className="dialogue-row">
            <span className="dialogue-name">▸ {agentLabel}</span>
            <div className="dialogue-bubble">
              {streaming ? <StoryMarkdown className="text-sm" content={streaming} showCaret /> : <p>正在思考<span className="px-caret" aria-hidden="true" /></p>}
            </div>
          </div>
        )}
        {messages.length === 0 && !streaming && !running && <p className="text-sm text-[color:var(--faint)]">正在唤醒{agentLabel}…</p>}
      </div>
      {error && <div className="px-alert">{error}</div>}
      <div className="flex items-start gap-2 border-2 border-[color:var(--border-strong)] bg-[color:var(--input)] px-3 py-2 shadow-[inset_2px_2px_0_0_rgba(0,0,0,0.45)] focus-within:border-[color:var(--phosphor)]">
        <span aria-hidden="true" className="command-prompt mt-0.5">&gt;</span>
        <textarea
          className="command-input flex-1"
          disabled={running}
          onChange={e => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={running ? `${agentLabel}落笔中…` : placeholder}
          rows={2}
          value={input}
        />
        <button className="px-btn px-btn-primary min-h-9 self-end" disabled={!input.trim() || running} onClick={() => void send()} type="button">发送 ▸</button>
      </div>
    </section>
  )
}
