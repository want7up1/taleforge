import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { listStories, listVersions, publishStory, readStory } from './index.ts'

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

test('发布合法剧本：写进数据根并编译出 preset', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios'), presetsRoot: path.join(root, 'presets') }
    const result = publishStory(config, story)
    assert.equal(result.ok, true)
    assert.equal(result.id, 'story-ws-test')
    assert.ok(!('issues' in result), 'ok 时不携带 issues 键（无损 JSON）')
    assert.ok(existsSync(path.join(config.scenariosRoot, 'ws-test/story.json')))
    const yml = readFileSync(path.join(config.presetsRoot, 'story-ws-test/agent.cordis.yml'), 'utf8')
    assert.match(yml, /工坊测试剧本/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('发布非法剧本：逐条错误退回、不落盘任何文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tf-ws-'))
  try {
    const config = { scenariosRoot: path.join(root, 'scenarios'), presetsRoot: path.join(root, 'presets') }
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
    const config = { scenariosRoot: path.join(root, 'scenarios'), presetsRoot: path.join(root, 'presets') }
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
    const current = readStory(config.presetsRoot, 'story-ws-test') as { acts: { anchors: unknown[] }[] }
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
    const config = { scenariosRoot: path.join(root, 'scenarios'), presetsRoot: path.join(root, 'presets') }
    publishStory(config, story)
    // 混入非剧本 preset：不得出现在列表
    mkdirSync(path.join(config.presetsRoot, 'workshop'), { recursive: true })

    const list = listStories(config.presetsRoot)
    assert.deepEqual(list, [{ id: 'story-ws-test', title: '工坊测试剧本', tagline: '一句话' }])

    const loaded = readStory(config.presetsRoot, 'story-ws-test')
    assert.equal((loaded as { title: string }).title, '工坊测试剧本')
    assert.equal(readStory(config.presetsRoot, 'story-nope'), undefined)
    assert.equal(readStory(config.presetsRoot, '../etc/passwd'), undefined, '路径穿越必须被 id 正则拦下')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
