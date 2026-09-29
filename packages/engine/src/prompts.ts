/**
 * 每回合重新组装的上下文（布局见 CLAUDE.md「v2 内核重建 · 上下文布局」）：
 *
 *   system   ① 固定前缀 + ② 文风范本（scenario-compiler renderPersona，转幕时才变）
 *   user     ③ 前情提要 + ④ 最近 K 章原文   ← 同一块里只往后追加，前缀缓存稳稳命中
 *            ⑤ 临时尾部（面板、提醒、漂移事实、命中的设定、主线）+ ⑥ 玩家输入 + 本章要求
 *
 * ④ 以文本放进 user 消息，不当作模型自己的历史消息回放：带工具时每条 assistant 消息都得
 * 带回 reasoning_content，整局回放既贵又脆；以文本放入还能自由控制窗口与格式。
 * ⑤ 每回合重写、不进历史：旧版的回合头注入只能追加，一局下来几十份面板快照堆在上下文里。
 *
 * 结算步的指令（settlementBrief）也在这里——机制细则只写在结算步，写正文那一步不背清单。
 */
import type { AppliedChange } from '@taleforge/mechanics'
import { levelLabel } from '@taleforge/mechanics'
import { pressureOf, remainingAnchors, revisionLines } from '@taleforge/progress'
import { interleavedWords, type Lexicon, type LoreEntry, type Story } from '@taleforge/scenario-compiler'
import { driftNotes, freshWords, markersOf, type TurnFact } from './drift.ts'
import { actsOf, attributeDefs, phaseOf, resourceDefs, type Chapter, type SessionState } from './fold.ts'

/** 本章要求：尾部的最后一行，离生成点最近。只说一章的形状、篇幅、收在哪里。 */
export const CHAPTER_BRIEF = '【本章】写一整章：一个连续场景从定镜写到落点，不少于 2000 字；先让读者看见人在哪，再让事发生，收在让人想按下一步的地方。只写正文——选项与结算由系统在你写完后处理。'

export const OPENING_BRIEF = '【开局】这是第一章：以开场场景开篇，收在开场钩子上。'

export const FINALE_BRIEF = '【终幕】主线锚点已经全部达成，这一章就是结局：接住玩家的最后一步，收束主线与人物关系，写出终幕；结尾另起一行独写「——剧终——」。'

/** 进行中的局吃得到的"热字段"：剧本重新发布后下一回合就生效，其余字段锁在开局时的快照里。 */
export function hotStory(snapshot: Story, current: Story | undefined): Story {
  if (!current || current.id !== snapshot.id) return snapshot
  const craft = { ...snapshot.craft }
  if (current.craft.reminder !== undefined) craft.reminder = current.craft.reminder
  else delete craft.reminder
  if (current.craft.intensity_words !== undefined) craft.intensity_words = current.craft.intensity_words
  else delete craft.intensity_words
  if (current.craft.lexicons !== undefined) craft.lexicons = current.craft.lexicons
  else delete craft.lexicons
  const acts = snapshot.acts.map((a) => {
    const now = current.acts.find(x => x.id === a.id)
    if (!now) return a
    const { reminder: _old, ...rest } = a
    return now.reminder !== undefined ? { ...rest, reminder: now.reminder } : rest
  })
  const next: Story = { ...snapshot, craft, acts }
  if (current.lore !== undefined) next.lore = current.lore
  return next
}

// ---- ③④ 稳定部分 ----

/** 进入正文窗口的章节：前情提要覆盖到的之后全部。 */
export function windowChapters(state: SessionState): Chapter[] {
  const through = state.recap?.through ?? 0
  return state.chapters.filter(c => c.turn > through)
}

/** 章节正文进上下文前剥掉模型偶尔自带的【行动】块（选项归结算步，正文里的是残留）。 */
export function proseOf(text: string): string {
  const m = /^\s*【行动】\s*$/m.exec(text)
  return (m ? text.slice(0, m.index) : text).trimEnd()
}

export function renderStable(state: SessionState): string {
  const parts: string[] = []
  if (state.recap) {
    parts.push(`【前情提要】（第 1–${state.recap.through} 回合）\n${state.recap.text}`)
  }
  const chapters = windowChapters(state)
  if (chapters.length) {
    parts.push(`【最近章节】（已经写成的正文原文，按时间顺序；新的一章承接最后一章往下写）\n\n${chapters
      .map(c => `——第 ${c.turn} 回合——\n${c.input ? `玩家：${c.input}\n\n` : ''}${proseOf(c.text)}`)
      .join('\n\n')}`)
  }
  return parts.join('\n\n')
}

