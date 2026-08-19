/**
 * 工坊插件：只挂在 workshop preset 上，玩家剧本 preset 永不挂载（它会写文件系统）。
 *
 * publish_story 是访谈的出口：校验 → 写进数据卷 scenarios/ → 立即编译成可玩 preset。
 * 校验失败把逐条错误退回给工坊 agent 自行修正——闭环在工具内完成，不经人手。
 * 写入路径由剧本 id 决定（schema 强制 story- 前缀 + kebab-case，天然无路径穿越）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compileScenario, storySchema, type PluginEntries } from '@taleforge/scenario-compiler'

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

/** 发布逻辑本体（纯出入参，供工具与测试共用）。undefined 键整个省略（dsh 无损 JSON 约束）。 */
export function publishStory(config: Config, storyInput: unknown): PublishResult {
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
  const dir = path.join(config.scenariosRoot, story.id.replace(/^story-/, ''))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'story.json'), JSON.stringify(story, null, 2))
  compileScenario(dir, config.presetsRoot, config.entries)
  return {
    ok: true,
    id: story.id,
    title: story.title,
    brief: `《${story.title}》已发布并编译（id：${story.id}）。`
      + '告诉玩家：回到剧本库即可看到并开始游戏。后续想改，直接在这里说，改完重新发布即可。',
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'publish_story',
    description: '发布剧本：校验 story 对象，写入剧本库并编译成可玩的游戏。'
      + '访谈内容全部确认后调用；校验失败会返回逐条错误，按错误修正后重新发布即可。'
      + '同 id 重复发布是覆盖更新（剧本永远只有一个现行正式版）。',
    parameters: {
      story: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: '完整的 taleforge.story.v1 剧本对象',
        properties: {},
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
      return Promise.resolve(publishStory(config, args.story))
    },
    presentCall: () => ({ card: 'generic', title: '发布剧本', kind: 'other' }),
  }))
}
