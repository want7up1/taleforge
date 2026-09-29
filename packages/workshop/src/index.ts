/**
 * 工坊：剧本的发布、读取、留档与回滚，外加工坊对话用的三件工具（list/read/publish_story）。
 * 这些工具只给工坊会话与修改对话用，游戏会话永远拿不到（它们会写文件系统）。
 *
 * publish_story 是访谈的出口：校验 → 写进数据卷 scenarios/ → 立即可玩（引擎每次开局现读目录）。
 * 校验失败把逐条错误退回给工坊 agent 自行修正——闭环在工具内完成，不经人手。
 * 写入路径由剧本 id 决定（schema 强制 story- 前缀 + kebab-case，天然无路径穿越）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { toolDef, type AgentTool } from '@taleforge/llm'
import { isStoryId, scanCatalog, storySchema, type Story } from '@taleforge/scenario-compiler'
import { readLexicon } from './lexicons.ts'

export * from './lexicons.ts'

export interface Config {
  /** 用户内容根（数据卷）：工坊产出与修订落盘都写这里 */
  scenariosRoot: string
  /** 全部剧本源根（仓库种子在前、数据卷在后，后者同 id 覆盖）；缺省只有 scenariosRoot */
  roots?: string[]
  /** 词库目录（数据卷 lexicons/）：给了才在发布时核对 craft.lexicons 引用的词库是否已导入 */
  lexiconsRoot?: string
}

const rootsOf = (config: Config) => config.roots ?? [config.scenariosRoot]

/** 列出已上架剧本（现行正式版）。源损坏且没有留档的不列。 */
export function listStories(config: Config): { id: string; title: string; tagline: string }[] {
  return scanCatalog(rootsOf(config))
    .flatMap(e => (e.story ? [{ id: e.id, title: e.story.title, tagline: e.story.tagline }] : []))
}

/** 某剧本现行正式版所在目录与原文；id 不合法或不存在返回 undefined。 */
function currentOf(config: Config, id: string): { dir: string; raw: string } | undefined {
  if (!isStoryId(id)) return undefined
  const entry = scanCatalog(rootsOf(config)).find(e => e.id === id)
  if (!entry) return undefined
  const file = path.join(entry.dir, 'story.json')
  return existsSync(file) ? { dir: entry.dir, raw: readFileSync(file, 'utf8') } : undefined
}

