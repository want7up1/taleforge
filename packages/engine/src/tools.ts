/**
 * 游戏会话里模型能调的另外两件工具：roll_check（正文步，掷骰由代码裁决）与
 * revise_setting（场外步，修订设定）。settle_turn 在 settle.ts。
 *
 * 一局游戏的每个请求都带同一份工具列表（缓存要求它稳定），能不能调由 tool_choice 与
 * 执行侧把关：正文步只认 roll_check，场外步只认 revise_setting，调错了回一句出路。
 */
import { randomInt } from 'node:crypto'
import { toolDef, type ToolDef } from '@taleforge/llm'
import { renderCheck, resolveCheck, rollDie, type CheckResult } from '@taleforge/mechanics'
import { boundaryWarnings, validateRevisions, type Revision } from '@taleforge/progress'
import type { Story } from '@taleforge/scenario-compiler'
import { actsOf, attributeDefs, resourceDefs, type SessionState } from './fold.ts'
import { settleToolDef } from './settle.ts'

export const CHECK_TOOL = 'roll_check'
export const REVISE_TOOL = 'revise_setting'

export function checkToolDef(story: Story, state: SessionState): ToolDef | undefined {
  const checks = story.mechanics?.checks
  if (!checks) return undefined
  const attrs = attributeDefs(story, state.progress.revisions)
  return toolDef(CHECK_TOOL, `裁决一次成败不确定的行动：系统掷 ${checks.die}，加上属性与情境修正后与难度比较。`
    + '掷出的结果是最终裁决，只许承接不许翻案。何时必须掷、难度几档，见固定前缀里的判定规则。', {
    type: 'object',
    properties: {
      difficulty: { type: 'integer', description: '难度值，按剧本判定档位设定' },
      ...attrs.length ? { attribute: { type: 'string', enum: attrs.map(a => a.id), description: `参与修正的属性（${attrs.map(a => `${a.id}=${a.label}`).join('、')}），不涉及就省略` } } : {},
      modifier: { type: 'integer', description: '情境修正（装备、环境、协助……），默认 0' },
      reason: { type: 'string', description: '判定什么，一句话，玩家可见' },
    },
    required: ['difficulty', 'reason'],
    additionalProperties: false,
  })
}

export function reviseToolDef(story: Story, state: SessionState): ToolDef {
  const revisions = state.progress.revisions
  const acts = actsOf(story, revisions)
  const numeric = [
    ...resourceDefs(story, revisions).map(d => `${d.id}=${d.label}（资源）`),
    ...attributeDefs(story, revisions).map(d => `${d.id}=${d.label}（属性）`),
  ]
  return toolDef(REVISE_TOOL, '【场外专用】修订剧本设定，玩家在场外明确要求修改时调用。'
    + '修订立即落账、只对未来剧情生效、效力高于剧本原文。'
    + 'target：world（世界设定补充/覆盖）、cast（修改某人物，需 id）、direction（剧情走向/风格指令）、'
    + 'anchor（增删改锚点，需 act、op、id）、resource / attribute（修改既有数值条目的语义或边界，需 id，'
    + '可改 label/guidance/min/max/maxStep/floor；不支持中途增删条目——'
    + '玩家要新数值条时如实说明：走剧本详情页「修改剧本」把条目写进剧本源，新开局生效；'
    + '本局之内可先用 direction 修订把规则立起来、在正文里演，只是面板上不会有条）。'
    + `人物：${story.cast.map(c => `${c.id}=${c.name}`).join('、') || '（无）'}。`
    + `幕：${acts.map(a => `${a.id}=${a.title}`).join('、')}。`
    + `数值条目：${numeric.join('、') || '（无）'}。`, {
    type: 'object',
    properties: {
      revisions: {
        type: 'array',
        description: '本次修订条目',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['world', 'cast', 'direction', 'anchor', 'resource', 'attribute'] },
            id: { type: 'string', description: 'cast：人物 id；anchor：锚点 id；resource/attribute：条目 id' },
            act: { type: 'string', description: 'anchor 专用：所属幕 id' },
            op: { type: 'string', enum: ['add', 'edit', 'remove'], description: 'anchor 专用' },
            text: { type: 'string', description: '修订内容（world/cast/direction 必填；anchor 为锚点描述）' },
            signal: { type: 'string', description: 'anchor 专用：完成信号' },
            required: { type: 'boolean', description: 'anchor 专用：是否必需' },
            label: { type: 'string', description: 'resource/attribute：新显示名' },
            guidance: { type: 'string', description: 'resource/attribute：新的数值语义（何时加减多少、区段含义）' },
            min: { type: 'integer' },
            max: { type: 'integer' },
            maxStep: { type: 'integer' },
            floor: { type: 'integer', description: 'resource 专用：新下限护栏' },
          },
          required: ['target'],
        },
      },
    },
    required: ['revisions'],
    additionalProperties: false,
  })
}

