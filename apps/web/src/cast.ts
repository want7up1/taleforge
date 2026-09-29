/**
 * 人物名录的界面逻辑：防剧透（只有在正文里出场过的人才算"已知"）与正文里的人名匹配。
 * 匹配算法移植自 Rpgforge lib/characters.ts；别名规则沿用 TaleForge：中文姓名常被简称
 * （林绾绾→绾绾），去姓后 ≥2 字的后缀也算命中。
 */
export interface CastMember {
  id: string
  name: string
  identity: string
}

export interface CharacterMatch {
  label: string
  character: CastMember
}

export function aliasesOf(c: Pick<CastMember, 'name'>): string[] {
  const short = c.name.length >= 3 ? c.name.slice(1) : ''
  return short.length >= 2 ? [short] : []
}

/** 名字（或简称）在语料里出现过的人物 id。 */
export function knownCastIds(cast: readonly CastMember[], corpus: string): Set<string> {
  const known = new Set<string>()
  for (const c of cast) {
    if ([c.name, ...aliasesOf(c)].some(label => corpus.includes(label))) known.add(c.id)
  }
  return known
}

/** 按出场先后列出一段正文里提到的人物（在场角色条用）。 */
export function mentionedIn(cast: readonly CastMember[], text: string): CastMember[] {
  return cast
    .map(c => ({ c, at: Math.min(...[c.name, ...aliasesOf(c)].map(l => text.indexOf(l)).filter(i => i >= 0)) }))
    .filter(x => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at)
    .map(x => x.c)
}

export function buildMatchers(cast: readonly CastMember[]): CharacterMatch[] {
  const out: CharacterMatch[] = []
  const seen = new Set<string>()
  for (const character of cast) {
    for (const raw of [character.name, ...aliasesOf(character)]) {
      const label = raw.trim()
      if (label.length < 2 || seen.has(label)) continue
      seen.add(label)
      out.push({ label, character })
    }
  }
  return out.sort((a, b) => b.label.length - a.label.length)
}

const isAsciiWord = (ch: string) => /^[A-Za-z0-9_]$/.test(ch)

export function findMatch(text: string, index: number, matchers: readonly CharacterMatch[]): CharacterMatch | undefined {
  for (const m of matchers) {
    if (!text.startsWith(m.label, index)) continue
    if (isAsciiWord(text[index - 1] ?? '') || isAsciiWord(text[index + m.label.length] ?? '')) continue
    return m
  }
  return undefined
}

export function nextMatchIndex(text: string, from: number, matchers: readonly CharacterMatch[]): number {
  let next = -1
  for (const m of matchers) {
    const at = text.indexOf(m.label, from)
    if (at !== -1 && (next === -1 || at < next)) next = at
  }
  return next
}
