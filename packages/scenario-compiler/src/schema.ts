/**
 * 剧本格式 taleforge.story.v1（2026-08-19 契约定稿）。
 * v0→v1：style 段废除，改为 craft 段显式声明——无隐藏默认，剧本里写了什么 GM 就背了什么；
 * 自带工艺文本无条数上限；锚点增加完成信号（供 F2 进度上报判定用）。
 * 一切声明都是初始种子：运行中可被修订事件覆盖（修订折叠出"现行有效设定"）。
 * 剧本永远只有一个现行正式版；历史版本靠 git 留档。
 */
import { z } from 'zod'

export const anchorSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, '锚点 id 需为 kebab-case'),
  text: z.string().min(1),
  required: z.boolean().default(true),
  /**
   * 完成信号：一句可观察的剧情事实，达成与否尽量少歧义（"玩家吸收了第一枚晶核"，
   * 而不是"玩家变强了"）。GM 每回合对照它上报进度——写得越具体，误报越少。
   */
  signal: z.string().optional(),
})

export const actSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  objective: z.string().min(1),
  anchors: z.array(anchorSchema).min(1),
  forbidden_reveals: z.array(z.string()).default([]),
})

/** 平台工艺货架上的模块名。上新货在 persona.ts 的 CRAFT_MODULES 里加，同时更新此枚举。 */
export const craftModuleNames = ['standard', 'shuang', 'harem', 'hardcore'] as const

export const storySchema = z.object({
  format: z.literal('taleforge.story.v1'),
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
  /** 本剧本启用的资源条；省略即纯叙事，不加载机制引擎。 */
  mechanics: z
    .object({
      resources: z.array(z.object({
        id: z.string().regex(/^[a-z][a-z0-9]*(:[a-z][a-z0-9-]*)?$/, '资源 id 形如 evolution 或 affinity:suwan'),
        label: z.string().min(1),
        group: z.enum(['affinity', 'self', 'world']),
        min: z.number().int(),
        max: z.number().int(),
        initial: z.number().int(),
        /** 下限护栏：可降但不破线 */
        floor: z.number().int().optional(),
        /** 单次调整上限，防止模型让数值失去意义 */
        maxStep: z.number().int().positive(),
        /**
         * 这条资源的语义：什么情况加、什么情况减、不同区段代表什么。
         * 直接进 GM 提示词——数值必须自带含义，否则模型不知道 30 和 70 差在哪。
         * 用机械规则写（给类型、给数字），别写"该加的时候加"。
         */
        guidance: z.string().min(1),
      })).min(1),
    })
    .optional(),
  /**
   * 工艺声明——显式、无隐藏默认。modules 必填（可为空数组 = 只要底座结构保证）；
   * rules 是本剧本自带的工艺指令，无条数上限。同类写法在多个剧本重复时沉淀成新模块。
   */
  craft: z.object({
    /** 从平台货架选用的工艺模块，按声明顺序拼进 persona。 */
    modules: z.array(z.enum(craftModuleNames)),
    /** 内容强度声明，直接决定 GM 写到什么程度。 */
    rating: z.string().optional(),
    /** 本剧本自带的工艺指令。剧本对"怎么写"有绝对自由度。 */
    rules: z.array(z.string()).default([]),
  }),
})

export type Story = z.infer<typeof storySchema>
export type Act = z.infer<typeof actSchema>
export type CraftModule = (typeof craftModuleNames)[number]
