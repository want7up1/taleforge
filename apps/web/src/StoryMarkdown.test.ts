/**
 * 受控 Markdown 的解析契约测试。这里不渲染 React，只验证解析器对
 * persona 允许标记的识别、以及越界标记的降级——LLM 输出不可控，越界必须安全落地。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** 与 StoryMarkdown.tsx 同源的块级分类逻辑，抽出来做纯函数验证。 */
function classify(text: string): string[] {
  const out: string[] = []
  let inQuote = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('>')) {
      if (!inQuote) out.push('quote')
      inQuote = true
      continue
    }
    inQuote = false
    if (!trimmed) continue
    out.push(/^(#{3,4})\s+/.test(trimmed) ? 'heading' : 'paragraph')
  }
  return out
}

test('识别场景标题、段落与引用块', () => {
  assert.deepEqual(
    classify('### 青泥驿\n\n雾涌进门槛。\n\n> 报——前路已断\n> 速回\n\n他握紧信筒。'),
    ['heading', 'paragraph', 'quote', 'paragraph'],
  )
})

test('h4 也算场景标题，h1/h2 降级为普通段落', () => {
  assert.deepEqual(classify('#### 后院'), ['heading'])
  assert.deepEqual(classify('# 大标题'), ['paragraph'])
  assert.deepEqual(classify('## 次标题'), ['paragraph'])
})

test('多行引用块合并为一个', () => {
  assert.deepEqual(classify('> 一\n> 二\n> 三'), ['quote'])
})

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g

test('行内标记切分：加粗、斜体、短代码', () => {
  const parts = '他摸到**火漆印**，指尖*发烫*，编号 `丙七`。'.split(INLINE).filter(Boolean)
  assert.ok(parts.includes('**火漆印**'))
  assert.ok(parts.includes('*发烫*'))
  assert.ok(parts.includes('`丙七`'))
})

test('未闭合的星号不误判为标记', () => {
  const parts = '他说*了一半'.split(INLINE).filter(Boolean)
  assert.deepEqual(parts, ['他说*了一半'])
})
