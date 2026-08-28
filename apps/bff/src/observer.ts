/**
 * 被动结构观测：逐回合跑一组纯函数检查，只追加日志、不干预、无面板（护栏 4/6）。
 * Rpgforge 实证：被动记录回本（trace/observer 是引用率最高的基建），
 * 主动评估设施变摆设（judge/replay 使用次数≈0）——所以这里没有 LLM、没有额度消耗。
 *
 * 检查的是平台保证的"结构"：行动块、工具固定流程、场外协议、终幕格式。
 * 味道不查——那是剧本层的事，归因边界在此。
 */
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import type { TurnFact } from './drift.ts'
import { onMuxFrame } from './dsh.ts'

export interface ObservedEvent {
  type: string
  seq?: number
  time?: number
  data: Record<string, unknown>
}

export interface TurnRecord {
  ts: string
  sessionId: string
  turn?: number
  kind: 'play' | 'offstage' | 'aborted'
  /** turn/end 的非正常结束原因（error/interrupted） */
  reason?: string
  violations: string[]
  info: Record<string, unknown>
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as { type?: string; text?: string }[])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

const isOffstageAsk = (text: string) => text.trimStart().startsWith('【场外】')
const isOffstageReply = (text: string) => /^\s*[（(]场外[)）]/.test(text)

/** 一个回合里玩家可见的正文：最后一条 assistant/message 的 text 块。 */
export function visibleTextOf(events: ObservedEvent[]): string {
  let visible = ''
  let withBlock = ''
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const t = textOfBlocks((e.data as { message?: { content?: unknown } }).message?.content)
    if (!t) continue
    visible = t
    // 带行动块的那条才是玩家看的正文；工具返回后模型偶尔再补一句短话，不能拿它当正文
    if (t.includes('【行动】')) withBlock = t
  }
  return withBlock || visible
}

/**
 * 最近几回合的事实，供回合头注入做漂移回灌（apps/bff drift.ts）。
 * **只在内存**：正文是剧情内容，日志留痕只记统计数字，不落盘。
 * 新的在前；只留够判定用的长度，进程重启后从下一回合重新攒。
 */
const RECENT_KEEP = 4
const recentFacts = new Map<string, TurnFact[]>()

export function factsOf(sessionId: string): readonly TurnFact[] {
  return recentFacts.get(sessionId) ?? []
}

/**
 * 对一个完整回合（turn/start..turn/end 的事件序列）做结构检查。纯函数，可离线跑历史存档。
 * @param expectedOptions - 该剧本声明的行动选项数（craft.action_options）；数量由剧本定，
 *   平台不再假定一定是 4，取不到就按缺省 4 记。
 */
