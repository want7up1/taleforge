/**
 * 受控 Markdown 的解析契约。不渲染 React，只验证块级解析：persona 允许的标记被识别，
 * 越界标记安全降级——LLM 输出不可控，越界必须安全落地。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBlocks } from './markdown.ts'

const types = (text: string) => parseBlocks(text).map(b => b.type)

test('识别场景标题、段落与引用块', () => {
  assert.deepEqual(types('### 青泥驿\n\n雾涌进门槛。\n\n> 报——前路已断\n> 速回\n\n他握紧信筒。'), ['heading', 'paragraph', 'quote', 'paragraph'])
})

test('标题和下一段挤在一起时也单独成块', () => {
  const blocks = parseBlocks('### 后院\n她推开门。')
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'paragraph'])
  assert.deepEqual(blocks[0], { type: 'heading', level: 3, text: '后院' })
})

test('h4 也算场景标题，h1/h2 降级为普通段落（去掉井号）', () => {
  assert.deepEqual(parseBlocks('#### 后院'), [{ type: 'heading', level: 4, text: '后院' }])
  assert.deepEqual(parseBlocks('# 大标题'), [{ type: 'paragraph', text: '大标题' }])
})

test('多行引用块合并为一个', () => {
  assert.deepEqual(parseBlocks('> 一\n> 二\n> 三'), [{ type: 'quote', text: '一\n二\n三' }])
})

test('表格与代码块降级成纯文本，不按 Markdown 渲染', () => {
  assert.deepEqual(types('| a | b |\n|---|---|\n| 1 | 2 |'), ['plain'])
  assert.deepEqual(parseBlocks('```\n代码\n```'), [{ type: 'plain', text: '代码' }])
})

test('列表识别有序与无序', () => {
  assert.deepEqual(parseBlocks('- 甲\n- 乙'), [{ type: 'list', ordered: false, items: ['甲', '乙'] }])
  assert.deepEqual(parseBlocks('1. 甲\n2. 乙'), [{ type: 'list', ordered: true, items: ['甲', '乙'] }])
})
