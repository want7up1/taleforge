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
  /** 防剧透门控：绑定 cast id，该人物出场前本条资源对玩家不可见 */
  revealWith?: string
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

/** 从一个会话事件里取出符合类型守卫的工具 meta；不是 tool/result 或形状不符时 undefined。 */
export function metaOf<T>(
  event: { type: string; data: unknown },
  pick: (meta: unknown) => meta is T,
): T | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: unknown }).meta
  return pick(meta) ? meta : undefined
}

/**
 * 从事件里取数值定义修订。meta kind `progress/revision` 的事实来源在 progress 包的
 * revise_setting——只认 resource/attribute 两类条目，其余忽略。
 *
 * 这里刻意不建跨包依赖（形状以彼处为准），代价是改字段名不会有编译错误；
 * 兜底靠 contract.test.ts：那份测试真的调 progress 的工具拿 meta 再喂给这边的折叠。
 */
export function revisionsInEvent(event: { type: string; data: unknown }): NumericDefRevision[] | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: { kind?: string; revisions?: unknown[] } }).meta
  if (meta?.kind !== 'progress/revision' || !Array.isArray(meta.revisions)) return undefined
  const hits = (meta.revisions as NumericDefRevision[]).filter(
    r => r && (r.target === 'resource' || r.target === 'attribute') && typeof r.id === 'string',
  )
  return hits.length ? hits : undefined
}

/**
 * 周期收支声明在事件里的形状：progress 包的 report_progress 只带**声明**
 * （它不知道资源当前值，也不知道被修订改过的现行定义），实际增减由这边裁决。
 */
export interface UpkeepMetaEntry {
  id: string
  delta: number
  reason: string
  activeAbove?: number
}

/** 本事件带来的周期收支声明，已按 activeAbove 过滤（"种下之后才生长"）。 */
export function dueUpkeep(
  values: ResourceState,
  event: { type: string; data: unknown },
): UpkeepMetaEntry[] {
  if (event.type !== 'tool/result') return []
  const meta = (event.data as { meta?: { kind?: string; upkeep?: UpkeepMetaEntry[] } }).meta
  if (meta?.kind !== 'progress/report' || !meta.upkeep?.length) return []
  return meta.upkeep.filter(e =>
    e.activeAbove === undefined || (values[e.id]?.value ?? 0) > e.activeAbove)
}

// ---- 经验与等级：GM 报经验，代码按阈值算等级与发点，玩家自己加点 ----

export interface ProgressionConfig {
  /** 经验值的显示名（"经验""进化点"……） */
  label: string
  /** 什么事件给多少经验——机械规则，给数字 */
  guidance: string
  /** 单回合经验变动上限 */
  maxStep: number
  /** 升到 2、3、…级各需累计多少经验，严格递增；表长 + 1 = 最高等级 */
  thresholds: number[]
  /** 每升一级发放的属性点 */
  pointsPerLevel: number
  /** 剧情奖励属性点的单次上限（grant_xp 的 points 参数）；0/缺省 = 不开放 */
  bonusPointsMax?: number
  /** 各级显示名（C/B/A/S…），长度 = 阈值数 + 1；不给则显示 Lv.N */
  levelNames?: string[]
  /** 显示位置：strip 顶栏（缺省）/ panel 只进卷宗 */
  display?: 'strip' | 'panel'
}

/** 投影内部状态：经验、等级、累计发放与已花的属性点（未分配 = granted - spent）。 */
export interface ProgressionState {
  xp: number
  level: number
  granted: number
  spent: number
}

/** grant_xp 的落账：经验裁决 + 等级裁定 + 本次发放的属性点。 */
export interface XpResult {
  kind: 'mechanics/xp'
  delta: number
  applied: number
  before: number
  after: number
  clamped: boolean
  reason: string
  levelBefore: number
  levelAfter: number
  /** 本次发放的属性点总数 = 升级点 + 剧情奖励点 */
  pointsGranted: number
  /** 其中的剧情奖励点（裁过单次上限） */
  bonusPoints: number
}

export function isXpResult(value: unknown): value is XpResult {
  return (
    typeof value === 'object'
    && value !== null
    && (value as XpResult).kind === 'mechanics/xp'
    && typeof (value as XpResult).after === 'number'
  )
}

/**
 * spend_points 的落账：复用属性 meta 形状（changes 直接折进属性投影，不另起一套），
 * 附带 points 账供经验投影扣减未分配池。
 */
export interface PointsResult extends AttributesResult {
  points: { spent: number }
}

export function isPointsResult(value: unknown): value is PointsResult {
  return isAttributesResult(value) && typeof (value as PointsResult).points?.spent === 'number'
}
