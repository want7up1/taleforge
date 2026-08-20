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
  /**
   * 分幕贴身提醒（可选，≤600 字）：本幕进行期间替换 craft.reminder 随回合头注入。
   * 用于世界状态/文风随剧情阶段变化的剧本——每幕只注入当前幕的那段，未到的幕玩家
   * 与 GM 生成点都看不到（天然防剧透）。没写的幕回落到 craft.reminder。
   */
  reminder: z.string().min(1).max(600).optional(),
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
  /**
   * 机制货架的选调——四件套各自显式声明，声明哪个挂哪个；省略整段即纯叙事。
   * 每个模块的 guidance 直接进 GM 提示词，用机械规则写（给类型、给数字），
   * 别写"该记的时候记"。
   */
  mechanics: z
    .object({
      /** 资源条：随剧情涨落的数值（好感、体力、物资……） */
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
        /** 什么情况加减多少、各区段含义——数值必须自带含义 */
        guidance: z.string().min(1),
        /**
         * 显示位置（平台枚举，剧本选位）：strip=顶栏常驻，panel=卷宗面板，
         * hidden=只记账不展示（GM 可见玩家不可见）。缺省：self 组进 strip，其余 panel。
         */
        display: z.enum(['strip', 'panel', 'hidden']).optional(),
        /**
         * 防剧透门控：绑定一个 cast id，该人物在正文中出场之前，这条资源
         * （连同其结算记录）对玩家不可见。未出场人物的好感条就是剧透。
         */
        revealWith: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      })).min(1).optional(),
      /** 属性表：变动稀少的能力值，判定自动引用作修正 */
      attributes: z.array(z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        label: z.string().min(1),
        initial: z.number().int(),
        min: z.number().int().default(0),
        max: z.number().int().default(20),
        /** 属性变动稀少，单步默认 1 */
        maxStep: z.number().int().positive().default(1),
        /** 这条属性衡量什么、什么剧情事件才配让它变动 */
        guidance: z.string().min(1),
      })).min(1).optional(),
      /** 判定（骰子）：成败不确定的行动交给代码掷骰裁决 */
      checks: z.object({
        die: z.enum(['d20', 'd100', '2d6']).default('d20'),
        /** 何时必须掷、难度分几档各是多少——机械规则 */
        guidance: z.string().min(1),
      }).optional(),
      /** 侧栏分组标题自定义；不声明用平台默认（你/她们/世界） */
      groups: z.object({
        self: z.string().min(1).optional(),
        affinity: z.string().min(1).optional(),
        world: z.string().min(1).optional(),
      }).optional(),
      /** 物品栏：id 引用 + 纯 upsert */
      inventory: z.object({
        /** 什么算需要入账的物品、什么不算（机械规则） */
        guidance: z.string().min(1),
        initial: z.array(z.object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          name: z.string().min(1),
          qty: z.number().int().positive().default(1),
          note: z.string().optional(),
        })).default([]),
      }).optional(),
    })
    .refine(m => m.resources || m.attributes || m.checks || m.inventory, '声明了 mechanics 就至少要启用一个模块')
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
    /**
     * 贴身提醒：BFF 随每回合注入到生成点旁，效力压过长局文风惯性。
     * 写"每回合必须坚持、且模型容易在长局里漂移"的要求；内容全由剧本定（平台不携带强度）。
     * 上限 600 字——贴身的前提是短。
     */
    reminder: z.string().min(1).max(600).optional(),
  }),
})

export type Story = z.infer<typeof storySchema>
export type Act = z.infer<typeof actSchema>
export type CraftModule = (typeof craftModuleNames)[number]
