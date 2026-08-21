/**
 * 剧本工坊：与工坊 agent 的对话视图。普通聊天形态——完整消息流 + 常驻输入框，
 * 没有行动块、没有机制面板。发布成功后玩家回剧本库即可开玩。
 * 同一组件也承担剧本详情页唤起的"修改剧本"对话：换标题与开场白、收起创作包。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import { foldHistory, lastSeqOf, mergeMessages, messageOfEvent, planResume } from './fold.ts'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import { openSessionStream } from './stream.ts'
import type { ChatMessage, MuxFrame } from './types.ts'

interface Props {
  sessionId: string
  onExit: () => void
  onReset: () => void
  /** 界面标题；默认工坊 */
  title?: string
  /** 空会话自动发送的第一条消息 */
  opening?: string
  /** 创作包（说明书下载 + 导入剧本）；修改对话里收起 */
  showKit?: boolean
  exitLabel?: string
  resetConfirm?: string
}

export function Workshop({
  sessionId,
  onExit,
  onReset,
  title = '剧本工坊',
  opening = '你好，我想创作一个新剧本。',
  showKit = true,
  exitLabel = '剧本库',
  resetConfirm = '重开工坊会丢弃当前访谈进度（已发布的剧本不受影响），确定吗？',
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const [importNote, setImportNote] = useState<string>()
  /** 修改对话里对方是"GM"，创作访谈里是"工坊"——同一个 agent，两种在场身份 */
  const agentLabel = showKit ? '工坊' : 'GM'
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const opened = useRef<string | undefined>(undefined)
  /** 断点续传：history 返回前缓冲实时分片，返回后按 seq 去重拼接 */
  const histReady = useRef(false)
  const chunkFloor = useRef(-1)
  const pendingChunks = useRef<{ seq: number; text: string }[]>([])
  /** 实时流里见过的最近回合边界 seq：重拉历史时据此判断拉取窗口内回合有没有开始/结束 */
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

    /** 按历史快照对齐本地状态：首次打开与每次重连后都走这里（断线期间漏掉的帧靠它补齐） */
    const apply = ({ events, projections, inflight }: Awaited<ReturnType<typeof api.history>>) => {
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
      setMessages(prev => mergeMessages(foldHistory(events), prev, plan.boundary))
      const lastStart = lastSeqOf(events, 'turn/start')
      liveTurnStart.current = Math.max(liveTurnStart.current, lastStart)
      liveTurnEnd.current = Math.max(liveTurnEnd.current, lastSeqOf(events, 'turn/end'))
      // 空会话补发开场白：工坊模式自我介绍抛选项；修改模式直接让 GM 读取目标剧本
      if (lastStart < 0 && opened.current !== sessionId) {
        opened.current = sessionId
        api.prompt(sessionId, opening).catch(err => setError(String(err)))
      }
    }

    /** 重拉历史并对齐。拉取期间实时分片先缓冲，对齐时按 seq 去重接上；并发拉取只认最后一次 */
    const sync = async () => {
      const token = ++syncToken
      histReady.current = false
      let result: Awaited<ReturnType<typeof api.history>>
      try {
        result = await api.history(sessionId)
      } catch (err) {
        if (cancelled || token !== syncToken) return
        histReady.current = true
        const tail = pendingChunks.current.filter(c => c.seq > chunkFloor.current).map(c => c.text).join('')
        pendingChunks.current = []
        if (tail) setStreaming(s => s + tail)
        setError(String(err))
        return
      }
      if (cancelled || token !== syncToken) return
      apply(result)
      histReady.current = true
    }

    // 连上事件流再拉历史；回前台/断线重连后重拉一遍补齐漏帧（同 Play）
    const stream = openSessionStream({
      sessionId,
      onLive: () => void sync(),
      onFrame: (raw) => {
        const frame = JSON.parse(raw.data) as MuxFrame
        if (frame.type !== 'session/event' || !frame.event) return
        const event = frame.event
        if (event.type === 'turn/start') {
          liveTurnStart.current = event.seq
          setRunning(true)
          setStreaming('')
        }
        if (event.type === 'turn/end') {
          liveTurnEnd.current = event.seq
          setRunning(false)
        }
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

  const importFile = async (file: File) => {
    setImportNote('导入中…')
    try {
      const story = JSON.parse(await file.text()) as unknown
      const result = await api.importStory(story)
      setImportNote(result.ok
        ? `《${result.title}》已导入并上架`
        : `校验失败 ${result.issues?.length ?? 0} 处：\n`
          + (result.issues ?? []).map(i => `· ${i.path}：${i.message}`).join('\n'))
    } catch (err) {
      setImportNote(`导入失败：${String(err)}`)
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <Brand />
        <div className="crumbs"><b>{title}</b>{running && <span>构思中…</span>}</div>
        <div className="tools">
          {showKit && (
            <a className="tool-link" href="/app/authoring-guide" title="下载创作说明书（自己写剧本用）">
              ⤓<span className="t"> 说明书</span>
            </a>
          )}
          <button
            onClick={() => {
              if (confirm(resetConfirm)) onReset()
            }}
            title="重开对话"
          >
            ↺<span className="t"> 重开</span>
          </button>
          <button onClick={onExit} title="返回">←<span className="t"> {exitLabel}</span></button>
        </div>
      </header>

      <div className="scroll" ref={listRef}>
        <div className="column workshop-chat">
          {/* 创作包：说明书在顶栏；此处导入外部写好的 story.json */}
          {showKit && (
            <div className="workshop-kit">
              <span className="muted">创作包：照「⤓ 说明书」自己写（或让别的 AI 写）一份 story.json，导入即校验上架；同 id 覆盖更新。</span>
              <button className="ghost" onClick={() => fileRef.current?.click()}>导入剧本 ⤒</button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void importFile(file)
                  e.target.value = ''
                }}
              />
            </div>
          )}
          {importNote && <p className="muted import-note">{importNote}</p>}

          {messages.map((m, i) => (
            <div key={m.seq ?? i} className={`ws-msg ${m.role}`}>
              <span className="label">{m.role === 'user' ? '你' : agentLabel}</span>
              {m.role === 'assistant'
                ? <StoryMarkdown text={m.text} characters={[]} />
                : <p>{m.text}</p>}
            </div>
          ))}
          {streaming && (
            <div className="ws-msg assistant">
              <span className="label">{agentLabel}</span>
              <StoryMarkdown text={streaming} characters={[]} />
              <span className="caret" />
            </div>
          )}
          {messages.length === 0 && !streaming && <p className="dim">正在唤醒{agentLabel}…</p>}
          {error && <div className="error">{error}</div>}

          <div className="composer">
            <span className="prompt">&gt;</span>
            <textarea
              value={input}
              rows={2}
              placeholder={running ? `${agentLabel}落笔中…` : showKit ? '说说你想要什么样的剧本' : '说说这个剧本要改哪里'}
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
