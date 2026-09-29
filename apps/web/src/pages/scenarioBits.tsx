/** 剧本信息的小件：工艺模块名、机制摘要。 */
import type { StoryDetail } from '../types.ts'

export const MODULE_NAME: Record<string, string> = {
  standard: '标准叙事',
  shuang: '爽文',
  harem: '关系与张力',
  hardcore: '硬核',
}

export function mechanicsSummary(story: StoryDetail): string[] {
  const m = story.mechanics
  if (!m) return []
  return [
    m.resources?.length ? `资源条 ×${m.resources.length}` : '',
    m.attributes?.length ? `属性 ×${m.attributes.length}` : '',
    m.checks ? `掷骰判定（${m.checks.die ?? 'd20'}）` : '',
    m.inventory ? `物品栏（初始 ${m.inventory.initial?.length ?? 0} 件）` : '',
    m.progression ? `经验等级（满级 ${(m.progression.thresholds?.length ?? 0) + 1}）` : '',
  ].filter(Boolean)
}
