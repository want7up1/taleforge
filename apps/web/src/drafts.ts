/**
 * 可视化编辑器的草稿逻辑（纯函数，node 测试直接加载）：
 * 载入时把可选的列表补成空数组，好让表单直接绑定；保存前反过来把空串、空列表、没启用的机制段删掉，
 * 交给平台校验的就是一份干净的剧本。字段含义与限制以平台 schema 为准，这里只做形状上的往返。
 */

/** 词表框的拆词：顿号、中英文逗号、分号或换行分隔，去掉空白与重复。 */
export function splitWords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[\n、，,；;]+/)) {
    const w = raw.trim()
    if (w && !out.includes(w)) out.push(w)
  }
  return out
}

// ---- 词库 ----

export interface LexiconGroupDraft {
  label: string
  note?: string
  words: string[]
}

export interface LexiconDraft {
  format: 'taleforge.lexicon.v1'
  id: string
  title: string
  guide?: string
  groups: LexiconGroupDraft[]
}

export const blankLexicon = (): LexiconDraft => ({
  format: 'taleforge.lexicon.v1',
  id: '',
  title: '',
  groups: [{ label: '', words: [] }],
})

export function cleanLexicon(d: LexiconDraft): LexiconDraft {
  const out: LexiconDraft = { format: 'taleforge.lexicon.v1', id: d.id.trim(), title: d.title.trim(), groups: [] }
  if (d.guide?.trim()) out.guide = d.guide.trim()
  out.groups = d.groups.map(g => ({
    label: g.label.trim(),
    ...g.note?.trim() ? { note: g.note.trim() } : {},
    words: g.words,
  }))
  return out
}

// ---- 剧本 ----

export type ResourceGroup = 'self' | 'affinity' | 'world'
export type Display = 'strip' | 'panel' | 'hidden'
export type Die = 'd20' | 'd100' | '2d6'

export interface AnchorDraft { id: string; text: string; required: boolean; signal?: string }
export interface ActDraft {
  id: string
  title: string
  objective: string
  anchors: AnchorDraft[]
  forbidden_reveals: string[]
  reminder?: string
  pace?: number
}
export interface CastDraft { id: string; name: string; identity: string; secret?: string; voice: string[] }
export interface ResourceDraft {
  id: string
  label: string
  group: ResourceGroup
  min: number | undefined
  max: number | undefined
  initial: number | undefined
  floor?: number
  maxStep: number | undefined
  guidance: string
  display?: Display
  revealWith?: string
}
export interface UpkeepDraft { id: string; delta: number | undefined; reason: string; activeAbove?: number }
export interface AttributeDraft {
  id: string
  label: string
  initial: number | undefined
  min?: number
  max?: number
  maxStep?: number
  guidance: string
}
export interface ItemDraft { id: string; name: string; qty?: number; note?: string }
export interface ProgressionDraft {
  label?: string
  guidance: string
  maxStep: number | undefined
  thresholds: number[]
  pointsPerLevel: number | undefined
  bonusPointsMax?: number
  levelNames: string[]
  display?: 'strip' | 'panel'
}
export interface MechanicsDraft {
  resources?: ResourceDraft[]
  upkeep?: UpkeepDraft[]
  attributes?: AttributeDraft[]
  checks?: { die: Die; guidance: string }
  inventory?: { guidance: string; initial: ItemDraft[] }
  progression?: ProgressionDraft
  groups?: { self?: string; affinity?: string; world?: string }
}
export interface LoreDraft { id: string; title: string; triggers: string[]; text: string }

export interface StoryDraft {
  format: string
  id: string
  title: string
  tagline: string
  world: { overview: string; tone: string[]; hidden_truths: { id: string; text: string }[] }
  protagonist: { name: string; identity: string; voice?: string }
  cast: CastDraft[]
  opening: { scene: string; hook: string; chapter?: string }
  acts: ActDraft[]
  mechanics: MechanicsDraft
  craft: {
    modules: string[]
    rating?: string
    action_options: number
    numbers_in_prose: boolean
    rules: string[]
    reminder?: string
    intensity_words: string[]
    exemplar?: string
    lexicons: string[]
  }
  lore: LoreDraft[]
}

