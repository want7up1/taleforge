/**
 * 修订落盘：把一局游戏里积累的场外修订合并回 story.json 源。
 * 剧本永远只有一个现行正式版——落盘后的源就是它，下一局从干净的修订版开始。
 *
 * 修订条目的事实来源是 progress 包的 revise_setting；这里刻意不建跨包依赖，
 * 按结构消费（形状以彼处为准），不认识的条目原样跳过并计入 skipped。
 */
import { storySchema, type Story } from './schema.ts'

export interface RevisionLike {
  target: string
  id?: string
  act?: string
  op?: string
  text?: string
  signal?: string
  required?: boolean
  label?: string
  guidance?: string
  min?: number
  max?: number
  maxStep?: number
  floor?: number
}

export interface MergeResult {
  story: Story
  applied: number
  skipped: { revision: RevisionLike; reason: string }[]
}

/** 合并修订到剧本（输入不被修改；输出重新过 schema 校验，不合法直接抛错）。 */
export function applyRevisionsToStory(source: Story, revisions: RevisionLike[]): MergeResult {
  const story = structuredClone(source)
  const skipped: MergeResult['skipped'] = []
  let applied = 0

  for (const r of revisions) {
    switch (r.target) {
      case 'world': {
        if (!r.text) { skipped.push({ revision: r, reason: '缺 text' }); break }
        story.world.overview += `\n\n${r.text}`
        applied++
        break
      }
      case 'direction': {
        if (!r.text) { skipped.push({ revision: r, reason: '缺 text' }); break }
        story.craft.rules.push(r.text)
        applied++
        break
      }
      case 'cast': {
        const member = story.cast.find(c => c.id === r.id)
        if (!member || !r.text) { skipped.push({ revision: r, reason: member ? '缺 text' : `人物不存在：${r.id}` }); break }
        member.identity += `\n${r.text}`
        applied++
        break
      }
      case 'anchor': {
        const act = story.acts.find(a => a.id === r.act)
        if (!act || !r.id) { skipped.push({ revision: r, reason: act ? '缺锚点 id' : `幕不存在：${r.act}` }); break }
        const existing = act.anchors.find(a => a.id === r.id)
        if (r.op === 'add') {
          if (existing) { skipped.push({ revision: r, reason: `锚点已存在：${r.id}` }); break }
          act.anchors.push({
            id: r.id,
            text: r.text ?? '',
            required: r.required ?? true,
            ...(r.signal !== undefined ? { signal: r.signal } : {}),
          })
          applied++
        } else if (r.op === 'edit') {
          if (!existing) { skipped.push({ revision: r, reason: `锚点不存在：${r.id}` }); break }
          if (r.text !== undefined) existing.text = r.text
          if (r.signal !== undefined) existing.signal = r.signal
          if (r.required !== undefined) existing.required = r.required
          applied++
        } else if (r.op === 'remove') {
          if (!existing) { skipped.push({ revision: r, reason: `锚点不存在：${r.id}` }); break }
          act.anchors = act.anchors.filter(a => a.id !== r.id)
          applied++
        } else {
          skipped.push({ revision: r, reason: `未知 op：${String(r.op)}` })
        }
        break
      }
      case 'resource':
      case 'attribute': {
        const list = r.target === 'resource' ? story.mechanics?.resources : story.mechanics?.attributes
        const def = list?.find(d => d.id === r.id)
        if (!def) { skipped.push({ revision: r, reason: `条目不存在：${r.id}` }); break }
        if (r.label !== undefined) def.label = r.label
        if (r.guidance !== undefined) def.guidance = r.guidance
        if (r.min !== undefined) def.min = r.min
        if (r.max !== undefined) def.max = r.max
        if (r.maxStep !== undefined) def.maxStep = r.maxStep
        if (r.target === 'resource' && r.floor !== undefined) {
          (def as { floor?: number }).floor = r.floor
        }
        applied++
        break
      }
      default:
        skipped.push({ revision: r, reason: `未知 target：${r.target}` })
    }
  }

  // 落盘产物必须仍是合法剧本——不合法说明合并逻辑或修订数据有问题，宁可失败不写脏文件
  return { story: storySchema.parse(story), applied, skipped }
}
