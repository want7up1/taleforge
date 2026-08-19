import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { compileAll, compileScenario, renderPersona, storySchema } from './index.ts'

const story = {
  format: 'taleforge.story.v1',
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
      anchors: [{ id: 'a1', text: '锚点一', required: true, signal: '主角拿到了钥匙' }],
      forbidden_reveals: ['秘密'],
    },
  ],
  craft: { modules: ['shuang'], rules: [] },
}

test('schema 拒绝非法剧本 id', () => {
  assert.throws(() => storySchema.parse({ ...story, id: 'wrong-prefix' }))
})

test('schema 拒绝未知工艺模块', () => {
  assert.throws(() => storySchema.parse({ ...story, craft: { modules: ['unknown'], rules: [] } }))
})

test('craft 声明显式必填——无隐藏默认', () => {
  const { craft: _omitted, ...withoutCraft } = story
  assert.throws(() => storySchema.parse(withoutCraft), '缺 craft 段必须被拒绝')
  assert.throws(
    () => storySchema.parse({ ...story, craft: { rules: [] } }),
    '缺 modules 必须被拒绝——空也要显式写空数组',
  )
})

test('modules 可为空数组：只要底座结构保证，不含任何工艺模块', () => {
  const persona = renderPersona(storySchema.parse({ ...story, craft: { modules: [], rules: [] } }))
  assert.doesNotMatch(persona, /本作调性/)
  assert.doesNotMatch(persona, /工艺模块：标准叙事/)
  // 底座结构与输出契约仍然齐全
  assert.match(persona, /结构规则/)
  assert.match(persona, /【行动】/)
  assert.match(persona, /【场外】/)
})

test('剧本自带工艺 rules 无条数上限', () => {
  const rules = ['一', '二', '三', '四', '五', '六', '七']
  const persona = renderPersona(storySchema.parse({ ...story, craft: { modules: [], rules } }))
  assert.match(persona, /本剧本工艺要求/)
  for (const r of rules) assert.ok(persona.includes(`- ${r}`))
})

test('工艺模块可组合，按声明顺序拼接', () => {
  const persona = renderPersona(
    storySchema.parse({ ...story, craft: { modules: ['shuang', 'harem'], rules: [] } }),
  )
  assert.match(persona, /本作调性：爽/)
  assert.match(persona, /本作调性：关系与张力/)
  assert.ok(persona.indexOf('本作调性：爽') < persona.indexOf('本作调性：关系与张力'), '应按声明顺序')
})

test('声明哪个模块，persona 里就出现哪套工艺，不多不少', () => {
  const shuang = renderPersona(storySchema.parse(story))
  assert.match(shuang, /出手即碾压/)
  assert.doesNotMatch(shuang, /代价与失败是好戏/)
  assert.doesNotMatch(shuang, /承接优先/, 'standard 未声明就不该出现——无隐藏默认')

  const standard = renderPersona(
    storySchema.parse({ ...story, craft: { modules: ['standard'], rules: [] } }),
  )
  assert.match(standard, /承接优先/)
  assert.match(standard, /每回合 2–4 处/, '标记用法工艺随 standard 模块走')
  assert.doesNotMatch(standard, /出手即碾压/)

  // 底座与输出契约不随选件变化
  for (const persona of [shuang, standard]) {
    assert.match(persona, /戏内铁律/)
    assert.match(persona, /场外协议/)
    assert.match(persona, /【行动】/)
  }
})

test('锚点完成信号渲染进幕结构', () => {
  const persona = renderPersona(storySchema.parse(story))
  assert.match(persona, /完成信号：主角拿到了钥匙/)
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

test('传入插件入口时：进度引擎一律挂载，机制引擎只在声明 mechanics 时挂载', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const storyDir = path.join(root, 'src')
    mkdirSync(storyDir)
    writeFileSync(path.join(storyDir, 'story.json'), JSON.stringify(story))
    const entries = { mechanics: '/abs/mechanics.ts', progress: '/abs/progress.ts' }

    // 纯叙事剧本（无 mechanics 段）：只有进度引擎
    const pure = compileScenario(storyDir, path.join(root, 'p1'), entries)
    const pureYml = readFileSync(path.join(pure.presetDir, 'agent.cordis.yml'), 'utf8')
    assert.match(pureYml, /\/abs\/progress\.ts/)
    assert.match(pureYml, /act-1/, '进度引擎配置应带幕结构种子')
    assert.doesNotMatch(pureYml, /\/abs\/mechanics\.ts/)

    // 带机制的剧本：两个都挂
    writeFileSync(path.join(storyDir, 'story.json'), JSON.stringify({
      ...story,
      mechanics: {
        resources: [{
          id: 'hp', label: '体力', group: 'self', min: 0, max: 100, initial: 80, maxStep: 20, guidance: '战斗扣，休息回',
        }],
      },
    }))
    const rich = compileScenario(storyDir, path.join(root, 'p2'), entries)
    const richYml = readFileSync(path.join(rich.presetDir, 'agent.cordis.yml'), 'utf8')
    assert.match(richYml, /\/abs\/progress\.ts/)
    assert.match(richYml, /\/abs\/mechanics\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('回合固定流程紧随剧本数据、位于输出契约之前，终幕规则齐备', () => {
  const persona = renderPersona(storySchema.parse(story))
  const flow = persona.indexOf('# 回合固定流程')
  const contract = persona.indexOf('# 输出格式')
  assert.ok(flow > 0 && flow < contract, '固定流程应在输出契约之前')
  assert.match(persona, /report_progress/)
  assert.match(persona, /——剧终——/)
  assert.match(persona, /revise_setting/)
})
