/**
 * 词库本地校验：给写作文件夹用，改完词库 JSON 就地自查，不必导入试错。
 * 用法：node <本仓库>/scripts/validate-lexicon.ts <词库.json 路径>
 * 通过打印概要（组数、词数、进 GM 设定的字数），失败逐条列出错误；退出码 0/1。
 */
import { readFileSync } from 'node:fs'
import { LEXICON_MAX_CHARS, lexiconSchema, renderLexicon } from '../packages/scenario-compiler/src/index.ts'

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/validate-lexicon.ts <词库.json 路径>')
  process.exit(2)
}

let raw: unknown
try {
  raw = JSON.parse(readFileSync(target, 'utf8'))
} catch (err) {
  console.error(`✗ 文件读取或 JSON 解析失败：${String(err)}`)
  process.exit(1)
}

const parsed = lexiconSchema.safeParse(raw)
if (!parsed.success) {
  console.error(`✗ 校验失败 ${parsed.error.issues.length} 处：`)
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}：${issue.message}`)
  }
  process.exit(1)
}

const lex = parsed.data
const words = lex.groups.flatMap(g => g.words)
const chars = renderLexicon(lex).length
console.log(`✓ 词库《${lex.title}》（${lex.id}）通过 ${lex.format} 校验`)
console.log(`  ${lex.groups.length} 组 · ${words.length} 个词 · 进 GM 设定约 ${chars} 字（上限 ${LEXICON_MAX_CHARS}）`)
// 同一个词出现在两组里：渲染时各组各自去重，跨组重复只是白占篇幅
const seen = new Map<string, string>()
const dup: string[] = []
for (const g of lex.groups) {
  for (const w of new Set(g.words)) {
    if (seen.has(w) && seen.get(w) !== g.label) dup.push(`${w}（${seen.get(w)} / ${g.label}）`)
    else seen.set(w, g.label)
  }
}
if (dup.length) console.log(`  ⚠ ${dup.length} 个词在多组里重复：${dup.slice(0, 20).join('、')}${dup.length > 20 ? '……' : ''}`)
