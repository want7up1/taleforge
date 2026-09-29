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
  /** 已开始的正戏回合数（场外回合不计） */
  turn: number
  /** 最近一次主线进展（锚点达成或转幕）发生的回合 */
  lastProgressTurn: number
  phase: 'playing' | 'ended'
  revisions: Revision[]
}

export type PressureLevel = 'low' | 'rising' | 'high'

/** 玩家与界面看到的进度快照：现行幕结构（含修订）、达成、压力、终局态。 */
export interface ProgressView {
  acts: ActDef[]
  actIndex: number
  achieved: string[]
  turn: number
  /** finale：主线锚点已齐、结局章还没写；ended：结局章已写完 */
  phase: 'playing' | 'finale' | 'ended'
  pressure: { level: PressureLevel; stalledTurns: number }
  revisions: Revision[]
}