/** 读取某剧本的现行正式版全文；id 不合法或不存在返回 undefined。 */
export function readStory(config: Config, id: string): Record<string, unknown> | undefined {
  const current = currentOf(config, id)
  if (!current) return undefined
  try {
    return JSON.parse(current.raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * 发布写到哪个目录：这部剧本已经住在数据卷里就写回原处（目录名不一定等于 id），
 * 否则按约定 `scenarios/<去掉 story- 的 id>/`。同一个根里两个目录声明同一 id，目录扫描的胜负就看 readdir 顺序了。
 */
export function storyDirOf(config: Config, id: string): string {
  const current = currentOf(config, id)
  const conventional = path.join(config.scenariosRoot, id.replace(/^story-/, ''))
  if (current && path.resolve(path.dirname(current.dir)) === path.resolve(config.scenariosRoot)) return current.dir
  return conventional
}

export interface PublishResult {
  ok: boolean
  id?: string
  title?: string
  issues?: { path: string; message: string }[]
  /** 写法体检的提醒（不影响 ok；见 craftWarnings） */
  warnings?: string[]
  brief: string
}

const KEEP_VERSIONS = 10

/**
 * 发布时的写法体检：**不拦截发布**，只把"写了也不会生效"的地方指名报出来。
 *
 * 实证依据（desire-era 12 回合逐条核对）：18 条 rules 里，
 * 「每次性场景结束必须落账」这类**机械条件**执行 5/5 精确，连"进行中不算结束"都分得清；
 * 「当写到据点内部生活或日常场景时」这类**判断条件** 0/2 全跳过——盘点仓库、检修布防
 * 两个回合都发生在岛上，GM 判定"这是办正事不算日常"，于是整条不触发。
 * 两条都在同一份 persona 里全量注入，位置更靠前的那条反而失灵：
 * **GM 不是没看见，是条件判定失败**。规则数量不是风险，判断余地才是。
 *
 * 纯字符串匹配，零 LLM。宁可漏报不误报——误报会让作者学会忽略它。
 */
const VAGUE_TRIGGERS = [
  '适当', '适度', '适时', '恰当', '酌情', '视情况', '看情况',
  '尽量', '尽可能', '必要时', '需要时', '重要时', '日常时', '有必要时',
  '氛围到位', '合适的时候', '合适时', '该出现时', '值得时',
]

/**
 * 人物设定里的现在时：把后期状态写进初始设定，等于提前剧透 + 时序错位。
 * 光看时间词会误报——"前顶流偶像，**如今**素面朝天"对比的是末世前后，是正常写法；
 * "**现在**她是据点防务的头儿"才是问题。所以要求时间词与**归属/职位**词共现。
 */
const TENSE_WORDS = ['现在', '如今', '目前']
const BELONGING_WORDS = [
  '据点', '岛上', '防务', '掌管', '管着', '负责', '头儿', '首领', '老大',
  '成员', '家人', '加入', '投靠', '麾下', '手下', '归顺', '效忠',
]

/** 逐条体检，返回人类可读的提醒行；一切正常返回空数组。 */
export function craftWarnings(story: Story): string[] {
  const notes: string[] = []
  const scan = (text: string, where: string) => {
    const hit = VAGUE_TRIGGERS.filter(w => text.includes(w))
    if (hit.length) {
      notes.push(
        `${where}：出现「${hit.join('」「')}」——触发条件是性质判断，GM 会判定"这次不算"从而整条跳过。`
        + '改成一句能查证的事实（位置、次数、状态、阶段），比如"只要人在岛上"而不是"日常场景时"。',
      )
    }
  }
  story.craft.rules.forEach((r, i) => scan(r, `craft.rules[${i}]`))
  if (story.craft.reminder) scan(story.craft.reminder, 'craft.reminder')
  story.acts.forEach((a, i) => {
    if (a.reminder) scan(a.reminder, `acts[${i}].reminder`)
  })
  for (const c of story.cast) {
    const hit = TENSE_WORDS.filter(w => c.identity.includes(w))
    const belongs = BELONGING_WORDS.some(w => c.identity.includes(w))
    if (hit.length && belongs) {
      notes.push(
        `cast.${c.id}.identity：出现「${hit.join('」「')}」——人物设定用现在时写后期状态，`
        + 'GM 从第一幕起就会按终态写他/她（时序错位，还等于提前剧透）。'
        + '初始设定只写初遇时的样子，归顺、加入、转变之后的身份留给锚点去兑现。',
      )
    }
  }
  return notes
}

/** 结构体量指纹：覆盖发布前后对比用，防止模型复述全文时静默丢内容。 */
function shapeOf(story: unknown): { acts: number; anchors: number; cast: number; resources: number; rules: number; chars: number } {
  const s = story as {
    acts?: { anchors?: unknown[] }[]
    cast?: unknown[]
    mechanics?: { resources?: unknown[] }
    craft?: { rules?: unknown[] }
  }
  return {
    acts: s.acts?.length ?? 0,
    anchors: (s.acts ?? []).reduce((n, a) => n + (a.anchors?.length ?? 0), 0),
    cast: s.cast?.length ?? 0,
    resources: s.mechanics?.resources?.length ?? 0,
    rules: s.craft?.rules?.length ?? 0,
    chars: JSON.stringify(story).length,
  }
}

const shapeBrief = (s: ReturnType<typeof shapeOf>): string =>
  `幕×${s.acts}、锚点×${s.anchors}、人物×${s.cast}、资源×${s.resources}、工艺规则×${s.rules}、全文 ${s.chars} 字符`

/** 覆盖发布的历史留档：旧正式版存进剧本源目录 versions/，只保留最近 N 版。 */
export function versionsDirOf(config: Config, id: string): string {
  return path.join(storyDirOf(config, id), 'versions')
}

export function listVersions(config: Config, id: string): { name: string; savedAt: number; chars: number }[] {
  if (!isStoryId(id)) return []
  const dir = versionsDirOf(config, id)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map((f) => {
      const p = path.join(dir, f)
      const text = readFileSync(p, 'utf8')
      const saved = Number(f.replace(/\.json$/, '').replace(/^v-/, ''))
      return { name: f, savedAt: Number.isFinite(saved) ? saved : 0, chars: text.length }
    })
    .sort((a, b) => b.savedAt - a.savedAt)
}

function snapshotCurrent(config: Config, id: string): void {
  const current = currentOf(config, id)
  if (!current) return
  const dir = versionsDirOf(config, id)
  mkdirSync(dir, { recursive: true })
  // 同毫秒内的连续发布不许互相覆盖留档
  let stamp = Date.now()
  while (existsSync(path.join(dir, `v-${stamp}.json`))) stamp += 1
  writeFileSync(path.join(dir, `v-${stamp}.json`), current.raw)
  for (const stale of listVersions(config, id).slice(KEEP_VERSIONS)) {
    rmSync(path.join(dir, stale.name), { force: true })
  }
}

/**
 * 发布逻辑本体（纯出入参，供工具与测试共用）。可选键不给就整个省略。
 *
 * 两道防护（GM 改剧本不能改坏）：
 * 1. 覆盖发布前把旧正式版快照进 versions/（保留最近 10 版，可回滚）；
 * 2. 缩水防线——新版比旧版少了幕/锚点/人物/资源/规则，或全文缩水超过两成，
 *    默认拒绝：模型复述全文时最常见的事故就是静默丢内容。确为玩家要求的删减，
 *    带 force 重发一次即可通过。
 */
export function publishStory(config: Config, storyInput: unknown, opts?: { force?: boolean }): PublishResult {
  const parsed = storySchema.safeParse(storyInput)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }))
    return {
      ok: false,
      issues,
      brief: `校验失败 ${issues.length} 处，逐条修正后重新发布：\n`
        + issues.map(i => `- ${i.path}：${i.message}`).join('\n'),
    }
  }
  const story = parsed.data
  const previous = readStory(config, story.id)
  if (previous && !opts?.force) {
    const before = shapeOf(previous)
    const after = shapeOf(story)
    const shrunk
      = after.acts < before.acts || after.anchors < before.anchors || after.cast < before.cast
        || after.resources < before.resources || after.rules < before.rules
        || after.chars < before.chars * 0.8
    if (shrunk) {
      return {
        ok: false,
        id: story.id,
        brief: '发布被缩水防线拦下（未写入任何内容）：\n'
          + `- 现行版：${shapeBrief(before)}\n- 新版本：${shapeBrief(after)}\n`
          + '整读改写最常见的事故是复述时静默丢内容。逐项核对：少掉的部分确实是玩家要求删的吗？'
          + '如确认无误，用 confirm_shrink: true 重新发布；如不是，找回丢失的内容后再发。',
      }
    }
  }
  if (previous) snapshotCurrent(config, story.id)
  const dir = storyDirOf(config, story.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'story.json'), JSON.stringify(story, null, 2))
  const warnings = [...craftWarnings(story), ...missingLexicons(config, story)]
  return {
    ok: true,
    id: story.id,
    title: story.title,
    ...warnings.length ? { warnings } : {},
    brief: `《${story.title}》已发布（id：${story.id}，${shapeBrief(shapeOf(story))}）。`
      + '告诉玩家：回到剧本库即可看到并开始游戏。后续想改，直接在这里说，改完重新发布即可。'
      + (previous ? '旧版已自动留档，剧本详情页可回滚。' : '')
      + (warnings.length
        ? `\n\n写法体检（已发布，不影响开局；但这些地方 GM 大概率不会照做）：\n${warnings.map(w => `- ${w}`).join('\n')}`
        : ''),
  }
}

