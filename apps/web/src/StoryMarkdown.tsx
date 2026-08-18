/**
 * 受控 Markdown 渲染：只认 GM persona 规则 7 允许的标记，其余原样降级为纯文本。
 * 手写白名单而非通用库——LLM 输出不可控，越界标记降级比报错或渲染出意外结构安全。
 */
import { Fragment, type ReactNode } from 'react'

interface Props {
  text: string
  /** 正文中出现这些名字时渲染为可点击（角色档案）。 */
  characters?: string[]
  onCharacter?: (name: string) => void
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g

function renderInline(
  text: string,
  characters: string[],
  onCharacter?: (name: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0

  const withCharacters = (plain: string): ReactNode[] => {
    if (!characters.length || !onCharacter) return [plain]
    // 名字按长度降序，避免短名先匹配吃掉长名
    const pattern = new RegExp(
      `(${characters
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`,
      'g',
    )
    return plain.split(pattern).map((piece, i) =>
      characters.includes(piece)
        ? (
            <button key={`c${key++}-${i}`} className="char-ref" onClick={() => onCharacter(piece)}>
              {piece}
            </button>
          )
        : <Fragment key={`t${key++}-${i}`}>{piece}</Fragment>,
    )
  }

  for (const part of text.split(INLINE)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={key++}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(<code key={key++}>{part.slice(1, -1)}</code>)
    } else if (part.startsWith('*') && part.endsWith('*')) {
      nodes.push(<em key={key++}>{part.slice(1, -1)}</em>)
    } else {
      nodes.push(<Fragment key={key++}>{withCharacters(part)}</Fragment>)
    }
  }
  return nodes
}

export function StoryMarkdown({ text, characters = [], onCharacter }: Props) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let quote: string[] = []
  let key = 0

  const flushQuote = () => {
    if (!quote.length) return
    blocks.push(
      <blockquote key={`q${key++}`}>
        {quote.map((l, i) => <p key={i}>{renderInline(l, characters, onCharacter)}</p>)}
      </blockquote>,
    )
    quote = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('>')) {
      quote.push(trimmed.replace(/^>\s?/, ''))
      continue
    }
    flushQuote()

    if (!trimmed) continue

    const heading = /^(#{3,4})\s+(.*)$/.exec(trimmed)
    if (heading) {
      blocks.push(<h3 key={`h${key++}`}>{heading[2]}</h3>)
      continue
    }

    blocks.push(
      <p key={`p${key++}`}>{renderInline(trimmed, characters, onCharacter)}</p>,
    )
  }
  flushQuote()

  return <div className="story">{blocks}</div>
}
