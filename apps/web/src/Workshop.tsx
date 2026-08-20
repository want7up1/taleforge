/**
 * 剧本工坊：与工坊 agent 的对话视图。普通聊天形态——完整消息流 + 常驻输入框，
 * 没有行动块、没有机制面板。发布成功后玩家回剧本库即可开玩。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { foldHistory, messageOfEvent } from './fold.ts'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import type { ChatMessage, MuxFrame } from './types.ts'

interface Props {
  sessionId: string
  onExit: () => void
  onReset: () => void
}

export function Workshop({ sessionId, onExit, onReset }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const opened = useRef<string | undefined>(undefined)
  /** 断点续传：history 返回前缓冲实时分片，返回后按 seq 去重拼接 */
  const histReady = useRef(false)
  const chunkFloor = useRef(-1)
  const pendingChunks = useRef<{ seq: number; text: string }[]>([])

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setStreaming('')
    setRunning(false)
    setError(undefined)

    histReady.current = false
    chunkFloor.current = -1
    pendingChunks.current = []

    const source = new EventSource(`/app/sessions/${sessionId}/events`)
    api.history(sessionId)
      .then(({ events, inflight }) => {
        if (cancelled) return
        setMessages(foldHistory(events))
        if (inflight) {
          chunkFloor.current = inflight.lastChunkSeq
          const tail = pendingChunks.current
            .filter(c => c.seq > inflight.lastChunkSeq)
            .map(c => c.text)
            .join('')
          setStreaming(inflight.partial + tail)
          setRunning(true)
        }
        histReady.current = true
        pendingChunks.current = []
        // 空会话补发开场白，让工坊先自我介绍并抛出第一批选项
        const started = events.some(e => e.event.type === 'turn/start')
        if (!started && opened.current !== sessionId) {
          opened.current = sessionId
          api.prompt(sessionId, '你好，我想创作一个新剧本。').catch(err => setError(String(err)))
        }
      })
      .catch(err => setError(String(err)))

    source.onmessage = (raw) => {
      const frame = JSON.parse(raw.data) as MuxFrame
      if (frame.type !== 'session/event' || !frame.event) return
      const event = frame.event
      if (event.type === 'turn/start') {
        setRunning(true)
        setStreaming('')
      }
      if (event.type === 'turn/end') setRunning(false)
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk?.type === 'text-delta' && chunk.text) {
          if (!histReady.current) {
            pendingChunks.current.push({ seq: event.seq, text: chunk.text })
          } else if (event.seq > chunkFloor.current) {
            setStreaming(s => s + chunk.text)
          }
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
  }, [sessionId])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setError(undefined)
    try {
      await api.prompt(sessionId, text)
    } catch (err) {
      setError(String(err))
    }
  }, [input, running, sessionId])

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">TALEFORGE</span>
        <div className="crumbs"><b>剧本工坊</b>{running && <span>构思中…</span>}</div>
        <div className="tools">
          <a className="tool-link" href="/app/authoring-guide" title="下载创作说明书（自己写剧本用）">
            ⤓<span className="t"> 说明书</span>
          </a>
          <button
            onClick={() => {
              if (confirm('重开工坊会丢弃当前访谈进度（已发布的剧本不受影响），确定吗？')) onReset()
            }}
            title="重开工坊"
          >
            ↺<span className="t"> 重开</span>
          </button>
          <button onClick={onExit} title="返回">←<span className="t"> 剧本库</span></button>
        </div>
      </header>

      <div className="scroll" ref={listRef}>
        <div className="column workshop-chat">
          {messages.map((m, i) => (
            <div key={m.seq ?? i} className={`ws-msg ${m.role}`}>
              <span className="label">{m.role === 'user' ? '你' : '工坊'}</span>
              {m.role === 'assistant'
                ? <StoryMarkdown text={m.text} characters={[]} />
                : <p>{m.text}</p>}
            </div>
          ))}
          {streaming && (
            <div className="ws-msg assistant">
              <span className="label">工坊</span>
              <StoryMarkdown text={streaming} characters={[]} />
              <span className="caret" />
            </div>
          )}
          {messages.length === 0 && !streaming && <p className="dim">正在唤醒工坊…</p>}
          {error && <div className="error">{error}</div>}

          <div className="composer">
            <span className="prompt">&gt;</span>
            <textarea
              value={input}
              rows={2}
              placeholder={running ? '工坊落笔中…' : '说说你想要什么样的剧本'}
              disabled={running}
              onChange={e => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="composer-actions">
              <button onClick={() => void send()} disabled={!input.trim() || running}>发送 ▸</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
