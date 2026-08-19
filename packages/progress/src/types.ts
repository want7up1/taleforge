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
 * anchor 类修订会真实改写幕结构的折叠结果；其余是回注给 GM 的文本指令。
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

export interface ProgressState {
  actIndex: number
  /** 已达成锚点 id，按达成顺序 */
  achieved: string[]
  /** 已开始的回合数（含场外回合，作为已知简化） */
  turn: number
  /** 最近一次主线进展（锚点达成或转幕）发生的回合 */
  lastProgressTurn: number
  phase: 'playing' | 'ended'
  revisions: Revision[]
}

export type PressureLevel = 'low' | 'rising' | 'high'

/** report_progress 的 tool/result.meta 载荷 */
export interface ReportMeta {
  kind: 'progress/report'
  accepted: string[]
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
