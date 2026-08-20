/**
 * 剧本本地校验：给写作文件夹用，改完 story.json 就地自查，不必导入试错。
 * 用法：node <本仓库>/scripts/validate-story.ts <story.json 路径>
 * 通过打印剧本概要，失败逐条列出错误；退出码 0/1。
 */
import { readFileSync } from 'node:fs'
import { storySchema } from '../packages/scenario-compiler/src/index.ts'

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/validate-story.ts <story.json 路径>')
  process.exit(2)
}

let raw: unknown
try {
  raw = JSON.parse(readFileSync(target, 'utf8'))
} catch (err) {
  console.error(`✗ 文件读取或 JSON 解析失败：${String(err)}`)
  process.exit(1)
}

const parsed = storySchema.safeParse(raw)
if (!parsed.success) {
  console.error(`✗ 校验失败 ${parsed.error.issues.length} 处：`)
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}：${issue.message}`)
  }
  process.exit(1)
}

const s = parsed.data
const anchors = s.acts.flatMap(a => a.anchors)
const noSignal = anchors.filter(a => a.required && !a.signal)
console.log(`✓ 《${s.title}》（${s.id}）通过 taleforge.story.v1 校验`)
console.log(`  幕 ${s.acts.length} · 锚点 ${anchors.length}（必需 ${anchors.filter(a => a.required).length}）· 人物 ${s.cast.length} · 工艺 [${s.craft.modules.join(', ')}]${s.craft.rules.length ? ` + ${s.craft.rules.length} 条专属规则` : ''}`)
if (s.mechanics) {
  const m = s.mechanics
  console.log(`  机制：${[
    m.resources && `资源×${m.resources.length}`,
    m.attributes && `属性×${m.attributes.length}`,
    m.checks && `判定(${m.checks.die})`,
    m.inventory && `物品栏(初始×${m.inventory.initial.length})`,
  ].filter(Boolean).join('、')}`)
}
// 品质提示（不算错误）：必需锚点缺完成信号是卡幕/跳幕的头号来源
if (noSignal.length) {
  console.log(`  ⚠ ${noSignal.length} 个必需锚点没写完成信号（${noSignal.map(a => a.id).join(', ')}）——强烈建议补上`)
}
