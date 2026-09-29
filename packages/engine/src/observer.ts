/**
 * 被动结构观测：每个回合结束跑一次纯函数检查，只追加日志、不干预、无面板（护栏 4/6）。
 * Rpgforge 实证：被动记录回本，主动评估设施变摆设——所以这里没有 LLM、没有额度消耗。
 *
 * v2 里"漏调工具""缺行动块"这两类由代码结构保证，观测改看结构保证本身有没有兑现
 * （结算步是否成功、选项个数），以及 v2 的验收指标：篇幅、强调标记、首字前工具往返、缓存命中。
 * 日志写 observer-v2.jsonl；旧的 observer.jsonl 原样保留，作改动前的对照基线。
 */
import { appendFileSync } from 'node:fs'
import type { StoredEvent } from '@taleforge/store'
import { markersOf } from './drift.ts'
import type { ChapterData, ReplyData, SettlementData, StepUsage, TurnEndData, TurnStartData } from './events.ts'

export interface TurnRecord {
  ts: string
  sessionId: string
  turn: number
  kind: 'play' | 'offstage' | 'agent' | 'aborted'
  reason?: string
  violations: string[]
  info: Record<string, unknown>
}

/**
 * 两句话有多像：去掉选项字母与标点后按相邻两字切片，重合的片数 ÷ 较短一句的片数（0 = 无关，1 = 一样）。
 * 只用来观测选项有没有原地打转（2026-09-29 线上：同一个选项换个说法反复出现），不参与任何裁决。
 */
