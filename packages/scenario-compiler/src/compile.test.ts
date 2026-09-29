import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyRevisionsToStory, renderPersona, scanCatalog, storySchema } from './index.ts'
import { WORKSHOP_PERSONA } from './workshop.ts'

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
  assert.match(persona, /# 输出格式/)
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
  assert.match(standard, /每章 2–4 处/, '标记用法工艺随 standard 模块走')
  assert.doesNotMatch(standard, /出手即碾压/)

  // 底座与输出契约不随选件变化
  for (const persona of [shuang, standard]) {
    assert.match(persona, /戏内铁律/)
    assert.match(persona, /场外协议/)
    assert.match(persona, /不少于 2000 字/)
  }
})

test('正文步的幕结构：当前幕写详细，其余只列标题；完成信号只归结算步', () => {
  const three = storySchema.parse({
    ...story,
    acts: [
      story.acts[0],
      { id: 'act-2', title: '第二幕', objective: '第二幕的秘密目标', anchors: [{ id: 'b1', text: '第二幕锚点', required: true }] },
      { id: 'act-3', title: '第三幕', objective: '第三幕目标', anchors: [{ id: 'c1', text: '终点', required: true }] },
    ],
  })
  const atAct2 = renderPersona(three, { actIndex: 1 })
  assert.match(atAct2, /第 1 幕《第一幕》（已完成）/)
  assert.match(atAct2, /第 2 幕《第二幕》（当前）/)
  assert.match(atAct2, /第二幕锚点/)
  assert.match(atAct2, /第 3 幕《第三幕》（尚未开始/)
  assert.doesNotMatch(atAct2, /第三幕目标|终点/, '未到的幕不给细节——写进上下文 GM 就会提前演')
  assert.doesNotMatch(atAct2, /锚点一/, '已完成的幕不再占篇幅')
  assert.doesNotMatch(renderPersona(storySchema.parse(story)), /完成信号/, '完成信号是结算步的对照物，正文步不背')
})

test('幕结构随锚点修订渲染：传入现行幕结构就用它', () => {
  const parsed = storySchema.parse(story)
  const revised = [{ ...parsed.acts[0], anchors: [...parsed.acts[0].anchors, { id: 'a9', text: '场外新增的锚点', required: true }] }]
  assert.match(renderPersona(parsed, { acts: revised }), /场外新增的锚点/)
})

test('输出契约排在固定前缀末尾，离后面的对话最近；正文里不再有行动块', () => {
  const persona = renderPersona(storySchema.parse({ ...story, craft: { ...story.craft, exemplar: '范文'.repeat(120) } }))
  const contract = persona.indexOf('# 输出格式')
  assert.ok(contract > 0, '应存在输出格式契约')
  for (const marker of ['## 世界', '## 出场人物', '## 幕结构', '## 开场', '# 文风范本']) {
    assert.ok(persona.indexOf(marker) < contract, `${marker} 应排在输出契约之前`)
  }
  assert.match(persona.slice(contract), /不写【行动】块/, '选项由结算步结构化产出')
  assert.match(persona.slice(contract), /——剧终——/)
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
  assert.match(persona, /资源（欲望）/, '隐藏条目不列进正文步的面板清单')
  assert.throws(() => storySchema.parse({
    ...story,
    mechanics: { resources: [{ id: 'x', label: 'x', group: 'self', min: 0, max: 1, initial: 0, maxStep: 1, guidance: 'x', display: 'popup' }] },
  }), '未知位置必须被拒绝')
})

test('剧本目录双源根：后者同 id 覆盖前者（数据卷压过仓库种子）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const repo = path.join(root, 'repo')
    const data = path.join(root, 'data')
    mkdirSync(path.join(repo, 'a'), { recursive: true })
    writeFileSync(path.join(repo, 'a', 'story.json'), JSON.stringify({ ...story, tagline: '种子版' }))
    mkdirSync(path.join(data, 'a2'), { recursive: true })
    writeFileSync(path.join(data, 'a2', 'story.json'), JSON.stringify({ ...story, tagline: '落盘修订版' }))
    const entries = scanCatalog([repo, data])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].story?.tagline, '落盘修订版', '数据根应覆盖仓库同 id 剧本')
    assert.equal(entries[0].dir, path.join(data, 'a2'))
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

