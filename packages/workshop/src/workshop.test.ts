import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { publishStory } from './index.ts'

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
