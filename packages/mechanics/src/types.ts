/** 通用资源条：好感度、进化度、体力、物资都是它的实例。 */

export interface ResourceDef {
  /** 稳定 id，剧本内唯一。形如 affinity:suwan、evolution、stamina */
  id: string
  /** 界面显示名 */
  label: string
  /** 分组，前端据此归类（affinity=角色好感，self=主角自身，world=外部资源） */
  group: 'affinity' | 'self' | 'world'
  min: number
  max: number
  initial: number
  /**
   * 下限护栏：可以掉，但不会掉破这条线。
   * 好感度用它实现"吃醋误会会掉、但不会崩盘"；省略则等同 min。
   */
  floor?: number
  /** 单次调整的绝对值上限，防止模型一口气 +50 让数值失去意义 */
  maxStep: number
}

export interface ResourceChange {
  id: string
  delta: number
  /** 变化原因，写给玩家看 */
  reason: string
}

/** 一次调整被代码裁决后的结果。 */
export interface AppliedChange extends ResourceChange {
  /** 裁剪后实际生效的增减量 */
  applied: number
  before: number
  after: number
  /** 被边界规则改写过（超出单步上限、触到上下限） */
  clamped: boolean
}

export interface ResourceValue {
  value: number
  last?: { applied: number; reason: string }
}

export type ResourceState = Record<string, ResourceValue>

/** 工具执行结果，同时是 tool/result.meta 的载荷。 */
export interface MechanicsResult {
  kind: 'mechanics/resources'
  changes: AppliedChange[]
}

export function isMechanicsResult(value: unknown): value is MechanicsResult {
  return (
    typeof value === 'object'
    && value !== null
    && (value as MechanicsResult).kind === 'mechanics/resources'
    && Array.isArray((value as MechanicsResult).changes)
  )
}
