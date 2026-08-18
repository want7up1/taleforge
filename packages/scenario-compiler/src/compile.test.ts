import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { compileScenario, storySchema } from './index.ts'

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
  style: { extra_rules: [] },
}

test('schema 拒绝非法剧本 id', () => {
  assert.throws(() => storySchema.parse({ ...story, id: 'wrong-prefix' }))
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
