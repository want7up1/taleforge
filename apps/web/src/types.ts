/** 与 BFF 交互的最小类型面（形状依据 packages/engine 的事件与视图，只声明本端用到的字段）。 */

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

/** 剧本的玩家可见信息（BFF 已剥掉隐藏真相、人物暗线与设定条目）。 */
export interface StoryDetail {
  id: string
  title: string
  tagline: string
  world: { overview: string; tone: string[] }
  protagonist: { name: string; identity: string; voice?: string }
  cast: { id: string; name: string; identity: string }[]
  opening: { scene: string; hook: string }
  acts: StoryAct[]
  craft?: { modules: string[]; rating?: string; rules?: string[] }
  mechanics?: {
    resources?: unknown[]
    attributes?: unknown[]
    checks?: { die?: string }
    inventory?: { initial?: unknown[] }
    progression?: { thresholds?: number[]; pointsPerLevel?: number }
  }
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
  /** 显示位置（剧本选位）；缺省：self 组进 strip，其余 panel */
  display?: 'strip' | 'panel' | 'hidden'
  /** 防剧透门控：绑定 cast id，出场前不可见 */
  revealWith?: string
}

export interface ResourceValue {
  value: number
  last?: { applied: number; reason: string }
}

/** mechanics projection 的载荷 */
export interface MechanicsSnapshot {
  defs: ResourceDef[]
  state: Record<string, ResourceValue>
  /** 剧本自定义的分组标题 */
  groups?: Partial<Record<ResourceDef['group'], string>>
}

/** 结算回执里的一次数值变化（资源与属性同构） */
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

/** 结算回执里的一次物品变动 */
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

/** progression projection 的载荷：等级、经验、未分配属性点 */
export interface ProgressionSnapshot {
  label: string
  xp: number
  level: number
  maxLevel: number
  /** 当前等级的起点阈值 */
  prev: number
  /** 下一级阈值；满级为 null */
  next: number | null
  unspent: number
  pointsPerLevel: number
  /** 各级显示名（剧本声明了才有），代替 Lv.N */
  levelNames?: string[]
  display?: 'strip' | 'panel'
}

/** 结算回执里的一次经验结算（含升级发点与剧情奖励点） */
export interface XpMeta {
  applied: number
  before: number
  after: number
  reason: string
  levelBefore: number
  levelAfter: number
  /** 本次发放的属性点总数（升级点 + 奖励点） */
  pointsGranted: number
  /** 其中的剧情奖励点 */
  bonusPoints?: number
}

/** check/rolled 事件：一次判定裁决 */
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
  promptTokens?: number
  cacheHitTokens?: number
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
  guidance?: string
}

/** progress 视图：现行幕结构（含修订）、达成、压力、终局态 */
export interface ProgressSnapshot {
  acts: ProgressAct[]
  actIndex: number
  achieved: string[]
  turn: number
  /** finale：主线已齐、结局章还没写（玩家还要选最后一步）；ended：剧终 */
  phase: 'playing' | 'finale' | 'ended'
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

/** 会话日志里的一条事件（信封 {type, seq, time, data}；BFF 已剥掉剧本快照与推理文本） */
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** settlement 事件的回执：这一章结出了什么（数值、物品、经验、锚点）与下一步选项 */
export interface SettlementReceipt {
  anchors: { accepted: string[]; ignored: { id: string; reason: string }[] }
  upkeep: MechanicsChange[]
  resources: MechanicsChange[]
  attributes: MechanicsChange[]
  inventory: InventoryChange[]
  xp?: XpMeta
  options: string[]
  rejected: string[]
  advancedTo?: number
  ended: boolean
}

export interface HistoryEntry {
  event: SessionEvent
}

/** 会话视图（面板与进度）：打开存档时立刻还原，之后随 state 帧更新 */
export interface SessionValues {
  title?: string
  model?: { model: string; effort: string }
  mechanics?: MechanicsSnapshot | null
  attributes?: AttributesSnapshot | null
  inventory?: InventorySnapshot | null
  progress?: ProgressSnapshot | null
  progression?: ProgressionSnapshot | null
  sessionStats?: SessionStats
}

/** 历史尾页附带的视图基线 */
export interface ProjectionsBlock {
  asOfSeq: number
  values: SessionValues
}

/** SSE 帧：持久事件、正文增量、阶段、视图快照、日志被截断（重写回合）后的重置 */
export type StreamFrame =
  | { type: 'event'; event: SessionEvent }
  | { type: 'delta'; seq: number; channel: 'text'; text: string }
  | { type: 'phase'; seq: number; phase: string }
  | { type: 'state'; state: SessionValues }
  | { type: 'reset' }

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  seq?: number
  /** play：正戏（玩家行动 / 章节）；offstage：场外往来 */
  kind?: 'play' | 'offstage'
}
