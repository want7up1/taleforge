import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interleavedWords, LEXICON_MAX_CHARS, lexiconSchema, renderLexicons, renderPersona, storySchema } from './index.ts'

const story = storySchema.parse({
  format: 'taleforge.story.v1.1',
  id: 'story-lex',
  title: '雾港',
  tagline: '一句话',
  world: { overview: '世界观', tone: ['湿冷'] },
  protagonist: { name: '陈默', identity: '守塔人' },
  opening: { scene: '开场', hook: '钩子' },
  acts: [{ id: 'act-1', title: '第一幕', objective: '目标', anchors: [{ id: 'a1', text: '锚点', signal: '信号' }] }],
  craft: { modules: ['standard'], rules: [] },
})

const lexicon = lexiconSchema.parse({
  format: 'taleforge.lexicon.v1',
  id: 'harbor-talk',
  title: '港口与船上用语',
  guide: '写码头与船上的对白时用这些说法，不换成书面语。',
  groups: [
    { label: '船与港', words: ['缆桩', '跳板', '缆桩', '舢板'] },
    { label: '渔民的话', note: '只在对白里出现', words: ['讨海', '赶小海'] },
  ],
})

test('词库 schema：format 必填、id 要 kebab-case、至少一组一词', () => {
  const base = { format: 'taleforge.lexicon.v1', id: 'x', title: 't', groups: [{ label: 'g', words: ['词'] }] }
  assert.ok(lexiconSchema.safeParse(base).success)
  assert.equal(lexiconSchema.safeParse({ ...base, format: undefined }).success, false, '不带 format 的 JSON 多半是别的文件（比如剧本）')
  assert.equal(lexiconSchema.safeParse({ ...base, id: 'Bad_ID' }).success, false)
  assert.equal(lexiconSchema.safeParse({ ...base, id: '../x' }).success, false, 'id 决定写入路径，不许穿越')
  assert.equal(lexiconSchema.safeParse({ ...base, groups: [] }).success, false)
  assert.equal(lexiconSchema.safeParse({ ...base, groups: [{ label: 'g', words: [] }] }).success, false)
})

test('词库体量上限：渲染进 GM 设定超过上限就拒绝，并说出实际字数', () => {
  const words = Array.from({ length: 2000 }, (_, i) => `词条${i}`)
  const result = lexiconSchema.safeParse({ format: 'taleforge.lexicon.v1', id: 'big', title: '大', groups: [{ label: 'g', words }] })
  assert.equal(result.success, false)
  assert.match(result.error!.issues[0].message, new RegExp(`上限 ${LEXICON_MAX_CHARS}`))
})

test('渲染：框定语保持中立（不替词库决定强度）、用法说明由词库自己说、同组重复的词去掉', () => {
  const text = renderLexicons([lexicon])
  assert.match(text, /# 用词库（本剧本选用）/)
  assert.match(text, /不是每章都要出现的清单/)
  assert.match(text, /仍以剧本的内容强度与提醒为准/)
  assert.doesNotMatch(text, /直呼|委婉/, '要不要直呼由词库自己的 guide 说，平台不说')
  assert.match(text, /## 《港口与船上用语》\n\n写码头与船上的对白时用这些说法/)
  assert.match(text, /- 船与港：缆桩、跳板、舢板\n/)
  assert.match(text, /- 渔民的话（只在对白里出现）：讨海、赶小海/)
  assert.equal(renderLexicons([]), '')
})

test('词库进固定前缀：排在工艺模块之后、剧本数据之前；没选就没有这一段，前缀与从前逐字节相同', () => {
  const without = renderPersona(story)
  const withLex = renderPersona(story, { lexicons: [lexicon] })
  assert.doesNotMatch(without, /用词库/)
  const at = withLex.indexOf('# 用词库')
  assert.ok(at > withLex.indexOf('## 工艺模块：标准叙事'), '在工艺模块之后')
  assert.ok(at < withLex.indexOf('# 剧本：雾港'), '在剧本数据之前')
  assert.equal(withLex.replace(`${renderLexicons([lexicon])}\n\n`, ''), without)
})

test('craft.lexicons：可选、最多 3 个、不许重复、id 要 kebab-case', () => {
  const withIds = (lexicons: unknown) => storySchema.safeParse({ ...story, craft: { ...story.craft, lexicons } })
  assert.ok(withIds(['harbor-talk', 'b']).success)
  assert.equal(withIds(['a', 'b', 'c', 'd']).success, false)
  assert.equal(withIds(['a', 'a']).success, false)
  assert.equal(withIds(['Bad ID']).success, false)
  assert.equal(storySchema.parse(story).craft.lexicons, undefined, '不声明就没有（无隐藏默认）')
})

test('interleavedWords：各组轮流取，跨组去重', () => {
  const second = lexiconSchema.parse({ format: 'taleforge.lexicon.v1', id: 'b', title: 'b', groups: [{ label: 'x', words: ['讨海', '起锚'] }] })
  assert.deepEqual(interleavedWords([lexicon, second]), ['缆桩', '讨海', '跳板', '赶小海', '起锚', '舢板'])
})
