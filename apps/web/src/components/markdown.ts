/** 受控 Markdown 的块级解析（纯函数，StoryMarkdown 渲染用；单测在 StoryMarkdown.test.ts）。移植自 Rpgforge。 */

export type TextBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'plain'; text: string }
  | { type: 'paragraph'; text: string }

export function parseBlocks(content: string): TextBlock[] {
  const normalized = isolateHeadings(content.replace(/\r\n/g, '\n').trim())
  if (!normalized) return []
  return normalized.split(/\n{2,}/).map(chunk => chunk.trim()).filter(Boolean).map(parseBlock)
}

/** 标题单独成块：模型常把场景标题和下一段正文挤在一起 */
function isolateHeadings(content: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()
    const isFence = trimmed.startsWith('```')
    if (!inFence && /^(#{3,4})\s+.+$/.test(trimmed)) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      out.push(trimmed)
      out.push('')
      continue
    }
    out.push(line)
    if (isFence) inFence = !inFence
  }
  return out.join('\n').trim()
}

function parseBlock(chunk: string): TextBlock {
  const lines = chunk.split('\n').map(line => line.trimEnd())
  if (lines.length >= 2 && lines[0].trimStart().startsWith('```') && lines[lines.length - 1].trimStart().startsWith('```')) {
    return { type: 'plain', text: lines.filter(l => !l.trimStart().startsWith('```')).join('\n').trim() }
  }
  const divider = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
  if (lines.length >= 2 && lines.every(l => l.includes('|')) && lines.some(l => divider.test(l))) {
    return { type: 'plain', text: lines.join('\n') }
  }
  const heading = lines.length === 1 ? /^(#{3,4})\s+(.+)$/.exec(lines[0]) : null
  if (heading) return { type: 'heading', level: heading[1].length, text: heading[2].trim() }
  if (lines.every(l => /^>\s?/.test(l.trimStart()))) {
    return { type: 'quote', text: lines.map(l => l.trimStart().replace(/^>\s?/, '')).join('\n') }
  }
  const items = lines.map(l => /^(([-*+])|(\d+[.)]))\s+(.+)$/.exec(l.trimStart()))
  if (items.every(Boolean)) {
    return { type: 'list', ordered: items.some(m => Boolean(m?.[3])), items: items.map(m => m?.[4].trim() ?? '') }
  }
  // H1/H2 越界：降级成普通段落（去掉井号）
  return { type: 'paragraph', text: lines.map(l => l.replace(/^#{1,2}\s+/, '')).join('\n') }
}
