/**
 * 测试用具：脚本化的假模型 + 一部覆盖全部货架件的测试剧本。
 * 不进生产路径（index.ts 不导出），只给 *.test.ts 与离线回归脚本用。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChatOptions, ChatRequest, ChatResult, LlmClient, ToolCall } from '@taleforge/llm'
import { storySchema, type Lexicon, type Story } from '@taleforge/scenario-compiler'
import { SessionStore } from '@taleforge/store'
import { Engine, type EngineSettings } from './engine.ts'

export type Reply = Partial<Pick<ChatResult, 'content' | 'reasoning' | 'toolCalls' | 'finishReason'>> & { usage?: ChatResult['usage'] }

export interface ScriptedCall {
  request: ChatRequest
  kind: 'prose' | 'settle' | 'offstage' | 'recap' | 'agent'
}

/** 按请求形状分派的假模型：谁在调（正文/结算/场外/提要/工坊）一眼可辨，各自排队取脚本。 */
export class FakeLlm implements LlmClient {
  readonly calls: ScriptedCall[] = []
  readonly queues: Record<ScriptedCall['kind'], (Reply | ((req: ChatRequest) => Reply))[]> = {
    prose: [], settle: [], offstage: [], recap: [], agent: [],
  }

  /** 正文步没脚本时的默认章节 */
  defaultChapter = (n: number) => `### 第${n}章\n\n雨落在铁皮屋顶上，**旧钥匙**在她掌心发烫。${'他们沿着走廊往里走。'.repeat(20)}`
  /** 挂起正文步，直到 release()（取消测试用） */
  hold?: Promise<void>

  static kindOf(req: ChatRequest): ScriptedCall['kind'] {
    const tc = req.toolChoice
    if (typeof tc === 'object' && tc.function.name === 'settle_turn') return 'settle'
    const last = req.messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
    if (last.includes('【前情提要写作任务】')) return 'recap'
    if (last.includes('【玩家的场外消息】')) return 'offstage'
    if (req.messages.some(m => m.role === 'user' && m.content.includes('【本章】'))) return 'prose'
    return 'agent'
  }

