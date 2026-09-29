/**
 * 会话折叠：日志 → 当前状态。**唯一的一份实现**——结算前读态、界面面板、重写回合后的重算、
 * 离线回归（scripts/refold.ts）全部走这里。旧版曾经工具侧和投影侧各写一份，两份就会分叉，
 * 而且分叉过（周期收支被悄悄覆盖、中途改边界算出两个值）。
 *
 * 数值以落账回执为准，不重算：修订只对未来生效，过去的裁决以当时写下的 after 为准。
 */
import type { StoredEvent } from '@taleforge/store'
import {
  effectiveNumericDefs,
  initialInventory,
  initialProgression,
  initialState,
  reduceProgression,
  type AttributeDef,
  type InventoryState,
  type NumericDefRevision,
  type ProgressionState,
  type ResourceDef,
  type ResourceState,
} from '@taleforge/mechanics'
import { effectiveActs, initialProgress, reduceProgress, type ActDef, type ProgressState, type Revision } from '@taleforge/progress'
import type { Story } from '@taleforge/scenario-compiler'
import type {
  ChapterData,
  CheckData,
  CreatedData,
  ModelChoice,
  PlayerInputData,
  PointsSpentData,
  RecapData,
  ReplyData,
  RevisionData,
  RewardClaimedData,
  RewardOffer,
  SettlementData,
  StepUsage,
  TurnStartData,
} from './events.ts'

export interface Chapter {
  turn: number
  /** 这一回合玩家的行动原话（开场为空串） */
  input: string
  text: string
  seq: number
  ending?: boolean
}

export interface SessionStats {
  turns: number
  llmMs: number
  decodeTokens: number
  promptTokens: number
  cacheHitTokens: number
}

export interface SessionState {
  created: CreatedData
  model: ModelChoice
  values: ResourceState
  attrs: ResourceState
  inventory: InventoryState
  progression: ProgressionState
  progress: ProgressState
  /** 结局章已写完 */
  endingWritten: boolean
  chapters: Chapter[]
  /** 场外往来（问、答），按时间顺序 */
  offstage: { ask: string; reply: string }[]
  recap?: { through: number; text: string }
  /** 最近一次结算（下一章的尾部要知道"上一章结算出了什么"） */
  lastSettlement?: SettlementData
  /** 最近一个正戏回合里的判定 */
  lastChecks: CheckData[]
  /** 最近一次加点（本回合落账的才贴进尾部） */
  lastPoints?: PointsSpentData
  /** 还没领取的奖励候选组（结算记下、玩家领取后移除） */
  offers: RewardOffer[]
  /** 本回合玩家领取的奖励（贴进尾部与结算指令） */
  lastClaims: RewardClaimedData[]
  stats: SessionStats
  /** 已开始但还没结束的回合 */
  open?: { seq: number; data: TurnStartData }
  /** 最近一条玩家输入 */
  lastInput?: { seq: number; data: PlayerInputData }
  /** 最近一个正戏回合的 player/input（重写回合的切点） */
  lastPlayInput?: { seq: number; data: PlayerInputData }
}

const numericRevisions = (revisions: Revision[]) =>
  revisions.filter((r): r is Extract<Revision, { target: 'resource' | 'attribute' }> =>
    r.target === 'resource' || r.target === 'attribute') as NumericDefRevision[]

/** 现行资源定义（种子 + 修订） */
export function resourceDefs(story: Story | undefined, revisions: Revision[]): (ResourceDef & { guidance: string })[] {
  const seed = (story?.mechanics?.resources ?? []) as (ResourceDef & { guidance: string })[]
  return effectiveNumericDefs(seed, numericRevisions(revisions), 'resource')
}

/** 现行属性定义（种子 + 修订） */
export function attributeDefs(story: Story | undefined, revisions: Revision[]): AttributeDef[] {
  return effectiveNumericDefs((story?.mechanics?.attributes ?? []) as AttributeDef[], numericRevisions(revisions), 'attribute')
}

/** 现行幕结构（种子 + 锚点修订） */
export function actsOf(story: Story | undefined, revisions: Revision[]): ActDef[] {
  return effectiveActs((story?.acts ?? []) as ActDef[], revisions)
}

const addStep = (stats: SessionStats, step?: StepUsage) => {
  if (!step) return
  stats.llmMs += step.ms
  stats.decodeTokens += step.usage?.completionTokens ?? 0
  stats.promptTokens += step.usage?.promptTokens ?? 0
  stats.cacheHitTokens += step.usage?.cacheHitTokens ?? 0
}

