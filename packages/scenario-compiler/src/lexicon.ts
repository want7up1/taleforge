/**
 * 词库（平台货架件，2026-09-29）：平台级的用词表，剧本在 craft.lexicons 里声明了才挂上——
 * 不声明就没有（无隐藏默认）。存在数据卷 lexicons/<id>.json，界面导入导出；改了重新导入，
 * 进行中的局下一回合就用上。
 *
 * 词库只管"用什么词写"。写不写、写到什么程度，仍由剧本的 rating 与提醒决定——
 * 平台的框定语保持中立，不说"直呼""别委婉"这类带强度的话；要不要直呼由词库自己的 guide 说
 * （强度分层：平台货架永不携带强度）。
 *
 * 和 craft.intensity_words 是两件事：那张表是漂移探测器，只收只在目标语境里出现的词、
 * 不给 GM 看；词库是给 GM 看的词汇，要全，单字、节奏词、场所词都可以收。
 */
import { z } from 'zod'

/** 单个词库渲染进固定前缀后的字数上限：词表越长，每条指令分到的注意力越少。 */
export const LEXICON_MAX_CHARS = 8000

export const LEXICON_ID = /^[a-z0-9][a-z0-9-]*$/

interface LexiconShape {
  id: string
  title: string
  guide?: string
  groups: { label: string; note?: string; words: string[] }[]
}

const uniq = (words: readonly string[]) => [...new Set(words.map(w => w.trim()).filter(Boolean))]

/** 一个词库在固定前缀里的样子：标题、用法说明、每组一行。 */
export function renderLexicon(lex: LexiconShape): string {
  const groups = lex.groups
    .map(g => `- ${g.label}${g.note ? `（${g.note}）` : ''}：${uniq(g.words).join('、')}`)
    .join('\n')
  return `## 《${lex.title}》${lex.guide ? `\n\n${lex.guide}` : ''}\n\n${groups}`
}

export const lexiconSchema = z.object({
  format: z.literal('taleforge.lexicon.v1'),
  id: z.string().regex(LEXICON_ID, '词库 id 需为 kebab-case（小写字母、数字、连字符）'),
  title: z.string().min(1).max(40),
  /** 用法说明（进 GM 固定前缀）：这套词用在什么场面、要不要直呼、怎么轮换——词库自己说，平台不替它说。 */
  guide: z.string().min(1).max(600).optional(),
  groups: z.array(z.object({
    label: z.string().min(1).max(30),
    /** 这一组的用法提示（可选），比如"古风场面用""只在系统播报里出现" */
    note: z.string().min(1).max(200).optional(),
    words: z.array(z.string().trim().min(1).max(40)).min(1),
  })).min(1).max(40),
}).superRefine((lex, ctx) => {
  const size = renderLexicon(lex).length
  if (size > LEXICON_MAX_CHARS) {
    ctx.addIssue({
      code: 'custom',
      path: ['groups'],
      message: `词库渲染后 ${size} 字，超过上限 ${LEXICON_MAX_CHARS} 字——精选到上限以内，或按风格拆成几个词库`,
    })
  }
})

export type Lexicon = z.infer<typeof lexiconSchema>

/**
 * 剧本选用的词库在固定前缀里的整段（排在工艺模块之后、剧本数据之前——它和工艺模块一样是货架件）。
 * 没有选用任何词库就返回空串，前缀与从前逐字节相同。
 */
export function renderLexicons(lexicons: readonly LexiconShape[]): string {
  if (!lexicons.length) return ''
  return `# 用词库（本剧本选用）

写到下面这些内容时，优先用这里的词——这是作者为本作挑定的说法。同一段里轮换着用，别让一个词反复出现。这是可用的词汇，不是每章都要出现的清单：写不写、写到什么程度，仍以剧本的内容强度与提醒为准。

${lexicons.map(renderLexicon).join('\n\n')}`
}

/** 词库里的全部词，各组轮流取（漂移提醒挑词用：轮流取才不会十个词全来自同一组）。 */
export function interleavedWords(lexicons: readonly LexiconShape[]): string[] {
  const columns = lexicons.flatMap(l => l.groups.map(g => uniq(g.words)))
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; columns.some(c => i < c.length); i++) {
    for (const column of columns) {
      const word = column[i]
      if (word !== undefined && !seen.has(word)) {
        seen.add(word)
        out.push(word)
      }
    }
  }
  return out
}
