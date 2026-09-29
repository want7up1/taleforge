import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { storySchema } from '../../../packages/scenario-compiler/src/index.ts'
import { testStoryInput } from '../../../packages/engine/src/testkit.ts'
import { blankStory, draftHints, fromDraft, issueText, pathLabel, sectionOf, splitWords, toDraft } from './drafts.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('词表框拆词：顿号、逗号、分号、换行都认，去空白去重', () => {
  assert.deepEqual(splitWords('缆桩、跳板,舢板\n\n 讨海；缆桩;  '), ['缆桩', '跳板', '舢板', '讨海'])
  assert.deepEqual(splitWords(''), [])
})

test('往返不丢东西：剧本载入表单再原样存出来，过 schema 后与原剧本一字不差（只把 format 升到 v1.1）', () => {
  for (const source of [testStoryInput, JSON.parse(readFileSync(path.join(repoRoot, 'presets-dev/baseline/story.json'), 'utf8'))]) {
    const original = storySchema.parse(source)
    const roundTrip = storySchema.parse(fromDraft(toDraft(original)))
    assert.deepEqual(roundTrip, { ...original, format: 'taleforge.story.v1.1' })
  }
})

test('存出来时空的可选字段整个去掉：空暗线、空口吻、空提醒、没启用的机制段都不出现', () => {
  const d = blankStory()
  d.id = 'story-new'
  d.cast.push({ id: 'a', name: '甲', identity: '路人', secret: '', voice: [] })
  d.acts[0].reminder = '  '
  const out = fromDraft(d) as Record<string, any>
  assert.deepEqual(out.cast[0], { id: 'a', name: '甲', identity: '路人' })
  assert.equal('reminder' in out.acts[0], false)
  assert.equal('mechanics' in out, false)
  assert.equal('lore' in out, false)
  assert.equal('lexicons' in out.craft, false)
  assert.equal(out.title, '', '必填字段留空就原样交出去，平台才报得出具体问题')
})

test('校验信息：zod 的英文缺省文案翻成中文，剧本自带的中文文案原样保留；字段路径变成看得懂的位置', () => {
  assert.equal(issueText('Too small: expected string to have >=200 characters'), '至少 200 字')
  assert.equal(issueText('Too small: expected string to have >=1 characters'), '不能为空')
  assert.equal(issueText('Invalid input: expected string, received undefined'), '必填')
  assert.equal(issueText('Too big: expected string to have <=600 characters'), '最多 600 字')
  assert.equal(issueText('Too small: expected number to be >0'), '要大于 0')
  assert.equal(issueText('剧本 id 必须形如 story-xxx（kebab-case）'), '剧本 id 必须形如 story-xxx（kebab-case）')
  assert.equal(pathLabel('acts.0.anchors.1.signal'), '幕 1 › 锚点 2 › 完成信号')
  assert.equal(pathLabel('mechanics.inventory.initial.2.name'), '机制 › 物品栏 › 开局物品 3 › 名字')
  assert.equal(pathLabel('mechanics.resources.0.initial'), '机制 › 资源 1 › 初值')
  assert.equal(sectionOf('acts.3.title'), 'acts')
  assert.equal(sectionOf('tagline'), 'basic')
})

test('编辑器提醒：每幕都有分幕提醒时全局提醒是死文本；没有必需锚点的幕会被跳过；单字强度词；跨幕重复的锚点 id', () => {
  const d = toDraft(storySchema.parse(testStoryInput))
  assert.equal(draftHints(d).length, 1)
  assert.match(draftHints(d)[0], /^强度词表里有单字：血。/, '测试剧本自己的词表就是单字「血」')
  d.craft.intensity_words = ['血迹']
  assert.deepEqual(draftHints(d), [], '干净的剧本不提醒')
  d.acts.forEach(a => (a.reminder = '分幕'))
  d.acts[1].anchors.forEach(x => (x.required = false))
  d.craft.intensity_words = ['血', '血迹']
  d.acts[1].anchors[0].id = d.acts[0].anchors[0].id
  const hints = draftHints(d).join('\n')
  assert.match(hints, /全局贴身提醒永远不会发给 GM/)
  assert.match(hints, /第 2 幕没有必需锚点/)
  assert.match(hints, /单字：血/)
  assert.match(hints, /锚点 id 在多幕里重复/)
})