export const blankAnchor = (): AnchorDraft => ({ id: '', text: '', required: true, signal: '' })
export const blankAct = (): ActDraft => ({ id: '', title: '', objective: '', anchors: [blankAnchor()], forbidden_reveals: [] })
export const blankCast = (): CastDraft => ({ id: '', name: '', identity: '', secret: '', voice: [] })
export const blankResource = (): ResourceDraft => ({ id: '', label: '', group: 'self', min: 0, max: 100, initial: 50, maxStep: 20, guidance: '' })
export const blankAttribute = (): AttributeDraft => ({ id: '', label: '', initial: 3, min: 0, max: 20, maxStep: 1, guidance: '' })
export const blankLore = (): LoreDraft => ({ id: '', title: '', triggers: [], text: '' })

export const blankStory = (): StoryDraft => ({
  format: 'taleforge.story.v1.1',
  id: 'story-',
  title: '',
  tagline: '',
  world: { overview: '', tone: [], hidden_truths: [] },
  protagonist: { name: '', identity: '', voice: '第二人称「你」。' },
  cast: [],
  opening: { scene: '', hook: '' },
  acts: [blankAct()],
  mechanics: {},
  craft: { modules: ['standard'], action_options: 4, numbers_in_prose: false, rules: [], intensity_words: [], lexicons: [] },
  lore: [],
})

type Loose = Record<string, unknown>
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** 平台导出的剧本（已过 schema，缺省值齐全）→ 表单草稿：可选列表补成空数组。 */
export function toDraft(input: unknown): StoryDraft {
  const s = (input ?? {}) as Loose
  const world = (s.world ?? {}) as Loose
  const prot = (s.protagonist ?? {}) as Loose
  const opening = (s.opening ?? {}) as Loose
  const craft = (s.craft ?? {}) as Loose
  const mech = (s.mechanics ?? {}) as Loose
  const inventory = mech.inventory as Loose | undefined
  const progression = mech.progression as Loose | undefined
  const checks = mech.checks as Loose | undefined
  return {
    format: str(s.format) || 'taleforge.story.v1.1',
    id: str(s.id),
    title: str(s.title),
    tagline: str(s.tagline),
    world: { overview: str(world.overview), tone: arr<string>(world.tone), hidden_truths: arr(world.hidden_truths) },
    protagonist: { name: str(prot.name), identity: str(prot.identity), voice: optStr(prot.voice) },
    cast: arr<Loose>(s.cast).map(c => ({ id: str(c.id), name: str(c.name), identity: str(c.identity), secret: optStr(c.secret), voice: arr<string>(c.voice) })),
    opening: { scene: str(opening.scene), hook: str(opening.hook), chapter: optStr(opening.chapter) },
    acts: arr<Loose>(s.acts).map(a => ({
      id: str(a.id),
      title: str(a.title),
      objective: str(a.objective),
      anchors: arr<Loose>(a.anchors).map(x => ({ id: str(x.id), text: str(x.text), required: x.required !== false, signal: optStr(x.signal) })),
      forbidden_reveals: arr<string>(a.forbidden_reveals),
      reminder: optStr(a.reminder),
      pace: optNum(a.pace),
    })),
    mechanics: {
      ...mech.resources ? { resources: arr<ResourceDraft>(mech.resources) } : {},
      ...mech.upkeep ? { upkeep: arr<UpkeepDraft>(mech.upkeep).map(u => ({ id: u.id, delta: u.delta, reason: u.reason, activeAbove: u.activeAbove })) } : {},
      ...mech.attributes ? { attributes: arr<AttributeDraft>(mech.attributes) } : {},
      ...checks ? { checks: { die: (str(checks.die) || 'd20') as Die, guidance: str(checks.guidance) } } : {},
      ...inventory ? { inventory: { guidance: str(inventory.guidance), initial: arr<ItemDraft>(inventory.initial) } } : {},
      ...progression
        ? {
            progression: {
              label: optStr(progression.label),
              guidance: str(progression.guidance),
              maxStep: optNum(progression.maxStep),
              thresholds: arr<number>(progression.thresholds),
              pointsPerLevel: optNum(progression.pointsPerLevel),
              bonusPointsMax: optNum(progression.bonusPointsMax),
              levelNames: arr<string>(progression.levelNames),
              display: optStr(progression.display) as ProgressionDraft['display'],
            },
          }
        : {},
      ...mech.groups ? { groups: mech.groups as MechanicsDraft['groups'] } : {},
    },
    craft: {
      modules: arr<string>(craft.modules),
      rating: optStr(craft.rating),
      action_options: optNum(craft.action_options) ?? 4,
      numbers_in_prose: craft.numbers_in_prose === true,
      rules: arr<string>(craft.rules),
      reminder: optStr(craft.reminder),
      intensity_words: arr<string>(craft.intensity_words),
      exemplar: optStr(craft.exemplar),
      lexicons: arr<string>(craft.lexicons),
    },
    lore: arr<Loose>(s.lore).map(l => ({ id: str(l.id), title: str(l.title), triggers: arr<string>(l.triggers), text: str(l.text) })),
  }
}