test('资源 id 接受 kebab-case（首段可含连字符），冒号命名空间仍可用', () => {
  const res = (id: string) => ({ id, label: 'x', group: 'self', min: 0, max: 10, initial: 0, maxStep: 1, guidance: 'x' })
  const ok = storySchema.parse({ ...story, mechanics: { resources: [res('desire-jiangtang'), res('affinity:suwan'), res('evolution')] } })
  assert.equal(ok.mechanics?.resources?.length, 3)
  assert.throws(() => storySchema.parse({ ...story, mechanics: { resources: [res('Desire')] } }))
  assert.throws(() => storySchema.parse({ ...story, mechanics: { resources: [res('a:b:c')] } }))
})

test('progression：levelNames 长度必须等于阈值数+1；bonusPointsMax 缺省 0', () => {
  const attrs = [{ id: 'str', label: '力量', initial: 3, guidance: 'x' }]
  const base = { guidance: 'x', maxStep: 3, thresholds: [6, 16], pointsPerLevel: 2 }
  assert.throws(
    () => storySchema.parse({ ...story, mechanics: { attributes: attrs, progression: { ...base, levelNames: ['C', 'B'] } } }),
    /levelNames/,
  )
  const plain = storySchema.parse({ ...story, mechanics: { attributes: attrs, progression: base } })
  assert.equal(plain.mechanics?.progression?.bonusPointsMax, 0)
})

test('standard 模块带着"文字代画面"的三条：定镜、连续场景、数值写成动作', () => {
  const persona = renderPersona(storySchema.parse({ ...story, craft: { modules: ['standard'], rules: [] } }))
  // 这三条是文字游戏区别于其他游戏的地方——画面得由文字自己承担，删了就退回巡视报告
  assert.match(persona, /动笔先立定镜/)
  assert.match(persona, /一个回合是一个连续场景/)
  assert.match(persona, /数值的变化写成动作/)
  // 未声明 standard 的剧本不该拿到它们
  const bare = renderPersona(storySchema.parse({ ...story, craft: { modules: [], rules: [] } }))
  assert.doesNotMatch(bare, /动笔先立定镜/)
})

/**
 * 坏源隔离：目录扫描跑在 BFF 的启动路径上，一个剧本抛异常就是进程退出 + 容器无限重启，
 * 连进 WebUI 删掉它都做不到。所以坏的必须跳过、好的照常上架；坏剧本有留档就退回最近一份，
 * 玩家还能在详情页看到它、回滚或删除。
 */
