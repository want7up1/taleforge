/**
 * 机制货架：资源条 / 属性表 / 判定 / 物品栏 / 经验等级——全部是纯裁决函数。
 *
 * 链路（v2）：结算步里 GM 报"这一章发生了什么变化" → 这里的函数按剧本声明的边界裁决 →
 * 裁决回执写进会话日志的 settlement 事件 → 投影从日志折叠出当前值。
 * GM 决定加减多少（叙事判断），这里决定实际生效多少（代码权威）；本包不碰 IO、不碰模型。
 */
export * from './check.ts'
export * from './inventory.ts'
export * from './progression.ts'
export * from './resources.ts'
export * from './types.ts'
