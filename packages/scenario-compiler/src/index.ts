/**
 * 剧本编译器：剧本源目录（story.json [+ skills/]）→ dsh agent preset 目录。
 * preset 发现无缓存，写入 $DSH_HOME/.agent-presets/<id>/ 后新会话立即可用。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'
import { renderPersona } from './persona.ts'
import { storySchema, type Story } from './schema.ts'

export { applyRevisionsToStory, type MergeResult, type RevisionLike } from './merge.ts'
export { renderPersona } from './persona.ts'
export { craftModuleNames, storySchema, type Story } from './schema.ts'
export { compileWorkshopPreset } from './workshop.ts'

export interface CompileResult {
  id: string
  title: string
  presetDir: string
  /** 源已删除，该 preset 被回收 */
  removed?: boolean
}

export function loadStory(storyDir: string): Story {
  const raw = readFileSync(path.join(storyDir, 'story.json'), 'utf8')
  return storySchema.parse(JSON.parse(raw))
}

/** 平台插件入口的绝对路径——preset 组合文件不支持动态求值，跨机器差异只能在生成时写死。 */
export interface PluginEntries {
  /** 机制引擎（资源条等），仅剧本声明了 mechanics 时挂载 */
  mechanics?: string
  /** 幕进度引擎（底座能力，所有剧本都挂） */
  progress?: string
}

/** 编译单个剧本目录到 presetsRoot（幂等：整目录重建）。 */
export function compileScenario(
  storyDir: string,
  presetsRoot: string,
  entries?: PluginEntries,
): CompileResult {
  const story = loadStory(storyDir)
  const presetDir = path.join(presetsRoot, story.id)

  rmSync(presetDir, { recursive: true, force: true })
  mkdirSync(presetDir, { recursive: true })

  writeFileSync(
    path.join(presetDir, 'preset.yml'),
    stringify({ name: story.title, description: story.tagline }),
  )

  // persona 即完整 system prompt；玩家会话只挂机制工具，绝不挂 bash/fs 等执行类工具
  const composition: unknown[] = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        text: renderPersona(story),
        complete: true,
        includeRuntimeContext: false,
      },
    },
  ]

  if (entries?.progress) {
    composition.push({
      id: 'progress',
      name: entries.progress,
      config: {
        acts: story.acts,
        cast: story.cast.map(c => ({ id: c.id, name: c.name })),
        // 数值条目名录：供场外修订（resource/attribute 目标）的校验、显示与边界联动提醒
        numeric: {
          resources: story.mechanics?.resources?.map(r => ({ id: r.id, label: r.label, maxStep: r.maxStep })) ?? [],
          attributes: story.mechanics?.attributes?.map(a => ({ id: a.id, label: a.label, maxStep: a.maxStep })) ?? [],
        },
      },
    })
  }

  if (story.mechanics && entries?.mechanics) {
    composition.push({
      id: 'mechanics',
      name: entries.mechanics,
      // 整段声明原样交给机制引擎，声明哪个模块就注册哪个模块
      config: story.mechanics,
    })
  }

  writeFileSync(path.join(presetDir, 'agent.cordis.yml'), stringify(composition))

  // 剧本源随 preset 存一份，供列表/工坊回读
  writeFileSync(path.join(presetDir, 'story.json'), JSON.stringify(story, null, 2))

  const skillsDir = path.join(storyDir, 'skills')
  if (existsSync(skillsDir)) {
    cpSync(skillsDir, path.join(presetDir, 'skills'), { recursive: true })
  }

  return { id: story.id, title: story.title, presetDir }
}

/**
 * 把剧本源同步到 presetsRoot：编译现存的，清理源里已删除的。
 * 只回收 story- 前缀的目录——那是本编译器的产出，其余 preset 一律不碰。
 *
 * 支持多个源根，后者同 id 覆盖前者——仓库 presets/ 是内置种子，
 * 数据卷 scenarios/ 是用户内容（工坊产出、修订落盘），数据卷优先。
 */
export function compileAll(
  sourceRoots: string | string[],
  presetsRoot: string,
  entries?: PluginEntries,
): CompileResult[] {
  const roots = Array.isArray(sourceRoots) ? sourceRoots : [sourceRoots]
  const byId = new Map<string, CompileResult>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const storyDir = path.join(root, entry.name)
      if (!existsSync(path.join(storyDir, 'story.json'))) continue
      const result = compileScenario(storyDir, presetsRoot, entries)
      byId.set(result.id, result)
    }
  }
  const results = [...byId.values()]

  if (existsSync(presetsRoot)) {
    const live = new Set(results.map(r => r.id))
    for (const entry of readdirSync(presetsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('story-') || live.has(entry.name)) continue
      rmSync(path.join(presetsRoot, entry.name), { recursive: true, force: true })
      results.push({ id: entry.name, title: '', presetDir: '', removed: true })
    }
  }

  return results
}