test('坏剧本不拖垮整批：好的照常上架，坏的退回最近留档并标注原因', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const src = path.join(root, 'scenarios')
    mkdirSync(path.join(src, 'bad', 'versions'), { recursive: true })
    mkdirSync(path.join(src, 'good'), { recursive: true })
    writeFileSync(path.join(src, 'bad', 'versions', 'v-100.json'), JSON.stringify({ ...story, id: 'story-bad', title: '旧版' }))
    writeFileSync(path.join(src, 'bad', 'story.json'), JSON.stringify({ ...story, id: 'story-bad', title: undefined }))
    writeFileSync(path.join(src, 'good', 'story.json'), JSON.stringify({ ...story, id: 'story-good' }))
    const entries = scanCatalog([src])
    const bad = entries.find(e => e.id === 'story-bad')!
    assert.match(bad.failed!, /title/, '失败原因要能指到具体字段')
    assert.equal(bad.degraded, true)
    assert.equal(bad.story?.title, '旧版')
    assert.equal(entries.find(e => e.id === 'story-good')?.story?.title, '测试剧本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('源文件 JSON 都坏了（写盘中断）且没有留档：照样不崩，按目录名认领、不上架', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const src = path.join(root, 'scenarios')
    mkdirSync(path.join(src, 'half'), { recursive: true })
    writeFileSync(path.join(src, 'half', 'story.json'), '{"format":"taleforge.story.v1","id":"story-h')
    const [entry] = scanCatalog([src])
    assert.equal(entry.id, 'story-half')
    assert.ok(entry.failed)
    assert.equal(entry.story, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 货架上新要同步三处声明面：schema（能力本身）、AUTHORING.md（外发包与手写剧本的唯一依据）、
 * 工坊 persona（工坊 agent 创作剧本时的唯一依据）。少写一处的后果不是报错，是**这件货没人会用**——
 * 已经漏过两次：mechanics.upkeep 漏了工坊 persona，工坊产出的剧本永远不会用周期收支；
 * craft.intensity_words 两处都漏，drift.ts 的强度回灌事实上成了死代码。
 *
 * 纯字段名字符串匹配，是提醒装置不是严格证明：字段名在文档里出现 ≠ 说清楚了。
 * 但它能挡住"加了 schema 就完事"这个真实发生过的失误。
 */
test('货架上新的三处声明面同步：craft/mechanics 的每个字段都要写进说明书与工坊 persona', () => {
  const authoring = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../AUTHORING.md'),
    'utf8',
  )
  const shape = (storySchema as unknown as {
    shape: {
      craft: { shape: Record<string, unknown> }
      mechanics: { unwrap: () => { shape: Record<string, unknown> } }
    }
  }).shape
  const fields = [
    ...Object.keys(shape.craft.shape).map(k => `craft.${k}`),
    ...Object.keys(shape.mechanics.unwrap().shape).map(k => `mechanics.${k}`),
    // v1.1 在其他段落上新的字段，同样要写进两处
    'opening.chapter',
    'cast.voice',
    'story.lore',
  ]
  assert.ok(fields.length >= 10, '内省没拿到字段，检查已失效（zod 换版本了？）')

  const missing = fields.flatMap((full) => {
    const name = full.split('.')[1]
    return [
      ...(authoring.includes(name) ? [] : [`${full} → AUTHORING.md`]),
      ...(WORKSHOP_PERSONA.includes(name) ? [] : [`${full} → 工坊 persona`]),
    ]
  })
  assert.deepEqual(missing, [], `新字段没写进面向作者的文档，作者与工坊都不会知道它存在：\n${missing.join('\n')}`)
})

test('行动选项数的边界：2–4，E 键留给自由输入', () => {
  assert.equal(storySchema.parse(story).craft.action_options, 4)
  assert.equal(storySchema.parse({ ...story, craft: { ...story.craft, action_options: 3 } }).craft.action_options, 3)
  assert.throws(() => storySchema.parse({ ...story, craft: { ...story.craft, action_options: 5 } }))
  assert.throws(() => storySchema.parse({ ...story, craft: { ...story.craft, action_options: 1 } }))
})

test('正文里出不出现机制数字由剧本定：系统流剧本能把限制解除', () => {
  const withMech = {
    ...story,
    mechanics: {
      resources: [{ id: 'hp', label: '体力', group: 'self', min: 0, max: 100, initial: 80, maxStep: 20, guidance: '战斗扣' }],
      checks: { die: 'd20', guidance: '危险行动必掷' },
    },
  }
  const hidden = renderPersona(storySchema.parse(withMech))
  assert.match(hidden, /不出现任何数字和机制词/)
  assert.match(hidden, /正文里不出现点数与难度数字/)

  const shown = renderPersona(storySchema.parse({
    ...withMech,
    craft: { ...story.craft, numbers_in_prose: true },
  }))
  assert.match(shown, /直接写出数值与机制词/)
  assert.match(shown, /可以直接报出点数与难度/)
  assert.doesNotMatch(shown, /不出现任何数字和机制词/)
})

test('周期收支的 id 必须是已声明的资源：写错不该静默不结算', () => {
  const withUpkeep = (id: string) => ({
    ...story,
    mechanics: {
      resources: [{ id: 'grain', label: '口粮', group: 'self', min: 0, max: 100, initial: 50, maxStep: 25, guidance: '日耗' }],
      upkeep: [{ id, delta: -8, reason: '日耗' }],
    },
  })
  assert.equal(storySchema.safeParse(withUpkeep('grain')).success, true)

  const typo = storySchema.safeParse(withUpkeep('grian'))
  assert.equal(typo.success, false)
  assert.match(typo.error!.issues[0].message, /grian/, '要指名是哪个 id 写错了')
  assert.deepEqual(typo.error!.issues[0].path, ['mechanics', 'upkeep', 0, 'id'])
})

test('v1.1 新字段：全部可选，旧剧本照样有效；各自有长度边界', () => {
  assert.equal(storySchema.safeParse(story).success, true, 'v1 剧本不改一个字仍然有效')
  const rich = storySchema.parse({
    ...story,
    format: 'taleforge.story.v1.1',
    opening: { ...story.opening, chapter: '开场'.repeat(150) },
    cast: [{ id: 'su', name: '苏晚', identity: '医生', voice: ['“别动，我看看。”', '“你又逞强。”'] }],
    craft: { ...story.craft, exemplar: '范文'.repeat(150) },
    lore: [{ id: 'jingzhou', title: '荆州', triggers: ['荆州', '荆城'], text: '荆州是……' }],
  })
  assert.equal(rich.lore?.length, 1)
  assert.throws(() => storySchema.parse({ ...story, cast: [{ id: 'su', name: '苏', identity: 'x', voice: ['一句'] }] }), '口吻至少两句')
  assert.throws(() => storySchema.parse({ ...story, opening: { ...story.opening, chapter: '太短' } }))
  const dup = storySchema.safeParse({
    ...story,
    lore: [
      { id: 'x', title: 'a', triggers: ['a'], text: 't' },
      { id: 'x', title: 'b', triggers: ['b'], text: 't' },
    ],
  })
  assert.equal(dup.success, false)
  assert.match(dup.error!.issues[0].message, /重复/)
})

test('v1.1 新字段进固定前缀：口吻样例带"不照抄"、开场章与范文进文风范本', () => {
  const persona = renderPersona(storySchema.parse({
    ...story,
    opening: { ...story.opening, chapter: '雨下了一整夜。'.repeat(40) },
    cast: [{ id: 'su', name: '苏晚', identity: '医生', voice: ['别动，我看看。', '你又逞强。'] }],
    craft: { ...story.craft, exemplar: '风从北边来。'.repeat(50) },
  }))
  assert.match(persona, /口吻：「别动，我看看。」 「你又逞强。」/)
  assert.match(persona, /不原句照搬/)
  assert.match(persona, /# 文风范本[\s\S]*雨下了一整夜[\s\S]*风从北边来/)
  assert.doesNotMatch(renderPersona(storySchema.parse(story)), /# 文风范本/, '没声明就不出现')
})

test('奖励领取：rewards.counter 必须是已声明的资源；label 缺省"奖励"', () => {
  const withRewards = (rewards: unknown) => storySchema.safeParse({
    ...story,
    mechanics: { resources: [{ id: 'tokens', label: '未决', group: 'self', min: 0, max: 5, initial: 0, maxStep: 1, guidance: 'x' }], rewards },
  })
  const ok = withRewards({ guidance: '任务完成给三选一', counter: 'tokens' })
  assert.ok(ok.success)
  assert.equal(ok.data!.mechanics!.rewards!.label, '奖励')
  const bad = withRewards({ guidance: 'x', counter: 'nope' })
  assert.equal(bad.success, false)
  assert.match(bad.error!.issues[0].message, /未声明的资源「nope」/)
})
