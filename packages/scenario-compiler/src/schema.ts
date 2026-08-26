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
  /**
   * 本幕的节奏容忍度：连续多少个正戏回合没有主线进展，平台才开始在进度简报里加压
   * （两倍即进高档：要求行动选项 A 必须是主线前进位）。缺省 4。
   *
   * **慢热的幕要把它写大。** 平台拿一个固定阈值催所有剧本，等于替剧本决定"多慢算慢"：
   * 序幕本来就该花十几个回合铺人物与日常，默认阈值会把它催成速通（实测发生过）。
   */
  pace: z.number().int().positive().optional(),
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
      /**
       * 周期收支（可选）：每个正戏回合由**代码**自动结算一次，GM 一个数字都不用记。
       * 每天的口粮消耗、灯油折耗这类纯机械规则本就属于代码权威那一侧——交给 GM 逐条报数，
       * 既会漏（实测整回合漏调 report_progress 占 6%），又白白挤占它写正文的注意力。
       *
       * 作物生长也用它表达，不必另造计时器：把"麦苗"做成一条 0–3 的资源，
       * 声明 `{ id: 'crop', delta: 1, activeAbove: 0 }`，GM 播种时把它设成 1，
       * 之后每回合自动 +1，到 3 即可收割——玩家在面板上也直接看得见进度。
       */
      upkeep: z.array(z.object({
        /** 资源 id，必须是本剧本已声明的条目 */
        id: z.string(),
        /** 每个正戏回合的变化量（负数为消耗） */
        delta: z.number().int(),
        /** 落账理由，也会出现在给 GM 的回执里 */
        reason: z.string().min(1),
        /** 只在当前值大于此数时才滚动；用于"种下之后才生长"这类条件 */
        activeAbove: z.number().int().optional(),
        /** 显示名（可省，编译时自动从资源定义补上） */
        label: z.string().optional(),
      })).max(20).optional(),
      resources: z.array(z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/, '资源 id 为 kebab-case，可带一个冒号命名空间（如 evolution、desire-suwan、affinity:suwan）'),
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
      /**
       * 经验与等级：GM 按 guidance 上报经验（代码裁单次上限），等级与属性点由代码按阈值表
       * 裁定，属性点由玩家自行分配（加点随下一步行动进回合，GM 只能原样落账）。需同时声明 attributes。
       */
      progression: z.object({
        /** 经验值的显示名 */
        label: z.string().min(1).default('经验'),
        /** 什么事件给多少经验——机械规则，给数字 */
        guidance: z.string().min(1),
        /** 单回合经验变动上限 */
        maxStep: z.number().int().positive(),
        /** 升到 2、3、…级各需累计多少经验；表长 + 1 = 最高等级 */
        thresholds: z.array(z.number().int().positive()).min(1)
          .refine(t => t.every((v, i) => i === 0 || v > t[i - 1]), '阈值必须严格递增'),
        /** 每升一级发放的属性点 */
        pointsPerLevel: z.number().int().positive(),
        /**
         * 剧情奖励属性点的单次上限（grant_xp 的 points 参数）：GM 按 guidance 发放，进同一个
         * 待分配池由玩家自己加点。0（缺省）= 不开放剧情奖励点，属性只靠升级点成长。
         */
        bonusPointsMax: z.number().int().nonnegative().default(0),
        /** 各级显示名（C/B/A/S…），长度须等于阈值数 + 1；不给则显示 Lv.N */
        levelNames: z.array(z.string().min(1)).optional(),
        /** 显示位置：strip 顶栏（缺省）/ panel 只进卷宗 */
        display: z.enum(['strip', 'panel']).optional(),
      })
        .refine(p => !p.levelNames || p.levelNames.length === p.thresholds.length + 1, 'levelNames 长度必须等于 thresholds 长度 + 1（每级一个名字）')
        .optional(),
    })
    .refine(m => m.resources || m.attributes || m.checks || m.inventory, '声明了 mechanics 就至少要启用一个模块')
    .refine(m => !m.progression || m.attributes, '经验等级需要同时声明 attributes——属性点要加在属性上')
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
    /**
     * 每回合行动块给几个选项（2–4，缺省 4）。上限 4 是硬的：字母 E 留给"自由输入"这个固定按键。
     * 但**下限不该由平台定**——聚焦的悬疑或高压场面，三个选项比四个更有力，
     * 凑第四个只会凑出"再看看情况"这类空话。
     */
    action_options: z.number().int().min(2).max(4).default(4),
    /**
     * 正文里能不能直接出现机制数字与机制词（"力量 +5"、"好感度 80"、掷骰点数、等级与经验）。
     *
     * 缺省 false：数值变化写成可感的情节，数字交给面板与卡片呈现。**但这是文风不是结构**——
     * 系统流、面板流那一类剧本要的恰恰是正文里跳出数字，平台不该替它们决定。
     * 声明 true 的剧本，机制面板、判定、经验三处的"不出现数字"一并解除。
     */
    numbers_in_prose: z.boolean().default(false),
    /** 本剧本自带的工艺指令。剧本对"怎么写"有绝对自由度。 */
    rules: z.array(z.string()).default([]),
    /**
     * 贴身提醒：BFF 随每回合注入到生成点旁，效力压过长局文风惯性。
     * 写"每回合必须坚持、且模型容易在长局里漂移"的要求；内容全由剧本定（平台不携带强度）。
     * 上限 600 字——贴身的前提是短。
     */
    reminder: z.string().min(1).max(600).optional(),
    /**
     * 强度词表（可选）：剧本自己声明的直白用词。平台只按回合数命中数——连续几回合
     * 一次都不出现，就把这个事实贴回生成点（长局里正文先例会压过 rating 声明，
     * 实测 41 回合局全程规避词表，而干净上下文里首回合就照写）。
     * 平台永不判断内容、永不携带强度：写什么词、写多深，全由剧本定。
     */
    intensity_words: z.array(z.string().min(1)).max(60).optional(),
  }),
})

export type Story = z.infer<typeof storySchema>
export type Act = z.infer<typeof actSchema>
export type CraftModule = (typeof craftModuleNames)[number]
