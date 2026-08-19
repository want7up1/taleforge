import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { compileAll, compileScenario, renderPersona, storySchema } from './index.ts'

const story = {
  format: 'taleforge.story.v0',
  id: 'story-test',
  title: '测试剧本',
  tagline: '一句话简介',
  world: { overview: '世界观', tone: ['测试'], hidden_truths: [{ id: 'ht-1', text: '秘密' }] },
  protagonist: { name: '主角', identity: '身份' },
  opening: { scene: '开场', hook: '钩子' },
  acts: [
    {
      id: 'act-1',
      title: '第一幕',
      objective: '目标',
      anchors: [{ id: 'a1', text: '锚点一', required: true }],
      forbidden_reveals: ['秘密'],
    },
  ],
  style: { template: ['shuang'], extra_rules: [] },
}

test('schema 拒绝非法剧本 id', () => {
  assert.throws(() => storySchema.parse({ ...story, id: 'wrong-prefix' }))
})

test('compileAll 回收源已删除的剧本，但不碰其他 preset', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const src = path.join(root, 'presets')
    const out = path.join(root, 'out')
    mkdirSync(path.join(src, 'a'), { recursive: true })
    writeFileSync(path.join(src, 'a', 'story.json'), JSON.stringify(story))
    mkdirSync(path.join(out, 'standard'), { recursive: true })   // 非本编译器产出，须保留

    compileAll(src, out)
    assert.ok(existsSync(path.join(out, 'story-test')))

    rmSync(path.join(src, 'a'), { recursive: true })
    const second = compileAll(src, out)

    assert.ok(!existsSync(path.join(out, 'story-test')), '源已删除的剧本应被回收')
    assert.ok(existsSync(path.join(out, 'standard')), '非 story- 前缀的 preset 不得删除')
    assert.deepEqual(second.filter(r => r.removed).map(r => r.id), ['story-test'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('schema 拒绝未知调性模板', () => {
  assert.throws(() => storySchema.parse({ ...story, style: { template: ['unknown'], extra_rules: [] } }))
})

test('调性模块可组合，按声明顺序拼接', () => {
  const persona = renderPersona(
    storySchema.parse({ ...story, style: { template: ['shuang', 'harem'], extra_rules: [] } }),
  )
  assert.match(persona, /本作调性：爽/)
  assert.match(persona, /本作调性：关系与张力/)
  assert.ok(persona.indexOf('本作调性：爽') < persona.indexOf('本作调性：关系与张力'), '应按声明顺序')
})

test('调性模板决定 persona 里出现哪一套工艺指令', () => {
  const shuang = renderPersona(storySchema.parse(story))
  assert.match(shuang, /本作调性：爽/)
  assert.match(shuang, /出手即碾压/)
  assert.doesNotMatch(shuang, /代价与失败是好戏/)

  const hardcore = renderPersona(
    storySchema.parse({ ...story, style: { template: ['hardcore'], extra_rules: [] } }),
  )
  assert.match(hardcore, /本作调性：硬核/)
  assert.match(hardcore, /代价与失败是好戏/)
  assert.doesNotMatch(hardcore, /出手即碾压/)

  // 通用工艺与输出契约不随调性变化
  for (const persona of [shuang, hardcore]) {
    assert.match(persona, /承接优先/)
    assert.match(persona, /【行动】/)
  }
})

test('输出契约排在 persona 末尾，离生成点最近', () => {
  const persona = renderPersona(storySchema.parse(story))
  const contract = persona.indexOf('# 输出格式')
  assert.ok(contract > 0, '应存在输出格式契约')
  // 契约必须排在剧本设定之后——早先它在最前面，模型写到结尾会漏掉行动块
  for (const marker of ['## 世界', '## 出场人物', '## 幕结构', '## 开场']) {
    assert.ok(persona.indexOf(marker) < contract, `${marker} 应排在输出契约之前`)
  }
  // 契约之后只允许开局指令
  assert.match(persona.slice(contract), /# 开局/)
})

test('编译产出 preset 三件套且幂等', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const storyDir = path.join(root, 'src')
    mkdirSync(storyDir)
    writeFileSync(path.join(storyDir, 'story.json'), JSON.stringify(story))
    const presetsRoot = path.join(root, 'presets')

    const first = compileScenario(storyDir, presetsRoot)
    const second = compileScenario(storyDir, presetsRoot)
    assert.equal(first.presetDir, second.presetDir)

    for (const file of ['preset.yml', 'agent.cordis.yml', 'story.json']) {
      assert.ok(existsSync(path.join(first.presetDir, file)), `缺少 ${file}`)
    }

    const composition = readFileSync(path.join(first.presetDir, 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /dsh-persona/)
    assert.match(composition, /complete: true/)
    assert.match(composition, /【行动】/)
    assert.match(composition, /测试剧本/)
    assert.doesNotMatch(composition, /dsh-tool-bash/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
