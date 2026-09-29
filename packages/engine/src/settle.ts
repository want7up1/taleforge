/**
 * 结算步：settle_turn 的参数结构与代码裁决。
 *
 * 结算步发生在正文写完之后，关思考、tool_choice 指定 settle_turn——同一个 GM 在同一段上下文里
 * 被强制续写一次（护栏 1 修订：不另起人设，不算新的裁判层）。结构由代码保证：每个正戏回合
 * 必然有一次结算，选项以结构化字段产出，旧版"靠提示词催模型记得调工具"的整类问题
 * （09-02 那局 8 回合漏了 3 回合）在结构上消失。
 *
 * 参数结构由剧本启用的模块拼出来，所有引用既有条目的 id 都是 enum（护栏 3）。
 * 工具列表在整局里保持稳定（enum 只在转幕与修订时变）：工具定义渲染在提示词最前面，
 * 一变就打散整段前缀缓存。
 */
import { toolDef, type JsonSchema, type ToolDef } from '@taleforge/llm'
import {
  applyChanges,
  applyInventory,
  applyXp,
  dueUpkeep,
  type AppliedChange,
  type InventoryChange,
  type ResourceChange,
} from '@taleforge/mechanics'
import { applyReport } from '@taleforge/progress'
import type { Story } from '@taleforge/scenario-compiler'
import type { RewardOffer, SettlementReceipt } from './events.ts'
import { actsOf, attributeDefs, resourceDefs, type SessionState } from './fold.ts'

export const SETTLE_TOOL = 'settle_turn'

const changeItem = (ids: string[]): JsonSchema => ({
  type: 'object',
  properties: {
    id: { type: 'string', enum: ids },
    delta: { type: 'integer', description: '增减量，正数为增' },
    reason: { type: 'string', description: '一句话原因，玩家可见' },
  },
  required: ['id', 'delta', 'reason'],
  additionalProperties: false,
})

/** 按剧本启用的模块拼出 settle_turn 的定义。anchors 的 enum 取当前幕的全部锚点（转幕才变）。 */
export function settleToolDef(story: Story, state: SessionState): ToolDef {
  const revisions = state.progress.revisions
  const acts = actsOf(story, revisions)
  const act = acts[state.progress.actIndex]
  const properties: Record<string, JsonSchema> = {}
  const anchorIds = act?.anchors.map(a => a.id) ?? []
  properties.anchors = anchorIds.length
    ? { type: 'array', description: '这一章里完成信号已经真实落在纸面上的锚点；没有传空数组', items: { type: 'string', enum: anchorIds } }
    : { type: 'array', description: '当前幕没有锚点，传空数组', items: { type: 'string' }, maxItems: 0 }
  const resources = resourceDefs(story, revisions)
  if (resources.length) {
    properties.resources = { type: 'array', description: '这一章的资源变化；没有传空数组', items: changeItem(resources.map(d => d.id)) }
  }
  const attributes = attributeDefs(story, revisions)
  if (attributes.length) {
    properties.attributes = { type: 'array', description: '这一章的属性变化（稀少）；没有传空数组', items: changeItem(attributes.map(d => d.id)) }
  }
  if (story.mechanics?.inventory) {
    properties.inventory = {
      type: 'array',
      description: '这一章的物品变动；没有传空数组',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['gain', 'lose', 'consume', 'destroy'] },
          id: { type: 'string', description: '物品 id，kebab-case，同一件物品永远同一个 id' },
          name: { type: 'string', description: '显示名；新物品必填' },
          qty: { type: 'integer', description: '数量，缺省 1；destroy 忽略它（整件清空）' },
          note: { type: 'string', description: '备注（状态、来源、用途）' },
          reason: { type: 'string', description: '一句话原因，玩家可见' },
        },
        required: ['op', 'id'],
        additionalProperties: false,
      },
    }
  }
  const p = story.mechanics?.progression
  if (p) {
    properties.xp = {
      type: 'object',
      description: `这一章换来的${p.label}`,
      properties: {
        amount: { type: 'integer', description: `${p.label}变化，没有传 0` },
        reason: { type: 'string', description: '一句话原因，玩家可见' },
        ...p.bonusPointsMax > 0 ? { points: { type: 'integer', description: `剧情奖励属性点，单次最多 ${p.bonusPointsMax}，没有传 0` } } : {},
      },
      required: ['amount', 'reason'],
      additionalProperties: false,
    }
  }
  const rewards = story.mechanics?.rewards
  if (rewards) {
    properties.offers = {
      type: 'array',
      description: `这一章正文里系统给出的${rewards.label}候选组（玩家之后在界面上自己选一个）；没有传空数组`,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这一组的名目（比如完成了哪个任务）' },
          choices: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '候选的名称，照正文原样' },
                detail: { type: 'string', description: '一句说明：选了它会得到什么' },
              },
              required: ['title', 'detail'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'choices'],
        additionalProperties: false,
      },
    }
  }
  const n = story.craft.action_options
  properties.options = {
    type: 'array',
    description: `给玩家的 ${n} 个下一步具体行动，每条一句话，不带编号`,
    items: { type: 'string' },
    minItems: 0,
    maxItems: n,
  }
  return toolDef(SETTLE_TOOL, '把刚定稿的这一章结清：锚点、数值、物品、经验与下一步选项。只在系统要求结算时调用。', {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  })
}

