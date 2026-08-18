/**
 * 回合输出契约解析：GM 正文以单独一行【行动】结尾，随后 A./B./C./D. 四行选项。
 * 契约定义在剧本编译器的 persona 模板（硬性规则 2）。
 */
import type { ActionOption } from './types.ts'

export interface ParsedTurn {
  narrative: string
  options: ActionOption[]
}

const MARKER = /^\s*【行动】\s*$/m
const OPTION = /^\s*([A-D])[.、．]\s*(.+)\s*$/

export function parseTurn(text: string): ParsedTurn {
  const match = MARKER.exec(text)
  if (!match) return { narrative: text.trimEnd(), options: [] }

  const narrative = text.slice(0, match.index).trimEnd()
  const options: ActionOption[] = []
  for (const line of text.slice(match.index + match[0].length).split('\n')) {
    const m = OPTION.exec(line)
    if (m) options.push({ key: m[1], label: m[2] })
  }
  return { narrative, options }
}
