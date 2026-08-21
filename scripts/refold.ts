/**
 * 存档折叠回归：拿真实存档的事件流本地重放投影折叠，与服务端投影逐项比对。
 * 每次动状态层（progress/mechanics 的折叠逻辑）都跑一遍——Rpgforge 的对应物
 * 是"3 个真实存档 rebuild 验零回退"，每次动 state_applier 都靠它兜底。
 *
 * 用法：node scripts/refold.ts <history.json> <story.json>
 *   history.json 来自 GET /app/sessions/:id/history（完整、hasMore=false）
 */
import { readFileSync } from 'node:fs'
import {
  effectiveNumericDefs,
  foldApplied,
  foldInventory,
  foldProgression,
  initialInventory,
  isAttributesResult,
  isInventoryResult,
  isMechanicsResult,
  isPointsResult,
  isXpResult,
  progressionView,
  type AppliedChange,
  type AppliedInventoryChange,
  type NumericDefRevision,
} from '../packages/mechanics/src/index.ts'
import { foldEvents, pressureOf } from '../packages/progress/src/index.ts'
import { storySchema } from '../packages/scenario-compiler/src/index.ts'

const [historyPath, storyPath] = process.argv.slice(2)
if (!historyPath || !storyPath) {
  console.error('用法: node scripts/refold.ts <history.json> <story.json>')
  process.exit(2)
}

const history = JSON.parse(readFileSync(historyPath, 'utf8')) as {
  events: { event: { type: string; data: Record<string, unknown> } }[]
  hasMore?: boolean
  projections?: { values: Record<string, unknown> }
}
if (history.hasMore) {
  console.error('history 不完整（hasMore=true），比对无意义')
  process.exit(2)
}
const events = history.events.map(e => e.event)
const story = storySchema.parse(JSON.parse(readFileSync(storyPath, 'utf8')))
const served = history.projections?.values ?? {}

let failures = 0
function check(name: string, mine: unknown, theirs: unknown): void {
  const a = JSON.stringify(mine)
  const b = JSON.stringify(theirs)
  if (a === b) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}\n    本地重放: ${a}\n    服务端:   ${b}`)
  }
}

function metaBatches<T>(pick: (m: unknown) => m is { changes: T[] }): T[][] {
  const out: T[][] = []
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const meta = (e.data as { meta?: unknown }).meta
    if (pick(meta)) out.push((meta as { changes: T[] }).changes)
  }
  return out
}

function numericRevisions(): NumericDefRevision[] {
  const out: NumericDefRevision[] = []
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const meta = (e.data as { meta?: { kind?: string; revisions?: unknown[] } }).meta
    if (meta?.kind !== 'progress/revision' || !Array.isArray(meta.revisions)) continue
    for (const r of meta.revisions as NumericDefRevision[]) {
      if (r && (r.target === 'resource' || r.target === 'attribute')) out.push(r)
    }
  }
  return out
}

// ---- progress ----
console.log('progress:')
const prog = foldEvents(story.acts, events)
const servedProg = served.progress as {
  actIndex: number; achieved: string[]; phase: string; turn: number
  pressure: { level: string; stalledTurns: number }
} | undefined
if (servedProg) {
  check('actIndex', prog.actIndex, servedProg.actIndex)
  check('achieved', prog.achieved, servedProg.achieved)
  check('phase', prog.phase, servedProg.phase)
  check('turn', prog.turn, servedProg.turn)
  check('pressure', pressureOf(prog), servedProg.pressure)
} else {
  console.log('  （服务端无 progress 投影）')
}

// ---- mechanics（资源） ----
console.log('mechanics:')
const servedMech = served.mechanics as {
  state: Record<string, { value: number }>
} | undefined
if (story.mechanics?.resources && servedMech) {
  const revs = numericRevisions()
  const defs = effectiveNumericDefs(story.mechanics.resources, revs, 'resource')
  const state = foldApplied(defs, metaBatches<AppliedChange>(isMechanicsResult))
  for (const def of defs) {
    check(def.id, state[def.id]?.value, servedMech.state[def.id]?.value)
  }
} else {
  console.log('  （无资源声明或服务端无投影）')
}

// ---- attributes / inventory（声明了才比） ----
if (story.mechanics?.attributes) {
  console.log('attributes:')
  const servedAttr = served.attributes as { state: Record<string, { value: number }> } | undefined
  const defs = effectiveNumericDefs(story.mechanics.attributes, numericRevisions(), 'attribute')
  const state = foldApplied(defs, metaBatches<AppliedChange>(isAttributesResult))
  for (const def of defs) check(def.id, state[def.id]?.value, servedAttr?.state[def.id]?.value)
}
if (story.mechanics?.inventory) {
  console.log('inventory:')
  const servedInv = served.inventory as { items: { id: string; qty: number }[] } | undefined
  const state = foldInventory(
    story.mechanics.inventory.initial,
    metaBatches<AppliedInventoryChange>(isInventoryResult),
  )
  check('items', Object.entries(state).map(([id, v]) => ({ id, qty: v.qty })),
    (servedInv?.items ?? []).map(i => ({ id: i.id, qty: i.qty })))
}
if (story.mechanics?.progression) {
  console.log('progression:')
  const servedProg = served.progression as { xp: number; level: number; unspent: number } | undefined
  const metas: unknown[] = []
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const meta = (e.data as { meta?: unknown }).meta
    if (isXpResult(meta) || isPointsResult(meta)) metas.push(meta)
  }
  const view = progressionView(story.mechanics.progression, foldProgression(metas))
  check('xp', view.xp, servedProg?.xp)
  check('level', view.level, servedProg?.level)
  check('unspent', view.unspent, servedProg?.unspent)
}

console.log(failures === 0 ? '\n折叠回归通过：本地重放与服务端投影一致' : `\n${failures} 项不一致`)
process.exit(failures === 0 ? 0 : 1)