export function optionEcho(a: string, b: string): number {
  const grams = (t: string) => {
    const chars = [...t.replace(/^[A-E][.．、]\s*/, '').replace(/[\s，。、；：:,.;!?！？「」“”"'（）()—…-]/g, '')]
    const set = new Set<string>()
    for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1])
    return set
  }
  const x = grams(a)
  const y = grams(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const g of x) if (y.has(g)) shared++
  return Math.round((shared / Math.min(x.size, y.size)) * 100) / 100
}

/** 观测选项原地打转要用的上下文：这一回合玩家的行动原话、上一回合给过的选项。 */
export interface EchoContext {
  input?: string
  previousOptions?: readonly string[]
}

/** 从整份日志里取出最后一个回合的 EchoContext（观测用；lastTurnSlice 切掉的正是这两样）。 */
export function echoContextOf(events: readonly StoredEvent[]): EchoContext {
  const start = events.findLastIndex(e => e.type === 'turn/start')
  if (start < 0) return {}
  const turn = (events[start].data as unknown as TurnStartData).turn
  const before = events.slice(0, start)
  const input = before.findLast(e => e.type === 'player/input')?.data as { text?: string } | undefined
  const prev = before.findLast(e => e.type === 'settlement')?.data as unknown as SettlementData | undefined
  return {
    ...input?.text ? { input: input.text } : {},
    ...prev && prev.turn === turn - 1 ? { previousOptions: prev.receipt.options } : {},
  }
}

/** 一个回合（turn/start..turn/end）的结构检查。纯函数，可离线跑历史存档。 */
export function inspectTurn(sessionId: string, events: readonly StoredEvent[], expectedOptions = 4, echo: EchoContext = {}): TurnRecord {
  const start = events.find(e => e.type === 'turn/start')?.data as unknown as TurnStartData | undefined
  const end = events.find(e => e.type === 'turn/end')?.data as unknown as TurnEndData | undefined
  const record: TurnRecord = {
    ts: new Date().toISOString(),
    sessionId,
    turn: start?.turn ?? 0,
    kind: start?.kind ?? 'play',
    violations: [],
    info: {},
  }
  if (end?.reason !== 'completed') {
    record.kind = 'aborted'
    record.reason = end?.reason ?? 'unknown'
    if (end?.error) record.info.error = end.error
    return record
  }
  const steps: StepUsage[] = []

  if (record.kind === 'offstage') {
    const reply = events.find(e => e.type === 'reply')?.data as unknown as ReplyData | undefined
    if (!reply?.text) record.violations.push('场外回合没有答复')
    steps.push(...reply?.steps ?? [])
    record.info.revisions = events.filter(e => e.type === 'revision').length
  }

  if (record.kind === 'play') {
    const chapter = events.find(e => e.type === 'chapter')?.data as unknown as ChapterData | undefined
    if (!chapter) {
      record.violations.push('正戏回合没有正文')
    } else {
      steps.push(...chapter.steps)
      const chars = chapter.text.length
      record.info.chars = chars
      record.info.markers = markersOf(chapter.text)
      record.info.toolRoundsBeforeText = chapter.toolRoundsBeforeText
      if (chapter.handwritten) record.info.handwritten = true
      if (!chapter.text.trim()) {
        record.violations.push(chapter.reasoning ? `正文写进了推理通道（推理 ${chapter.reasoning.length} 字，玩家看到空白）` : '正文为空')
      }
      if (chapter.ending) {
        record.info.ending = true
        if (!chapter.text.includes('——剧终——')) record.violations.push('结局章缺少「——剧终——」')
      }
      const first = chapter.steps.find(s => s.firstTextMs !== undefined)
      if (first) record.info.firstTextMs = first.firstTextMs
      const settlement = events.find(e => e.type === 'settlement')?.data as unknown as SettlementData | undefined
      if (!chapter.ending) {
        if (!settlement) {
          record.violations.push('正戏回合没有结算')
        } else {
          if (settlement.step) steps.push(settlement.step)
          if (settlement.failed) record.violations.push(`结算步失败：${settlement.failed}`)
          const opts = settlement.receipt.options.length
          record.info.options = opts
          if (!settlement.failed && opts < expectedOptions) record.violations.push(`行动选项不足（${opts}/${expectedOptions}）`)
          if (settlement.receipt.anchors.accepted.length) record.info.anchors = settlement.receipt.anchors.accepted
          if (settlement.receipt.rejected.length) record.info.rejected = settlement.receipt.rejected
          if (settlement.receipt.advancedTo !== undefined) record.info.advancedTo = settlement.receipt.advancedTo
          if (settlement.receipt.ended) record.info.finale = true
          // 选项原地打转：与玩家刚做的事、与上一回合的选项最像的一条有多像（先攒数据，暂不算违规）
          const options = settlement.receipt.options
          const input = echo.input?.trim()
          if (options.length && input && !/^（[^）]*）$/.test(input)) {
            record.info.echoInput = Math.max(...options.map(o => optionEcho(o, input)))
          }
          if (options.length && echo.previousOptions?.length) {
            record.info.echoPrev = Math.max(...options.flatMap(o => echo.previousOptions!.map(p => optionEcho(o, p))))
          }
        }
      }
    }
  }

  const prompt = steps.reduce((n, s) => n + (s.usage?.promptTokens ?? 0), 0)
  const hit = steps.reduce((n, s) => n + (s.usage?.cacheHitTokens ?? 0), 0)
  if (prompt > 0) {
    record.info.promptTokens = prompt
    record.info.cacheHitRate = Math.round((hit / prompt) * 1000) / 1000
  }
  record.info.llmMs = steps.reduce((n, s) => n + s.ms, 0)
  return record
}

/** 取日志里最后一个完整回合的事件切片（最后一个 turn/start 起到它的 turn/end）。 */
export function lastTurnSlice(events: readonly StoredEvent[]): StoredEvent[] {
  const start = events.findLastIndex(e => e.type === 'turn/start')
  return start < 0 ? [] : events.slice(start)
}

export function writeRecord(logPath: string, record: TurnRecord): void {
  try {
    appendFileSync(logPath, `${JSON.stringify(record)}\n`)
    if (record.violations.length) console.warn(`[observer] 回合 ${record.turn} 违规：${record.violations.join('；')}`)
  } catch (err) {
    console.warn('[observer] 写日志失败：', err)
  }
}