const asArray = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v.filter(x => typeof x === 'object' && x !== null) : []) as Record<string, unknown>[]

const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

const changesOf = (raw: unknown): ResourceChange[] =>
  asArray(raw).flatMap((c) => {
    const delta = int(c.delta)
    return typeof c.id === 'string' && delta !== undefined
      ? [{ id: c.id, delta, reason: typeof c.reason === 'string' ? c.reason : '' }]
      : []
  })

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * 奖励计数对齐到"待领取的组数"：由代码直接写值（不走单步上限——它不是剧情里涨落的量，是一个计数）。
 * 剧本没声明 rewards.counter、或值已经对齐时返回 undefined。
 */
export function alignRewardCounter(story: Story, state: Pick<SessionState, 'values' | 'progress'>, pending: number, reason: string): SettlementReceipt['counter'] {
  const id = story.mechanics?.rewards?.counter
  const def = id ? resourceDefs(story, state.progress.revisions).find(d => d.id === id) : undefined
  if (!id || !def) return undefined
  const before = state.values[id]?.value ?? def.initial
  const after = Math.max(def.min, Math.min(def.max, pending))
  if (after === before) return undefined
  return { id, delta: pending - before, reason, applied: after - before, before, after, clamped: after !== pending }
}

/** 选项：去编号、去空、去重，截到剧本声明的个数。 */
export function cleanOptions(raw: unknown, max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of Array.isArray(raw) ? raw : []) {
    if (typeof v !== 'string') continue
    const text = v.replace(/^\s*(?:[A-Ea-e]|\d+)\s*[.、．:：)）]\s*/, '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/**
 * 裁决一次结算：GM 报的是"这一章发生了什么"，这里决定实际生效多少。
 * 次序：周期收支 → 资源 → 属性 → 物品 → 经验 → 锚点。周期收支排最前，是为了让
 * "种下之后才生长"的作物在播种那一章不长（activeAbove 看的是结算前的值）。
 * 不合法的条目整条丢弃并记进 rejected——宁可这一笔不生效，也不让脏数据进状态。
 */
export function adjudicate(story: Story, state: SessionState, args: unknown): SettlementReceipt {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const revisions = state.progress.revisions
  const rejected: string[] = []

  const rDefs = resourceDefs(story, revisions)
  let values = state.values
  let upkeep: AppliedChange[] = []
  if (rDefs.length && story.mechanics?.upkeep?.length) {
    const due = dueUpkeep(values, story.mechanics.upkeep)
    const r = applyChanges(values, rDefs, due)
    values = r.state
    upkeep = r.applied
  }
  const rewards = story.mechanics?.rewards
  let resources: AppliedChange[] = []
  if (rDefs.length) {
    let proposed = changesOf(a.resources)
    // 奖励计数归代码：GM 报的一律不收（线上实测它会在"发布任务"时记、在"完成任务"时漏记）
    if (rewards?.counter && proposed.some(c => c.id === rewards.counter)) {
      proposed = proposed.filter(c => c.id !== rewards.counter)
      rejected.push(`「${rDefs.find(d => d.id === rewards.counter)?.label ?? rewards.counter}」由系统按待领取的${rewards.label}自动对齐，结算里不用记`)
    }
    const r = applyChanges(values, rDefs, proposed)
    values = r.state
    resources = r.applied
    for (const c of proposed) if (!rDefs.some(d => d.id === c.id)) rejected.push(`未知资源 id：${c.id}`)
  }

  const aDefs = attributeDefs(story, revisions)
  let attributes: AppliedChange[] = []
  if (aDefs.length) {
    const proposed = changesOf(a.attributes)
    attributes = applyChanges(state.attrs, aDefs, proposed).applied
    for (const c of proposed) if (!aDefs.some(d => d.id === c.id)) rejected.push(`未知属性 id：${c.id}`)
  }

  let inventory: SettlementReceipt['inventory'] = []
  if (story.mechanics?.inventory) {
    const ops: InventoryChange[] = []
    for (const c of asArray(a.inventory)) {
      const id = typeof c.id === 'string' ? c.id.trim() : ''
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        rejected.push(`物品 id 不合法：${String(c.id)}`)
        continue
      }
      const qty = int(c.qty)
      const base = {
        id,
        ...typeof c.name === 'string' && c.name.trim() ? { name: c.name.trim() } : {},
        ...typeof c.note === 'string' && c.note.trim() ? { note: c.note.trim() } : {},
        ...typeof c.reason === 'string' && c.reason.trim() ? { reason: c.reason.trim() } : {},
      }
      if (c.op === 'gain') ops.push({ op: 'add', ...base, ...qty !== undefined ? { qty } : {} })
      else if (c.op === 'lose' || c.op === 'consume') ops.push({ op: 'remove', ...base, ...qty !== undefined ? { qty } : {} })
      else if (c.op === 'destroy') ops.push({ op: 'set', ...base, qty: 0 })
      else rejected.push(`未知物品操作：${String(c.op)}`)
    }
    const r = applyInventory(state.inventory, ops)
    inventory = r.applied
    if (r.applied.length < ops.length) rejected.push(`有 ${ops.length - r.applied.length} 条物品变动无效（新物品缺名字，或失去/消耗了物品栏里没有的东西）`)
  }

  let xp: SettlementReceipt['xp']
  const p = story.mechanics?.progression
  if (p && typeof a.xp === 'object' && a.xp !== null) {
    const x = a.xp as Record<string, unknown>
    const amount = int(x.amount) ?? 0
    const points = int(x.points) ?? 0
    if (amount !== 0 || points > 0) {
      const { state: next, result } = applyXp(state.progression, p, amount, typeof x.reason === 'string' ? x.reason : '', points)
      xp = { ...result, unspent: next.granted - next.spent }
    }
  }

  const offers: RewardOffer[] = []
  if (rewards) {
    const pendingTitles = new Set(state.offers.map(o => o.title))
    for (const o of asArray(a.offers)) {
      const title = text(o.title, 30)
      const seen = new Set<string>()
      const choices = asArray(o.choices).flatMap((c) => {
        const t = text(c.title, 30)
        if (!t || seen.has(t)) return []
        seen.add(t)
        const detail = text(c.detail, 120)
        return [detail ? { title: t, detail } : { title: t }]
      }).slice(0, 6)
      if (!title || choices.length < 2) {
        rejected.push(`${rewards.label}候选组不完整（要有名目和至少两个候选）：${title || '（没写名目）'}`)
        continue
      }
      if (pendingTitles.has(title)) {
        rejected.push(`重复记了还没领的${rewards.label}「${title}」`)
        continue
      }
      pendingTitles.add(title)
      offers.push({ id: `r${state.progress.turn}-${offers.length + 1}`, turn: state.progress.turn, title, choices })
    }
  }
  const counter = rewards
    ? alignRewardCounter(story, { values, progress: state.progress }, state.offers.length + offers.length, `待领取的${rewards.label}：${state.offers.length + offers.length} 组`)
    : undefined

  const acts = actsOf(story, revisions)
  const proposedAnchors = Array.isArray(a.anchors) ? a.anchors.filter((x): x is string => typeof x === 'string') : []
  const report = applyReport(state.progress, acts, proposedAnchors)

  const receipt: SettlementReceipt = {
    anchors: { accepted: report.accepted, ignored: report.ignored },
    upkeep,
    resources,
    attributes,
    inventory,
    options: cleanOptions(a.options, story.craft.action_options),
    rejected,
    ended: report.ended,
  }
  if (xp) receipt.xp = xp
  if (offers.length) receipt.offers = offers
  if (counter) receipt.counter = counter
  if (report.advancedTo !== undefined) receipt.advancedTo = report.advancedTo
  return receipt
}