// ---- ⑤ 临时尾部 ----

/**
 * 已在正文里登场的人物：全名或去姓的简称（林绾绾→绾绾，≥2 字）出现过就算。与前端的防剧透同一条规则。
 * 绑了 revealWith 的数值条（某人的好感、欲望……）在她登场前既不进面板快照、也不进结算指令——
 * 线上两部剧本各有 12–13 条这样的条目，前几幕每回合白背十几条根本用不上的说明。
 */
export function metCast(state: SessionState, story: Story): Set<string> {
  const corpus = state.chapters.map(c => c.text).join('\n')
  const met = new Set<string>()
  for (const c of story.cast) {
    const short = c.name.length >= 3 ? c.name.slice(1) : ''
    if (corpus.includes(c.name) || (short.length >= 2 && corpus.includes(short))) met.add(c.id)
  }
  return met
}

const revealed = (def: { revealWith?: string }, met: Set<string>) => !def.revealWith || met.has(def.revealWith)

/**
 * 面板即时快照（治"GM 忘了物品栏里有什么"与在正文里发明装备）：长局里开局清单早被稀释，
 * 实测物品栏躺着钢管，正文抡了五回合不存在的折叠椅。hidden 资源一并给 GM，标明玩家看不见。
 */
export function panelLines(state: SessionState, story: Story): string[] {
  const lines: string[] = []
  const revisions = state.progress.revisions
  const p = story.mechanics?.progression
  if (p) {
    const prog = state.progression
    const maxLevel = p.thresholds.length + 1
    const next = prog.level < maxLevel ? p.thresholds[prog.level - 1] : null
    const name = p.levelNames ? `${levelLabel(p, prog.level)}（Lv.${prog.level}）` : `Lv.${prog.level}`
    const unspent = prog.granted - prog.spent
    lines.push(`等级：${name}（${p.label} ${prog.xp}${next !== null ? `/${next}` : '，满级'}）${unspent > 0 ? `，未分配属性点 ${unspent}` : ''}`)
  }
  const attrs = attributeDefs(story, revisions).map(d => `${d.label}${state.attrs[d.id]?.value ?? d.initial}`)
  if (attrs.length) lines.push(`属性：${attrs.join(' ')}`)
  const groupTitle = { self: '自身', affinity: '好感', world: '队伍' } as const
  const byGroup = new Map<string, string[]>()
  const met = metCast(state, story)
  for (const d of resourceDefs(story, revisions)) {
    if (!revealed(d, met)) continue
    const value = state.values[d.id]?.value ?? d.initial
    if (!byGroup.has(d.group)) byGroup.set(d.group, [])
    byGroup.get(d.group)!.push(`${d.label}${value}${d.display === 'hidden' ? '（隐藏）' : ''}`)
  }
  for (const [group, parts] of byGroup) {
    const title = story.mechanics?.groups?.[group as keyof typeof groupTitle] ?? groupTitle[group as keyof typeof groupTitle] ?? group
    lines.push(`${title}：${parts.join(' ')}`)
  }
  if (story.mechanics?.inventory) {
    const items = Object.values(state.inventory)
    lines.push(`物品栏：${items.length ? items.map(i => (i.qty > 1 ? `${i.name}×${i.qty}` : i.name)).join('、') : '（空）'}`)
  }
  return lines
}

/**
 * 设定条目的按需注入：触发词精确匹配（写全别名），不做词重叠打分——模糊匹配的误判在
 * 前作里泛滥过（护栏 3）。每回合最多 6 条，按命中先后。
 */
export function loreHits(lore: readonly LoreEntry[] | undefined, texts: readonly string[], limit = 6): LoreEntry[] {
  if (!lore?.length) return []
  const corpus = texts.join('\n')
  return lore.filter(e => e.triggers.some(t => t && corpus.includes(t))).slice(0, limit)
}

/** 最近几章的可观测事实（新的在前），供漂移回灌。直接从日志里的章节算，进程重启不丢。 */
export function recentFacts(state: SessionState, keep = 4): TurnFact[] {
  return state.chapters.slice(-keep).reverse().map(c => ({ kind: 'play' as const, markers: markersOf(c.text), text: c.text }))
}

