import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTurn } from './turn.ts'

test('解析标准行动块', () => {
  const { narrative, options } = parseTurn(
    '雾更浓了。\n\n【行动】\nA. 跟上驿丞\nB. 查看后院\nC、盘问马贩子\nD． 回房护信',
  )
  assert.equal(narrative, '雾更浓了。')
  assert.deepEqual(options.map(o => o.key), ['A', 'B', 'C', 'D'])
  assert.equal(options[2].label, '盘问马贩子')
})

test('无行动块时全文为叙事', () => {
  const { narrative, options } = parseTurn('故事结束了。')
  assert.equal(narrative, '故事结束了。')
  assert.equal(options.length, 0)
})

test('正文中提及【行动】二字不误触发（标记须独占一行）', () => {
  const text = '他说："快【行动】起来！"'
  const { narrative, options } = parseTurn(text)
  assert.equal(narrative, text)
  assert.equal(options.length, 0)
})
