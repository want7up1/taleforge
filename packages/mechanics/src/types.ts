/** 机制四件套的类型：资源条 / 属性表 / 判定 / 物品栏。 */

/** 数值裁决引擎面对的最小形状——资源与属性共用同一套 clamp/fold。 */
export interface NumericDef {
  id: string
  min: number
  max: number
  initial: number
  floor?: number
  maxStep: number
}

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
  /** 显示位置（平台枚举，剧本选位）；缺省：self 组进 strip，其余 panel */
  display?: 'strip' | 'panel' | 'hidden'
}

/** 侧栏分组标题自定义 */
export type GroupTitles = Partial<Record<ResourceDef['group'], string>>

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

// ---- 属性表：变动稀少的能力值，判定自动引用 ----

export interface AttributeDef extends NumericDef {
  label: string
  guidance: string
}

export interface AttributesResult {
  kind: 'mechanics/attributes'
  changes: AppliedChange[]
}

export function isAttributesResult(value: unknown): value is AttributesResult {
  return (
    typeof value === 'object'
    && value !== null
    && (value as AttributesResult).kind === 'mechanics/attributes'
    && Array.isArray((value as AttributesResult).changes)
  )
}

// ---- 判定：代码掷骰，结果即裁决 ----

export type Die = 'd20' | 'd100' | '2d6'

export interface CheckConfig {
  die: Die
  guidance: string
}

export type CheckOutcome = 'crit-success' | 'success' | 'fail' | 'crit-fail'

/** 一次判定的完整裁决，落进 tool/result.meta，前端据此渲染骰子卡片。 */
export interface CheckResult {
  kind: 'mechanics/check'
  die: Die
  roll: number
  attribute?: string
  attrValue: number
  modifier: number
  total: number
  difficulty: number
  outcome: CheckOutcome
  reason: string
}

export function isCheckResult(value: unknown): value is CheckResult {
  return (
    typeof value === 'object'
    && value !== null
    && (value as CheckResult).kind === 'mechanics/check'
  )
}

// ---- 物品栏：id 引用 + 纯 upsert ----

export interface InventoryItemDef {
  id: string
  name: string
  qty: number
  note?: string
}

export interface InventoryConfig {
  guidance: string
  initial: InventoryItemDef[]
}

export interface InventoryChange {
  op: 'add' | 'remove' | 'set'
  id: string
  name?: string
  qty?: number
  note?: string
  reason?: string
}

/** 裁决后的物品变化：qty 是变化后的最终数量。 */
export interface AppliedInventoryChange {
  op: InventoryChange['op']
  id: string
  name: string
  qty: number
  delta: number
  removed: boolean
  note?: string
  reason?: string
}

export interface InventoryResult {
  kind: 'mechanics/inventory'
  changes: AppliedInventoryChange[]
}

export function isInventoryResult(value: unknown): value is InventoryResult {
  return (
    typeof value === 'object'
    && value !== null
    && (value as InventoryResult).kind === 'mechanics/inventory'
    && Array.isArray((value as InventoryResult).changes)
  )
}

export type InventoryState = Record<string, { name: string; qty: number; note?: string }>

// ---- 数值定义修订 ----

/**
 * 数值定义的修订条目。事实来源是 progress 包的 revise_setting 工具
 * （meta kind 'progress/revision'）；这里刻意不建跨包依赖，形状以彼处为准。
 */
export interface NumericDefRevision {
  target: 'resource' | 'attribute'
  id: string
  label?: string
  guidance?: string
  min?: number
  max?: number
  maxStep?: number
  floor?: number
}