/** "上一章结算出了什么"里下一章必须接住的：转幕、升级、奖励点。 */
function carryOverLines(state: SessionState, story: Story): string[] {
  const s = state.lastSettlement
  // 只接上一章的结算；中间隔着被取消的回合就不再提（那是更早的事了）
  if (!s || s.failed || s.turn !== state.progress.turn - 1) return []
  const lines: string[] = []
  const acts = actsOf(story, state.progress.revisions)
  if (s.receipt.advancedTo !== undefined && phaseOf(state) === 'playing') {
    const act = acts[s.receipt.advancedTo]
    if (act) lines.push(`【转幕】上一章完成了前一幕，这一章进入第 ${s.receipt.advancedTo + 1} 幕《${act.title}》——随剧情自然转场，不跳切。`)
  }
  const xp = s.receipt.xp
  const p = story.mechanics?.progression
  if (xp && p && xp.levelAfter > xp.levelBefore) {
    const lv = (n: number) => (p.levelNames ? levelLabel(p, n) : `Lv.${n}`)
    lines.push(`【升级】上一章结束时升到 ${lv(xp.levelAfter)}（${lv(xp.levelBefore)} → ${lv(xp.levelAfter)}，属性点由玩家自己分配）——这一章把升级写成可感的瞬间（怎么写按剧本规则）${story.craft.numbers_in_prose ? '' : '，不出现数字'}。`)
  }
  return lines
}

function pointsLine(state: SessionState, story: Story): string | undefined {
  const pts = state.lastPoints
  if (!pts || pts.turn !== state.progress.turn || !pts.changes.length) return undefined
  const labels = new Map(attributeDefs(story, state.progress.revisions).map(d => [d.id, d.label]))
  const done = pts.changes.map((c: AppliedChange) => `${labels.get(c.id) ?? c.id} +${c.applied}`).join('、')
  return `【加点】玩家刚把属性点加在：${done}（已落账）——正文里用一两句写出这份成长的体感${story.craft.numbers_in_prose ? '' : '，不出现数字'}。`
}

function mainlineLine(state: SessionState, story: Story): string | undefined {
  if (phaseOf(state) !== 'playing') return undefined
  const acts = actsOf(story, state.progress.revisions)
  const act = acts[state.progress.actIndex]
  if (!act) return undefined
  const next = remainingAnchors(state.progress, acts).find(a => a.required)
  const pressure = pressureOf(state.progress, act.pace)
  let line = `【主线】第 ${state.progress.actIndex + 1} 幕《${act.title}》：${act.objective}`
  if (next) line += `。下一个主线事件：${next.text}（迟早要发生，不是这一章的任务）`
  if (next && pressure.level === 'high') {
    line = `【主线】第 ${state.progress.actIndex + 1} 幕《${act.title}》已经停滞 ${pressure.stalledTurns} 回合——这一章让「${next.text}」真的发生。`
  }
  return line
}

export interface PlayTailInput {
  state: SessionState
  story: Story
  /** 玩家本回合的原话（开局为空） */
  input: string
  opening: boolean
  /** 剧本选用的词库现行版（强度提醒触发时从里面挑最近没用过的词）；没有就不附 */
  lexicons?: readonly Lexicon[]
}

