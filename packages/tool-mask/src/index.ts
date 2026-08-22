/**
 * 全局工具遮罩（底座能力，所有玩家 preset 都挂）。
 *
 * 护栏 4 要求玩家会话只看得见机制工具白名单。平台自己的工具（机制/进度/工坊）都注册在
 * preset 作用域，天然只跟着声明走；但 profile 层的第三方插件会往**全局层**注册工具，
 * 而 dsh 的可见性解析链是 `agent → preset → global`，全局层那些会一路漏到玩家回合里。
 * 实测：装上 dsh-plugin-subscriptions 后，baseline 剧本的回合里凭空多出
 * x_search / image_generate / video_generate 三个工具，GM 随时可能拿去搜 X 或生图。
 *
 * `ctx.tools.restrict()` 是 dsh 给的 agent 作用域遮罩，但只管得了全局工具：
 * allow 语义要求列出的名字本身就是全局工具，而我们要留下的全是 preset 作用域的，
 * 所以这里只能用 deny——把当前全局层里的东西逐个挡掉。
 *
 * 逐个调用而不是一次传整个列表：restrict 遇到未注册的名字会抛错，而同一份 preset
 * 要在装了插件和没装插件的机器上都能加载，不能因为某个名字不存在就整个 preset 加载失败。
 */
import type { Context } from '@deepseek-ai/cordis'
// 副作用导入：把 tools 挂上 Context
import '@deepseek-ai/dsh-tools'

export interface Config {
  /** 要从玩家可见范围里挡掉的全局工具名；不存在的名字自动跳过 */
  deny?: string[]
}

export const name = 'taleforge-tool-mask'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const deny = config?.deny ?? []
  if (deny.length === 0) return

  for (const tool of deny) {
    try {
      const lift = ctx.tools.restrict({ deny: [tool] })
      ctx.effect(() => lift, `taleforge-tool-mask: deny ${tool}`)
    } catch {
      // 这台机器上没装注册该工具的插件——本来就不可见，无需遮罩
    }
  }
}
