/** 会话事件 → 聊天消息的折叠逻辑（M0：只认 user/message 与 assistant/message 的 text 块）。 */
import type {
  ChatMessage,
  CheckMeta,
  ContentBlock,
  HistoryEntry,
  InventoryChange,
  MechanicsChange,
  SessionEvent,
} from './types.ts'

export function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as ContentBlock[])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

export function messageOfEvent(event: SessionEvent): ChatMessage | undefined {
  if (event.type === 'user/message') {
    // user/message 的 data 本身就是 UserMessage；回合头注入块（【回合流程】）是
    // 平台给 GM 的机械提醒，不是玩家的话，界面上剥掉
    const blocks = Array.isArray(event.data.content)
      ? event.data.content.filter(b => !(typeof b.text === 'string' && b.text.trimStart().startsWith('【回合流程】')))
      : event.data.content
    const text = textOfBlocks(blocks)
    if (text) return { role: 'user', text, seq: event.seq }
  }
  if (event.type === 'assistant/message') {
    const text = textOfBlocks(event.data.message?.content)
    if (text) return { role: 'assistant', text, seq: event.seq }
  }
  return undefined
}

export interface TurnDigest {
  settlement: MechanicsChange[]
  inventory: InventoryChange[]
  check?: CheckMeta
}

/** 汇总最近一个回合的机制事件（结算/物品/判定），供刷新页面后仍能看到本回合变化。 */
export function lastTurnDigest(entries: HistoryEntry[]): TurnDigest {
  let lastTurnStart = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].event.type === 'turn/start') {
      lastTurnStart = i
      break
    }
  }
  const digest: TurnDigest = { settlement: [], inventory: [] }
  for (let i = Math.max(0, lastTurnStart); i < entries.length; i++) {
    const event = entries[i].event
    if (event.type !== 'tool/result') continue
    const meta = (event.data as { meta?: { kind?: string; changes?: unknown[] } }).meta
    if (!meta?.kind) continue
    if (meta.kind === 'mechanics/resources' || meta.kind === 'mechanics/attributes') {
      digest.settlement.push(...(meta.changes as MechanicsChange[] ?? []))
    }
    if (meta.kind === 'mechanics/inventory') {
      digest.inventory.push(...(meta.changes as InventoryChange[] ?? []))
    }
    if (meta.kind === 'mechanics/check') digest.check = meta as unknown as CheckMeta
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
