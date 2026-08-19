/**
 * 场外通道的悬浮对话框：与 GM 的戏外沟通单独成线，不进正文流。
 * 消息仍走同一会话（同一个 GM、共享全部战局记忆），只是显示上剥离。
 */
import { useEffect, useRef, useState } from 'react'
import { StoryMarkdown } from './StoryMarkdown.tsx'

export interface GmChatItem {
  role: 'you' | 'gm'
  text: string
}

interface Props {
  open: boolean
  items: GmChatItem[]
  /** 正在流式输出的场外回复（已剥（场外）前缀） */
  streaming?: string
  /** 场外回合生成中 */
  busy: boolean
  onSend: (text: string) => void
  onClose: () => void
}

export function GmChat({ open, items, streaming, busy, onSend, onClose }: Props) {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 新消息与流式输出时跟到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, streaming, open])

  if (!open) return null

  const send = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    onSend(text)
  }

  return (
    <div className="gm-chat">
      <div className="gm-chat-head">
        <span className="gm-chat-title">场外 · GM</span>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="gm-chat-list" ref={listRef}>
        {items.length === 0 && !streaming && (
          <p className="gm-chat-hint">
            这里是戏外：问 GM 任何事（机制、剧情安排），或下指令——改剧情走向、人物戏份、修改设定。
            修订立即生效，只对未来剧情生效。
          </p>
        )}
        {items.map((m, i) => (
          <div key={i} className={`gm-chat-msg ${m.role}`}>
            <span className="who">{m.role === 'you' ? '你' : 'GM'}</span>
            {m.role === 'gm'
              ? <div className="body"><StoryMarkdown text={m.text} characters={[]} /></div>
              : <p>{m.text}</p>}
          </div>
        ))}
        {streaming && (
          <div className="gm-chat-msg gm">
            <span className="who">GM</span>
            <div className="body"><StoryMarkdown text={streaming} characters={[]} /><span className="caret" /></div>
          </div>
        )}
        {busy && !streaming && <p className="gm-chat-hint">GM 正在回复…</p>}
      </div>
      <div className="gm-chat-input">
        <textarea
          ref={inputRef}
          value={input}
          rows={2}
          placeholder="问 GM，或下指令…"
          disabled={busy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') onClose()
          }}
        />
        <button onClick={send} disabled={!input.trim() || busy}>▸</button>
      </div>
    </div>
  )
}
