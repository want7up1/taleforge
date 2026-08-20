/**
 * 工坊插件：只挂在 workshop preset 上，玩家剧本 preset 永不挂载（它会写文件系统）。
 *
 * publish_story 是访谈的出口：校验 → 写进数据卷 scenarios/ → 立即编译成可玩 preset。
 * 校验失败把逐条错误退回给工坊 agent 自行修正——闭环在工具内完成，不经人手。
 * 写入路径由剧本 id 决定（schema 强制 story- 前缀 + kebab-case，天然无路径穿越）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compileScenario, storySchema, type PluginEntries } from '@taleforge/scenario-compiler'

const STORY_ID = /^story-[a-z0-9][a-z0-9-]*$/

/** 列出已发布剧本（读编译产出：那里放着每部剧本的现行正式版快照）。 */
export function listStories(presetsRoot: string): { id: string; title: string; tagline: string }[] {
  if (!existsSync(presetsRoot)) return []
  const out: { id: string; title: string; tagline: string }[] = []
  for (const entry of readdirSync(presetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STORY_ID.test(entry.name)) continue
    const storyPath = path.join(presetsRoot, entry.name, 'story.json')
    if (!existsSync(storyPath)) continue
    try {
      const s = JSON.parse(readFileSync(storyPath, 'utf8')) as { id: string; title: string; tagline: string }
      out.push({ id: s.id, title: s.title, tagline: s.tagline })
    } catch {
      // 坏文件跳过，不让一个损坏的剧本拖垮列表
    }
  }
  return out
}

/** 读取某剧本的现行正式版全文；id 不合法或不存在返回 undefined。 */
export function readStory(presetsRoot: string, id: string): Record<string, unknown> | undefined {
  if (!STORY_ID.test(id)) return undefined
  const storyPath = path.join(presetsRoot, id, 'story.json')
  if (!existsSync(storyPath)) return undefined
  return JSON.parse(readFileSync(storyPath, 'utf8')) as Record<string, unknown>
}

export interface Config {
  /** 用户内容根（数据卷）：工坊产出与修订落盘都写这里 */
  scenariosRoot: string
  /** dsh preset 根 */
  presetsRoot: string
  /** 游戏插件入口，传给编译器 */
  entries?: PluginEntries
}

export const name = 'taleforge-workshop'
export const inject = ['tools']

export interface PublishResult {
  ok: boolean
  id?: string
  title?: string
  issues?: { path: string; message: string }[]
  brief: string
}

const KEEP_VERSIONS = 10

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
  return path.join(config.scenariosRoot, id.replace(/^story-/, ''), 'versions')
}

export function listVersions(config: Config, id: string): { name: string; savedAt: number; chars: number }[] {
  const dir = versionsDirOf(config, id)
  if (!STORY_ID.test(id) || !existsSync(dir)) return []
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
  const currentPath = path.join(config.presetsRoot, id, 'story.json')
  if (!existsSync(currentPath)) return
  const dir = versionsDirOf(config, id)
  mkdirSync(dir, { recursive: true })
  // 同毫秒内的连续发布不许互相覆盖留档
  let stamp = Date.now()
  while (existsSync(path.join(dir, `v-${stamp}.json`))) stamp += 1
  writeFileSync(path.join(dir, `v-${stamp}.json`), readFileSync(currentPath, 'utf8'))
  for (const stale of listVersions(config, id).slice(KEEP_VERSIONS)) {
    rmSync(path.join(dir, stale.name), { force: true })
  }
}

/**
 * 发布逻辑本体（纯出入参，供工具与测试共用）。undefined 键整个省略（dsh 无损 JSON 约束）。
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
  const previous = readStory(config.presetsRoot, story.id)
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
  const dir = path.join(config.scenariosRoot, story.id.replace(/^story-/, ''))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'story.json'), JSON.stringify(story, null, 2))
  compileScenario(dir, config.presetsRoot, config.entries)
  return {
    ok: true,
    id: story.id,
    title: story.title,
    brief: `《${story.title}》已发布并编译（id：${story.id}，${shapeBrief(shapeOf(story))}）。`
      + '告诉玩家：回到剧本库即可看到并开始游戏。后续想改，直接在这里说，改完重新发布即可。'
      + (previous ? '旧版已自动留档，剧本详情页可回滚。' : ''),
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'list_stories',
    description: '列出平台上已发布的全部剧本（id、标题、一句话简介）。玩家想改已有剧本却没说清是哪部时先用它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                tagline: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.stories as { id: string; title: string; tagline: string }[]).length === 0
          ? '平台上还没有剧本。'
          : (value.stories as { id: string; title: string; tagline: string }[])
              .map(s => `- ${s.id}《${s.title}》——${s.tagline}`)
              .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    execute() {
      return Promise.resolve({ stories: listStories(config.presetsRoot) })
    },
    presentCall: () => ({ card: 'generic', title: '查看剧本库', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'read_story',
    description: '读取某剧本的现行正式版全文（含 GM 侧暗线）。修改已有剧本前必须先读它——'
      + '拿到全文后按玩家要求修改，再用 publish_story 同 id 发布即为覆盖更新。',
    parameters: {
      id: { type: 'string', required: true, description: '剧本 id（story-xxx）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          story: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      // 全文直接给模型：修改剧本必须基于现行正式版原文
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `现行正式版全文如下（改完用 publish_story 同 id 发布）：\n${JSON.stringify(value.story, null, 2)}`
          : '没有这个剧本 id。先用 list_stories 看看现有剧本。',
      }],
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const story = readStory(config.presetsRoot, String(args.id ?? ''))
      // story 来自 JSON.parse，天然是 JsonValue；TS 推不出，这里断言过桥
      if (!story) return Promise.resolve({ found: false })
      return Promise.resolve({ found: true, story: story as never })
    },
    presentCall: () => ({ card: 'generic', title: '载入剧本', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'publish_story',
    description: '发布剧本：校验 story 对象，写入剧本库并编译成可玩的游戏。'
      + '访谈内容全部确认后调用；校验失败会返回逐条错误，按错误修正后重新发布即可。'
      + '同 id 重复发布是覆盖更新（剧本永远只有一个现行正式版；旧版自动留档，可在剧本详情页回滚）。'
      + '覆盖发布有缩水防线：新版比现行版少了幕/锚点/人物/资源/规则或全文明显变短会被拦下——'
      + '先逐项核对少掉的是不是玩家要求删的，确认无误才带 confirm_shrink: true 重发。',
    parameters: {
      story: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: '完整的 taleforge.story.v1 剧本对象',
        properties: {},
      },
      confirm_shrink: {
        type: 'boolean',
        description: '仅在缩水防线拦下、且已逐项确认删减确为玩家要求后传 true',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          title: { type: 'string' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          brief: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { brief: string }).brief }],
    },
    execute(args) {
      return Promise.resolve(publishStory(config, args.story, { force: args.confirm_shrink === true }))
    },
    presentCall: () => ({ card: 'generic', title: '发布剧本', kind: 'other' }),
  }))
}
