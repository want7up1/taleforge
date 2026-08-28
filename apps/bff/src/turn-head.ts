/**
 * 回合头注入块的组装——**每一个正戏回合都会跑这里**，出错就是整局的提醒通道失灵。
 *
 * 这一层原本埋在 apps/bff/src/index.ts 的 Express 路由中间，跟 rpc 调用缠在一起，
 * 一行都测不到；而项目历史上的事故恰好集中在它身上：投影 key 分片后前端认不出面板、
 * 适配段拼在最前面导致【回合流程】前缀判断落空（整段提醒显示给了玩家）、
 * 注入块混进玩家原话被当成重发内容。所以把纯逻辑整块搬出来，IO 留在路由里。
 *
 * 搬运时文本一个字都没动：这些措辞是逐局实测调出来的，改文案等于改行为。
 */
import { driftNotes, type TurnFact } from './drift.ts'

export const TURN_FLOW_REMINDER = '【回合流程】先调 report_progress——每一回合都要调，只报往回合正文里已经达成的锚点（本回合才打算写的不算，下回合再报），无进展传空数组；有机制面板则接着用相应工具把本回合的全部变化结清；然后写正文，结尾必须有【行动】块（系统宣布终幕的回合除外）。'

/**
 * 创作简报，注入块的最后一行：回合头里离正文最近的位置，之前全是记账
 * （流程、面板数字、加点指令），正文被这些清单带成了巡视报告。
 * 只说三件事：一章的形状、篇幅、收在哪里。
 */
export const CHAPTER_BRIEF = '【本章】写一整章：一个连续场景从定镜写到落点，不少于 2000 字；先让读者看见人在哪，再让事发生，收在让人想按下一步的地方；结尾【行动】块。'

export interface NumericSnapshot {
  defs: { id: string; label: string; group?: 'affinity' | 'self' | 'world' }[]
  state: Record<string, { value: number }>
  groups?: { self?: string; affinity?: string; world?: string }
}
export interface ProjectionValues {
  mechanics?: NumericSnapshot | null
  attributes?: NumericSnapshot | null
  inventory?: { items: { name: string; qty: number }[] } | null
  progress?: { actIndex: number } | null
  progression?: { label: string; xp: number; level: number; next: number | null; unspent: number; levelNames?: string[] } | null
  [key: string]: unknown
}

/**
 * 取一个投影值：投影 key 按剧本分片成 `base:剧本id`（否则 dsh 全局唯一的 key 会让
 * 先 mount 的剧本顶掉后来者的 defs——实测荻湾庄的会话拿到过澜心岛的面板）。
 * 认前缀不认全等，裸 key 仍然接受，兼容单剧本部署与旧存档。
 */
export function projectionOf<T>(values: ProjectionValues, base: string): T | undefined {
  const direct = values[base]
  if (direct) return direct as T
  for (const [k, v] of Object.entries(values)) {
    if (v && k.startsWith(`${base}:`)) return v as T
  }
  return undefined
}

/**
 * 玩家加点行 → spend_points 参数。前端用属性显示名写【加点】行（玩家看得懂），这里按
 * 投影里的现行属性名录（与界面同源，含改名修订）换算成 id，作为机械指令贴进回合头。
 */
export function allocationHint(playerText: string, attributes: NumericSnapshot | null | undefined): string | undefined {
  const line = playerText.split('\n').map(l => l.trim()).find(l => l.startsWith('【加点】'))
  if (!line) return undefined
  const defs = attributes?.defs ?? []
  const allocations: { id: string; points: number }[] = []
  const unknown: string[] = []
  // 条目以顿号/逗号分隔，每条"显示名 +N"（显示名可含空格）；同一属性写多次合并
  for (const part of line.slice('【加点】'.length).split(/[、,，;；]/)) {
    const m = /^(.+?)\s*\+\s*(\d+)\s*$/.exec(part.trim())
    if (!m) continue
    const def = defs.find(d => d.label === m[1] || d.id === m[1])
    if (!def) {
      unknown.push(m[1])
      continue
    }
    const points = Number(m[2])
    const hit = allocations.find(a => a.id === def.id)
    if (hit) hit.points += points
    else allocations.push({ id: def.id, points })
  }
  return `【加点】玩家本回合分配属性点——固定流程第 2 步第一件事调 spend_points 原样落账：allocations=${JSON.stringify(allocations)}`
    + (unknown.length ? `（无法对应属性：${unknown.join('、')}，忽略）` : '')
}

/**
 * 面板即时快照，随回合头注入（治"GM 忘了物品栏里有什么"与延迟结算）：
 * 机制状态折叠在会话事件里，长局中初始清单早被上下文稀释——GM 会在正文里
 * 发明装备（实测：物品栏躺着钢管，正文抡了五回合不存在的折叠椅）。每回合把
 * 全量数值与物品清单贴到生成点旁，账实相符就有了对照物。hidden 资源一并给
 * GM（本块玩家侧被前端隐藏，与 hidden 的界面约定一致）。
 */