/**
 * 可选字段"不写"就该整个不出现：去掉列出的这些键里值为 undefined、空串或空列表的。
 * 只动可选键——必填字段留空就原样交出去，平台才报得出"至少 1 字"而不是笼统的"缺字段"。
 */
function dropEmpty<T extends object>(o: T, keys: readonly string[]): T {
  const out = { ...o } as Loose
  for (const k of keys) {
    const v = out[k]
    if (v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) delete out[k]
  }
  return out as T
}

/** 表单草稿 → 交给平台的剧本：空的可选字段整个去掉，没启用的机制段不出现。 */
export function fromDraft(d: StoryDraft): Loose {
  const m = d.mechanics
  const mechanics: Loose = {}
  const groups = m.groups ? dropEmpty(m.groups, ['self', 'affinity', 'world']) : undefined
  if (groups && Object.keys(groups).length) mechanics.groups = groups
  if (m.resources?.length) mechanics.resources = m.resources.map(r => dropEmpty(r, ['floor', 'display', 'revealWith']))
  if (m.upkeep?.length) mechanics.upkeep = m.upkeep.map(u => dropEmpty(u, ['activeAbove']))
  if (m.attributes?.length) mechanics.attributes = m.attributes.map(a => dropEmpty(a, ['min', 'max', 'maxStep']))
  if (m.checks) mechanics.checks = m.checks
  if (m.inventory) mechanics.inventory = { guidance: m.inventory.guidance, initial: m.inventory.initial.map(i => dropEmpty(i, ['qty', 'note'])) }
  if (m.progression) mechanics.progression = dropEmpty(m.progression, ['label', 'bonusPointsMax', 'levelNames', 'display'])
  const hasMechanics = Object.keys(mechanics).some(k => k !== 'groups')
  return {
    format: 'taleforge.story.v1.1',
    id: d.id.trim(),
    title: d.title,
    tagline: d.tagline,
    world: d.world,
    protagonist: dropEmpty(d.protagonist, ['voice']),
    cast: d.cast.map(c => dropEmpty(c, ['secret', 'voice'])),
    opening: dropEmpty(d.opening, ['chapter']),
    acts: d.acts.map(a => ({ ...dropEmpty(a, ['reminder', 'pace']), anchors: a.anchors.map(x => dropEmpty(x, ['signal'])) })),
    ...hasMechanics ? { mechanics } : {},
    craft: dropEmpty(d.craft, ['rating', 'reminder', 'exemplar', 'intensity_words', 'lexicons']),
    ...d.lore.length ? { lore: d.lore } : {},
  }
}

