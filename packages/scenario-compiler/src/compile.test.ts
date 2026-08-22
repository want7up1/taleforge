import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MASKED_GLOBAL_TOOLS, applyRevisionsToStory, compileAll, compileScenario, compileWorkshopPreset, renderPersona, storySchema } from './index.ts'

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

test('craft.reminder：合法可选、超 600 字拒绝（贴身的前提是短）', () => {
  const ok = storySchema.parse({ ...story, craft: { modules: [], rules: [], reminder: '每回合按词表直给。' } })
  assert.equal(ok.craft.reminder, '每回合按词表直给。')
  assert.equal(storySchema.parse(story).craft.reminder, undefined)
  assert.throws(() => storySchema.parse({ ...story, craft: { modules: [], rules: [], reminder: '长'.repeat(601) } }))
})

test('acts[].reminder：分幕贴身提醒合法可选、同样限 600 字', () => {
  const withStage = {
    ...story,
    acts: [{ ...story.acts[0], reminder: '本幕世界还是正常的：写日常温度，不写底噪。' }],
  }
  const ok = storySchema.parse(withStage)
  assert.equal(ok.acts[0].reminder, '本幕世界还是正常的：写日常温度，不写底噪。')
  assert.equal(storySchema.parse(story).acts[0].reminder, undefined)
  assert.throws(() => storySchema.parse({
    ...story,
    acts: [{ ...story.acts[0], reminder: '长'.repeat(601) }],
  }))
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

test('显示选位与分组标题：display 三值合法、hidden 在 persona 里标注、groups 可自定义', () => {
  const withDisplay = storySchema.parse({
    ...story,
    mechanics: {
      groups: { affinity: '红颜' },
      resources: [
        { id: 'lust', label: '欲望', group: 'self', min: 0, max: 100, initial: 10, maxStep: 40, guidance: 'x', display: 'strip' },
        { id: 'doom', label: '倒计时', group: 'world', min: 0, max: 30, initial: 30, maxStep: 5, guidance: 'x', display: 'hidden' },
      ],
    },
  })
  assert.equal(withDisplay.mechanics?.resources?.[1].display, 'hidden')
  assert.equal(withDisplay.mechanics?.groups?.affinity, '红颜')
  const persona = renderPersona(withDisplay)
  assert.match(persona, /此条对玩家隐藏/)
  assert.throws(() => storySchema.parse({
    ...story,
    mechanics: { resources: [{ id: 'x', label: 'x', group: 'self', min: 0, max: 1, initial: 0, maxStep: 1, guidance: 'x', display: 'popup' }] },
  }), '未知位置必须被拒绝')
})

test('双源根：后者同 id 覆盖前者（数据卷压过仓库种子），并集之外的才回收', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const repo = path.join(root, 'repo')
    const data = path.join(root, 'data')
    const out = path.join(root, 'out')
    mkdirSync(path.join(repo, 'a'), { recursive: true })
    writeFileSync(path.join(repo, 'a', 'story.json'), JSON.stringify({ ...story, tagline: '种子版' }))
    mkdirSync(path.join(data, 'a2'), { recursive: true })
    writeFileSync(path.join(data, 'a2', 'story.json'), JSON.stringify({ ...story, tagline: '落盘修订版' }))

    compileAll([repo, data], out)
    const compiledStory = JSON.parse(readFileSync(path.join(out, 'story-test', 'story.json'), 'utf8'))
    assert.equal(compiledStory.tagline, '落盘修订版', '数据根应覆盖仓库同 id 剧本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('修订落盘合并：各目标类型落对位置，产物仍过 schema', () => {
  const source = storySchema.parse({
    ...story,
    cast: [{ id: 'su', name: '苏', identity: '医生' }],
    mechanics: {
      resources: [{ id: 'hp', label: '体力', group: 'self', min: 0, max: 100, initial: 80, maxStep: 20, guidance: '旧语义' }],
    },
  })
  const { story: merged, applied, skipped } = applyRevisionsToStory(source, [
    { target: 'world', text: '天空是红的' },
    { target: 'direction', text: '节奏放快' },
    { target: 'cast', id: 'su', text: '她带着一只上锁的药箱' },
    { target: 'anchor', act: 'act-1', op: 'add', id: 'a9', text: '新锚点', signal: '新信号' },
    { target: 'resource', id: 'hp', max: 80, guidance: '新语义' },
    { target: 'cast', id: 'ghost', text: '不存在' },
  ])
  assert.equal(applied, 5)
  assert.equal(skipped.length, 1)
  assert.ok(merged.world.overview.endsWith('天空是红的'))
  assert.deepEqual(merged.craft.rules, ['节奏放快'])
  assert.ok(merged.cast[0].identity.includes('药箱'))
  assert.ok(merged.acts[0].anchors.some(a => a.id === 'a9' && a.signal === '新信号'))
  assert.equal(merged.mechanics?.resources?.[0].max, 80)
  assert.equal(merged.mechanics?.resources?.[0].guidance, '新语义')
  assert.equal(source.world.overview.includes('天空'), false, '输入不被修改')
})

test('工坊 preset 生成：persona 完整、挂发布插件、不带 story- 前缀', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    compileWorkshopPreset(root, { workshopEntry: '/abs/workshop.ts', scenariosRoot: '/data/scenarios' })
    const yml = readFileSync(path.join(root, 'workshop', 'agent.cordis.yml'), 'utf8')
    assert.match(yml, /dsh-persona/)
    assert.match(yml, /publish_story/)
    assert.match(yml, /\/abs\/workshop\.ts/)
    assert.match(yml, /完成信号/)
    assert.match(yml, /机械规则，不写判断规则/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('progression：需同时声明 attributes、阈值必须严格递增', () => {
  const attrs = [{ id: 'str', label: '力量', initial: 3, guidance: 'x' }]
  const prog = { guidance: '击杀 +10', maxStep: 40, thresholds: [40, 100], pointsPerLevel: 2 }
  assert.throws(() => storySchema.parse({ ...story, mechanics: { progression: prog } }), /attributes/)
  assert.throws(
    () => storySchema.parse({ ...story, mechanics: { attributes: attrs, progression: { ...prog, thresholds: [100, 40] } } }),
    /递增/,
  )
  const ok = storySchema.parse({ ...story, mechanics: { attributes: attrs, progression: prog } })
  assert.equal(ok.mechanics?.progression?.label, '经验', 'label 缺省为经验')
})

test('progression 进 persona：经验等级段、固定流程里 grant_xp 必调与【加点】先落账', () => {
  const parsed = storySchema.parse({
    ...story,
    mechanics: {
      attributes: [{ id: 'str', label: '力量', initial: 3, guidance: 'x' }],
      progression: { label: '进化点', guidance: '吞噬晶核 +20', maxStep: 40, thresholds: [40, 100], pointsPerLevel: 2, display: 'panel' },
    },
  })
  const persona = renderPersona(parsed)
  assert.match(persona, /## 经验与等级（进化点）/)
  assert.match(persona, /吞噬晶核 \+20/)
  assert.match(persona, /2 级需累计 40、3 级需累计 100，满级 3 级/)
  assert.match(persona, /`grant_xp` 每个正戏回合必调（没有传 0）/)
  assert.match(persona, /【加点】时第一件事先 `spend_points`/)
  assert.match(persona, /属性主要靠玩家用属性点加点成长/)
  // 没声明就一个字都不出现
  assert.doesNotMatch(renderPersona(storySchema.parse(story)), /grant_xp|经验与等级/)
})

test('资源 id 接受 kebab-case（首段可含连字符），冒号命名空间仍可用', () => {
  const res = (id: string) => ({ id, label: 'x', group: 'self', min: 0, max: 10, initial: 0, maxStep: 1, guidance: 'x' })
  const ok = storySchema.parse({ ...story, mechanics: { resources: [res('desire-jiangtang'), res('affinity:suwan'), res('evolution')] } })
  assert.equal(ok.mechanics?.resources?.length, 3)
  assert.throws(() => storySchema.parse({ ...story, mechanics: { resources: [res('Desire')] } }))
  assert.throws(() => storySchema.parse({ ...story, mechanics: { resources: [res('a:b:c')] } }))
})

test('progression：levelNames 长度必须等于阈值数+1；bonusPointsMax 缺省 0；persona 带级名与奖励点规则', () => {
  const attrs = [{ id: 'str', label: '力量', initial: 3, guidance: 'x' }]
  const base = { guidance: 'x', maxStep: 3, thresholds: [6, 16], pointsPerLevel: 2 }
  assert.throws(
    () => storySchema.parse({ ...story, mechanics: { attributes: attrs, progression: { ...base, levelNames: ['C', 'B'] } } }),
    /levelNames/,
  )
  const plain = storySchema.parse({ ...story, mechanics: { attributes: attrs, progression: base } })
  assert.equal(plain.mechanics?.progression?.bonusPointsMax, 0)
  assert.doesNotMatch(renderPersona(plain), /剧情奖励属性点/)
  const rich = storySchema.parse({
    ...story,
    mechanics: { attributes: attrs, progression: { ...base, levelNames: ['C', 'B', 'A'], bonusPointsMax: 5 } },
  })
  const persona = renderPersona(rich)
  assert.match(persona, /各级名称 C\/B\/A；B（2 级）需累计 6、A（3 级）需累计 16，满级 3 级=A/)
  assert.match(persona, /剧情奖励属性点.*points.*单次最多 5/)
})

test('工具遮罩进玩家与工坊 preset：挡掉 profile 层插件漏进来的全局工具（护栏 4）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const src = path.join(root, 'src')
    const out = path.join(root, 'out')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'story.json'), JSON.stringify(story))
    const entries = { toolMask: '/abs/tool-mask.ts', progress: '/abs/progress.ts' }

    compileScenario(src, out, entries)
    const composition = readFileSync(path.join(out, 'story-test', 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /id: tool-mask/)
    for (const tool of MASKED_GLOBAL_TOOLS) {
      assert.ok(composition.includes(tool), `玩家 preset 应挡掉 ${tool}`)
    }
    // 遮罩必须排在平台自己的插件之前，先挡再挂
    assert.ok(
      composition.indexOf('id: tool-mask') < composition.indexOf('id: progress'),
      '遮罩应排在其他插件之前',
    )

    compileWorkshopPreset(out, { workshopEntry: '/abs/workshop.ts', scenariosRoot: src, entries })
    const workshop = readFileSync(path.join(out, 'workshop', 'agent.cordis.yml'), 'utf8')
    assert.match(workshop, /id: tool-mask/, '工坊 preset 同样要挡')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没有 toolMask 入口时不写遮罩条目：同一份编译器在未装插件的环境照常工作', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const src = path.join(root, 'src')
    const out = path.join(root, 'out')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'story.json'), JSON.stringify(story))

    compileScenario(src, out, { progress: '/abs/progress.ts' })
    const composition = readFileSync(path.join(out, 'story-test', 'agent.cordis.yml'), 'utf8')
    assert.ok(!composition.includes('tool-mask'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