/** 一局游戏的工具列表：整局稳定（settle_turn → roll_check → revise_setting）。 */
export function gameTools(story: Story, state: SessionState): ToolDef[] {
  const check = checkToolDef(story, state)
  return [settleToolDef(story, state), ...check ? [check] : [], reviseToolDef(story, state)]
}

export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** 执行一次判定：掷骰在这里发生一次，结果进日志；重放读落账的结果，不重掷。 */
export function runCheck(
  story: Story,
  state: SessionState,
  args: Record<string, unknown>,
  randInt: (sides: number) => number = sides => randomInt(1, sides + 1),
): { result: CheckResult; text: string } | { error: string } {
  const checks = story.mechanics?.checks
  if (!checks) return { error: '本作没有判定机制。' }
  const difficulty = Number(args.difficulty)
  if (!Number.isFinite(difficulty)) return { error: 'difficulty 必须是整数。' }
  const attrId = typeof args.attribute === 'string' && args.attribute ? args.attribute : undefined
  const defs = attributeDefs(story, state.progress.revisions)
  let attrValue = 0
  if (attrId) {
    const def = defs.find(a => a.id === attrId)
    if (!def) return { error: `未知属性 id：${attrId}` }
    attrValue = state.attrs[attrId]?.value ?? def.initial
  }
  const result = resolveCheck({
    die: checks.die,
    roll: rollDie(checks.die, randInt),
    difficulty: Math.trunc(difficulty),
    attribute: attrId,
    attrValue,
    modifier: Number.isFinite(Number(args.modifier)) ? Math.trunc(Number(args.modifier)) : 0,
    reason: String(args.reason ?? ''),
  })
  if (result.attribute === undefined) delete result.attribute
  const label = attrId ? defs.find(a => a.id === attrId)?.label : undefined
  let text = renderCheck(result, label)
  if (story.craft.numbers_in_prose) text = text.replace('，正文里不出现点数与难度数字', '')
  return { result, text }
}

/** 执行一次修订：校验不合法的整条拒绝并说明原因，合法的规范化落账。 */
export function runRevise(
  story: Story,
  state: SessionState,
  args: Record<string, unknown>,
): { accepted: Revision[]; text: string } {
  const revisions = state.progress.revisions
  const numeric = {
    resources: resourceDefs(story, revisions).map(d => ({ id: d.id, label: d.label, maxStep: d.maxStep })),
    attributes: attributeDefs(story, revisions).map(d => ({ id: d.id, label: d.label, maxStep: d.maxStep })),
  }
  const { accepted, rejected } = validateRevisions(
    Array.isArray(args.revisions) ? args.revisions as Record<string, unknown>[] : [],
    actsOf(story, revisions),
    story.cast,
    numeric,
  )
  const lines = [
    accepted.length ? `已落账 ${accepted.length} 条修订，即刻生效，此后正戏必须遵守。` : '没有可落账的修订。',
    ...rejected.map(r => `第 ${r.index + 1} 条被拒绝：${r.reason}`),
    ...boundaryWarnings(accepted, numeric),
  ]
  return { accepted, text: lines.join('\n') }
}