/**
 * 剧本引用了还没导入的词库：不拦截（词库可以后导入），但要说出来——
 * 不说的后果是作者以为 GM 拿到了词库，其实这一段在固定前缀里根本不存在。
 */
function missingLexicons(config: Config, story: Story): string[] {
  if (!config.lexiconsRoot) return []
  const root = config.lexiconsRoot
  return (story.craft.lexicons ?? [])
    .filter(id => !readLexicon(root, id))
    .map(id => `craft.lexicons：词库「${id}」还没导入平台（或文件坏了）——导入之前 GM 看不到它。去剧本库 → 词库导入。`)
}

/** 只校验不发布（可视化编辑器保存前的检查）：schema 错误逐条返回；通过时带写法体检与词库核对的提醒。 */
export function checkStory(config: Config, storyInput: unknown): Pick<PublishResult, 'ok' | 'issues' | 'warnings'> {
  const parsed = storySchema.safeParse(storyInput)
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(i => ({ path: i.path.join('.') || '(root)', message: i.message })) }
  }
  const warnings = [...craftWarnings(parsed.data), ...missingLexicons(config, parsed.data)]
  return { ok: true, ...warnings.length ? { warnings } : {} }
}

/** 工坊对话的三件工具。只给工坊会话与修改对话，游戏会话永远拿不到。 */
export function workshopTools(config: Config, onPublished?: (id: string) => void): AgentTool[] {
  return [
    {
      def: toolDef('list_stories', '列出平台上已发布的全部剧本（id、标题、一句话简介）。玩家想改已有剧本却没说清是哪部时先用它。', {
        type: 'object',
        properties: {},
      }),
      run: () => {
        const stories = listStories(config)
        return Promise.resolve({
          text: stories.length === 0
            ? '平台上还没有剧本。'
            : stories.map(s => `- ${s.id}《${s.title}》——${s.tagline}`).join('\n'),
        })
      },
    },
    {
      def: toolDef('read_story', '读取某剧本的现行正式版全文（含 GM 侧暗线）。修改已有剧本前必须先读它——'
        + '拿到全文后按玩家要求修改，再用 publish_story 同 id 发布即为覆盖更新。', {
        type: 'object',
        properties: { id: { type: 'string', description: '剧本 id（story-xxx）' } },
        required: ['id'],
      }),
      run: (args) => {
        const story = readStory(config, String(args.id ?? ''))
        // 全文直接给模型：修改剧本必须基于现行正式版原文
        return Promise.resolve({
          text: story
            ? `现行正式版全文如下（改完用 publish_story 同 id 发布）：\n${JSON.stringify(story, null, 2)}`
            : '没有这个剧本 id。先用 list_stories 看看现有剧本。',
        })
      },
    },
    {
      def: toolDef('publish_story', '发布剧本：校验 story 对象，写入剧本库，立即可玩。'
        + '访谈内容全部确认后调用；校验失败会返回逐条错误，按错误修正后重新发布即可。'
        + '同 id 重复发布是覆盖更新（剧本永远只有一个现行正式版；旧版自动留档，可在剧本详情页回滚）。'
        + '覆盖发布有缩水防线：新版比现行版少了幕/锚点/人物/资源/规则或全文明显变短会被拦下——'
        + '先逐项核对少掉的是不是玩家要求删的，确认无误才带 confirm_shrink: true 重发。', {
        type: 'object',
        properties: {
          story: { type: 'object', description: '完整的 taleforge.story.v1.1 剧本对象' },
          confirm_shrink: { type: 'boolean', description: '仅在缩水防线拦下、且已逐项确认删减确为玩家要求后传 true' },
        },
        required: ['story'],
      }),
      run: (args) => {
        const result = publishStory(config, args.story, { force: args.confirm_shrink === true })
        if (result.ok && result.id) onPublished?.(result.id)
        const meta: Record<string, unknown> = { kind: 'workshop/publish', ok: result.ok }
        if (result.id) meta.id = result.id
        return Promise.resolve({ text: result.brief, meta })
      },
    },
  ]
}