export function foldSession(events: readonly StoredEvent[]): SessionState {
  const createdEvent = events.find(e => e.type === 'session/created')
  if (!createdEvent) throw new Error('日志缺少 session/created')
  const created = createdEvent.data as unknown as CreatedData
  const story = created.story
  const seedActs = (story?.acts ?? []) as ActDef[]
  const state: SessionState = {
    created,
    model: created.model,
    values: initialState((story?.mechanics?.resources ?? []) as ResourceDef[]),
    attrs: initialState((story?.mechanics?.attributes ?? []) as AttributeDef[]),
    inventory: initialInventory(story?.mechanics?.inventory?.initial ?? []),
    progression: initialProgression(),
    progress: initialProgress(),
    endingWritten: false,
    chapters: [],
    offstage: [],
    lastChecks: [],
    offers: [],
    lastClaims: [],
    stats: { turns: 0, llmMs: 0, decodeTokens: 0, promptTokens: 0, cacheHitTokens: 0 },
  }
  let pendingAsk: string | undefined

  for (const event of events) {
    switch (event.type) {
      case 'model/selected':
        state.model = event.data as unknown as ModelChoice
        break
      case 'player/input': {
        const data = event.data as unknown as PlayerInputData
        state.lastInput = { seq: event.seq, data }
        if (data.offstage) pendingAsk = data.text
        else state.lastPlayInput = { seq: event.seq, data }
        break
      }
      case 'turn/start': {
        const data = event.data as unknown as TurnStartData
        state.open = { seq: event.seq, data }
        if (data.kind === 'play') {
          // 回合号以事件里写下的为准（被取消的回合不占号，重开时沿用同一个号）
          state.progress = { ...reduceProgress(state.progress, { kind: 'turn' }, seedActs), turn: data.turn }
          state.stats.turns = data.turn
          state.lastChecks = []
          state.lastPoints = undefined
          state.lastClaims = []
        }
        break
      }
      case 'turn/end':
        state.open = undefined
        break
      case 'points/spent': {
        const data = event.data as unknown as PointsSpentData
        const attrs = { ...state.attrs }
        for (const c of data.changes) if (c.id in attrs) attrs[c.id] = { value: c.after, last: { applied: c.applied, reason: c.reason } }
        state.attrs = attrs
        state.progression = reduceProgression(state.progression, { kind: 'mechanics/attributes', changes: data.changes, points: { spent: data.spent } })
        state.lastPoints = data
        break
      }
      case 'reward/claimed': {
        const data = event.data as unknown as RewardClaimedData
        state.offers = state.offers.filter(o => o.id !== data.offerId)
        state.lastClaims = [...state.lastClaims, data]
        const c = data.counter
        if (c && c.id in state.values) state.values = { ...state.values, [c.id]: { value: c.after, last: { applied: c.applied, reason: c.reason } } }
        break
      }
      case 'check/rolled':
        state.lastChecks = [...state.lastChecks, event.data as unknown as CheckData]
        break
      case 'chapter': {
        const data = event.data as unknown as ChapterData
        const input = state.lastPlayInput?.data
        state.chapters = [...state.chapters, {
          turn: data.turn,
          input: input && !input.opening ? input.text : '',
          text: data.text,
          seq: event.seq,
          ...data.ending ? { ending: true } : {},
        }]
        if (data.ending) state.endingWritten = true
        for (const step of data.steps) addStep(state.stats, step)
        break
      }
      case 'settlement': {
        const data = event.data as unknown as SettlementData
        state.lastSettlement = data
        addStep(state.stats, data.step)
        // 结算步失败时回执里只有代码自己算的周期收支，照样落账（每个正戏回合结算一次由代码保证）
        const r = data.receipt
        const values = { ...state.values }
        if (r.offers?.length) state.offers = [...state.offers, ...r.offers]
        for (const c of [...r.upkeep, ...r.resources, ...r.counter ? [r.counter] : []]) {
          if (c.id in values) values[c.id] = { value: c.after, last: { applied: c.applied, reason: c.reason } }
        }
        state.values = values
        const attrs = { ...state.attrs }
        for (const c of r.attributes) if (c.id in attrs) attrs[c.id] = { value: c.after, last: { applied: c.applied, reason: c.reason } }
        state.attrs = attrs
        if (r.inventory.length) {
          const inv: InventoryState = { ...state.inventory }
          for (const c of r.inventory) {
            if (c.removed) delete inv[c.id]
            else {
              const note = c.note ?? inv[c.id]?.note
              inv[c.id] = note === undefined ? { name: c.name, qty: c.qty } : { name: c.name, qty: c.qty, note }
            }
          }
          state.inventory = inv
        }
        if (r.xp) state.progression = reduceProgression(state.progression, r.xp)
        state.progress = reduceProgress(state.progress, { kind: 'report', accepted: r.anchors.accepted }, seedActs)
        break
      }
      case 'revision':
        state.progress = reduceProgress(state.progress, { kind: 'revision', revisions: (event.data as unknown as RevisionData).revisions }, seedActs)
        break
      case 'reply': {
        const data = event.data as unknown as ReplyData
        for (const step of data.steps) addStep(state.stats, step)
        if (pendingAsk !== undefined) {
          state.offstage = [...state.offstage, { ask: pendingAsk, reply: data.text }]
          pendingAsk = undefined
        }
        break
      }
      case 'recap': {
        const data = event.data as unknown as RecapData
        state.recap = { through: data.through, text: data.text }
        addStep(state.stats, data.step)
        break
      }
      default:
        break
    }
  }
  return state
}

/** 终局态：playing / finale（主线已齐、结局章未写）/ ended（结局章已写完）。 */
export function phaseOf(state: SessionState): 'playing' | 'finale' | 'ended' {
  if (state.endingWritten) return 'ended'
  return state.progress.phase === 'ended' ? 'finale' : 'playing'
}

/** 没有 story 的会话（工坊、修改对话）调用这些会抛——游戏会话才有剧本。 */
export function storyOf(state: SessionState): Story {
  if (!state.created.story) throw new Error('这个会话不是游戏会话')
  return state.created.story
}
