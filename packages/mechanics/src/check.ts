/**
 * 判定的裁决——掷骰在工具执行时发生一次，结果落进 tool/result.meta 持久化；
 * 重放与 fork 读的是落账的结果，不重掷。resolve 是纯函数，掷骰由调用方注入。
 */
import type { CheckOutcome, CheckResult, Die } from './types.ts'

export const DIE_RANGE: Record<Die, { rolls: number; sides: number }> = {
  'd20': { rolls: 1, sides: 20 },
  'd100': { rolls: 1, sides: 100 },
  '2d6': { rolls: 2, sides: 6 },
}

/** randInt(sides) 需返回 1..sides 的整数。 */
export function rollDie(die: Die, randInt: (sides: number) => number): number {
  const { rolls, sides } = DIE_RANGE[die]
  let total = 0
  for (let i = 0; i < rolls; i++) total += randInt(sides)
  return total
}

/**
 * 裁决一次判定。大成功/大失败仅 d20：天然 20 必成、天然 1 必败，
 * 其余骰型只有普通成败——不同骰型的暴击惯例差异太大，不猜。
 */
export function resolveCheck(input: {
  die: Die
  roll: number
  difficulty: number
  attribute?: string
  attrValue: number
  modifier: number
  reason: string
}): CheckResult {
  const total = input.roll + input.attrValue + input.modifier
  let outcome: CheckOutcome
  if (input.die === 'd20' && input.roll === 20) outcome = 'crit-success'
  else if (input.die === 'd20' && input.roll === 1) outcome = 'crit-fail'
  else outcome = total >= input.difficulty ? 'success' : 'fail'
  return {
    kind: 'mechanics/check',
    die: input.die,
    roll: input.roll,
    attribute: input.attribute,
    attrValue: input.attrValue,
    modifier: input.modifier,
    total,
    difficulty: input.difficulty,
    outcome,
    reason: input.reason,
  }
}

/** 回给 GM 的裁决文本：结果即事实，只许承接不许翻案。 */
export function renderCheck(result: CheckResult, attrLabel?: string): string {
  const parts = [`掷 ${result.die} = ${result.roll}`]
  if (result.attribute) parts.push(`${attrLabel ?? result.attribute} ${result.attrValue >= 0 ? '+' : ''}${result.attrValue}`)
  if (result.modifier !== 0) parts.push(`情境修正 ${result.modifier > 0 ? '+' : ''}${result.modifier}`)
  const math = `${parts.join('，')}，合计 ${result.total}，难度 ${result.difficulty}`
  const verdict = {
    'crit-success': '大成功——不仅成了，再给一个亮眼的额外收获。',
    'success': '成功——让他成得干脆。',
    'fail': '失败——用「否，但…」承接：受阻，但留下转机或新信息。',
    'crit-fail': '大失败——失败并附加一个新麻烦。',
  }[result.outcome]
  return `判定（${result.reason}）：${math} → ${verdict}\n这是最终裁决，按此叙事，正文里不出现点数与难度数字。`
}