/** ⑤ + ⑥：本回合的临时尾部，拼在稳定部分之后。 */
export function renderPlayTail({ state, story, input, opening, lexicons = [] }: PlayTailInput): string {
  const lines: string[] = []
  const panel = panelLines(state, story)
  if (panel.length) {
    lines.push(`【当前面板】${panel.join('；')}。面板是即时真值：正文里的装备物品与数值状态必须与它一致，新到手的东西这一章写出来、结算时入账。`)
  }
  lines.push(...carryOverLines(state, story))
  const acts = actsOf(story, state.progress.revisions)
  // 分幕提醒替换（不是叠加）全局提醒：序幕"正常世界不写底噪"与全局"每回合必须有底噪"
  // 这类互斥要求叠在一起会自相矛盾。未到的幕天然防剧透；没写的幕回落 craft.reminder。
  const staged = acts[state.progress.actIndex] ? story.acts.find(a => a.id === acts[state.progress.actIndex].id)?.reminder?.trim() : undefined
  const reminder = staged || story.craft.reminder?.trim()
  if (reminder) lines.push(`【剧本提醒】${reminder}`)
  const facts = recentFacts(state)
  const suggest = freshWords(interleavedWords(lexicons), facts.map(f => f.text), 10, state.chapters.length * 7)
  lines.push(...driftNotes(facts, story.craft.intensity_words ?? [], story.craft.modules.includes('standard'), suggest))
  const last = state.chapters[state.chapters.length - 1]
  const hits = loreHits(story.lore, [input, last?.text ?? ''])
  if (hits.length) lines.push(`【设定】\n${hits.map(e => `- ${e.title}：${e.text}`).join('\n')}`)
  const revisions = revisionLines(state.progress.revisions.filter(r => r.target !== 'anchor'), story.cast)
  if (revisions.length) lines.push(`【现行修订】（效力高于剧本原文）\n${revisions.join('\n')}`)
  const mainline = mainlineLine(state, story)
  if (mainline) lines.push(mainline)
  if (opening) lines.push(OPENING_BRIEF)
  if (phaseOf(state) === 'finale') lines.push(FINALE_BRIEF)
  const points = pointsLine(state, story)
  if (points) lines.push(points)
  if (!opening) lines.push(`【玩家本回合】${input}`)
  lines.push(CHAPTER_BRIEF)
  return lines.join('\n')
}

/** 正戏回合的 user 消息全文：稳定部分在前，尾部在后。 */
export function renderPlayMessage(input: PlayTailInput): string {
  const stable = renderStable(input.state)
  const tail = renderPlayTail(input)
  return stable ? `${stable}\n\n${tail}` : tail
}

/** 场外回合的 user 消息：同一份稳定部分（共享缓存），尾部换成场外协议与场外记录。 */
export function renderOffstageMessage(state: SessionState, story: Story, ask: string): string {
  const lines: string[] = [
    '【场外】玩家暂停了游戏，在场外和你说话。以主持人身份直接回答：可以谈机制、谈剧情安排、接受对后续剧情的指令；'
    + '玩家明确要求修改设定时调用 revise_setting 落账，只是聊聊就不必。不写正文、不推进剧情。回答简洁。',
  ]
  const panel = panelLines(state, story)
  if (panel.length) lines.push(`【当前面板】${panel.join('；')}。`)
  const revisions = revisionLines(state.progress.revisions.filter(r => r.target !== 'anchor'), story.cast)
  if (revisions.length) lines.push(`【现行修订】\n${revisions.join('\n')}`)
  const history = state.offstage.slice(-6)
  if (history.length) lines.push(`【场外记录】（最近几次）\n${history.map(h => `玩家：${h.ask}\n你：${h.reply}`).join('\n\n')}`)
  lines.push(`【玩家的场外消息】${ask}`)
  const stable = renderStable(state)
  return stable ? `${stable}\n\n${lines.join('\n')}` : lines.join('\n')
}

// ---- 结算步 ----

/** 旧版（dsh 时代）的工具名。按旧流程写的剧本文本里还留着它们。 */
const LEGACY_TOOLS = /grant_xp|spend_points|adjust_resources|adjust_attributes|adjust_inventory|report_progress|回执会告诉你|回执会列出/

/**
 * 旧剧本兼容：剧本文本里写着"用 grant_xp 落账""回执会列出"这类旧流程的说法时，给结算步一句映射。
 * 不去改写剧本原文——那是作者层；平台只负责把旧说法翻译成现在的字段。
 */
export const LEGACY_TOOLS_NOTE = '剧本文本里的 grant_xp（经验）与它的 points（剧情奖励属性点）、adjust_resources / adjust_attributes / adjust_inventory、report_progress 都是旧版的工具名：'
  + '现在一律记在这一次 settle_turn 里——经验写 xp.amount，剧情奖励属性点写 xp.points，资源、属性、物品写对应字段，锚点写 anchors。'
  + '剧本说的"回执会告诉你 / 回执会列出"，指的就是下面列出的周期收支。'

export function mentionsLegacyTools(story: Story): boolean {
  const texts = [
    ...story.craft.rules,
    story.craft.reminder ?? '',
    ...story.acts.map(a => a.reminder ?? ''),
    ...(story.mechanics?.resources ?? []).map(r => r.guidance),
    ...(story.mechanics?.attributes ?? []).map(a => a.guidance),
    story.mechanics?.checks?.guidance ?? '',
    story.mechanics?.inventory?.guidance ?? '',
    story.mechanics?.progression?.guidance ?? '',
  ]
  return texts.some(t => LEGACY_TOOLS.test(t))
}

