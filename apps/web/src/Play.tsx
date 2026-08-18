/**
 * 游玩屏：顶栏 / 叙事区（只渲染最新一回合）/ 命令栏 三段锁屏布局。
 * 自由输入不常驻——必须先选 E 才展开（硬性交互规定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.ts'
import { Dossier } from './Dossier.tsx'
import { foldHistory, messageOfEvent } from './fold.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import { parseTurn } from './turn.ts'
import type { ChatMessage, ModelCatalog, MuxFrame, SessionStats, StoryDetail } from './types.ts'

interface Props {
  sessionId: string
  story?: StoryDetail
  onExit: () => void
  onOpenHistory: () => void
}

const FREE_KEY = 'E'

export function Play({ sessionId, story, onExit, onOpenHistory }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState<SessionStats>()
  const [scene, setScene] = useState<string>()
  const [freeMode, setFreeMode] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const [elapsed, setElapsed] = useState(0)
  const [dossier, setDossier] = useState(false)
  const [focusCharacter, setFocusCharacter] = useState<string>()
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [modelOpen, setModelOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const startedAt = useRef(0)
  const opened = useRef<string | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 读者是否停在底部——决定流式输出要不要跟随滚动 */
  const atBottom = useRef(true)
  const [hasMore, setHasMore] = useState(false)

  const syncScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottom.current = remaining < 80
    setHasMore(remaining > 120)
  }, [])

  const resetToTop = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = 0
    atBottom.current = false
    requestAnimationFrame(syncScrollState)
  }, [syncScrollState])

  // 事件流的依赖只有 sessionId，回调经 ref 取用最新实现，避免重连
  const resetToTopRef = useRef(resetToTop)
  useEffect(() => {
    resetToTopRef.current = resetToTop
  }, [resetToTop])

  const loadCatalog = useCallback(() => {
    api.sessionModel(sessionId).then(setCatalog).catch(() => undefined)
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setStreaming('')
    setRunning(false)
    setFreeMode(false)
    setError(undefined)

    const source = new EventSource(`/app/sessions/${sessionId}/events`)

    // 先连上事件流再拉历史：空存档要在这里补发开场，早于 SSE 会漏掉整段流式输出
    api.history(sessionId)
      .then(({ events }) => {
        if (cancelled) return
        setMessages(foldHistory(events))
        resetToTopRef.current()
        if (events.length === 0 && opened.current !== sessionId) {
          opened.current = sessionId
          api.prompt(sessionId, '（开始）').catch(err => setError(String(err)))
        }
      })
      .catch(err => setError(String(err)))
    loadCatalog()

    source.onmessage = (raw) => {
      const frame = JSON.parse(raw.data) as MuxFrame
      if (frame.type === 'session/projection' && frame.key === 'sessionStats') {
        setStats(frame.value as SessionStats)
        return
      }
      if (frame.type !== 'session/event' || !frame.event) return
      const event = frame.event

      if (event.type === 'turn/start') {
        startedAt.current = Date.now()
        setElapsed(0)
        setRunning(true)
        setStreaming('')
        // 新回合从头开始读；想边写边看就自己往下滚，跟随会自动接管
        resetToTopRef.current()
      }
      if (event.type === 'turn/end') setRunning(false)

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
  }, [sessionId, loadCatalog])

  // 生成中的秒表：比转圈更能说明"还在动"
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100)
    return () => clearInterval(timer)
  }, [running])

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // 流式输出只在读者本就停在底部时跟随，往上翻看时不打断
  useEffect(() => {
    if (!streaming) return
    if (atBottom.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    syncScrollState()
  }, [streaming, syncScrollState])

  // 选项、错误等落定后重新测量，决定是否提示"还有内容"
  useEffect(() => {
    requestAnimationFrame(syncScrollState)
  }, [messages, freeMode, error, syncScrollState])

  useEffect(() => {
    if (freeMode) textareaRef.current?.focus()
  }, [freeMode])

  const latest = useMemo(() => {
    const index = messages.findLastIndex(m => m.role === 'assistant')
    return index >= 0 ? parseTurn(messages[index].text) : undefined
  }, [messages])

  const lastPlayerAction = useMemo(() => {
    const index = messages.findLastIndex(m => m.role === 'user')
    return index >= 0 ? messages[index].text : undefined
  }, [messages])

  // 正文里最近一个场景标题，作为顶栏的"当前场景"
  useEffect(() => {
    const source = streaming || latest?.narrative
    if (!source) return
    const headings = [...source.matchAll(/^#{3,4}\s+(.+)$/gm)]
    if (headings.length) setScene(headings[headings.length - 1][1])
  }, [streaming, latest])

  const send = async (text: string) => {
    if (!text.trim()) return
    setError(undefined)
    setFreeMode(false)
    setInput('')
    try {
      await api.prompt(sessionId, text)
    } catch (err) {
      setError(String(err))
    }
  }

  const characterNames = story?.cast.map(c => c.name) ?? []
  const options = !running && !streaming ? latest?.options ?? [] : []
  // GM 没按格式给选项时也要留出路，否则玩家无处可点
  const showFreeEntry = !running && !streaming && !freeMode
  const turnNo = stats?.turns ?? 0

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">TALEFORGE</span>
        <div className="crumbs">
          <b>{story?.title ?? '游戏'}</b>
          {turnNo > 0 && <span>第 {turnNo} 回合</span>}
          {scene && <span>{scene}</span>}
        </div>
        <div className="tools">
          <button onClick={() => setModelOpen(true)} title="切换本局模型">
            ▨ {catalog?.current.model.replace('deepseek-v4-', '') ?? '…'}
          </button>
          <button onClick={() => setDossier(true)}>▤ 卷宗</button>
          <button onClick={onOpenHistory}>▦ 回顾</button>
          <button onClick={onExit}>← 离开</button>
        </div>
      </header>

      <div className="scroll" ref={scrollRef} onScroll={syncScrollState}>
        <div className="column">
          {lastPlayerAction && (
            <div className="player-block">
              <span className="label">你</span>
              <p>{lastPlayerAction}</p>
            </div>
          )}

          {running && (
            <div className="progress">
              <div className="bar"><i /></div>
              <div className="progress-row">
                <span>
                  GM 落笔中 · {elapsed.toFixed(1)}s
                  {streaming && ` · ${streaming.length} 字`}
                </span>
                <button className="stop" onClick={() => void api.cancel(sessionId)}>■ 停止</button>
              </div>
            </div>
          )}

          {(streaming || latest) && (
            <div className="gm-block">
              <span className="label">GM{turnNo > 0 ? ` · 第 ${turnNo} 回合` : ''}</span>
              <StoryMarkdown
                text={streaming || latest?.narrative || ''}
                characters={characterNames}
                onCharacter={name => setFocusCharacter(name)}
              />
              {streaming && <span className="caret" />}
            </div>
          )}

          {!streaming && !latest && !running && (
            <p className="dim">正在开场…</p>
          )}

          {/* 选项跟随正文，读完才出现——不占常驻屏幕空间 */}
          {options.length > 0 && (
            <div className="choices">
              {options.map(o => (
                <button key={o.key} className="choice" onClick={() => void send(`${o.key}. ${o.label}`)}>
                  <span className="key">{o.key}</span>
                  <span className="label">{o.label}</span>
                </button>
              ))}
              {showFreeEntry && (
                <button className="choice free" onClick={() => setFreeMode(true)}>
                  <span className="key">{FREE_KEY}</span>
                  <span className="label">其他——自己想一个行动</span>
                </button>
              )}
            </div>
          )}

          {options.length === 0 && showFreeEntry && (streaming || latest) && (
            <div className="choices">
              <button className="choice free" onClick={() => setFreeMode(true)}>
                <span className="key">{FREE_KEY}</span>
                <span className="label">自由行动</span>
              </button>
            </div>
          )}

          {freeMode && (
            <div className="composer">
              <span className="prompt">&gt;</span>
              <textarea
                ref={textareaRef}
                value={input}
                rows={2}
                placeholder="你要做什么？"
                onChange={e => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send(input)
                  }
                  if (e.key === 'Escape') setFreeMode(false)
                }}
              />
              <div className="composer-actions">
                <button className="ghost" onClick={() => setFreeMode(false)}>取消</button>
                <button onClick={() => void send(input)} disabled={!input.trim()}>发送 ▸</button>
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </div>
      </div>

      {/* 正文未读到底时的提示；点一下直接落到选项 */}
      {hasMore && (
        <button className="more-hint" onClick={scrollToEnd}>
          ▼ 还有内容
        </button>
      )}

      {dossier && story && (
        <Dossier
          story={story}
          stats={stats}
          focus={focusCharacter}
          onClose={() => {
            setDossier(false)
            setFocusCharacter(undefined)
          }}
        />
      )}
      {focusCharacter && !dossier && story && (
        <Dossier
          story={story}
          stats={stats}
          focus={focusCharacter}
          onClose={() => setFocusCharacter(undefined)}
        />
      )}
      {modelOpen && catalog && (
        <ModelPicker
          catalog={catalog}
          onClose={() => setModelOpen(false)}
          onPick={async (selection) => {
            await api.setSessionModel(sessionId, selection)
            loadCatalog()
            setModelOpen(false)
          }}
        />
      )}
    </div>
  )
}
