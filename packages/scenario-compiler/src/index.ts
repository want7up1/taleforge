/**
 * 剧本编译器：剧本源目录（story.json [+ skills/]）→ dsh agent preset 目录。
 * preset 发现无缓存，写入 $DSH_HOME/.agent-presets/<id>/ 后新会话立即可用。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'
import { renderPersona } from './persona.ts'
import { storySchema, type Story } from './schema.ts'

export { renderPersona } from './persona.ts'
export { storySchema, type Story } from './schema.ts'

export interface CompileResult {
  id: string
  title: string
  presetDir: string
}

export function loadStory(storyDir: string): Story {
  const raw = readFileSync(path.join(storyDir, 'story.json'), 'utf8')
  return storySchema.parse(JSON.parse(raw))
}

/** 编译单个剧本目录到 presetsRoot（幂等：整目录重建）。 */
export function compileScenario(storyDir: string, presetsRoot: string): CompileResult {
  const story = loadStory(storyDir)
  const presetDir = path.join(presetsRoot, story.id)

  rmSync(presetDir, { recursive: true, force: true })
  mkdirSync(presetDir, { recursive: true })

  writeFileSync(
    path.join(presetDir, 'preset.yml'),
    stringify({ name: story.title, description: story.tagline }),
  )

  // 纯叙事 GM：persona 即完整 system prompt，零工具（机制模块行在 M2 按剧本声明追加）
  const composition = [
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
  writeFileSync(path.join(presetDir, 'agent.cordis.yml'), stringify(composition))

  // 剧本源随 preset 存一份，供列表/工坊回读
  writeFileSync(path.join(presetDir, 'story.json'), JSON.stringify(story, null, 2))

  const skillsDir = path.join(storyDir, 'skills')
  if (existsSync(skillsDir)) {
    cpSync(skillsDir, path.join(presetDir, 'skills'), { recursive: true })
  }

  return { id: story.id, title: story.title, presetDir }
}

/** 编译 sourceRoot 下所有含 story.json 的子目录。 */
export function compileAll(sourceRoot: string, presetsRoot: string): CompileResult[] {
  if (!existsSync(sourceRoot)) return []
  const results: CompileResult[] = []
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const storyDir = path.join(sourceRoot, entry.name)
    if (!existsSync(path.join(storyDir, 'story.json'))) continue
    results.push(compileScenario(storyDir, presetsRoot))
  }
  return results
}