/**
 * 结算步指令：正文已经定稿，照着刚写完的这一章结清。机制细则全在这里——
 * 锚点完成信号、每条资源的 guidance、物品规则、经验规则、选项要求。
 * 对照的就是刚写完的这一章：旧版"只报往回合已定稿正文"的绕法随之删除。
 */
export function settlementBrief(state: SessionState, story: Story, options: { finale: boolean }): string {
  const revisions = state.progress.revisions
  const acts = actsOf(story, revisions)
  const act = acts[state.progress.actIndex]
  const mech = story.mechanics
  const sections: string[] = ['【结算】上面这一章已经定稿。现在调用 settle_turn 把它结清——只看这一章里真实写出来的内容，不预支下一章。']
  if (mentionsLegacyTools(story)) sections.push(LEGACY_TOOLS_NOTE)

  if (act && !options.finale) {
    const remaining = remainingAnchors(state.progress, acts)
    sections.push(remaining.length
      ? `anchors（锚点，当前幕《${act.title}》还没达成的）：逐条对照完成信号——信号已经落在这一章的纸面上才报；"接近了""下一章会写到"都不算，锚点打勾不可逆。没有就传空数组。\n${remaining
        .map(a => `- ${a.id}：${a.text}${a.required ? '' : '（可选）'}${a.signal ? `｜完成信号：${a.signal}` : ''}`).join('\n')}`
      : 'anchors：当前幕没有待达成的锚点，传空数组。')
  }

  const upkeep = mech?.upkeep ?? []
  if (mech?.resources?.length) {
    const met = metCast(state, story)
    const all = resourceDefs(story, revisions)
    const defs = all.filter(d => revealed(d, met))
    const pending = all.length - defs.length
    sections.push(`resources（资源）：这一章的事件落进了下面哪条说明，就记哪条——判断标准是"事件类型对不对得上"，不是"变化够不够大"：一次遭遇战、一次并肩逃生、一夜休整都要记。没有变化传空数组。增减多少你按剧情定，系统会裁掉越界的部分。\n${defs
      .map(d => `- ${d.id}（${d.label}，当前 ${state.values[d.id]?.value ?? d.initial}，${d.min}–${d.max}，单次最多 ±${d.maxStep}${d.display === 'hidden' ? '，玩家看不见但照样记账' : ''}）：${d.guidance}`)
      .join('\n')}${upkeep.length
      ? `\n周期收支已由系统自动结算（${upkeep.map(u => `${u.reason}：${defs.find(d => d.id === u.id)?.label ?? u.id} ${u.delta > 0 ? '+' : ''}${u.delta}`).join('；')}），不要重复记。`
      : ''}${pending > 0 ? `\n另有 ${pending} 条绑定在还没登场的人物身上，人物登场之前不记。` : ''}`)
  }

  if (mech?.attributes?.length) {
    const defs = attributeDefs(story, revisions)
    sections.push(`attributes（属性）：变动稀少，只有剧情事件明确落进某条属性的说明时才记，没有传空数组。${mech.progression ? '本作开启了经验等级：属性主要靠玩家用属性点加点成长，这里只记说明里明确写出的剧情奖励。' : ''}\n${defs
      .map(d => `- ${d.id}（${d.label}，当前 ${state.attrs[d.id]?.value ?? d.initial}，${d.min}–${d.max}）：${d.guidance}`)
      .join('\n')}`)
  }

  if (mech?.inventory) {
    const items = Object.entries(state.inventory)
    sections.push(`inventory（物品）：这一章写到获得（gain）、失去（lose）、消耗（consume）、损毁（destroy）的物品，逐件入账——判断标准是这四个动词，不是"重不重要"。同一件物品永远用同一个 id；新物品给 kebab-case id 和名字；成批的按种类分条、各给数量（bottled-water×6、canned-food×4），不打包成一条"物资"。没有传空数组。\n${mech.inventory.guidance}\n现有物品：${items.length ? items.map(([id, v]) => `${id}（${v.name}${v.qty > 1 ? `×${v.qty}` : ''}）`).join('、') : '（空）'}`)
  }

  if (mech?.progression) {
    const p = mech.progression
    sections.push(`xp（${p.label}）：${p.guidance}\n这一章换来多少就报多少（负数为失去），没有传 0；单次最多 ${p.maxStep}。等级与属性点由系统按阈值裁定，属性点由玩家自己分配——你不替玩家加点。${p.bonusPointsMax > 0 ? `剧本规则写明的剧情奖励属性点用 points 发放（单次最多 ${p.bonusPointsMax}），同样进玩家的待分配池。` : ''}`)
  }

  if (!options.finale) {
    const n = story.craft.action_options
    const pressure = act ? pressureOf(state.progress, act.pace) : undefined
    const next = act ? remainingAnchors(state.progress, acts).find(a => a.required) : undefined
    sections.push([
      `options（给玩家的 ${n} 个下一步行动）：每条是玩家此刻可以立刻去做的具体行动——谁、做什么、对谁或往哪，一句话；不写"继续""看看情况"这类空话，不带编号。`,
      '从这一章的结尾往下走：结尾刚出现的东西（一个声音、一个人、一处变化）至少有一条选项直接回应它。',
      `第一条推动当前幕目标${pressure?.level === 'high' && next ? `，直指「${next.text}」` : ''}；其余给出不同的策略、风险或信息方向。`,
      repeatGuard(state),
      phaseOf(state) === 'finale' ? '主线已经全部达成：这是走向结局前的最后一步。' : '',
    ].join(''))
  }
  return sections.join('\n\n')
}

