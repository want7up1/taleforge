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
  foldInventory,
  foldNumericEvents,
  foldProgression,
  isInventoryResult,
  isPointsResult,
  isXpResult,
  progressionView,
  type AppliedInventoryChange,
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

/**
 * 取一个投影值。投影 key 按剧本分片成 `base:剧本id`（否则多剧本并存时先 mount 的会顶掉后来者），
 * 所以认前缀不认全等；裸 key 仍接受，兼容单剧本部署与旧存档。
 *
 * 与 apps/bff/src/index.ts 的同名函数同一套规则——分片规则要改就两处一起改。
 * 刻意不共享：把它抽进 packages/mechanics 会让 BFF 为一个纯函数加载整个 dsh 插件包。
 */
function projectionOf<T>(base: string): T | undefined {
  const direct = served[base]
  if (direct) return direct as T
  for (const [k, v] of Object.entries(served)) {
    if (v && k.startsWith(`${base}:`)) return v as T
  }
  return undefined
}

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

// ---- progress ----
console.log('progress:')
const prog = foldEvents(story.acts, events)
const servedProg = projectionOf<{
  actIndex: number; achieved: string[]; phase: string; turn: number
  pressure: { level: string; stalledTurns: number }
}>('progress')
if (servedProg) {
  check('actIndex', prog.actIndex, servedProg.actIndex)
  check('achieved', prog.achieved, servedProg.achieved)
  check('phase', prog.phase, servedProg.phase)
  check('turn', prog.turn, servedProg.turn)
  check('pressure', pressureOf(prog, story.acts[prog.actIndex]?.pace), servedProg.pressure)
} else {
  console.log('  （服务端无 progress 投影）')
}

// ---- mechanics（资源） ----
console.log('mechanics:')
const servedMech = projectionOf<{
  defs: { id: string }[]
  state: Record<string, { value: number }>
}>('mechanics')
if (story.mechanics?.resources && servedMech) {
  // 与投影同一个 reducer：周期收支与定义修订都在里面按事件顺序算
  const { values } = foldNumericEvents(story.mechanics.resources, events, 'resource')
  for (const def of story.mechanics.resources) {
    check(def.id, values[def.id]?.value, servedMech.state[def.id]?.value)
  }
} else {
  console.log('  （无资源声明或服务端无投影）')
}

// ---- attributes / inventory（声明了才比） ----
if (story.mechanics?.attributes) {
  console.log('attributes:')
  const servedAttr = projectionOf<{ state: Record<string, { value: number }> }>('attributes')
  const { values } = foldNumericEvents(story.mechanics.attributes, events, 'attribute')
  for (const def of story.mechanics.attributes) {
    check(def.id, values[def.id]?.value, servedAttr?.state[def.id]?.value)
  }
}
if (story.mechanics?.inventory) {
  console.log('inventory:')
  const servedInv = projectionOf<{ items: { id: string; qty: number }[] }>('inventory')
  const state = foldInventory(
    story.mechanics.inventory.initial,
    metaBatches<AppliedInventoryChange>(isInventoryResult),
  )
  check('items', Object.entries(state).map(([id, v]) => ({ id, qty: v.qty })),
    (servedInv?.items ?? []).map(i => ({ id: i.id, qty: i.qty })))
}
if (story.mechanics?.progression) {
  console.log('progression:')
  const servedProg = projectionOf<{ xp: number; level: number; unspent: number }>('progression')
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
