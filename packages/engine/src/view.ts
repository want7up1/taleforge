/**
 * 给界面的会话视图。字段名与旧版投影一致（mechanics / attributes / inventory / progress /
 * progression / sessionStats），前端面板组件不必跟着改。
 */
import { progressionView, type ProgressionView, type ResourceDef, type ResourceState } from '@taleforge/mechanics'
import { pressureOf, type ProgressView } from '@taleforge/progress'
import { actsOf, attributeDefs, phaseOf, resourceDefs, type SessionState, type SessionStats } from './fold.ts'
import type { ModelChoice, RewardOffer, SessionKind } from './events.ts'

export interface SessionView {
  kind: SessionKind
  title: string
  storyId?: string
  model: ModelChoice
  mechanics: { defs: ResourceDef[]; state: ResourceState; groups?: Record<string, string> } | null
  attributes: { defs: { id: string; label: string; min: number; max: number; initial: number; maxStep: number }[]; state: ResourceState } | null
  inventory: { items: { id: string; name: string; qty: number; note?: string }[] } | null
  progress: ProgressView | null
  progression: ProgressionView | null
  /** 待玩家自己领取的奖励（剧本声明了 mechanics.rewards 才有） */
  rewards: { label: string; pending: RewardOffer[] } | null
  sessionStats: SessionStats
}

export function sessionView(state: SessionState): SessionView {
  const story = state.created.story
  const revisions = state.progress.revisions
  const mech = story?.mechanics
  const acts = actsOf(story, revisions)
  return {
    kind: state.created.kind,
    title: state.created.title,
    ...story ? { storyId: story.id } : {},
    model: state.model,
    mechanics: mech?.resources?.length
      ? {
          defs: resourceDefs(story, revisions).map(({ guidance: _g, ...d }) => d),
          state: state.values,
          ...mech.groups ? { groups: mech.groups as Record<string, string> } : {},
        }
      : null,
    attributes: mech?.attributes?.length
      ? {
          defs: attributeDefs(story, revisions).map(({ guidance: _g, ...d }) => d),
          state: state.attrs,
        }
      : null,
    inventory: mech?.inventory
      ? { items: Object.entries(state.inventory).map(([id, v]) => ({ id, ...v })) }
      : null,
    progress: story
      ? {
          acts,
          actIndex: state.progress.actIndex,
          achieved: state.progress.achieved,
          turn: state.progress.turn,
          phase: phaseOf(state),
          pressure: pressureOf(state.progress, acts[state.progress.actIndex]?.pace),
          revisions,
        }
      : null,
    progression: mech?.progression ? progressionView(mech.progression, state.progression) : null,
    rewards: mech?.rewards ? { label: mech.rewards.label, pending: state.offers } : null,
    sessionStats: state.stats,
  }
}
