/**
 * 游玩屏：顶栏 / 叙事区（只渲染最新一回合）/ 命令栏 三段锁屏布局。
 * 自由输入不常驻——必须先选 E 才展开（硬性交互规定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.ts'
import { Dossier } from './Dossier.tsx'
import { foldHistory, lastSettlement, messageOfEvent } from './fold.ts'
import { MeterStrip } from './Meters.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import { parseTurn } from './turn.ts'
import type {
  ChatMessage,
  MechanicsChange,
  MechanicsSnapshot,
  ModelCatalog,
  MuxFrame,
  ProgressSnapshot,
  SessionStats,
  StoryDetail,
} from './types.ts'

interface Props {
  sessionId: string
  story?: StoryDetail
  onExit: () => void
  onOpenHistory: () => void
}

const FREE_KEY = 'E'
const OFFSTAGE_PREFIX = '【场外】'
/** GM 的场外回复以（场外）开头——底座场外协议规定的固定格式 */
const isOffstageReply = (text: string) => /^\s*[（(]场外[)）]/.test(text)

export function Play({ sessionId, story, onExit, onOpenHistory }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState<SessionStats>()
  const [mechanics, setMechanics] = useState<MechanicsSnapshot>()
  const [progress, setProgress] = useState<ProgressSnapshot>()
  /** 本回合的结算明细，跟着正文一起显示 */
  const [settlement, setSettlement] = useState<MechanicsChange[]>([])
  const [scene, setScene] = useState<string>()
  const [freeMode, setFreeMode] = useState(false)
  /** 场外通道：输入将以【场外】前缀发出，GM 以主持人身份回应 */
  const [offstage, setOffstage] = useState(false)
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
      .then(({ events, projections }) => {
        if (cancelled) return
        setMessages(foldHistory(events))
        // 打开存档时立刻还原数值、幕进度与最近一次结算，不必等下一回合
        if (projections?.values.mechanics) setMechanics(projections.values.mechanics)
        if (projections?.values.progress) setProgress(projections.values.progress)
        setSettlement(lastSettlement(events))
        resetToTopRef.current()
        // 新会话并非空日志（dsh 先写权限/沙箱等配置事件），只有 turn/start 能证明对话开过；
        // 用它判断还能挡住"首回合生成中刷新页面"导致的重复开场。
        const started = events.some(e => e.event.type === 'turn/start')
        if (!started && opened.current !== sessionId) {
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
      if (frame.type === 'session/projection' && frame.key === 'mechanics') {
        setMechanics(frame.value as MechanicsSnapshot)
        return
      }
      if (frame.type === 'session/projection' && frame.key === 'progress') {
        setProgress(frame.value as ProgressSnapshot)
        return
      }
      if (frame.type !== 'session/event' || !frame.event) return
      const event = frame.event

      // 结算明细从 tool/result 的 meta 取，与正文同回合展示
      if (event.type === 'tool/result') {
        const meta = (event.data as { meta?: { kind?: string; changes?: MechanicsChange[] } }).meta
        if (meta?.kind === 'mechanics/resources' && meta.changes?.length) {
          setSettlement(meta.changes)
        }
        return
      }

      if (event.type === 'turn/start') {
        startedAt.current = Date.now()
        setElapsed(0)
        setRunning(true)
        setStreaming('')
        setSettlement([])
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

  // 最近的正戏回合供正文与选项；若最新回复是场外答复，则单独展示、不顶掉正戏选项
  const { latest, offstageReply } = useMemo(() => {
    let reply: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      if (isOffstageReply(m.text)) {
        if (reply === undefined) reply = m.text
        continue
      }
      return { latest: parseTurn(m.text), offstageReply: reply }
    }
    return { latest: undefined, offstageReply: reply }
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
    const wasOffstage = offstage
    setOffstage(false)
    try {
      await api.prompt(sessionId, wasOffstage ? `${OFFSTAGE_PREFIX}${text}` : text)
    } catch (err) {
      setError(String(err))
    }
  }

  const characterNames = story?.cast.map(c => c.name) ?? []
  const ended = progress?.phase === 'ended'
  const idle = !running && !streaming
  const options = idle && !ended ? latest?.options ?? [] : []
  // GM 没按格式给选项时也要留出路，否则玩家无处可点
  const showFreeEntry = idle && !freeMode && !ended
  const currentAct = progress?.acts[progress.actIndex]
  const turnNo = stats?.turns ?? 0

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">TALEFORGE</span>
        <div className="crumbs">
          <b>{story?.title ?? '游戏'}</b>
          {currentAct && <span>{ended ? '剧终' : currentAct.title}</span>}
          {turnNo > 0 && <span>第 {turnNo} 回合</span>}
          {scene && <span>{scene}</span>}
        </div>
        {mechanics && <MeterStrip snapshot={mechanics} />}
        <div className="tools">
          <button onClick={() => setModelOpen(true)} title="切换本局模型">
            ▨<span className="t">{' '}{catalog?.current.model.replace('deepseek-v4-', '') ?? '…'}</span>
          </button>
          <button onClick={() => setDossier(true)} title="卷宗">▤<span className="t"> 卷宗</span></button>
          <button onClick={onOpenHistory} title="回顾">▦<span className="t"> 回顾</span></button>
          <button onClick={onExit} title="离开">←<span className="t"> 离开</span></button>
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

          {/* 场外答复单独成块，不顶掉正戏与选项 */}
          {offstageReply && !streaming && (
            <div className="gm-block offstage-block">
              <span className="label">GM · 场外</span>
              <StoryMarkdown
                text={offstageReply.replace(/^\s*[（(]场外[)）]\s*/, '')}
                characters={characterNames}
                onCharacter={name => setFocusCharacter(name)}
              />
            </div>
          )}

          {!streaming && !latest && !running && (
            <p className="dim">正在开场…</p>
          )}

          {settlement.length > 0 && !running && (
            <div className="settlement">
              <span className="settlement-title">本回合结算</span>
              {settlement.map(c => (
                <div key={c.id} className="settlement-row">
                  <b className={c.applied > 0 ? 'up' : 'down'}>
                    {c.applied > 0 ? `+${c.applied}` : c.applied}
                  </b>
                  <span className="settlement-label">
                    {mechanics?.defs.find(d => d.id === c.id)?.label ?? c.id}
                  </span>
                  <span className="settlement-after">→ {c.after}</span>
                  <span className="settlement-reason">{c.reason}</span>
                </div>
              ))}
            </div>
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
                <button className="choice free" onClick={() => { setFreeMode(true); setOffstage(false) }}>
                  <span className="key">{FREE_KEY}</span>
                  <span className="label">其他——自己想一个行动</span>
                </button>
              )}
              {showFreeEntry && (
                <button className="choice free offstage-entry" onClick={() => { setFreeMode(true); setOffstage(true) }}>
                  <span className="key">⌗</span>
                  <span className="label">场外——问 GM、改设定</span>
                </button>
              )}
            </div>
          )}

          {options.length === 0 && showFreeEntry && (streaming || latest) && (
            <div className="choices">
              <button className="choice free" onClick={() => { setFreeMode(true); setOffstage(false) }}>
                <span className="key">{FREE_KEY}</span>
                <span className="label">自由行动</span>
              </button>
              <button className="choice free offstage-entry" onClick={() => { setFreeMode(true); setOffstage(true) }}>
                <span className="key">⌗</span>
                <span className="label">场外——问 GM、改设定</span>
              </button>
            </div>
          )}

          {/* 终幕：系统裁定的结局，收起一切输入 */}
          {ended && idle && (
            <div className="ending-card">
              <div className="ending-mark">—— 剧终 ——</div>
              {story && <p className="ending-title">{story.title}</p>}
              <div className="ending-actions">
                <button onClick={onOpenHistory}>回顾全程</button>
                <button onClick={onExit}>返回首页</button>
              </div>
            </div>
          )}

          {freeMode && (
            <div className={`composer${offstage ? ' offstage' : ''}`}>
              <span className="prompt">{offstage ? '⌗' : '>'}</span>
              <textarea
                ref={textareaRef}
                value={input}
                rows={2}
                placeholder={offstage ? '场外：问 GM，或下指令——改剧情走向、人物、设定' : '你要做什么？'}
                onChange={e => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send(input)
                  }
                  if (e.key === 'Escape') {
                    setFreeMode(false)
                    setOffstage(false)
                  }
                }}
              />
              <div className="composer-actions">
                <button className="ghost" onClick={() => { setFreeMode(false); setOffstage(false) }}>取消</button>
                <button onClick={() => void send(input)} disabled={!input.trim()}>
                  {offstage ? '场外发送 ▸' : '发送 ▸'}
                </button>
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

      {(dossier || focusCharacter) && story && (
        <Dossier
          story={story}
          stats={stats}
          mechanics={mechanics}
          progress={progress}
          focus={focusCharacter}
          onClose={() => {
            setDossier(false)
            setFocusCharacter(undefined)
          }}
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
