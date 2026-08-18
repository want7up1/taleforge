/**
 * 机制引擎：通用资源条。
 *
 * 链路：GM 调工具 → 代码裁决（单步上限/上下限）→ 结果进 tool/result.meta
 *      → projection 折叠出当前值 → 经 session/projection 帧实时推前端。
 *
 * 为什么状态走 tool/result.meta 而不是自定义事件类型：dsh 有一份 codegen 的已知事件
 * 白名单，外部插件新增的事件类型会让存档在重新加载时被直接拒绝。meta 是既有事件的
 * 合法字段，随日志持久化、随 fork 复制，projection 重放即可还原。
 */
import type { Context } from '@deepseek-ai/cordis'
// 副作用导入：这两个包通过模块合并把 tools / sessionProjections 挂上 Context
import '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { applyChanges, foldApplied, initialState } from './resources.ts'
import { isMechanicsResult, type AppliedChange, type ResourceDef, type ResourceState } from './types.ts'

const mechanicsSchema = z.object({
  defs: z.array(z.object({
    id: z.string(),
    label: z.string(),
    group: z.enum(['affinity', 'self', 'world']),
    min: z.number(),
    max: z.number(),
    initial: z.number(),
    floor: z.number().optional(),
    maxStep: z.number(),
  })),
  state: z.record(z.string(), z.object({
    value: z.number(),
    last: z.object({ applied: z.number(), reason: z.string() }).optional(),
  })),
})

export * from './resources.ts'
export * from './types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 玩家可见的资源快照 */
    mechanics: { defs: ResourceDef[]; state: ResourceState } | null
  }
}

export interface Config {
  /** 本剧本声明的资源条，由剧本编译器写入 */
  resources: ResourceDef[]
}

export const name = 'taleforge-mechanics'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const defs = config?.resources ?? []
  if (defs.length === 0) return

  const catalog = defs
    .map(d => `- \`${d.id}\`（${d.label}，${d.min}–${d.max}，单次最多 ±${d.maxStep}）`)
    .join('\n')

  ctx.tools.register(defineTool({
    name: 'adjust_resources',
    description: `在剧情推进的同时记录本回合的数值变化。可用资源：\n${catalog}\n\n`
      + '一个回合把所有变化放在一次调用里提交。增减多少由你按剧情判断，'
      + '系统会裁掉越界的部分并把最终结果告诉你——以裁决后的结果为准继续叙事。'
      + 'reason 写给玩家看，一句话说明为什么变。',
    parameters: {
      changes: {
        type: 'array',
        required: true,
        description: '本回合的全部资源变化',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '资源 id，必须来自上面的清单' },
            delta: { type: 'integer', required: true, description: '增减量，正数为增' },
            reason: { type: 'string', required: true, description: '一句话说明变化原因，玩家可见' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                delta: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
                applied: { type: 'integer', required: true },
                before: { type: 'integer', required: true },
                after: { type: 'integer', required: true },
                clamped: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      // 回给模型的文本：只说裁决结果，让它照着写叙事
      render: (_args, value) => [{
        type: 'text',
        text: (value.changes as AppliedChange[]).length === 0
          ? '没有产生有效变化。'
          : (value.changes as AppliedChange[])
              .map((c) => {
                const def = defs.find(d => d.id === c.id)
                const sign = c.applied > 0 ? '+' : ''
                const note = c.clamped ? `（原提交 ${c.delta}，已按边界裁决）` : ''
                return `${def?.label ?? c.id}：${sign}${c.applied} → ${c.after}${note}`
              })
              .join('\n'),
      }],
      // 结构化结果落进 tool/result.meta，供 projection 折叠与前端渲染卡片
      presentationMeta: (_args, value) => ({
        kind: 'mechanics/resources',
        changes: value.changes,
      }),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('adjust_resources 需要一个归属会话')
      const current = readState(defs, exec.agent.session.events)
      const { applied } = applyChanges(current, defs, args.changes as never)
      return Promise.resolve({ changes: applied })
    },
    presentCall: () => ({ card: 'generic', title: '结算本回合变化', kind: 'other' }),
  }))

  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register({
      key: 'mechanics',
      schema: mechanicsSchema,
      init: () => initialState(defs),
      // 不认识的事件必须原样返回同一引用，registry 靠 Object.is 判断有没有变化
      apply: (state: ResourceState, event: { type: string; data: unknown }) => {
        const batch = batchOf(event)
        if (!batch?.length) return state
        const next = { ...state }
        for (const change of batch) {
          if (!(change.id in next)) continue
          next[change.id] = {
            value: change.after,
            last: { applied: change.applied, reason: change.reason },
          }
        }
        return next
      },
      view: (state: ResourceState) => ({ defs, state }),
      stateVersion: 1,
    })
  })
}

/** 从会话事件里读出当前资源状态（工具执行时用，取代进程内缓存——它不随 fork 复制）。 */
function readState(defs: ResourceDef[], events: readonly { type: string; data: unknown }[]): ResourceState {
  const batches: AppliedChange[][] = []
  for (const event of events) {
    const batch = batchOf(event)
    if (batch) batches.push(batch)
  }
  return foldApplied(defs, batches)
}

function batchOf(event: { type: string; data: unknown }): AppliedChange[] | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: unknown }).meta
  return isMechanicsResult(meta) ? meta.changes : undefined
}