export function inspectTurn(sessionId: string, events: ObservedEvent[], expectedOptions = 4): TurnRecord {
  const end = events.find(e => e.type === 'turn/end')
  const endData = end?.data as { turn?: number; reason?: { kind?: string } } | undefined
  const reasonKind = endData?.reason?.kind
  const base: TurnRecord = {
    ts: new Date().toISOString(),
    sessionId,
    turn: endData?.turn,
    kind: 'play',
    violations: [],
    info: {},
  }

  const userText = textOfBlocks(events.find(e => e.type === 'user/message')?.data?.content)
  const toolCalls = events
    .filter(e => e.type === 'tool/call')
    .map(e => String((e.data as { name?: unknown }).name ?? ''))

  const visible = visibleTextOf(events)
  let reasoningChars = 0
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const content = (e.data as { message?: { content?: unknown } }).message?.content
    if (Array.isArray(content)) {
      for (const b of content as { type?: string; text?: string }[]) {
        if (b?.type === 'reasoning' && typeof b.text === 'string') reasoningChars += b.text.length
      }
    }
  }

  base.info.toolCalls = toolCalls
  base.info.chars = visible.length

  if (reasonKind !== 'completed') {
    base.kind = 'aborted'
    base.reason = reasonKind ?? 'unknown'
    return base
  }

  // 通道翻车：整回合产出全写进推理通道，玩家看到空白（实测 flash 高推理档偶发）
  if (!visible && reasoningChars > 0) {
    base.kind = isOffstageAsk(userText) ? 'offstage' : 'play'
    base.violations.push(`正文写进了推理通道（推理 ${reasoningChars} 字，玩家看到空白）`)
    return base
  }

  const ending = visible.includes('——剧终——')
  const offReply = isOffstageReply(visible)

  if (isOffstageAsk(userText)) {
    base.kind = 'offstage'
    if (!offReply) base.violations.push('场外答复未以（场外）开头')
    if (visible.includes('【行动】')) base.violations.push('场外回合出现了行动块')
    if (toolCalls.includes('report_progress') || toolCalls.includes('adjust_resources')) {
      base.violations.push('场外回合调用了正戏工具')
    }
    return base
  }

  // 正戏回合
  if (toolCalls[0] !== 'report_progress') {
    base.violations.push(toolCalls.length
      ? `首个工具是 ${toolCalls[0]}，不是 report_progress`
      : '整回合未调用 report_progress')
  }
  if (offReply) base.violations.push('正戏输入得到场外格式答复')
  if (ending) {
    if (visible.includes('【行动】')) base.violations.push('终幕回合仍有行动块')
  } else if (!visible.includes('【行动】')) {
    base.violations.push('缺少行动块')
  } else {
    const opts = visible.match(/^\s*[A-D][.、．]\s*\S/gm)?.length ?? 0
    if (opts < expectedOptions) base.violations.push(`行动选项不足（${opts}/${expectedOptions}）`)
  }

  base.info.ending = ending
  base.info.markers = (visible.match(/\*\*[^*]+\*\*/g) ?? []).length
  const anchors: string[] = []
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const meta = (e.data as { meta?: { kind?: string; accepted?: unknown } }).meta
    if (meta?.kind === 'progress/report' && Array.isArray(meta.accepted)) {
      anchors.push(...(meta.accepted as string[]))
    }
  }
  if (anchors.length) base.info.anchors = anchors
  return base
}

/**
 * 挂上共享 mux：按会话缓冲整回合事件，turn/end 时检查并落一行 JSONL。
 * @param optionsOf - 按会话取该剧本声明的行动选项数；同步查（回调在 mux 帧里跑），
 *   取不到返回 undefined 即按缺省。
 */
export function startObserver(dshHome: string, optionsOf?: (sessionId: string) => number | undefined): void {
  const logPath = path.join(dshHome, 'observer.jsonl')
  const buffers = new Map<string, ObservedEvent[]>()

  onMuxFrame((frame) => {
    if (frame.type !== 'session/event' || !frame.sessionId || !frame.event) return
    const event = frame.event as ObservedEvent
    const sid = frame.sessionId
    if (event.type === 'turn/start') {
      buffers.set(sid, [event])
      return
    }
    const buffer = buffers.get(sid)
    if (!buffer) return // 半截回合（观测器晚于回合启动）不看，等下一个完整回合
    buffer.push(event)
    if (event.type !== 'turn/end') return
    buffers.delete(sid)
    const record = inspectTurn(sid, buffer, optionsOf?.(sid) ?? 4)
    const facts = recentFacts.get(sid) ?? []
    facts.unshift({
      kind: record.kind,
      markers: Number(record.info.markers ?? 0),
      text: visibleTextOf(buffer),
    })
    recentFacts.set(sid, facts.slice(0, RECENT_KEEP))
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`)
      if (record.violations.length) {
        console.warn(`[observer] 回合 ${record.turn ?? '?'} 违规: ${record.violations.join('；')}`)
      }
    } catch (err) {
      console.warn('[observer] 写日志失败:', err)
    }
  })
  console.log(`[observer] 被动结构观测已挂载 → ${logPath}`)
}
