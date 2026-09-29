/**
 * 会话日志的事件类型。日志是唯一的事实来源：面板、进度、章节窗口、观测统计全部由它折叠出来。
 *
 * 游戏会话：session/created → (player/input → turn/start → [points/spent] → [check/rolled…]
 *   → chapter → settlement → [act/advanced] [ending/declared] → turn/end)… 场外回合是
 *   player/input(offstage) → turn/start → [revision…] → reply → turn/end。recap 由后台在回合之间追加。
 * 工坊/修改对话：session/created → (player/input → turn/start → agent/message → tool/result… → turn/end)…
 */
import type { ToolCall, Usage } from '@taleforge/llm'
import type {
  AppliedChange,
  AppliedInventoryChange,
  CheckResult,
  XpResult,
} from '@taleforge/mechanics'
import type { Revision } from '@taleforge/progress'
import type { Story } from '@taleforge/scenario-compiler'

export type SessionKind = 'game' | 'workshop' | 'edit'

export type Effort = 'off' | 'low' | 'high' | 'max'

export interface ModelChoice {
  model: string
  effort: Effort
}

export interface CreatedData {
  kind: SessionKind
  title: string
  model: ModelChoice
  /** 游戏会话：开局时的剧本快照。会话锁定这一代（热字段除外，见 engine hotStory） */
  story?: Story
  storyId?: string
  /** 修改对话：所改剧本的 id */
  scenarioId?: string
}

export interface PlayerInputData {
  text: string
  offstage: boolean
  /** 开局那一条（界面不显示） */
  opening?: boolean
  /** 玩家随这一步行动提交的加点（属性 id → 点数），由代码直接落账 */
  allocations?: { id: string; points: number }[]
}

export interface TurnStartData {
  kind: 'play' | 'offstage' | 'agent'
  /** 正戏回合序号（开场 = 1）；场外与工坊回合为 0 */
  turn: number
}

export interface TurnEndData {
  kind: TurnStartData['kind']
  turn: number
  reason: 'completed' | 'cancelled' | 'error'
  error?: string
}

export interface StepUsage {
  model: string
  ms: number
  firstTextMs?: number
  usage?: Usage
}

export interface ChapterData {
  turn: number
  text: string
  reasoning?: string
  /** 作者手写的开场章：不调模型 */
  handwritten?: boolean
  /** 系统宣布终幕后写成的结局章 */
  ending?: boolean
  /** 正文首字之前的工具往返次数（只有掷骰时才该是 1） */
  toolRoundsBeforeText: number
  steps: StepUsage[]
}

export interface CheckData extends CheckResult {
  turn: number
}

export interface SettlementReceipt {
  anchors: { accepted: string[]; ignored: { id: string; reason: string }[] }
  upkeep: AppliedChange[]
  resources: AppliedChange[]
  attributes: AppliedChange[]
  inventory: AppliedInventoryChange[]
  xp?: XpResult & { unspent: number }
  options: string[]
  /** 裁决时被丢掉的条目（未知 id、非法值……），给观测与排查用 */
  rejected: string[]
  advancedTo?: number
  ended: boolean
}

export interface SettlementData {
  turn: number
  receipt: SettlementReceipt
  /** 结算步本身失败（重试后仍拿不到合法调用）：数值与进度本回合不动，选项为空 */
  failed?: string
  args?: unknown
  step?: StepUsage
}

export interface ActAdvancedData {
  from: number
  to: number
  title: string
}

export interface PointsSpentData {
  turn: number
  changes: AppliedChange[]
  spent: number
  rejected: { id: string; points: number; reason: string }[]
}

export interface RevisionData {
  revisions: Revision[]
}

export interface RecapData {
  /** 覆盖到第几回合（含） */
  through: number
  text: string
  step?: StepUsage
}

export interface ReplyData {
  text: string
  reasoning?: string
  steps: StepUsage[]
}

export interface AgentMessageData {
  content: string
  reasoning?: string
  toolCalls?: ToolCall[]
  step?: StepUsage
}

export interface ToolResultData {
  toolCallId: string
  name: string
  text: string
  meta?: Record<string, unknown>
}