  async chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
    const kind = FakeLlm.kindOf(request)
    this.calls.push({ request: structuredClone(request), kind })
    if (kind === 'prose' && this.hold) {
      await new Promise<void>((resolve, reject) => {
        void this.hold!.then(resolve)
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (options.signal?.aborted) throw new Error('aborted')
    const next = this.queues[kind].shift()
    let reply: Reply = typeof next === 'function' ? next(request) : next ?? {}
    if (!next) {
      if (kind === 'prose') reply = { content: this.defaultChapter(this.calls.filter(c => c.kind === 'prose').length), reasoning: '想一想' }
      if (kind === 'settle') reply = { toolCalls: [settleCall({ options: ['A 选项', 'B 选项', 'C 选项', 'D 选项'] })] }
      if (kind === 'recap') reply = { content: '前情：他们来到了镇上。' }
      if (kind === 'offstage') reply = { content: '（场外）好的。' }
      if (kind === 'agent') reply = { content: '你好，我是工坊。' }
    }
    if (reply.reasoning) options.handlers?.onReasoning?.(reply.reasoning)
    for (const call of reply.toolCalls ?? []) options.handlers?.onToolCall?.(call.function.name)
    if (reply.content) {
      for (const piece of reply.content.match(/[\s\S]{1,40}/g) ?? []) options.handlers?.onText?.(piece)
    }
    return {
      content: reply.content ?? '',
      reasoning: reply.reasoning ?? '',
      toolCalls: reply.toolCalls ?? [],
      finishReason: reply.finishReason ?? (reply.toolCalls?.length ? 'tool_calls' : 'stop'),
      ms: 5,
      ...reply.content ? { firstTextMs: 2 } : {},
      usage: reply.usage ?? { promptTokens: 1000, completionTokens: 200, cacheHitTokens: 800, cacheMissTokens: 200 },
    }
  }
}

let callSeq = 0
export function toolCall(name: string, args: unknown): ToolCall {
  return { id: `call_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
export const settleCall = (args: Record<string, unknown>) => toolCall('settle_turn', { anchors: [], ...args })

export const testStoryInput = {
  format: 'taleforge.story.v1.1',
  id: 'story-kit',
  title: '测试镇',
  tagline: '一座下雨的小镇',
  world: { overview: '雨一直下。', tone: ['阴郁'], hidden_truths: [{ id: 'ht', text: '镇长是凶手' }] },
  protagonist: { name: '林', identity: '外来的侦探' },
  cast: [{ id: 'su', name: '苏晚', identity: '镇医', secret: '她认识死者', voice: ['别动。', '你又逞强。'] }],
  opening: { scene: '车站', hook: '一封没有署名的信' },
  acts: [
    {
      id: 'act-1',
      title: '初到',
      objective: '找到信的主人',
      anchors: [
        { id: 'meet-su', text: '见到苏晚', required: true, signal: '苏晚与林说上了话' },
        { id: 'find-key', text: '找到旧钥匙', required: false, signal: '钥匙到手' },
      ],
    },
    {
      id: 'act-2',
      title: '真相',
      objective: '揭开镇长',
      anchors: [{ id: 'expose', text: '揭穿镇长', required: true, signal: '镇长当众认罪' }],
    },
  ],
  mechanics: {
    resources: [
      { id: 'stamina', label: '体力', group: 'self', min: 0, max: 100, initial: 50, maxStep: 20, guidance: '奔跑 -10，休息 +20' },
      { id: 'grain', label: '口粮', group: 'world', min: 0, max: 30, initial: 10, maxStep: 10, guidance: '找到食物 +5' },
      { id: 'doom', label: '倒计时', group: 'world', min: 0, max: 10, initial: 10, maxStep: 3, guidance: '拖延 -1', display: 'hidden' },
    ],
    upkeep: [{ id: 'grain', delta: -1, reason: '每日口粮' }],
    attributes: [{ id: 'wit', label: '机敏', initial: 3, min: 0, max: 10, guidance: '破解谜题 +1' }],
    checks: { die: 'd20', guidance: '危险行动必掷；难度 10/15/20' },
    inventory: { guidance: '钥匙、信件这类可交出的东西要入账', initial: [{ id: 'letter', name: '无名信', qty: 1 }] },
    progression: { label: '经验', guidance: '推进主线 +20', maxStep: 50, thresholds: [20, 60], pointsPerLevel: 2 },
  },
  craft: {
    modules: ['standard'],
    rules: ['雨声不停'],
    reminder: '每章都要有雨。',
    intensity_words: ['血'],
    action_options: 4,
  },
  lore: [{ id: 'station', title: '旧车站', triggers: ['车站', '站台'], text: '车站废弃了十年。' }],
}

export const testStory = (): Story => storySchema.parse(structuredClone(testStoryInput))

export const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  model: 'deepseek-flash',
  effort: 'high',
  recentChapters: 5,
  recapEvery: 4,
  ...over,
})

export function makeEngine(opts: { llm?: FakeLlm; settings?: Partial<EngineSettings>; story?: Story; rolls?: number[]; lexicons?: () => Lexicon[] } = {}) {
  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'tf-engine-')))
  const llm = opts.llm ?? new FakeLlm()
  const rolls = [...(opts.rolls ?? [])]
  const engine = new Engine({
    store,
    llm,
    settings: () => settings(opts.settings),
    currentStory: () => opts.story,
    lexicons: ids => (opts.lexicons?.() ?? []).filter(l => ids.includes(l.id)),
    agentPersona: '你是工坊。',
    agentTools: () => [],
    observerLog: path.join(store.root, 'observer-v2.jsonl'),
    randInt: sides => rolls.shift() ?? Math.ceil(sides / 2),
  })
  return { engine, store, llm }
}

/** 跑一个回合并等它结束 */
export async function turn(engine: Engine, id: string, text: string): Promise<void> {
  engine.prompt(id, text)
  await engine.idle(id)
}
