/**
 * 会话日志回归：拿真实会话的事件日志本地重放折叠，逐笔核对落账链是否自洽。
 * 每次动状态层（engine fold、mechanics/progress 的裁决）都跑一遍——Rpgforge 的对应物
 * 是"3 个真实存档 rebuild 验零回退"，每次动 state_applier 都靠它兜底。
 *
 * 核对的是：每一笔数值/物品变化的 before 必须等于重放到那一刻的值（否则说明折叠与裁决分叉了），
 * 重放两遍结果一致，最终视图能完整生成。
 *
 * 用法：node scripts/refold.ts <数据卷>/v2/sessions/<会话 id>.jsonl
 */
import { readFileSync } from 'node:fs'
import { foldSession, sessionView, type SettlementData, type PointsSpentData } from '../packages/engine/src/index.ts'
import { parseLog } from '../packages/store/src/index.ts'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/refold.ts <会话日志.jsonl>')
  process.exit(2)
}

const events = parseLog(readFileSync(file, 'utf8'))
const state = foldSession(events)
const again = foldSession(events)
const problems: string[] = []
if (JSON.stringify(state) !== JSON.stringify(again)) problems.push('两次重放结果不一致')

const story = state.created.story
if (story) {
  const values = new Map<string, number>()
  for (const r of story.mechanics?.resources ?? []) values.set(`r:${r.id}`, r.initial)
  for (const a of story.mechanics?.attributes ?? []) values.set(`a:${a.id}`, a.initial)
  const check = (key: string, before: number, after: number, where: string) => {
    const expected = values.get(key)
    if (expected !== undefined && expected !== before) problems.push(`${where}：${key} 的 before=${before}，重放值=${expected}`)
    values.set(key, after)
  }
  for (const e of events) {
    if (e.type === 'settlement') {
      const s = e.data as unknown as SettlementData
      const where = `第 ${s.turn} 回合结算（seq ${e.seq}）`
      for (const c of [...s.receipt.upkeep, ...s.receipt.resources]) check(`r:${c.id}`, c.before, c.after, where)
      for (const c of s.receipt.attributes) check(`a:${c.id}`, c.before, c.after, where)
    }
    if (e.type === 'points/spent') {
      const p = e.data as unknown as PointsSpentData
      for (const c of p.changes) check(`a:${c.id}`, c.before, c.after, `第 ${p.turn} 回合加点（seq ${e.seq}）`)
    }
  }
}

const view = sessionView(state)
const settlements = events.filter(e => e.type === 'settlement').map(e => e.data as unknown as SettlementData)
const failed = settlements.filter(s => s.failed).length
console.log(`会话 ${state.created.title}（${state.created.kind}），${events.length} 条事件`)
console.log(`  正戏 ${state.chapters.length} 章，当前第 ${view.progress ? view.progress.actIndex + 1 : '-'} 幕，${view.progress?.phase ?? '-'}`)
console.log(`  结算 ${settlements.length} 次（失败 ${failed}），前情提要覆盖到第 ${state.recap?.through ?? 0} 回合`)
const hitRate = state.stats.promptTokens ? Math.round((state.stats.cacheHitTokens / state.stats.promptTokens) * 100) : 0
console.log(`  模型耗时 ${Math.round(state.stats.llmMs / 1000)}s，产出 ${state.stats.decodeTokens} token，输入缓存命中 ${hitRate}%`)
if (problems.length) {
  console.error(`\n✗ ${problems.length} 处不自洽：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\n✓ 落账链自洽，重放一致')
