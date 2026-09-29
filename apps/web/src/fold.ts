/** 会话事件 → 界面状态的折叠逻辑：消息流、最近一回合的结算卡与选项、断线重连后的对齐。 */
import type {
  ChatMessage,
  CheckMeta,
  HistoryEntry,
  InventoryChange,
  MechanicsChange,
  SessionEvent,
  SettlementReceipt,
  XpMeta,
} from './types.ts'

/**
 * 一条事件对应的消息（没有就 undefined）：玩家输入、章节、场外答复、工坊的回复。
 * 开局那条"（开始）"是平台替玩家发的，不显示。
 */
export function messageOfEvent(event: SessionEvent): ChatMessage | undefined {
  const d = event.data as { text?: unknown; offstage?: unknown; opening?: unknown; content?: unknown }
  if (event.type === 'player/input') {
    if (d.opening || typeof d.text !== 'string' || !d.text) return undefined
    return { role: 'user', text: d.text, seq: event.seq, kind: d.offstage ? 'offstage' : 'play' }
  }
  if (event.type === 'chapter' && typeof d.text === 'string') {
    return { role: 'assistant', text: d.text, seq: event.seq, kind: 'play' }
  }
  if (event.type === 'reply' && typeof d.text === 'string' && d.text) {
    return { role: 'assistant', text: d.text, seq: event.seq, kind: 'offstage' }
  }
  if (event.type === 'agent/message' && typeof d.content === 'string' && d.content.trim()) {
    return { role: 'assistant', text: d.content, seq: event.seq }
  }
  return undefined
}

export interface TurnDigest {
  settlement: MechanicsChange[]
  inventory: InventoryChange[]
  check?: CheckMeta
  xp?: XpMeta
  /** 这一章结算出的下一步选项；结算步失败或还没结算时为空 */
  options: string[]
}

export const emptyDigest = (): TurnDigest => ({ settlement: [], inventory: [], options: [] })

/** 把一条事件并进当前回合的结算卡（实时帧与重拉历史走同一份逻辑）。 */
export function digestEvent(digest: TurnDigest, event: SessionEvent): TurnDigest {
  if (event.type === 'settlement') {
    const r = (event.data as { receipt?: SettlementReceipt }).receipt
    if (!r) return digest
    return {
      ...digest,
      settlement: [...digest.settlement, ...r.upkeep, ...r.resources, ...r.attributes],
      inventory: [...digest.inventory, ...r.inventory],
      ...r.xp ? { xp: r.xp } : {},
      options: r.options,
    }
  }
  if (event.type === 'points/spent') {
    const changes = (event.data as { changes?: MechanicsChange[] }).changes ?? []
    return { ...digest, settlement: [...digest.settlement, ...changes] }
  }
  if (event.type === 'check/rolled') return { ...digest, check: event.data as unknown as CheckMeta }
  return digest
}

/**
 * 最近一个写出了章节的正戏回合的结算卡（刷新页面后仍能看到本回合变化与选项）。
 * 以"最后一章"为准：之后被取消的回合没有正文，它不该把上一章的选项清掉。
 */
export function lastTurnDigest(entries: HistoryEntry[]): TurnDigest {
  const chapterAt = entries.findLastIndex(e => e.event.type === 'chapter')
  if (chapterAt < 0) return emptyDigest()
  let start = chapterAt
  while (start > 0 && entries[start].event.type !== 'turn/start') start--
  let digest = emptyDigest()
  for (let i = start + 1; i < entries.length; i++) {
    const event = entries[i].event
    if (event.type === 'turn/start') break
    digest = digestEvent(digest, event)
  }
  return digest
}

export function foldHistory(entries: HistoryEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const { event } of entries) {
    const msg = messageOfEvent(event)
    if (msg) messages.push(msg)
  }
  return messages
}

// ---- 重拉历史后的状态对齐（断线重连 / 回前台）----
// 连接断过就可能漏帧：回合结束、最终消息、机制事件都可能只存在于服务端。
// 对策是每次连接建立后重拉一遍历史，按 seq 与本地状态对齐；下面是其中的纯逻辑。

/** 快照边界：seq ≤ 它的事件保证都在这份历史里；之后的只会经实时流到达。 */
export function historyBoundary(entries: HistoryEntry[], asOfSeq?: number): number {
  const last = entries.length ? entries[entries.length - 1].event.seq : -1
  return Math.max(asOfSeq ?? -1, last)
}

/** 历史里最后一个某类型事件的 seq，没有为 -1。 */
export function lastSeqOf(entries: HistoryEntry[], type: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].event.type === type) return entries[i].event.seq
  }
  return -1
}

/**
 * 消息合并：快照以内以快照为准，快照之后经实时流已到的消息保留——
 * 拉取期间到达的帧不在快照里，整段替换会把它们弄丢。
 */
export function mergeMessages(folded: ChatMessage[], prev: ChatMessage[], boundary: number): ChatMessage[] {
  const seen = new Set(folded.map(m => m.seq))
  const extra = prev.filter(m => m.seq !== undefined && m.seq > boundary && !seen.has(m.seq))
  return extra.length ? [...folded, ...extra] : folded
}

export interface InflightInfo {
  partial: string
  lastChunkSeq: number
  startedAt: number
}

export interface ResumeInput {
  entries: HistoryEntry[]
  asOfSeq?: number
  inflight?: InflightInfo
  /** 实时流里见过的最近一次回合开始 / 结束的 seq（没见过为 -1） */
  liveTurnStart: number
  liveTurnEnd: number
  /** 拉取期间缓冲的实时分片 */
  pending: { seq: number; text: string }[]
}

export interface ResumePlan {
  boundary: number
  running: boolean
  /** 接上的正文流；不在生成中为空串 */
  streaming: string
  /** 从快照里的未收尾回合接上（需要恢复该回合的起始时间等） */
  resumedInflight: boolean
  /** 拉取窗口内实时流已开了新回合：帧处理器已在推进状态，不要用快照盖掉 */
  startedMeanwhile: boolean
  /** 实时分片去重水位线：seq ≤ 它的分片已包含在 streaming 里 */
  chunkFloor: number
}

/**
 * 决定重拉历史后的生成态：快照说的"未收尾回合"与实时流在拉取窗口内看到的回合边界
 * 谁更新听谁的——窗口内收到了 turn/end 就算结束，收到了 turn/start 就算新回合开始。
 */
export function planResume(input: ResumeInput): ResumePlan {
  const boundary = historyBoundary(input.entries, input.asOfSeq)
  const endedMeanwhile = input.liveTurnEnd > boundary
  const startedMeanwhile = input.liveTurnStart > boundary
  const resumedInflight = input.inflight !== undefined && !endedMeanwhile
  const running = resumedInflight || startedMeanwhile
  const chunkFloor = input.inflight ? input.inflight.lastChunkSeq : boundary
  const tail = input.pending.filter(c => c.seq > chunkFloor).map(c => c.text).join('')
  const base = resumedInflight && input.inflight ? input.inflight.partial : ''
  return {
    boundary,
    running,
    streaming: running ? base + tail : '',
    resumedInflight,
    startedMeanwhile,
    chunkFloor,
  }
}
