/** 会话事件 → 聊天消息的折叠逻辑（M0：只认 user/message 与 assistant/message 的 text 块）。 */
import type {
  ChatMessage,
  ContentBlock,
  HistoryEntry,
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

/** 取最近一次机制结算，供刷新页面后仍能看到本回合的数值变化。 */
export function lastSettlement(entries: HistoryEntry[]): MechanicsChange[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i].event
    if (event.type !== 'tool/result') continue
    const meta = (event.data as { meta?: { kind?: string; changes?: MechanicsChange[] } }).meta
    if (meta?.kind === 'mechanics/resources') return meta.changes ?? []
  }
  return []
}

export function foldHistory(entries: HistoryEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const { event } of entries) {
    const msg = messageOfEvent(event)
    if (msg) messages.push(msg)
  }
  return messages
}
