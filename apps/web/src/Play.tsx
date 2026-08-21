/**
 * 游玩屏：顶栏 / 叙事区（只渲染最新一回合）/ 命令栏 三段锁屏布局。
 * 自由输入不常驻——必须先选 E 才展开（硬性交互规定）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.ts'
import { Brand } from './Brand.tsx'
import { Dossier } from './Dossier.tsx'
import { foldHistory, lastSeqOf, lastTurnDigest, mergeMessages, messageOfEvent, planResume } from './fold.ts'
import { GmChat, type GmChatItem } from './GmChat.tsx'
import { LevelStrip, MeterStrip, placementOf } from './Meters.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import { openSessionStream } from './stream.ts'
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
  ProgressionSnapshot,
  ProgressSnapshot,
  SessionStats,
  StoryDetail,
  XpMeta,
} from './types.ts'

interface Props {
  sessionId: string
  story?: StoryDetail
  onExit: () => void
  onOpenHistory: () => void
  /** 重写回合会 fork 出新会话取代当前会话，由父组件切换 */
  onSessionReplaced: (sessionId: string) => void
}

const FREE_KEY = 'E'
/** 工具轮的可见化文案：正文开流前玩家看到 GM 正在做什么 */
const TOOL_PHASE: Record<string, string> = {
  report_progress: '核对剧情进度',
  adjust_resources: '结算数值',
  adjust_attributes: '结算属性',
  adjust_inventory: '清点物品',
  roll_check: '掷骰判定',
  revise_setting: '修订设定',
  grant_xp: '结算经验',
  spend_points: '分配属性点',
}
const OFFSTAGE_PREFIX = '【场外】'
/** GM 的场外回复以（场外）开头——底座场外协议规定的固定格式 */
const isOffstageReply = (text: string) => /^\s*[（(]场外[)）]/.test(text)
const isOffstageAsk = (text: string) => text.trimStart().startsWith(OFFSTAGE_PREFIX)
const stripOffstage = (text: string) =>
  text.replace(/^\s*【场外】\s*/, '').replace(/^\s*[（(]场外[)）]\s*/, '')

