/**
 * 词库的存取（数据卷 lexicons/<id>.json）：网页上新建、编辑、导入导出、回滚、删除；引擎每回合按 id 现读。
 *
 * **平台上的这份就是正本**（2026-09-29 用户改定）：词库在网页上维护，写剧本的 AI 只读（GET）。
 * 所以每次覆盖都先把旧版快照进 lexicons/versions/<id>/，保留最近 10 版，可回滚——改错一次不至于找不回来。
 * 词库不进仓库：仓库是公开的，词库是作者的内容，和剧本一样住在数据卷里。
 * 写入路径由词库 id 决定（schema 强制 kebab-case），天然无路径穿越。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { LEXICON_ID, lexiconSchema, renderLexicon, renderLexicons, type Lexicon } from '@taleforge/scenario-compiler'

export interface LexiconSummary {
  id: string
  title: string
  groups: number
  words: number
  /** 渲染进固定前缀后的字数 */
  chars: number
  /** 文件坏了（JSON 或 schema 过不了）：运行时跳过它，界面照样列出来好删掉或重新导入 */
  failed?: string
}

export interface LexiconSaveResult {
  ok: boolean
  id?: string
  title?: string
  /** 覆盖了同 id 的现行版 */
  replaced?: boolean
  issues?: { path: string; message: string }[]
  brief: string
}

const fileOf = (root: string, id: string) => path.join(root, `${id}.json`)
const KEEP_VERSIONS = 10
export const lexiconVersionsDir = (root: string, id: string) => path.join(root, 'versions', id)

export function lexiconExists(root: string, id: string): boolean {
  return LEXICON_ID.test(id) && existsSync(fileOf(root, id))
}

function parseFile(file: string): { lexicon?: Lexicon; failed?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { failed: `JSON 解析失败：${String(err)}` }
  }
  const parsed = lexiconSchema.safeParse(raw)
  return parsed.success
    ? { lexicon: parsed.data }
    : { failed: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}：${i.message}`).join('；') }
}

/** 读一个词库；id 不合法、不存在或文件坏了返回 undefined。 */
export function readLexicon(root: string, id: string): Lexicon | undefined {
  if (!LEXICON_ID.test(id)) return undefined
  const file = fileOf(root, id)
  return existsSync(file) ? parseFile(file).lexicon : undefined
}

/** 按剧本声明的顺序取词库，缺的、坏的跳过（运行时不能因为一个词库坏了就开不了回合）。 */
export function loadLexicons(root: string, ids: readonly string[]): Lexicon[] {
  return ids.flatMap(id => readLexicon(root, id) ?? [])
}

export function listLexicons(root: string): LexiconSummary[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(f => f.endsWith('.json') && LEXICON_ID.test(f.slice(0, -5)))
    .map((f) => {
      const id = f.slice(0, -5)
      const { lexicon, failed } = parseFile(path.join(root, f))
      if (!lexicon) return { id, title: id, groups: 0, words: 0, chars: 0, failed }
      return {
        id,
        title: lexicon.title,
        groups: lexicon.groups.length,
        words: lexicon.groups.reduce((n, g) => n + g.words.length, 0),
        chars: renderLexicon(lexicon).length,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export interface LexiconCheck {
  ok: boolean
  issues?: { path: string; message: string }[]
  /** 通过时：GM 固定设定里这个词库的那一段（含平台框定语），以及字数 */
  rendered?: string
  chars?: number
}

/** 只校验不保存（编辑器的实时预览用）：错误逐条返回；通过时给出 GM 看到的样子。 */
export function checkLexicon(input: unknown): LexiconCheck {
  const parsed = lexiconSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(i => ({ path: i.path.join('.') || '(root)', message: i.message })) }
  }
  return { ok: true, rendered: renderLexicons([parsed.data]), chars: renderLexicon(parsed.data).length }
}

export function listLexiconVersions(root: string, id: string): { name: string; savedAt: number; words: number }[] {
  if (!LEXICON_ID.test(id)) return []
  const dir = lexiconVersionsDir(root, id)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /^v-\d+\.json$/.test(f))
    .map((f) => {
      const { lexicon } = parseFile(path.join(dir, f))
      return { name: f, savedAt: Number(f.slice(2, -5)), words: lexicon ? lexicon.groups.reduce((n, g) => n + g.words.length, 0) : 0 }
    })
    .sort((a, b) => b.savedAt - a.savedAt)
}

function snapshot(root: string, id: string): void {
  const file = fileOf(root, id)
  if (!existsSync(file)) return
  const dir = lexiconVersionsDir(root, id)
  mkdirSync(dir, { recursive: true })
  // 同毫秒内的连续保存不许互相覆盖留档
  let stamp = Date.now()
  while (existsSync(path.join(dir, `v-${stamp}.json`))) stamp += 1
  writeFileSync(path.join(dir, `v-${stamp}.json`), readFileSync(file, 'utf8'))
  for (const stale of listLexiconVersions(root, id).slice(KEEP_VERSIONS)) rmSync(path.join(dir, stale.name), { force: true })
}

/**
 * 保存：校验（错误逐条返回）→ 旧版先留档 → 写数据卷（先写临时文件再 rename）→ 下一回合起生效。
 * 同 id 覆盖；新建时不许撞已有 id、编辑时不许改 id，这两道由调用方（路由）把关。
 */
export function saveLexicon(root: string, input: unknown): LexiconSaveResult {
  const parsed = lexiconSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => ({ path: i.path.join('.') || '(root)', message: i.message }))
    return {
      ok: false,
      issues,
      brief: `词库校验失败 ${issues.length} 处：\n${issues.map(i => `- ${i.path}：${i.message}`).join('\n')}`,
    }
  }
  const lexicon = parsed.data
  mkdirSync(root, { recursive: true })
  const file = fileOf(root, lexicon.id)
  const replaced = existsSync(file)
  if (replaced) snapshot(root, lexicon.id)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(lexicon, null, 2))
  renameSync(tmp, file)
  const words = lexicon.groups.reduce((n, g) => n + g.words.length, 0)
  return {
    ok: true,
    id: lexicon.id,
    title: lexicon.title,
    replaced,
    brief: `词库《${lexicon.title}》已${replaced ? '保存（旧版已留档，可回滚）' : '建好'}（id：${lexicon.id}，${lexicon.groups.length} 组、${words} 个词，`
      + `进 GM 设定约 ${renderLexicon(lexicon).length} 字）。剧本在 craft.lexicons 里写上这个 id 才会用它；`
      + '用着它的冒险从下一回合起就用新版。',
  }
}

/** 回滚到某个历史版本：当前版先留档（回滚本身也可再回滚）。版本文件坏了返回校验结果。 */
export function restoreLexiconVersion(root: string, id: string, name: string): LexiconSaveResult | undefined {
  if (!LEXICON_ID.test(id) || !/^v-\d+\.json$/.test(name)) return undefined
  const file = path.join(lexiconVersionsDir(root, id), name)
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, brief: '历史版本文件损坏，无法回滚' }
  }
  return saveLexicon(root, raw)
}

/** 删除词库（连同它的留档）。 */
export function deleteLexicon(root: string, id: string): boolean {
  if (!LEXICON_ID.test(id)) return false
  const file = fileOf(root, id)
  if (!existsSync(file)) return false
  rmSync(file)
  rmSync(lexiconVersionsDir(root, id), { recursive: true, force: true })
  return true
}
