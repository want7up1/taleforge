/**
 * 剧本格式 taleforge.story.v0（继承 Rpgforge story.v2 的分幕+锚点骨架，机制声明段在 M2 加入）。
 * 一切引用走 id；schema 冻结发生在 M3。
 */
import { z } from 'zod'

export const anchorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, '锚点 id 需为 kebab-case'),
  text: z.string().min(1),
  required: z.boolean().default(true),
})

export const actSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  objective: z.string().min(1),
  anchors: z.array(anchorSchema).min(1),
  forbidden_reveals: z.array(z.string()).default([]),
})

export const storySchema = z.object({
  format: z.literal('taleforge.story.v0'),
  /** 剧本 id 兼作 dsh agent preset id；story- 前缀是平台识别剧本 preset 的约定。 */
  id: z.string().regex(/^story-[a-z0-9][a-z0-9-]*$/, '剧本 id 必须形如 story-xxx（kebab-case）'),
  title: z.string().min(1),
  tagline: z.string().min(1),
  world: z.object({
    overview: z.string().min(1),
    tone: z.array(z.string()).min(1),
    hidden_truths: z
      .array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), text: z.string().min(1) }))
      .default([]),
  }),
  protagonist: z.object({
    name: z.string().min(1),
    identity: z.string().min(1),
    voice: z.string().optional(),
  }),
  /** 出场人物。name 用于正文中高亮成可点档案；secret 只进 GM 提示词，永不下发前端。 */
  cast: z
    .array(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      name: z.string().min(1),
      identity: z.string().min(1),
      secret: z.string().optional(),
    }))
    .default([]),
  opening: z.object({
    scene: z.string().min(1),
    hook: z.string().min(1),
  }),
  acts: z.array(actSchema).min(1),
  style: z.object({
    /** 调性模板：决定同样的情节写出来是什么味道。 */
    template: z.enum(['shuang', 'hardcore']),
    /** 内容强度声明，直接决定 GM 写到什么程度。 */
    rating: z.string().optional(),
    /** 本剧本特有的写作要求，上限 3 条——多了就该做成调性模板。 */
    extra_rules: z.array(z.string()).max(3).default([]),
  }),
})

export type Story = z.infer<typeof storySchema>
export type Act = z.infer<typeof actSchema>
export type ToneTemplate = Story['style']['template']
