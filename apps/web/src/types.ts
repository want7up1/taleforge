/** 与 BFF/dsh 交互的最小类型面（形状依据 dsh apiproxy 契约，只声明本端用到的字段）。 */

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  agentPreset?: string
  projections?: {
    asOfSeq: number
    values: { title?: string | null }
  }
}

export interface ScenarioSummary {
  id: string
  name: string
  description?: string
}

export interface ActionOption {
  key: string
  label: string
}

export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown> & {
    chunk?: { type: string; text?: string; index?: number }
    message?: { role?: string; content?: ContentBlock[] }
    content?: ContentBlock[]
  }
}

export interface HistoryEntry {
  event: SessionEvent
}

export interface MuxFrame {
  type: string
  sessionId?: string
  event?: SessionEvent
  [key: string]: unknown
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  seq?: number
}
