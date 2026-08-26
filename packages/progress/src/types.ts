/**
 * 幕进度与设定修订的类型。
 * 一切剧本声明都只是初始种子：锚点可被修订事件增删改，折叠出"现行有效设定"。
 */

export interface AnchorDef {
  id: string
  text: string
  required: boolean
  /** 完成信号：一句可核对的剧情事实，GM 每回合对照它上报 */
  signal?: string
}

export interface ActDef {
  id: string
  title: string
  objective: string
  anchors: AnchorDef[]
  /** 本幕的节奏容忍度：连续多少个正戏回合无主线进展才开始加压（缺省 DEFAULT_PACE） */
  pace?: number
}

export interface CastRef {
  id: string
  name: string
}

/** 由剧本编译器写入 preset 的配置（种子）。 */
export interface ProgressConfig {
  acts: ActDef[]
  cast?: CastRef[]
}

/**
 * 设定修订：场外由 GM 落账，只对未来生效，效力高于剧本原文。
 * anchor 类修订改写幕结构的折叠结果；resource/attribute 类改写机制定义的折叠结果
 * （只允许 edit 既有条目——中途增删数值条目走"落盘+新局"）；其余是回注给 GM 的文本指令。
 */
export type Revision =
  | { target: 'world'; text: string }
  | { target: 'direction'; text: string }
  | { target: 'cast'; id: string; text: string }
  | {
    target: 'anchor'
    act: string
    op: 'add' | 'edit' | 'remove'
    id: string
    text?: string
    signal?: string
    required?: boolean
  }
  | {
    target: 'resource' | 'attribute'
    id: string
    label?: string
    guidance?: string
    min?: number
    max?: number
    maxStep?: number
    floor?: number
  }

/** 机制引擎侧消费的数值定义修订（Revision 的 resource/attribute 分支）。 */
export type NumericRevision = Extract<Revision, { target: 'resource' | 'attribute' }>

export interface ProgressState {
  actIndex: number
  /** 已达成锚点 id，按达成顺序 */
  achieved: string[]
  /** 已开始的回合数（含场外回合，作为已知简化） */
  turn: number
  /** 最近一次主线进展（锚点达成或转幕）发生的回合 */
  lastProgressTurn: number
  /**
   * 最近一次周期收支结算的回合。GM 一个回合里调两次 report_progress 是实测存在的，
   * 靠它保证每回合只滚一次（旧存档没有此字段，按 0 处理）。
   */
  lastUpkeepTurn?: number
  phase: 'playing' | 'ended'
  revisions: Revision[]
}

export type PressureLevel = 'low' | 'rising' | 'high'

/** 一条周期收支声明：由剧本在 mechanics.upkeep 里给出，代码每个正戏回合自动结算一次。 */
export interface UpkeepEntry {
  id: string
  /** 显示名，由编译器从资源定义带过来；回执用它，别让 GM 看见裸 id */
  label?: string
  delta: number
  reason: string
  /** 只在当前值大于此数时才滚动（"种下之后才生长"） */
  activeAbove?: number
}

/** report_progress 的 tool/result.meta 载荷 */
export interface ReportMeta {
  kind: 'progress/report'
  accepted: string[]
  /**
   * 本回合该结算的周期收支。这里只带**声明**：真正的 clamp 与 activeAbove 判定由
   * mechanics 的投影去做——当前值和现行定义都在它手上，progress 只负责决定"什么时候滚"。
   */
  upkeep?: UpkeepEntry[]
  /** 结算所属回合，投影据此记 lastUpkeepTurn，保证同回合重复上报不会滚两次 */
  upkeepTurn?: number
}

/** revise_setting 的 tool/result.meta 载荷 */
export interface RevisionMeta {
  kind: 'progress/revision'
  revisions: Revision[]
}

export function isReportMeta(value: unknown): value is ReportMeta {
  return (
    typeof value === 'object'
    && value !== null
    && (value as ReportMeta).kind === 'progress/report'
    && Array.isArray((value as ReportMeta).accepted)
  )
}

export function isRevisionMeta(value: unknown): value is RevisionMeta {
  return (
    typeof value === 'object'
    && value !== null
    && (value as RevisionMeta).kind === 'progress/revision'
    && Array.isArray((value as RevisionMeta).revisions)
  )
}
