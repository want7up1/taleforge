/**
 * 跨包契约：周期收支的**声明**由 progress 包的 report_progress 写进 tool/result.meta，
 * 实际增减由本包裁决（它不知道资源当前值，也不知道被修订改过的现行定义）。
 * 两边刻意不建运行时依赖、各写各的接口——好处是解耦，代价是 progress 改个字段名不会有
 * 任何编译错误，upkeep 从此静默不落账，面板上只是"数字没动"，没人会发现。
 *
 * 所以这里真的把 progress 的工具跑起来，拿它产出的 meta 喂给本包的折叠。测试文件用相对
 * 路径穿透到隔壁包的 src：只为一份测试给运行时加一条包依赖不划算，而这正是要锁的那条缝。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply as progressApply } from '../../progress/src/index.ts'
import { foldNumericEvents } from './resources.ts'
import type { ResourceDef } from './types.ts'

const acts = [{
  id: 'act-1',
  title: '第一幕',
  objective: '目标',
  anchors: [{ id: 'a1', text: '锚点', required: true }],
}]

const resources: ResourceDef[] = [
  { id: 'grain', label: '口粮', group: 'self', min: 0, max: 100, initial: 50, maxStep: 60 },
  { id: 'crop', label: '麦苗', group: 'self', min: 0, max: 3, initial: 0, maxStep: 5 },
]

interface RegisteredTool {
  name: string
  output: {
    schema: Parameters<typeof validateJsonSchemaValue>[0]
    presentationMeta?: (args: Record<string, unknown>, value: Record<string, unknown>) => unknown
  }
  execute: (
    args: Record<string, unknown>,
    exec: { agent: { session: { events: readonly { type: string; data: unknown }[] } } },
  ) => Promise<Record<string, unknown>>
}

/** 把 progress 插件挂在假 ctx 上，取出它注册的工具。 */
function progressTools(upkeep: { id: string; delta: number; reason: string; activeAbove?: number; label?: string }[]) {
  const tools: RegisteredTool[] = []
  progressApply(
    {
      tools: { register: (t: RegisteredTool) => tools.push(t) },
      inject: () => undefined,   // sessionProjections 的注册在测试里不需要
    } as never,
    { acts, upkeep } as never,
  )
  return tools
}

test('周期收支跨包契约：report_progress 写的 meta，本包折叠得出来', async () => {
  const [report] = progressTools([
    { id: 'grain', delta: -10, reason: '每日口粮', label: '口粮' },
    // activeAbove：没种下（0）就不该滚
    { id: 'crop', delta: 1, reason: '抽穗', activeAbove: 0, label: '麦苗' },
  ]).filter(t => t.name === 'report_progress')
  assert.ok(report, 'progress 包没有注册 report_progress')

  // turn/start 让回合数走到 1——周期收支每个正戏回合滚一次，同回合重复上报不再滚
  const history = [{ type: 'turn/start', data: {} }]
  const value = await report.execute({ achieved: [] }, { agent: { session: { events: history } } })

  // 顺带锁住输出契约：带 upkeep 的返回值必须过工具自己的 schema（漏声明键会让整份输出被拒）
  assert.deepEqual(validateJsonSchemaValue(report.output.schema, value, 'value'), [])

  const meta = report.output.presentationMeta?.({ achieved: [] }, value)
  assert.ok(meta, 'report_progress 应产出 presentationMeta')

  const events = [...history, { type: 'tool/result', data: { meta } }]
  const { values } = foldNumericEvents(resources, events, 'resource')

  assert.equal(values.grain.value, 40, '口粮该按声明扣掉 10')
  assert.equal(values.crop.value, 0, '麦苗没种下（activeAbove: 0）不该生长')
})

test('周期收支跨包契约：同一回合重复上报不重复扣账', async () => {
  const [report] = progressTools([{ id: 'grain', delta: -10, reason: '每日口粮', label: '口粮' }])
    .filter(t => t.name === 'report_progress')

  const events: { type: string; data: unknown }[] = [{ type: 'turn/start', data: {} }]
  for (let i = 0; i < 2; i++) {
    const value = await report.execute({ achieved: [] }, { agent: { session: { events } } })
    const meta = report.output.presentationMeta?.({ achieved: [] }, value)
    events.push({ type: 'tool/result', data: { meta } })
  }

  const { values } = foldNumericEvents(resources, events, 'resource')
  assert.equal(values.grain.value, 40, '第二次上报落在同一回合，不该再扣一次')
})

test('周期收支跨包契约：下一个回合照常再滚一次', async () => {
  const [report] = progressTools([{ id: 'grain', delta: -10, reason: '每日口粮', label: '口粮' }])
    .filter(t => t.name === 'report_progress')

  const events: { type: string; data: unknown }[] = []
  for (let turn = 0; turn < 3; turn++) {
    events.push({ type: 'turn/start', data: {} })
    const value = await report.execute({ achieved: [] }, { agent: { session: { events } } })
    const meta = report.output.presentationMeta?.({ achieved: [] }, value)
    events.push({ type: 'tool/result', data: { meta } })
  }

  const { values } = foldNumericEvents(resources, events, 'resource')
  assert.equal(values.grain.value, 20, '三个回合各扣一次')
})