/**
 * 选项别原地打转：把玩家这一步刚做的事、上一回合给过的选项原样摆出来，要求不换个说法再给一遍。
 * 实测（2026-09-29 线上）：玩家选了"逼潘雅把昨天看到的说清楚"，这一章写成她体力不支、没问完，
 * 结尾楼梯上响了一声——结算给的第一条却是"把车库、货梯井……一句句问到底"，同一件事换了个说法，
 * 也没有一条回应结尾那声响。给出原句是事实，比"别重复"这种判断更好执行。
 */
function repeatGuard(state: SessionState): string {
  const chapter = state.chapters[state.chapters.length - 1]
  const clip = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t)
  // 开场章没有"上一步"；（开始）这类整句括起来的是界面发的控制口令，不是玩家的行动
  if (!chapter || chapter.turn <= 1) return ''
  const raw = chapter.input.trim()
  const taken = /^（[^）]*）$/.test(raw) ? '' : raw.replace(/^[A-E][.．、]\s*/, '')
  const last = state.lastSettlement
  const offered = last && last.turn === chapter.turn - 1 ? last.receipt.options : []
  if (!taken && !offered.length) return ''
  const parts = [
    taken ? `玩家这一步刚做的是「${clip(taken)}」` : '',
    offered.length ? `上一回合给过的是${offered.map(o => `「${clip(o)}」`).join('')}` : '',
  ].filter(Boolean)
  return `不原地打转：${parts.join('；')}——不要把它们换个说法再给一遍。刚做的事没做完、还要接着做，就写清接着做的是哪一个新的动作（同一件事换个说法、换个角度都不算新动作）。`
}

// ---- 前情提要 ----

export const RECAP_TASK = `【前情提要写作任务】你是这部长篇的编辑。把【旧提要】和【新章节】合并成一份新的前情提要，供你自己写后面的章节时回看。

- 按时间顺序叙述，用小说梗概的笔法（第三人称、过去时），不是条目清单。
- 必须保留：每个人物现在在哪、在做什么、和主角的关系走到了哪一步（具体的那一下：谁对谁做了什么、说了什么关键的话）；已经确立的事实（地名、物品来历、伤势、约定、欠下的人情、许下的承诺、结下的仇）；还没解开的悬念与伏笔；主角知道了什么、还不知道什么。
- 越早的事写得越简略，最近几章写得具体。
- 不写数值（面板另有记录），不评价，不预测后续。
- 全文 1200–2500 字，只输出前情提要正文。`

/** 前情提要的 user 消息：旧提要 + 要并进来的章节原文 + 任务说明。 */
export function renderRecapMessage(oldRecap: string | undefined, chapters: readonly Chapter[]): string {
  return [
    `【旧提要】\n${oldRecap ?? '（无——这是第一份提要）'}`,
    `【新章节】\n\n${chapters.map(c => `——第 ${c.turn} 回合——\n${c.input ? `玩家：${c.input}\n\n` : ''}${proseOf(c.text)}`).join('\n\n')}`,
    RECAP_TASK,
  ].join('\n\n')
}