export function panelLines(values: ProjectionValues): string[] {
  const lines: string[] = []
  const numeric = (snap: NumericSnapshot | null | undefined): Map<string, string[]> => {
    const byGroup = new Map<string, string[]>()
    for (const def of snap?.defs ?? []) {
      const value = snap?.state[def.id]?.value
      if (value === undefined) continue
      const group = def.group ?? ''
      if (!byGroup.has(group)) byGroup.set(group, [])
      byGroup.get(group)!.push(`${def.label}${value}`)
    }
    return byGroup
  }
  const prog = projectionOf<ProjectionValues['progression']>(values, 'progression')
  if (prog) {
    const name = prog.levelNames?.[prog.level - 1]
    lines.push(`等级：${name ? `${name}（Lv.${prog.level}）` : `Lv.${prog.level}`}（${prog.label} ${prog.xp}${prog.next !== null && prog.next !== undefined ? `/${prog.next}` : '，满级'}）`
      + (prog.unspent > 0 ? `，未分配属性点 ${prog.unspent}` : ''))
  }
  const attrs = [...numeric(projectionOf<NumericSnapshot>(values, 'attributes')).values()].flat()
  if (attrs.length) lines.push(`属性：${attrs.join(' ')}`)
  const groupTitle = { self: '自身', affinity: '好感', world: '队伍' } as const
  const mech = projectionOf<NumericSnapshot>(values, 'mechanics')
  for (const [group, parts] of numeric(mech)) {
    const title = mech?.groups?.[group as keyof typeof groupTitle]
      ?? groupTitle[group as keyof typeof groupTitle] ?? group
    lines.push(`${title}：${parts.join(' ')}`)
  }
  const items = projectionOf<{ items: { name: string; qty: number }[] }>(values, 'inventory')?.items ?? []
  if (items.length) {
    lines.push(`物品栏：${items.map(i => (i.qty > 1 ? `${i.name}×${i.qty}` : i.name)).join('、')}`)
  }
  return lines
}

/** 回合头注入用到的剧本片段（BFF 每回合现读 preset 里的 story.json，改剧本后进行中的局下一回合就吃到）。 */
export interface StoryHead {
  craft?: { modules?: string[]; reminder?: string; intensity_words?: string[] }
  acts?: { reminder?: string }[]
}

/**
 * 组装正戏回合头注入的正文。纯函数：拿不到面板快照就传 `{}`（注入永远不能挡住回合本身），
 * 各段自然退化成空串。
 *
 * 段落顺序有实测依据，别随手调：模型适配段在最前（与直连重放时的相对位置一致），
 * 【回合流程】紧随其后，漂移回灌排在最后——它是本回合最该被看见的一条，
 * 且只在连续不达标时才有内容。
 */
export function renderTurnHead(parts: {
  /** 当前会话的全量投影值 */
  values: ProjectionValues
  /** 玩家这一回合的原话（用于识别【加点】行） */
  playerText: string
  /** 该剧本 story.json 里与注入有关的片段 */
  story?: StoryHead
  /** 最近几回合的观测事实，新的在前 */
  recent?: readonly TurnFact[]
}): string {
  const { values, playerText, story, recent = [] } = parts
  let alloc = ''
  // 只有开了经验等级的剧本才有 spend_points；没开的剧本即便玩家手打【加点】也不注入
  const progression = projectionOf<ProjectionValues['progression']>(values, 'progression')
  if (progression) {
    const hint = allocationHint(playerText, projectionOf<NumericSnapshot>(values, 'attributes'))
    if (hint) alloc = `\n${hint}`
    // grant_xp 的"每回合必调"也要贴在生成点旁——只写在 persona 里的机械规则，低事件回合会被跳过
    alloc += `\n【经验】grant_xp 每个正戏回合都要调（只报往回合已定稿正文换来的${progression.label}，没有传 0）。`
  }

  let panel = ''
  const lines = panelLines(values)
  if (lines.length) {
    panel = `\n【当前面板】${lines.join('；')}。`
      + '面板是即时真值：正文中的装备物品必须与物品栏一致（新到手先入账再用）；'
      + '本回合的一切增减当回合结算，不许延后补账。'
  }

  // 分幕提醒替换（不是叠加）全局提醒：序幕"正常世界不写底噪"与全局"每回合必须有底噪"
  // 这类互斥要求叠在一起会自相矛盾。未到的幕天然防剧透；没写的幕回落 craft.reminder。
  const actIndex = projectionOf<{ actIndex: number }>(values, 'progress')?.actIndex
  const staged = actIndex !== undefined ? story?.acts?.[actIndex]?.reminder?.trim() : undefined
  const reminder = staged || story?.craft?.reminder?.trim()

  // 强调标记的"每回合 2–4 处"是 standard 模块里的要求，没选它的剧本不该被平台催
  const drift = driftNotes(
    recent,
    story?.craft?.intensity_words ?? [],
    story?.craft?.modules?.includes('standard') ?? false,
  )

  return `\n\n${TURN_FLOW_REMINDER}${alloc}${panel}`
    + `${reminder ? `\n【剧本提醒】${reminder}` : ''}`
    + (drift.length ? `\n${drift.join('\n')}` : '')
    + `\n${CHAPTER_BRIEF}`
}
