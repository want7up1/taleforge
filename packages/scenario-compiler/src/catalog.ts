/**
 * 剧本目录：扫描剧本源根，得到每部剧本的现行正式版。
 *
 * 双源根：仓库 presets/ 是内置种子，数据卷 scenarios/ 是用户内容（工坊产出、修订落盘），
 * 后者同 id 覆盖前者。剧本永远只有一个现行正式版——就是它目录下的 story.json。
 *
 * 坏源不拖垮整批：JSON 坏了或过不了 schema 的剧本，退回它 versions/ 里最近一份能读的留档
 * （标记 degraded），好让玩家还能在详情页看到它、回滚或删除；连留档都没有的只报错不上架。
 * 这里是 BFF 的启动路径，抛出去就是容器无限重启，连修它的界面都打不开。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { storySchema, type Story } from './schema.ts'

export interface CatalogEntry {
  id: string
  /** 剧本源目录（story.json 所在处） */
  dir: string
  /** 现行正式版；源损坏时是最近一份能读的留档，再没有就缺省 */
  story?: Story
  /** 源损坏的原因（此时 story 若在，来自留档） */
  failed?: string
  /** story 来自留档而不是 story.json */
  degraded?: boolean
}

const STORY_ID = /^story-[a-z0-9][a-z0-9-]*$/

export function isStoryId(id: string): boolean {
  return STORY_ID.test(id)
}

export function loadStory(storyDir: string): Story {
  return storySchema.parse(JSON.parse(readFileSync(path.join(storyDir, 'story.json'), 'utf8')))
}

/** 坏源属于哪个剧本 id：先从原始 JSON 里抢救，抢救不到按目录名推断（publish 按这条约定写）。 */
function salvageId(storyDir: string, dirName: string): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(storyDir, 'story.json'), 'utf8')) as { id?: unknown }
    if (typeof raw.id === 'string' && STORY_ID.test(raw.id)) return raw.id
  } catch {
    // JSON 本身就坏了（写盘中断等），回落目录名
  }
  return `story-${dirName}`
}

/** versions/ 里最近一份能过 schema 的留档。 */
function newestGoodVersion(storyDir: string): Story | undefined {
  const dir = path.join(storyDir, 'versions')
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter(f => /^v-\d+\.json$/.test(f))
    .sort((a, b) => Number(b.slice(2, -5)) - Number(a.slice(2, -5)))
  for (const f of files) {
    try {
      return storySchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')))
    } catch {
      // 这一份也坏了，接着往前找
    }
  }
  return undefined
}

/** 扫描全部源根。后面的根同 id 覆盖前面的；同一个根里有两个目录声明同一 id 时，后扫到的赢。 */
export function scanCatalog(roots: readonly string[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      if (!existsSync(path.join(dir, 'story.json'))) continue
      try {
        const story = loadStory(dir)
        byId.set(story.id, { id: story.id, dir, story })
      } catch (err) {
        const id = salvageId(dir, entry.name)
        const fallback = newestGoodVersion(dir)
        byId.set(id, { id, dir, failed: String(err), ...fallback ? { story: fallback, degraded: true } : {} })
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
