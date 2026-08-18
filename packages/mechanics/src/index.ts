/**
 * 机制引擎的加载探针。
 * 先只验证一件事：dsh 能否从我们的仓库加载本地插件包——这是整个机制引擎的前提，
 * 打不通就得换挂载方式（绝对路径 / preset 目录内相对路径 / 宿主裸包名）。
 */
import type { Context } from '@deepseek-ai/dsh-tools'

export const name = 'taleforge-mechanics'
export const inject = ['tools']

export function apply(ctx: Context) {
  console.log('[taleforge-mechanics] 插件已加载，tools 服务可用:', Boolean(ctx.tools))
}