export function Play({ sessionId, story, onExit, onOpenHistory, onSessionReplaced }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  // 回合阶段：正文开流之前模型在干什么（构思/结算……）——长等待要让玩家看得见原因
  const [phase, setPhase] = useState<string>()
  const [stats, setStats] = useState<SessionStats>()
  const [mechanics, setMechanics] = useState<MechanicsSnapshot>()
  const [attributes, setAttributes] = useState<AttributesSnapshot>()
  const [inventory, setInventory] = useState<InventorySnapshot>()
  const [progress, setProgress] = useState<ProgressSnapshot>()
  const [progression, setProgression] = useState<ProgressionSnapshot>()
  /** 本回合的经验结算（含升级发点） */
  const [xpChange, setXpChange] = useState<XpMeta>()
  /** 待分配的加点（属性 id → 点数）：在卷宗里攒，随下一步行动发送，由 GM 经 spend_points 落账 */
  const [alloc, setAlloc] = useState<Record<string, number>>({})
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
  /** 断点续传：history 返回前先缓冲实时分片，返回后按 seq 去重拼接 */
  const histReady = useRef(false)
  const chunkFloor = useRef(-1)
  const pendingChunks = useRef<{ seq: number; text: string }[]>([])
  /** 实时流里见过的最近回合边界 seq：重拉历史时据此判断拉取窗口内回合有没有开始/结束 */
  const liveTurnStart = useRef(-1)
  const liveTurnEnd = useRef(-1)
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
    let syncToken = 0
    setMessages([])
    setStreaming('')
    setRunning(false)
    setPhase(undefined)
    setFreeMode(false)
    setError(undefined)
    histReady.current = false
    chunkFloor.current = -1
    pendingChunks.current = []
    liveTurnStart.current = -1
    liveTurnEnd.current = -1

    /** 按历史快照对齐本地状态：首次打开与每次重连后都走这里，多次调用结果一致 */
    const apply = (
      { events, projections, inflight }: Awaited<ReturnType<typeof api.history>>,
      initial: boolean,
    ) => {
      // 断点续传：回合未收尾时接上已产出的部分，再补上拉取期间到达的实时分片；
      // 拉取窗口内实时流已见到回合结束/新回合开始的，以实时流为准
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
      if (plan.resumedInflight && inflight) {
        startedAt.current = inflight.startedAt
        sawText.current = plan.streaming.length > 0
        setPhase(plan.streaming ? undefined : '构思中')
      } else if (!plan.running) {
        setPhase(undefined)
      }
      setMessages(prev => mergeMessages(foldHistory(events), prev, plan.boundary))
      // 打开存档时立刻还原数值、幕进度与最近一回合的机制事件，不必等下一回合
      const values = projections?.values
      if (values?.mechanics) setMechanics(values.mechanics)
      if (values?.attributes) setAttributes(values.attributes)
      if (values?.inventory) setInventory(values.inventory)
      if (values?.progress) setProgress(values.progress)
      if (values?.progression) setProgression(values.progression)
      if (values?.sessionStats) setStats(values.sessionStats)
      // 本回合结算卡：拉取窗口内已开了新回合的话，帧处理器正在累积，不用快照盖掉
      if (!plan.startedMeanwhile) {
        const digest = lastTurnDigest(events)
        setSettlement(digest.settlement)
        setInvChanges(digest.inventory)
        setCheck(digest.check)
        setXpChange(digest.xp)
      }
      // 阅读位置：首次打开归顶；重拉发现了实时流没见过的新回合（离开期间开始或结束的）也归顶
      const lastStart = lastSeqOf(events, 'turn/start')
      if (initial || lastStart > liveTurnStart.current) resetToTopRef.current()
      liveTurnStart.current = Math.max(liveTurnStart.current, lastStart)
      liveTurnEnd.current = Math.max(liveTurnEnd.current, lastSeqOf(events, 'turn/end'))
      // 新会话并非空日志（dsh 先写权限/沙箱等配置事件），只有 turn/start 能证明对话开过；
      // 用它判断还能挡住"首回合生成中刷新页面"导致的重复开场。
      if (lastStart < 0 && opened.current !== sessionId) {
        opened.current = sessionId
        api.prompt(sessionId, '（开始）').catch(err => setError(String(err)))
      }
    }

    /** 重拉历史并对齐。拉取期间实时分片先缓冲，对齐时按 seq 去重接上；并发拉取只认最后一次 */
    const sync = async (initial: boolean) => {
      const token = ++syncToken
      histReady.current = false
      let result: Awaited<ReturnType<typeof api.history>>
      try {
        result = await api.history(sessionId)
      } catch (err) {
        if (cancelled || token !== syncToken) return
        // 拉不到就维持现状继续收流，不让缓冲把后续分片扣住
        histReady.current = true
        const tail = pendingChunks.current.filter(c => c.seq > chunkFloor.current).map(c => c.text).join('')
        pendingChunks.current = []
        if (tail) setStreaming(s => s + tail)
        setError(String(err))
        return
      }
      if (cancelled || token !== syncToken) return
      apply(result, initial)
      histReady.current = true
    }

    // 先连上事件流再拉历史（onLive 在连接建立后触发）：空存档要在这里补发开场，早于 SSE 会
    // 漏掉整段流式输出。回前台/断线重连后同样重拉一遍，补齐连接不在期间漏掉的回合边界与消息——
    // 否则 turn/end 一丢，界面就永远停在"生成中"读秒。
    const stream = openSessionStream({
      sessionId,
      onLive: reconnect => void sync(!reconnect),
      onFrame: (raw) => {
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
        if (frame.type === 'session/projection' && frame.key === 'progression') {
          setProgression(frame.value as ProgressionSnapshot)
          return
        }
        if (frame.type !== 'session/event' || !frame.event) return
        const event = frame.event

        // 结算阶段可见化：等待的大头是推理与工具轮，报出正在做什么
        if (event.type === 'tool/call') {
          const name = (event.data as { name?: string }).name
          if (name) setPhase(TOOL_PHASE[name] ?? '结算面板')
          return
        }

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
          if (meta.kind === 'mechanics/xp') setXpChange(meta as unknown as XpMeta)
          return
        }

        if (event.type === 'turn/start') {
          liveTurnStart.current = event.seq
          startedAt.current = Date.now()
          setElapsed(0)
          setRunning(true)
          setPhase('构思中')
          setStreaming('')
          setSettlement([])
          setInvChanges([])
          setCheck(undefined)
          setXpChange(undefined)
          sawText.current = false
          setEmptyTurn(false)
          // 新回合从头开始读；想边写边看就自己往下滚，跟随会自动接管
          resetToTopRef.current()
        }
        if (event.type === 'turn/end') {
          liveTurnEnd.current = event.seq
          setRunning(false)
          // 完成却没有任何可见正文：内容翻进了推理通道，给玩家一个重新生成的出口
          const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
          if (reason === 'completed' && !sawText.current) setEmptyTurn(true)
          offstageTurn.current = false
        }

        if (event.type === 'assistant/chunk') {
          const chunk = event.data.chunk
          if (chunk?.type === 'reasoning-delta' || chunk?.type === 'reasoning') setPhase('构思中')
          if (chunk?.type === 'text-delta' && chunk.text) {
            setPhase(undefined)
            if (!histReady.current) {
              pendingChunks.current.push({ seq: event.seq, text: chunk.text })
            } else if (event.seq > chunkFloor.current) {
              setStreaming(s => s + chunk.text)
            }
          }
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
      },
    })
    loadCatalog()

    return () => {
      cancelled = true
      stream.close()
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

  // 流式输出不跟随滚动：生成速度快于阅读速度，页面追着长文跑反而没法读
  // （用户实测反馈）。读者自己控制进度，"还有内容"提示负责指路。
  useEffect(() => {
    if (streaming) syncScrollState()
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

  /** 待分配的加点写成一行【加点】跟在行动后面（用属性显示名，BFF 换算成 id 提示 GM 落账） */
  const allocLine = useMemo(() => {
    const parts = Object.entries(alloc)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${attributes?.defs.find(d => d.id === id)?.label ?? id} +${n}`)
    return parts.length ? `【加点】${parts.join('、')}` : ''
  }, [alloc, attributes])

  const onAlloc = useCallback((id: string, delta: number) => {
    setAlloc((prev) => {
      const n = Math.max(0, (prev[id] ?? 0) + delta)
      const next = { ...prev }
      if (n > 0) next[id] = n
      else delete next[id]
      return next
    })
  }, [])

  const send = async (text: string) => {
    if (!text.trim()) return
    setError(undefined)
    setFreeMode(false)
    setInput('')
    try {
      await api.prompt(sessionId, allocLine ? `${text.trim()}\n${allocLine}` : text)
      if (allocLine) setAlloc({})
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

  const [flushNote, setFlushNote] = useState<string>()
  const flushRevisions = async () => {
    setFlushNote('落盘中…')
    try {
      const r = await api.flushRevisions(sessionId)
      setFlushNote(`已落盘 ${r.applied} 条${r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''}——下一局从修订版开始`)
    } catch (err) {
      setFlushNote(String(err))
    }
  }

  const [retrying, setRetrying] = useState(false)
  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    setError(undefined)
    try {
      const { sessionId: next } = await api.retry(sessionId)
      onSessionReplaced(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setRetrying(false)
    }
  }

  // 防剧透：只有名字在正文里真实出现过的人物才算"已出场"。
  // 中文姓名常被简称（林绾绾→绾绾），去姓后 ≥2 字的后缀也算命中。
  const knownCast = useMemo(() => {
    const known = new Set<string>()
    if (!story) return known
    const corpus = messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n') + '\n' + streaming
    for (const c of story.cast) {
      const short = c.name.length >= 3 ? c.name.slice(1) : ''
      if (corpus.includes(c.name) || (short.length >= 2 && corpus.includes(short))) known.add(c.id)
    }
    return known
  }, [messages, streaming, story])

  /** 资源可见性：hidden 选位 or 绑定人物未出场 → 不给玩家看 */
  const defVisible = useCallback((def: { display?: string; revealWith?: string; group: string }) =>
    placementOf(def as never) !== 'hidden' && (!def.revealWith || knownCast.has(def.revealWith)), [knownCast])

  const characterNames = story?.cast.filter(c => knownCast.has(c.id)).map(c => c.name) ?? []
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
        <Brand />
        <div className="crumbs">
          <b>{story?.title ?? '游戏'}</b>
          {currentAct && <span>{ended ? '剧终' : currentAct.title}</span>}
          {turnNo > 0 && <span>第 {turnNo} 回合</span>}
          {scene && <span>{scene}</span>}
        </div>
        {progression && progression.display !== 'panel' && (
          <LevelStrip progression={progression} onClick={() => setDossier(true)} />
        )}
        {mechanics && <MeterStrip snapshot={mechanics} knownCast={knownCast} />}
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
                  GM {phase ?? '落笔中'} · {elapsed.toFixed(1)}s
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

          {(settlement.length > 0 || invChanges.length > 0 || (xpChange && xpChange.applied !== 0)) && !running && (
            <div className="settlement">
              <span className="settlement-title">本回合结算</span>
              {xpChange && xpChange.applied !== 0 && (
                <div className="settlement-row">
                  <b className={xpChange.applied > 0 ? 'up' : 'down'}>
                    {xpChange.applied > 0 ? `+${xpChange.applied}` : xpChange.applied}
                  </b>
                  <span className="settlement-label">{progression?.label ?? '经验'}</span>
                  <span className="settlement-after">
                    → {xpChange.after}{progression?.next != null ? `/${progression.next}` : ''}
                  </span>
                  <span className="settlement-reason">{xpChange.reason}</span>
                </div>
              )}
              {xpChange && xpChange.pointsGranted > 0 && (
                <div className="settlement-row levelup">
                  <b className="up">▲</b>
                  <span className="settlement-label">升级！Lv.{xpChange.levelBefore} → Lv.{xpChange.levelAfter}</span>
                  <span className="settlement-after">获得 {xpChange.pointsGranted} 点属性点</span>
                </div>
              )}
              {settlement.filter((c) => {
                // hidden 选位与未出场人物的数值只记账不展示（GM 侧照常可见）
                const def = mechanics?.defs.find(d => d.id === c.id)
                return !def || defVisible(def)
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

          {/* 属性点：未分配提示 / 待分配预览，加点本身在卷宗里做，随下一步行动落账 */}
          {idle && !ended && progression && (progression.unspent > 0 || allocLine) && (
            <div className="alloc-box">
              {allocLine
                ? <span>◆ 待分配：{allocLine.replace('【加点】', '')}（随下一步行动生效）</span>
                : <span>◆ 你有 {progression.unspent} 点属性点未分配</span>}
              <span className="alloc-actions">
                <button className="ghost" onClick={() => setDossier(true)}>{allocLine ? '调整' : '去加点'}</button>
                {allocLine && <button className="ghost" onClick={() => setAlloc({})}>清除</button>}
              </span>
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

          {/* 重写上一回合：fork 弃旧线，同一行动重新生成 */}
          {idle && !ended && latest && !freeMode && (
            <button className="retry-line" onClick={() => void retry()} disabled={retrying}>
              {retrying ? '↻ 正在回退重写…' : '↻ 对这回合不满意——重写'}
            </button>
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
          progression={progression}
          alloc={alloc}
          onAlloc={onAlloc}
          knownCast={knownCast}
          focus={focusCharacter}
          onFlushRevisions={() => void flushRevisions()}
          flushNote={flushNote}
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
