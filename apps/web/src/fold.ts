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
    // user/message 的 data 本身就是 UserMessage
    const text = textOfBlocks(event.data.content)
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