/** 平台校验信息里 zod 的英文缺省文案 → 中文（剧本自己带中文文案的原样保留）。 */
export function issueText(message: string): string {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/expected (?:string|number|array|object|boolean), received undefined/, () => '必填'],
    [/expected string to have >=(\d+) characters/, m => (m[1] === '1' ? '不能为空' : `至少 ${m[1]} 字`)],
    [/expected string to have <=(\d+) characters/, m => `最多 ${m[1]} 字`],
    [/expected array to have >=(\d+) items/, m => `至少 ${m[1]} 项`],
    [/expected array to have <=(\d+) items/, m => `最多 ${m[1]} 项`],
    [/expected number to be >=(-?\d+)/, m => `不能小于 ${m[1]}`],
    [/expected number to be >(-?\d+)/, m => `要大于 ${m[1]}`],
    [/expected number to be <=(-?\d+)/, m => `不能大于 ${m[1]}`],
    [/expected number to be <(-?\d+)/, m => `要小于 ${m[1]}`],
    [/expected number, received/, () => '要填整数'],
    [/expected int/, () => '要填整数'],
    [/Invalid option: expected one of (.+)/, m => `只能是 ${m[1]} 之一`],
    [/must match pattern|Invalid string/, () => '格式不对（小写字母、数字、连字符）'],
  ]
  for (const [re, fmt] of rules) {
    const m = re.exec(message)
    if (m) return fmt(m)
  }
  return message
}

// ---- 校验结果的字段路径 → 看得懂的位置 ----

const SECTION_OF: Record<string, string> = {
  format: 'basic', id: 'basic', title: 'basic', tagline: 'basic',
  world: 'world', protagonist: 'protagonist', cast: 'cast', opening: 'opening',
  acts: 'acts', mechanics: 'mechanics', craft: 'craft', lore: 'lore',
}

/** 这条错误属于编辑器的哪一页 */
export function sectionOf(path: string): string {
  return SECTION_OF[path.split('.')[0]] ?? 'basic'
}

/** 后面跟着序号的是列表 */
const LIST_NAMES: Record<string, string> = {
  hidden_truths: '隐藏真相', cast: '人物', acts: '幕', anchors: '锚点', resources: '资源', upkeep: '周期收支',
  attributes: '属性', initial: '开局物品', thresholds: '升级阈值', levelNames: '等级名', rules: '规则', lore: '设定条目',
  triggers: '触发词', forbidden_reveals: '禁止揭露', voice: '口吻样例', lexicons: '词库', intensity_words: '强度词',
  tone: '基调', modules: '工艺模块', groups: '组', words: '词',
}
const FIELD_NAMES: Record<string, string> = {
  world: '世界', protagonist: '主角', opening: '开场', mechanics: '机制', craft: '工艺', inventory: '物品栏',
  progression: '经验等级', checks: '判定', title: '标题', tagline: '卖点', overview: '总纲', tone: '基调',
  name: '名字', identity: '公开设定', secret: '暗线', voice: '口吻', scene: '场景', hook: '钩子', chapter: '开场章',
  objective: '目标', text: '内容', signal: '完成信号', required: '必需', pace: '节奏', reminder: '贴身提醒',
  label: '名称', group: '分组', min: '最小值', max: '最大值', initial: '初值', floor: '下限', maxStep: '单次上限',
  guidance: '说明', display: '显示位置', revealWith: '绑定人物', delta: '每回合变化', reason: '理由',
  activeAbove: '生效门槛', die: '骰型', qty: '数量', note: '备注', pointsPerLevel: '每级点数',
  bonusPointsMax: '剧情奖励点上限', rating: '内容强度', action_options: '选项数', numbers_in_prose: '数字进正文',
  exemplar: '范文', guide: '用法说明', groups: '分组标题',
}

