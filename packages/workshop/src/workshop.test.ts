import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { craftWarnings, listStories, listVersions, publishStory, readStory, workshopTools } from './index.ts'
import { storySchema } from '@taleforge/scenario-compiler'

const story = {
  format: 'taleforge.story.v1',
  id: 'story-ws-test',
  title: '工坊测试剧本',
  tagline: '一句话',
  world: { overview: '世界观', tone: ['测试'] },
  protagonist: { name: '主角', identity: '身份' },
  opening: { scene: '开场', hook: '钩子' },
  acts: [{ id: 'a1', title: '第一幕', objective: '目标', anchors: [{ id: 'x', text: '锚点', signal: '信号' }] }],
  craft: { modules: ['standard'], rules: [] },
}

test('发布合法剧本：写进数据根，立即出现在剧本列表', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    const result = publishStory(config, story)
    assert.equal(result.ok, true)
    assert.equal(result.id, 'story-ws-test')
    assert.ok(!('issues' in result), 'ok 时不携带 issues 键（无损 JSON）')
    assert.ok(existsSync(path.join(config.scenariosRoot, 'ws-test/story.json')))
    assert.deepEqual(listStories(config).map(s => s.title), ['工坊测试剧本'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('发布非法剧本：逐条错误退回、不落盘任何文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    const bad = { ...story, id: 'wrong-prefix', craft: { modules: ['nope'], rules: [] } }
    const result = publishStory(config, bad)
    assert.equal(result.ok, false)
    assert.ok(result.issues!.length >= 2)
    assert.ok(result.issues!.some(i => i.path === 'id'))
    assert.match(result.brief, /校验失败/)
    assert.ok(!existsSync(config.scenariosRoot), '校验失败不得写任何文件')
    assert.ok(!('id' in result) && !('title' in result), '失败时不携带 id/title 键（无损 JSON）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('覆盖发布防护：旧版自动留档可列出；缩水默认拦下、force 放行', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    assert.equal(publishStory(config, story).ok, true)
    assert.equal(listVersions(config, 'story-ws-test').length, 0, '首次发布无旧版可留')

    // 同体量的覆盖更新：通过，且留档一版
    const updated = { ...story, tagline: '换一句话卖点' }
    assert.equal(publishStory(config, updated).ok, true)
    const versions = listVersions(config, 'story-ws-test')
    assert.equal(versions.length, 1)
    const kept = JSON.parse(
      readFileSync(path.join(config.scenariosRoot, 'ws-test/versions', versions[0].name), 'utf8'),
    ) as { tagline: string }
    assert.equal(kept.tagline, '一句话', '留档的是覆盖前的旧正式版')

    const fewerAnchors = {
      ...updated,
      acts: [{ ...updated.acts[0], anchors: updated.acts[0].anchors.slice(0, 1) }],
      craft: { modules: ['standard'], rules: [] },
    }
    // 先发布一个双锚点版本，再用单锚点覆盖以触发缩水防线
    const twoAnchors = {
      ...updated,
      acts: [{ ...updated.acts[0], anchors: [...updated.acts[0].anchors, { id: 'y', text: '第二锚点', signal: '信号' }] }],
    }
    assert.equal(publishStory(config, twoAnchors).ok, true)
    const blocked = publishStory(config, fewerAnchors)
    assert.equal(blocked.ok, false)
    assert.match(blocked.brief, /缩水防线/)
    const current = readStory(config, 'story-ws-test') as { acts: { anchors: unknown[] }[] }
    assert.equal(current.acts[0].anchors.length, 2, '被拦下的发布不得写入')

    // 确认过的删减：force 放行
    const forced = publishStory(config, fewerAnchors, { force: true })
    assert.equal(forced.ok, true)
    assert.ok(listVersions(config, 'story-ws-test').length >= 2, '放行的覆盖同样留档')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('list_stories/read_story：只认 story- 前缀，读的是现行正式版，坏 id 拒绝', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    publishStory(config, story)
    // 混入不是剧本的目录：不得出现在列表
    mkdirSync(path.join(config.scenariosRoot, 'not-a-story'), { recursive: true })

    const list = listStories(config)
    assert.deepEqual(list, [{ id: 'story-ws-test', title: '工坊测试剧本', tagline: '一句话' }])

    const loaded = readStory(config, 'story-ws-test')
    assert.equal((loaded as { title: string }).title, '工坊测试剧本')
    assert.equal(readStory(config, 'story-nope'), undefined)
    assert.equal(readStory(config, '../etc/passwd'), undefined, '路径穿越必须被 id 正则拦下')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写法体检：判断型触发条件被指名报出，且不影响发布', () => {
  const vague = {
    ...story,
    craft: {
      ...story.craft,
      rules: [
        '结算铁律：每次战斗结束必须落账',          // 机械条件，不该报
        '氛围铁律：当写到据点日常时，必须出现烟火气', // 判断条件，该报
      ],
    },
  }
  const notes = craftWarnings(storySchema.parse(vague))
  assert.equal(notes.length, 1, '只报判断型那条')
  assert.match(notes[0], /craft\.rules\[1\]/)
  assert.match(notes[0], /日常时/)
})

test('写法体检：人物设定里的现在时会被点出（时序错位+剧透）', () => {
  const tensed = {
    ...story,
    cast: [{ id: 'npc-1', name: '甲', identity: '女匪头目。现在她是据点防务的头儿。' }],
  }
  const notes = craftWarnings(storySchema.parse(tensed))
  assert.equal(notes.length, 1)
  assert.match(notes[0], /cast\.npc-1\.identity/)
  assert.match(notes[0], /现在/)
})

test('写法体检：干净的剧本不报任何提醒，发布结果里也不带 warnings', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    assert.deepEqual(craftWarnings(storySchema.parse(story)), [])
    const result = publishStory(config, story)
    assert.equal(result.ok, true)
    assert.equal(result.warnings, undefined)
    assert.ok(!result.brief.includes('写法体检'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写法体检不拦截发布：有问题照样发布成功，提醒附在 brief 里', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'taleforge-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    const vague = { ...story, craft: { ...story.craft, rules: ['必要时补充设定'] } }
    const result = publishStory(config, vague)
    assert.equal(result.ok, true, '体检永远不拦截发布')
    assert.equal(result.warnings?.length, 1)
    assert.match(result.brief, /写法体检/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写法体检不误报：时间词对比的是世界变迁而非人物归属', () => {
  const fine = {
    ...story,
    cast: [{ id: 'npc-2', name: '乙', identity: '前顶流偶像明星，如今素面朝天依然美得发光。' }],
  }
  assert.deepEqual(craftWarnings(storySchema.parse(fine)), [], '末世前后的对比是正常写法')
})

test('工坊工具：publish_story 发布后回调、回给模型的是简报；read_story 读现行正式版', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    const published: string[] = []
    const tools = workshopTools(config, id => published.push(id))
    const byName = (n: string) => tools.find(t => t.def.function.name === n)!
    const out = await byName('publish_story').run({ story })
    assert.match(out.text, /已发布/)
    assert.deepEqual(out.meta, { kind: 'workshop/publish', ok: true, id: 'story-ws-test' })
    assert.deepEqual(published, ['story-ws-test'])
    const read = await byName('read_story').run({ id: 'story-ws-test' })
    assert.match(read.text, /工坊测试剧本/)
    assert.match((await byName('list_stories').run({})).text, /story-ws-test《工坊测试剧本》/)
    // 校验失败不回调
    const bad = await byName('publish_story').run({ story: { ...story, id: 'bad' } })
    assert.match(bad.text, /校验失败/)
    assert.deepEqual(published, ['story-ws-test'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('覆盖发布写回原目录：剧本住在别的目录名下时不另起一份', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios') }
    mkdirSync(path.join(config.scenariosRoot, 'legacy-name'), { recursive: true })
    writeFileSync(path.join(config.scenariosRoot, 'legacy-name', 'story.json'), JSON.stringify(story))
    assert.equal(publishStory(config, { ...story, tagline: '新卖点' }).ok, true)
    assert.ok(!existsSync(path.join(config.scenariosRoot, 'ws-test')), '不得出现同 id 的第二份源')
    assert.equal(listVersions(config, 'story-ws-test').length, 1)
    assert.equal((readStory(config, 'story-ws-test') as { tagline: string }).tagline, '新卖点')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
