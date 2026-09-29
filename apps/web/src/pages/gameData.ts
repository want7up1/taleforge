/** 一局冒险的离线读取（状态/角色/旅程/记忆/设定/营地这些子页用；游玩页走实时的 useGameSession）。 */
import { api } from '../api.ts'
import { knownCastIds } from '../cast.ts'
import { digestEvent, emptyDigest, type TurnDigest } from '../fold.ts'
import { parseTurn } from '../turn.ts'
import type { SessionEvent, SessionValues, StoryDetail } from '../types.ts'

export interface TurnView {
  turn: number
  /** 玩家这一回合的行动（开场为空） */
  input: string
  text: string
  ending: boolean
  digest: TurnDigest
}

export interface GameData {
  events: SessionEvent[]
  values: SessionValues
  story: StoryDetail
  turns: TurnView[]
  recap?: { through: number; text: string }
  offstage: { ask: string; reply: string }[]
  knownCast: Set<string>
}

/** 日志 → 按回合整理：每一章配上它的玩家行动与结算卡。被取消、没写成正文的回合不列。 */
export function turnsOf(events: SessionEvent[]): TurnView[] {
  const out: TurnView[] = []
  let input = ''
  let opening = false
  let current: TurnView | undefined
  for (const e of events) {
    const d = e.data as { text?: string; offstage?: boolean; opening?: boolean; kind?: string; turn?: number; ending?: boolean }
    if (e.type === 'player/input' && !d.offstage) {
      input = d.text ?? ''
      opening = Boolean(d.opening)
    }
    if (e.type === 'turn/start' && d.kind === 'play') current = undefined
    if (e.type === 'chapter') {
      current = { turn: d.turn ?? out.length + 1, input: opening ? '' : input, text: parseTurn(d.text ?? '').narrative, ending: Boolean(d.ending), digest: emptyDigest() }
      out.push(current)
    }
    if (current && (e.type === 'settlement' || e.type === 'check/rolled' || e.type === 'points/spent')) current.digest = digestEvent(current.digest, e)
  }
  return out
}

export function offstageOf(events: SessionEvent[]): { ask: string; reply: string }[] {
  const out: { ask: string; reply: string }[] = []
  let ask: string | undefined
  for (const e of events) {
    const d = e.data as { text?: string; offstage?: boolean }
    if (e.type === 'player/input' && d.offstage) ask = d.text
    if (e.type === 'reply' && ask !== undefined) {
      out.push({ ask, reply: d.text ?? '' })
      ask = undefined
    }
  }
  return out
}

export async function loadGame(gameId: string): Promise<GameData> {
  const [history, story] = await Promise.all([api.history(gameId), api.sessionStory(gameId)])
  const events = history.events.map(e => e.event)
  const turns = turnsOf(events)
  const recapEvent = [...events].reverse().find(e => e.type === 'recap')
  const recap = recapEvent ? recapEvent.data as { through: number; text: string } : undefined
  return {
    events,
    values: history.projections?.values ?? {},
    story,
    turns,
    ...recap ? { recap } : {},
    offstage: offstageOf(events),
    knownCast: knownCastIds(story.cast, turns.map(t => t.text).join('\n')),
  }
}

/** 结算卡 → 一行行可读的战报（旅程页的"关键变化"用） */
export function digestLines(digest: TurnDigest, values: SessionValues): string[] {
  const lines: string[] = []
  const label = (id: string) => values.mechanics?.defs.find(d => d.id === id)?.label ?? values.attributes?.defs.find(d => d.id === id)?.label ?? id
  const hidden = (id: string) => values.mechanics?.defs.find(d => d.id === id)?.display === 'hidden'
  if (digest.check) lines.push(`判定「${digest.check.reason}」：${{ 'crit-success': '大成功', 'success': '成功', 'fail': '失败', 'crit-fail': '大失败' }[digest.check.outcome]}`)
  for (const c of digest.settlement) if (!hidden(c.id)) lines.push(`${label(c.id)} ${c.applied > 0 ? '+' : ''}${c.applied} → ${c.after}${c.reason ? `（${c.reason}）` : ''}`)
  for (const c of digest.inventory) lines.push(c.removed ? `失去 ${c.name}` : `${c.delta >= 0 ? '获得' : '消耗'} ${c.name}${Math.abs(c.delta) > 1 ? `×${Math.abs(c.delta)}` : ''}`)
  if (digest.xp && digest.xp.levelAfter > digest.xp.levelBefore) lines.push(`升级到 ${digest.xp.levelAfter} 级`)
  return lines
}