/** "acts.0.anchors.1.signal" → "幕 1 › 锚点 2 › 完成信号" */
export function pathLabel(path: string): string {
  const parts = path.split('.')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const next = parts[i + 1]
    if (next !== undefined && /^\d+$/.test(next)) {
      out.push(`${LIST_NAMES[p] ?? p} ${Number(next) + 1}`)
      i++
    } else {
      out.push(FIELD_NAMES[p] ?? p)
    }
  }
  return out.join(' › ')
}

// ---- 编辑器提醒：审查清单里能机械查出来、平台校验又不拦的几项（只提醒，不拦保存） ----

export function draftHints(d: StoryDraft): string[] {
  const hints: string[] = []
  if (d.craft.reminder?.trim() && d.acts.length > 0 && d.acts.every(a => a.reminder?.trim())) {
    hints.push('每一幕都写了分幕提醒，全局贴身提醒永远不会发给 GM（分幕提醒是替换，不是叠加）。要么把全局那几句并进各幕，要么有的幕不写分幕提醒。')
  }
  d.acts.forEach((a, i) => {
    if (a.anchors.length && !a.anchors.some(x => x.required)) hints.push(`第 ${i + 1} 幕没有必需锚点：进入这一幕的那一刻就判定完成，会被直接跳过。`)
    a.anchors.forEach((x, j) => {
      if (x.required && !x.signal?.trim()) hints.push(`第 ${i + 1} 幕锚点 ${j + 1} 是必需的却没写完成信号：结算时 GM 没法判断它发生了没有，容易卡幕或跳幕。`)
    })
  })
  const dup = (label: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids.filter(Boolean)) {
      if (seen.has(id)) hints.push(`${label} id「${id}」重复了。`)
      seen.add(id)
    }
  }
  dup('幕', d.acts.map(a => a.id))
  dup('人物', d.cast.map(c => c.id))
  dup('资源', (d.mechanics.resources ?? []).map(r => r.id))
  dup('属性', (d.mechanics.attributes ?? []).map(a => a.id))
  const anchorIds = d.acts.flatMap(a => a.anchors.map(x => x.id)).filter(Boolean)
  const repeated = [...new Set(anchorIds.filter((id, i) => anchorIds.indexOf(id) !== i))]
  if (repeated.length) hints.push(`锚点 id 在多幕里重复：${repeated.join('、')}。锚点的达成记录全剧共用——前一幕达成了，后一幕的同名锚点自动算完成。不是有意为之就改成不同的 id。`)
  for (const r of d.mechanics.resources ?? []) {
    const { min, max, initial, floor } = r
    if (min !== undefined && max !== undefined && initial !== undefined && (initial < min || initial > max)) hints.push(`资源「${r.label || r.id}」的初值不在 ${min}–${max} 之间。`)
    if (min !== undefined && max !== undefined && floor !== undefined && (floor < min || floor > max)) hints.push(`资源「${r.label || r.id}」的下限不在 ${min}–${max} 之间。`)
  }
  const singles = d.craft.intensity_words.filter(w => w.length < 2)
  if (singles.length) hints.push(`强度词表里有单字：${singles.join('、')}。单字在日常叙述里也会出现，命中数永远不为零，"连续三章零命中"的提醒就永远不会触发。`)
  const loreSingles = d.lore.flatMap(l => l.triggers.filter(t => t.length < 2).map(t => `${l.title || l.id}：${t}`))
  if (loreSingles.length) hints.push(`设定条目的触发词里有单字（${loreSingles.join('；')}）：几乎每回合都会命中，挤掉真正相关的条目。`)
  const names = d.cast.map(c => c.name).filter(n => /[（(／/·、，]/.test(n))
  if (names.length) hints.push(`人物名字里带了括号或符号（${names.join('、')}）：平台按正文里出现名字来判定人物登场，别名写进公开设定。`)
  return hints
}
