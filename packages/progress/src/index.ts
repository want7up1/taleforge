/**
 * 幕进度（底座能力，所有剧本都有）——纯裁决逻辑。
 *
 * 判定分工：锚点是否达成由 GM 在结算步里表态（它是剧情的作者，不设第三个裁判）；
 * 结算步由代码强制发生、锚点 id 由 schema 枚举限定；转幕与终幕由代码裁定，GM 只承接叙事。
 * 设定修订也在此校验：场外由 GM 调 revise_setting，修订只对未来生效、效力高于剧本原文。
 */
import type { ActDef, Revision } from './types.ts'

export * from './progress.ts'
export * from './types.ts'

/** 机制条目名录（资源/属性），供数值定义修订的校验、显示与边界联动提醒 */
export interface NumericCatalog {
  resources?: { id: string; label: string; maxStep?: number }[]
  attributes?: { id: string; label: string; maxStep?: number }[]
}

/**
 * 边界联动提醒：修订只改了数值语义（guidance）而没动边界时，裁决仍按旧 maxStep
 * 裁剪——实测"双修体力回满"落账后，+55 被 maxStep=25 卡成 +25，语义永远兑现不了。
 */
export function boundaryWarnings(
  accepted: Revision[],
  numeric?: NumericCatalog,
): string[] {
  const warnings: string[] = []
  for (const r of accepted) {
    if (r.target !== 'resource' && r.target !== 'attribute') continue
    if (r.guidance === undefined) continue
    if (r.min !== undefined || r.max !== undefined || r.maxStep !== undefined || r.floor !== undefined) continue
    const known = (r.target === 'resource' ? numeric?.resources : numeric?.attributes)?.find(n => n.id === r.id)
    const cap = known?.maxStep
    warnings.push(`注意：「${r.id}」只改了语义未动边界${cap !== undefined ? `（现行单次上限 ±${cap}）` : ''}——`
      + '若新语义要求的单次变动会超过该上限（如"回满""清零"），请立刻再发一笔修订同步调整 maxStep/min/max，否则裁决会按旧边界裁剪，新语义永远无法兑现。')
  }
  return warnings
}

/** 校验修订条目：不合法的整条拒绝并说明原因，合法的规范化落账。 */
export function validateRevisions(
  entries: Record<string, unknown>[],
  acts: ActDef[],
  cast: { id: string; name: string }[],
  numeric?: NumericCatalog,
): { accepted: Revision[]; rejected: { index: number; reason: string }[] } {
  const accepted: Revision[] = []
  const rejected: { index: number; reason: string }[] = []
  const intOrUndef = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined)
  const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
  entries.forEach((raw, index) => {
    const target = raw.target
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (target === 'resource' || target === 'attribute') {
      const id = String(raw.id ?? '')
      const known = (target === 'resource' ? numeric?.resources : numeric?.attributes) ?? []
      if (!known.some(n => n.id === id)) {
        return rejected.push({ index, reason: `${target} id 不存在：${id}（局内不能增删条目；新条目走剧本详情页「修改剧本」写进剧本源，新开局生效）` }) && undefined
      }
      // 未给的字段整个省略：日志里不出现 undefined 键
      const fields = compact({
        label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined,
        guidance: typeof raw.guidance === 'string' && raw.guidance.trim() ? raw.guidance.trim() : undefined,
        min: intOrUndef(raw.min),
        max: intOrUndef(raw.max),
        maxStep: intOrUndef(raw.maxStep),
        floor: target === 'resource' ? intOrUndef(raw.floor) : undefined,
      })
      if (Object.keys(fields).length === 0) {
        return rejected.push({ index, reason: '至少给一个要修改的字段（label/guidance/min/max/maxStep/floor）' }) && undefined
      }
      if (typeof fields.maxStep === 'number' && fields.maxStep <= 0) {
        return rejected.push({ index, reason: 'maxStep 必须为正' }) && undefined
      }
      accepted.push({ target, id, ...fields } as Revision)
      return
    }
    if (target === 'world' || target === 'direction') {
      if (!text) return rejected.push({ index, reason: 'text 不能为空' }) && undefined
      accepted.push({ target, text })
      return
    }
    if (target === 'cast') {
      const id = String(raw.id ?? '')
      if (!cast.some(c => c.id === id)) return rejected.push({ index, reason: `人物 id 不存在：${id}` }) && undefined
      if (!text) return rejected.push({ index, reason: 'text 不能为空' }) && undefined
      accepted.push({ target: 'cast', id, text })
      return
    }
    if (target === 'anchor') {
      const actId = String(raw.act ?? '')
      const op = raw.op
      const id = String(raw.id ?? '')
      const act = acts.find(a => a.id === actId)
      if (!act) return rejected.push({ index, reason: `幕 id 不存在：${actId}` }) && undefined
      if (op !== 'add' && op !== 'edit' && op !== 'remove') {
        return rejected.push({ index, reason: `op 必须是 add/edit/remove：${String(op)}` }) && undefined
      }
      const exists = act.anchors.some(a => a.id === id)
      if (op === 'add' && exists) return rejected.push({ index, reason: `锚点已存在：${id}` }) && undefined
      if (op !== 'add' && !exists) return rejected.push({ index, reason: `锚点不存在：${id}` }) && undefined
      if (op === 'add' && !text) return rejected.push({ index, reason: '新增锚点必须给 text' }) && undefined
      accepted.push({
        target: 'anchor',
        act: actId,
        op,
        id,
        ...compact({
          text: text || undefined,
          signal: typeof raw.signal === 'string' ? raw.signal : undefined,
          required: typeof raw.required === 'boolean' ? raw.required : undefined,
        }),
      })
      return
    }
    rejected.push({ index, reason: `未知 target：${String(target)}` })
  })
  return { accepted, rejected }
}

/** 现行修订的文本行（回注给 GM，效力高于剧本原文）；没有返回空数组。 */
export function revisionLines(revisions: Revision[], cast: { id: string; name: string }[]): string[] {
  const lines: string[] = []
  for (const r of revisions) {
    if (r.target === 'world') lines.push(`- [世界] ${r.text}`)
    if (r.target === 'direction') lines.push(`- [走向] ${r.text}`)
    if (r.target === 'cast') lines.push(`- [人物·${cast.find(c => c.id === r.id)?.name ?? r.id}] ${r.text}`)
    if (r.target === 'resource' || r.target === 'attribute') {
      const parts: string[] = []
      if (r.label !== undefined) parts.push(`改名「${r.label}」`)
      if (r.min !== undefined || r.max !== undefined) parts.push(`区间 ${r.min ?? '原'}–${r.max ?? '原'}`)
      if (r.maxStep !== undefined) parts.push(`单步 ±${r.maxStep}`)
      if (r.floor !== undefined) parts.push(`下限护栏 ${r.floor}`)
      if (r.guidance !== undefined) parts.push(`语义改为：${r.guidance}`)
      lines.push(`- [${r.target === 'resource' ? '资源' : '属性'}·${r.id}] ${parts.join('；')}`)
    }
  }
  return lines
}
