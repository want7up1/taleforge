/**
 * 受控 Markdown 渲染（移植自 Rpgforge）：场景标题、引用块、列表、加粗/斜体/行内代码，
 * 正文里的人名渲染成可点的角色链接。表格、代码块这类越界标记降级成纯文本——
 * 模型输出不可控，越界必须安全落地。解析是纯函数（markdown.ts 的 parseBlocks），有单测。
 */
import type { ReactNode } from 'react'
import { buildMatchers, findMatch, nextMatchIndex, type CastMember, type CharacterMatch } from '../cast.ts'
import { parseBlocks, type TextBlock } from './markdown.ts'

interface Props {
  className?: string
  content: string
  characters?: readonly CastMember[]
  onCharacterClick?: (character: CastMember) => void
  showCaret?: boolean
}

export function StoryMarkdown({ characters = [], className = '', content, onCharacterClick, showCaret = false }: Props) {
  const blocks = parseBlocks(content)
  const matchers = onCharacterClick ? buildMatchers(characters) : []
  return (
    <div className={`story-markdown ${className}`}>
      {blocks.map((block, index) => renderBlock(block, index, matchers, onCharacterClick))}
      {showCaret ? <span className="story-caret">▋</span> : null}
    </div>
  )
}

function renderBlock(block: TextBlock, index: number, matchers: CharacterMatch[], onClick?: (c: CastMember) => void) {
  if (block.type === 'heading') {
    const Tag = block.level === 4 ? 'h4' : 'h3'
    return <Tag key={index}>{renderInline(block.text, matchers, onClick)}</Tag>
  }
  if (block.type === 'quote') {
    return <blockquote key={index}><Lines text={block.text} matchers={matchers} onClick={onClick} /></blockquote>
  }
  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul'
    return <Tag key={index}>{block.items.map((item, i) => <li key={i}>{renderInline(item, matchers, onClick)}</li>)}</Tag>
  }
  if (block.type === 'plain') {
    return (
      <p className="story-plain-text" key={index}>
        {block.text.split('\n').map((line, i, all) => <Fragment key={i} br={i < all.length - 1}>{line}</Fragment>)}
      </p>
    )
  }
  return <p key={index}><Lines text={block.text} matchers={matchers} onClick={onClick} /></p>
}

function Fragment({ children, br }: { children: ReactNode; br: boolean }) {
  return (
    <>
      {children}
      {br ? <br /> : null}
    </>
  )
}

function Lines({ text, matchers, onClick }: { text: string; matchers: CharacterMatch[]; onClick?: (c: CastMember) => void }) {
  return text.split('\n').map((line, i, all) => (
    <Fragment key={i} br={i < all.length - 1}>{renderInline(line, matchers, onClick)}</Fragment>
  ))
}

function renderInline(text: string, matchers: CharacterMatch[], onClick?: (c: CastMember) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > cursor) nodes.push(...renderNames(text.slice(cursor, m.index), m.index, matchers, onClick))
    if (m[2]) nodes.push(<code className="story-inline-code" key={`${m.index}-c`}>{m[2]}</code>)
    else if (m[3]) nodes.push(<strong key={`${m.index}-b`}>{renderNames(m[3], m.index, matchers, onClick)}</strong>)
    else if (m[4]) nodes.push(<em key={`${m.index}-i`}>{renderNames(m[4], m.index, matchers, onClick)}</em>)
    cursor = m.index + m[0].length
  }
  if (cursor < text.length) nodes.push(...renderNames(text.slice(cursor), cursor, matchers, onClick))
  return nodes
}

function renderNames(text: string, keyOffset: number, matchers: CharacterMatch[], onClick?: (c: CastMember) => void): ReactNode[] {
  if (!onClick || matchers.length === 0 || !text) return [text]
  const nodes: ReactNode[] = []
  let cursor = 0
  while (cursor < text.length) {
    const match = findMatch(text, cursor, matchers)
    if (!match) {
      const next = nextMatchIndex(text, cursor + 1, matchers)
      const end = next === -1 ? text.length : next
      nodes.push(text.slice(cursor, end))
      cursor = end
      continue
    }
    nodes.push(
      <button
        className="story-character-link"
        key={`${keyOffset}-${cursor}-${match.character.id}`}
        onClick={() => onClick(match.character)}
        type="button"
      >
        {text.slice(cursor, cursor + match.label.length)}
      </button>,
    )
    cursor += match.label.length
  }
  return nodes
}
