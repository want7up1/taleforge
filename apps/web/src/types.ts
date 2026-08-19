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

export interface StoryAct {
  id: string
  title: string
  objective: string
  anchors: { id: string; text: string; required: boolean }[]
}

/** 剧本的玩家可见信息（BFF 已剥掉隐藏真相与人物暗线）。 */
export interface StoryDetail {
  id: string
  title: string
  tagline: string
  world: { overview: string; tone: string[] }
  protagonist: { name: string; identity: string; voice?: string }
  cast: { id: string; name: string; identity: string }[]
  opening: { scene: string; hook: string }
  acts: StoryAct[]
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelCatalog {
  current: ModelSelection
  routable: boolean
  groups: {
    id: string
    name: string
    models: {
      id: string
      name: string
      reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
    }[]
  }[]
}

export interface ResourceDef {
  id: string
  label: string
  group: 'affinity' | 'self' | 'world'
  min: number
  max: number
  initial: number
  floor?: number
  maxStep: number
}

export interface ResourceValue {
  value: number
  last?: { applied: number; reason: string }
}

/** mechanics projection 的载荷 */
export interface MechanicsSnapshot {
  defs: ResourceDef[]
  state: Record<string, ResourceValue>
}

/** tool/result.meta 里的一次结算（资源与属性同构） */
export interface MechanicsChange {
  id: string
  applied: number
  before: number
  after: number
  reason: string
  clamped: boolean
}

/** attributes projection 的载荷 */
export interface AttributesSnapshot {
  defs: { id: string; label: string; min: number; max: number; initial: number; maxStep: number }[]
  state: Record<string, ResourceValue>
}

/** inventory projection 的载荷 */
export interface InventorySnapshot {
  items: { id: string; name: string; qty: number; note?: string }[]
}

/** tool/result.meta 里的一次物品变动 */
export interface InventoryChange {
  op: string
  id: string
  name: string
  qty: number
  delta: number
  removed: boolean
  note?: string
  reason?: string
}

/** tool/result.meta 里的一次判定裁决 */
export interface CheckMeta {
  die: string
  roll: number
  attribute?: string
  attrValue: number
  modifier: number
  total: number
  difficulty: number
  outcome: 'crit-success' | 'success' | 'fail' | 'crit-fail'
  reason: string
}

export interface SessionStats {
  turns: number
  llmMs: number
  decodeTokens: number
}

export interface ProgressAnchor {
  id: string
  text: string
  required: boolean
  signal?: string
}

export interface ProgressAct {
  id: string
  title: string
  objective: string
  anchors: ProgressAnchor[]
}

export interface ProgressRevision {
  target: string
  id?: string
  act?: string
  op?: string
  text?: string
}

/** progress projection 的载荷：现行幕结构（含修订）、达成、压力、终局态 */
export interface ProgressSnapshot {
  acts: ProgressAct[]
  actIndex: number
  achieved: string[]
  turn: number
  phase: 'playing' | 'ended'
  pressure: { level: 'low' | 'rising' | 'high'; stalledTurns: number }
  revisions: ProgressRevision[]
}

export interface CredentialStatus {
  /** 是否已有非空值可用 */
  configured: boolean
  /** 生效来源：file = 本界面写入；env = 启动环境注入 */
  source?: string
  /** 为 false 说明被环境变量遮蔽，本界面改不动 */
  writable: boolean
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

/** 历史尾页附带的投影基线，用来在打开存档时立刻还原当前数值 */
export interface ProjectionsBlock {
  asOfSeq: number
  values: {
    mechanics?: MechanicsSnapshot | null
    attributes?: AttributesSnapshot | null
    inventory?: InventorySnapshot | null
    progress?: ProgressSnapshot | null
    sessionStats?: SessionStats
  }
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
