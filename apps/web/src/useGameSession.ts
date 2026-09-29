/**
 * 一局冒险的实时状态：事件流（SSE）+ 历史快照对齐 + 断点续传 + 回合动作。
 *
 * 逻辑原样搬自旧版游玩屏（界面换成 Rpgforge 的外观，这一层没动）：
 * - 先连上事件流再拉历史：空存档要在这里补发开场，早于 SSE 会漏掉整段流式输出；
 * - 回前台 / 断线重连后重拉一遍历史，按 seq 对齐——否则 turn/end 一丢，界面就永远停在"生成中"；
 * - 拉取期间实时分片先缓冲，对齐时按 seq 去重接上（planResume）；
 * - 日志被截断（重写、回退、读档）时服务端推 reset，本地清空后按全新打开重拉。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { digestEvent, emptyDigest, foldHistory, lastSeqOf, lastTurnDigest, mergeMessages, messageOfEvent, planResume, type TurnDigest } from './fold.ts'
import { openSessionStream } from './stream.ts'
import type {
  AttributesSnapshot,
  ChatMessage,
  InventorySnapshot,
  MechanicsSnapshot,
  ProgressionSnapshot,
  ProgressSnapshot,
  SessionStats,
  SessionValues,
  StreamFrame,
} from './types.ts'

export interface Panels {
  mechanics?: MechanicsSnapshot
  attributes?: AttributesSnapshot
  inventory?: InventorySnapshot
  progress?: ProgressSnapshot
  progression?: ProgressionSnapshot
  stats?: SessionStats
}

const OFFSTAGE_PREFIX = '【场外】'

export function useGameSession(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [running, setRunning] = useState(false)
  // 回合阶段：正文开流之前模型在干什么（构思/掷骰/结算……）——长等待要让玩家看得见原因
  const [phase, setPhase] = useState<string>()
  const [panels, setPanels] = useState<Panels>({})
  /** 最近一章的结算卡：数值、物品、判定、经验，以及结算步给出的下一步选项 */
  const [digest, setDigest] = useState<TurnDigest>(emptyDigest)
  const [error, setError] = useState<string>()
  const [elapsed, setElapsed] = useState(0)
  /** 这局开过回合没有（开场那一回合失败或被停掉时，界面要给出重新开场的出口） */
  const [started, setStarted] = useState(false)
  /** 完成却没有可见正文：模型把内容写进了推理通道 */
  const [emptyTurn, setEmptyTurn] = useState(false)
  const [busy, setBusy] = useState<string>()
  /** 当前生成中的回合是否是场外回合（turn/start 与断点信息都带回合类型） */
  const offstageTurn = useRef(false)
  const [offstreaming, setOffstreaming] = useState(false)
  const sawText = useRef(true)
  const startedAt = useRef(0)
  const opened = useRef<string | undefined>(undefined)
  const histReady = useRef(false)
  const chunkFloor = useRef(-1)
  const pendingChunks = useRef<{ seq: number; text: string }[]>([])
  const liveTurnStart = useRef(-1)
  const liveTurnEnd = useRef(-1)
  /** 新回合开始时的回调（界面据此回到顶部） */
  const onTurnStart = useRef<() => void>(() => undefined)

  const setOffstage = (v: boolean) => {
    offstageTurn.current = v
    setOffstreaming(v)
  }

  useEffect(() => {
    let cancelled = false
    let syncToken = 0
    setMessages([])
    setStreaming('')
    setRunning(false)
    setPhase(undefined)
    setError(undefined)
    setPanels({})
    setDigest(emptyDigest())
    setStarted(false)
    histReady.current = false
    chunkFloor.current = -1
    pendingChunks.current = []
    liveTurnStart.current = -1
    liveTurnEnd.current = -1

    const applyValues = (values?: SessionValues) => {
      if (!values) return
      setPanels(prev => ({
        mechanics: values.mechanics ?? prev.mechanics,
        attributes: values.attributes ?? prev.attributes,
        inventory: values.inventory ?? prev.inventory,
        progress: values.progress ?? prev.progress,
        progression: values.progression ?? prev.progression,
        stats: values.sessionStats ?? prev.stats,
      }))
    }

    /** 按历史快照对齐本地状态：首次打开与每次重连后都走这里，多次调用结果一致 */
    const apply = ({ events, projections, inflight }: Awaited<ReturnType<typeof api.history>>, initial: boolean) => {
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
        setOffstage(inflight.kind === 'offstage')
        sawText.current = plan.streaming.length > 0
        setPhase(plan.streaming ? undefined : inflight.phase ?? '构思中')
      } else if (!plan.running) {
        setPhase(undefined)
        setOffstage(false)
      }
      setMessages(prev => mergeMessages(foldHistory(events), prev, plan.boundary))
      applyValues(projections?.values)
      if (!plan.startedMeanwhile) setDigest(lastTurnDigest(events))
      const lastStart = lastSeqOf(events, 'turn/start')
      setStarted(lastStart >= 0)
      if (initial || lastStart > liveTurnStart.current) onTurnStart.current()
      liveTurnStart.current = Math.max(liveTurnStart.current, lastStart)
      liveTurnEnd.current = Math.max(liveTurnEnd.current, lastSeqOf(events, 'turn/end'))
      // 空存档补发开场：只有 turn/start 能证明对话开过，还能挡住"首回合生成中刷新"导致的重复开场
      if (lastStart < 0 && opened.current !== sessionId) {
        opened.current = sessionId
        api.prompt(sessionId, '（开始）').catch(err => setError(String(err)))
      }
    }

    const sync = async (initial: boolean) => {
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
      apply(result, initial)
      histReady.current = true
    }

    const stream = openSessionStream({
      sessionId,
      onLive: reconnect => void sync(!reconnect),
      onFrame: (raw) => {
        const frame = JSON.parse(raw.data) as StreamFrame
        if (frame.type === 'state') {
          applyValues(frame.state)
          return
        }
        if (frame.type === 'reset') {
          liveTurnStart.current = -1
          liveTurnEnd.current = -1
          setMessages([])
          setDigest(emptyDigest())
          void sync(true)
          return
        }
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
        const event = frame.event
        const data = event.data as { kind?: string; reason?: string; error?: string; text?: string }
        if (event.type === 'turn/start') {
          liveTurnStart.current = event.seq
          setStarted(true)
          startedAt.current = Date.now()
          setElapsed(0)
          setRunning(true)
          setPhase('构思中')
          setStreaming('')
          setError(undefined)
          setOffstage(data.kind === 'offstage')
          if (data.kind === 'play') {
            setDigest(emptyDigest())
            sawText.current = false
            setEmptyTurn(false)
            onTurnStart.current()
          }
          return
        }
        if (event.type === 'turn/end') {
          liveTurnEnd.current = event.seq
          setRunning(false)
          setPhase(undefined)
          setStreaming('')
          if (data.reason === 'error' && data.error) setError(data.error)
          if (data.kind === 'play' && data.reason === 'completed' && !sawText.current) setEmptyTurn(true)
          // 没正常收尾的回合：重拉一遍，让结算卡与选项回到最后一章
          if (data.reason !== 'completed') void sync(false)
          setOffstage(false)
          return
        }
        if (event.type === 'settlement' || event.type === 'points/spent' || event.type === 'check/rolled') {
          setDigest(d => digestEvent(d, event))
          return
        }
        const msg = messageOfEvent(event)
        if (msg) {
          if (event.type === 'chapter') sawText.current = Boolean(data.text?.trim())
          setMessages(prev => (prev.some(m => m.seq === msg.seq) ? prev : [...prev, msg]))
          if (msg.role === 'assistant') setStreaming('')
        }
      },
    })

    return () => {
      cancelled = true
      stream.close()
    }
  }, [sessionId])

  // 生成中的秒表：比转圈更能说明"还在动"
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 200)
    return () => clearInterval(timer)
  }, [running])

  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setError(undefined)
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }, [])

  return {
    messages,
    streaming,
    running,
    phase,
    elapsed,
    panels,
    digest,
    error,
    setError,
    started,
    emptyTurn,
    setEmptyTurn,
    offstreaming,
    busy,
    onTurnStart,
    send: (text: string) => act('send', () => api.prompt(sessionId, text)),
    sendOffstage: async (text: string) => {
      setOffstage(true)
      setError(undefined)
      try {
        await api.prompt(sessionId, `${OFFSTAGE_PREFIX}${text}`)
      } catch (err) {
        setOffstage(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    retry: () => act('retry', () => api.retry(sessionId)),
    rewind: (toTurn: number) => act('rewind', () => api.rewind(sessionId, toTurn)),
    cancel: () => void api.cancel(sessionId),
  }
}
