/**
 * 游玩屏：顶栏 / 叙事区（只渲染最新一回合）/ 命令栏 三段锁屏布局。
 * 自由输入不常驻——必须先选 E 才展开（硬性交互规定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.ts'
import { Dossier } from './Dossier.tsx'
import { foldHistory, lastTurnDigest, messageOfEvent } from './fold.ts'
import { GmChat, type GmChatItem } from './GmChat.tsx'
import { MeterStrip, placementOf } from './Meters.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import { parseTurn } from './turn.ts'
import type {
  AttributesSnapshot,
  ChatMessage,
  CheckMeta,
  InventoryChange,
  InventorySnapshot,
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
const isOffstageAsk = (text: string) => text.trimStart().startsWith(OFFSTAGE_PREFIX)
const stripOffstage = (text: string) =>
  text.replace(/^\s*【场外】\s*/, '').replace(/^\s*[（(]场外[)）]\s*/, '')

export function Play({ sessionId, story, onExit, onOpenHistory }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState<SessionStats>()
  const [mechanics, setMechanics] = useState<MechanicsSnapshot>()
  const [attributes, setAttributes] = useState<AttributesSnapshot>()
  const [inventory, setInventory] = useState<InventorySnapshot>()
  const [progress, setProgress] = useState<ProgressSnapshot>()
  /** 本回合的结算明细（资源+属性），跟着正文一起显示 */
  const [settlement, setSettlement] = useState<MechanicsChange[]>([])
  /** 本回合的物品变动与判定 */
  const [invChanges, setInvChanges] = useState<InventoryChange[]>([])
  const [check, setCheck] = useState<CheckMeta>()
  const [scene, setScene] = useState<string>()
  const [freeMode, setFreeMode] = useState(false)
  /** 场外悬浮框开关；场外对话不进正文流 */
  const [gmOpen, setGmOpen] = useState(false)
  /** 当前生成中的回合是否由场外消息发起（刷新丢失时靠（场外）前缀兜底判断） */
  const offstageTurn = useRef(false)
  /** 本回合是否收到过可见正文——完成却全空说明模型把内容写进了推理通道 */
  const sawText = useRef(true)
  const [emptyTurn, setEmptyTurn] = useState(false)
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
        // 打开存档时立刻还原数值、幕进度与最近一回合的机制事件，不必等下一回合
        if (projections?.values.mechanics) setMechanics(projections.values.mechanics)
        if (projections?.values.attributes) setAttributes(projections.values.attributes)
        if (projections?.values.inventory) setInventory(projections.values.inventory)
        if (projections?.values.progress) setProgress(projections.values.progress)
        const digest = lastTurnDigest(events)
        setSettlement(digest.settlement)
        setInvChanges(digest.inventory)
        setCheck(digest.check)
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
      if (frame.type === 'session/projection' && frame.key === 'attributes') {
        setAttributes(frame.value as AttributesSnapshot)
        return
      }
      if (frame.type === 'session/projection' && frame.key === 'inventory') {
        setInventory(frame.value as InventorySnapshot)
        return
      }
      if (frame.type === 'session/projection' && frame.key === 'progress') {
        setProgress(frame.value as ProgressSnapshot)
        return
      }
      if (frame.type !== 'session/event' || !frame.event) return
      const event = frame.event

      // 机制事件从 tool/result 的 meta 取，与正文同回合展示（turn/start 时清零）
      if (event.type === 'tool/result') {
        const meta = (event.data as { meta?: { kind?: string; changes?: unknown[] } }).meta
        if (!meta?.kind) return
        if ((meta.kind === 'mechanics/resources' || meta.kind === 'mechanics/attributes') && meta.changes?.length) {
          setSettlement(prev => [...prev, ...(meta.changes as MechanicsChange[])])
        }
        if (meta.kind === 'mechanics/inventory' && meta.changes?.length) {
          setInvChanges(prev => [...prev, ...(meta.changes as InventoryChange[])])
        }
        if (meta.kind === 'mechanics/check') setCheck(meta as unknown as CheckMeta)
        return
      }

      if (event.type === 'turn/start') {
        startedAt.current = Date.now()
        setElapsed(0)
        setRunning(true)
        setStreaming('')
        setSettlement([])
        setInvChanges([])
        setCheck(undefined)
        sawText.current = false
        setEmptyTurn(false)
        // 新回合从头开始读；想边写边看就自己往下滚，跟随会自动接管
        resetToTopRef.current()
      }
      if (event.type === 'turn/end') {
        setRunning(false)
        // 完成却没有任何可见正文：内容翻进了推理通道，给玩家一个重新生成的出口
        const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
        if (reason === 'completed' && !sawText.current) setEmptyTurn(true)
        offstageTurn.current = false
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
        if (msg.role === 'assistant') sawText.current = true
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

  // 正文流只认正戏：场外往来一律剥离，进悬浮框
  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'assistant' && !isOffstageReply(m.text)) return parseTurn(m.text)
    }
    return undefined
  }, [messages])

  /** 场外对话史：同一会话里的【场外】/（场外）消息对 */
  const gmChatItems = useMemo<GmChatItem[]>(() =>
    messages
      .filter(m => (m.role === 'user' ? isOffstageAsk(m.text) : isOffstageReply(m.text)))
      .map(m => ({ role: m.role === 'user' ? 'you' : 'gm', text: stripOffstage(m.text) })), [messages])

  const lastPlayerAction = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && !isOffstageAsk(m.text)) return m.text
    }
    return undefined
  }, [messages])

  // 正文里最近一个场景标题，作为顶栏的"当前场景"（场外流不参与）
  useEffect(() => {
    const source = (streaming && !isOffstageReply(streaming) ? streaming : '') || latest?.narrative
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

  const sendOffstage = async (text: string) => {
    setError(undefined)
    offstageTurn.current = true
    try {
      await api.prompt(sessionId, `${OFFSTAGE_PREFIX}${text}`)
    } catch (err) {
      offstageTurn.current = false
      setError(String(err))
    }
  }

  const characterNames = story?.cast.map(c => c.name) ?? []
  const ended = progress?.phase === 'ended'
  // 场外回合的流式输出只进悬浮框，不打扰正文
  const offstreaming = offstageTurn.current || isOffstageReply(streaming)
  const mainStreaming = offstreaming ? '' : streaming
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

          {running && !offstreaming && (
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

          {(mainStreaming || latest) && (
            <div className="gm-block">
              <span className="label">GM{turnNo > 0 ? ` · 第 ${turnNo} 回合` : ''}</span>
              <StoryMarkdown
                text={mainStreaming || latest?.narrative || ''}
                characters={characterNames}
                onCharacter={name => setFocusCharacter(name)}
              />
              {mainStreaming && <span className="caret" />}
            </div>
          )}

          {!streaming && !latest && !running && (
            <p className="dim">正在开场…</p>
          )}

          {/* 判定卡片：代码权威的掷骰结果，数字只出现在这里，不进正文 */}
          {check && !running && (
            <div className={`check-card o-${check.outcome}`}>
              <span className="check-reason">⚄ {check.reason}</span>
              <span className="check-math">
                {check.die} = {check.roll}
                {check.attribute ? ` + ${check.attrValue}` : ''}
                {check.modifier !== 0 ? ` ${check.modifier > 0 ? '+' : '−'} ${Math.abs(check.modifier)}` : ''}
                {' '}vs 难度 {check.difficulty}
              </span>
              <b className="check-outcome">
                {{ 'crit-success': '大成功', 'success': '成功', 'fail': '失败', 'crit-fail': '大失败' }[check.outcome]}
              </b>
            </div>
          )}

          {(settlement.length > 0 || invChanges.length > 0) && !running && (
            <div className="settlement">
              <span className="settlement-title">本回合结算</span>
              {settlement.filter((c) => {
                // 剧本声明为 hidden 的数值只记账不展示（界面约定，GM 侧照常可见）
                const def = mechanics?.defs.find(d => d.id === c.id)
                return !(def && placementOf(def) === 'hidden')
              }).map((c, i) => (
                <div key={`${c.id}-${i}`} className="settlement-row">
                  <b className={c.applied > 0 ? 'up' : 'down'}>
                    {c.applied > 0 ? `+${c.applied}` : c.applied}
                  </b>
                  <span className="settlement-label">
                    {mechanics?.defs.find(d => d.id === c.id)?.label
                      ?? attributes?.defs.find(d => d.id === c.id)?.label
                      ?? c.id}
                  </span>
                  <span className="settlement-after">→ {c.after}</span>
                  <span className="settlement-reason">{c.reason}</span>
                </div>
              ))}
              {invChanges.map((c, i) => (
                <div key={`inv-${c.id}-${i}`} className="settlement-row">
                  <b className={c.delta >= 0 && !c.removed ? 'up' : 'down'}>
                    {c.removed ? '－' : c.delta >= 0 ? `+${c.delta}` : c.delta}
                  </b>
                  <span className="settlement-label">{c.name}</span>
                  <span className="settlement-after">{c.removed ? '已失去' : `现有 ${c.qty}`}</span>
                  {c.reason && <span className="settlement-reason">{c.reason}</span>}
                </div>
              ))}
            </div>
          )}

          {/* 空白回合自愈：模型把整回合写进推理通道时，给玩家一个明确的出口 */}
          {emptyTurn && idle && !ended && (
            <div className="choices">
              <div className="error">上一回合的正文没有送达（模型输出跑进了内部通道）。</div>
              <button
                className="choice free"
                onClick={() => {
                  setEmptyTurn(false)
                  void send('（上一回合我没有收到任何正文——请重新输出这一回合：正文写在正式回复里，结尾带【行动】块。）')
                }}
              >
                <span className="key">↻</span>
                <span className="label">重新生成这一回合</span>
              </button>
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

      {/* 场外通道：悬浮按钮 + 悬浮对话框，戏外沟通不进正文流 */}
      <button
        className={`gm-fab${running && offstreaming ? ' busy' : ''}${gmOpen ? ' on' : ''}`}
        onClick={() => setGmOpen(o => !o)}
        title="场外——问 GM、改设定"
      >
        GM
      </button>
      <GmChat
        open={gmOpen}
        items={gmChatItems}
        streaming={offstreaming && streaming ? stripOffstage(streaming) : undefined}
        busy={running && offstreaming}
        onSend={text => void sendOffstage(text)}
        onClose={() => setGmOpen(false)}
      />

      {(dossier || focusCharacter) && story && (
        <Dossier
          story={story}
          stats={stats}
          mechanics={mechanics}
          attributes={attributes}
          inventory={inventory}
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
