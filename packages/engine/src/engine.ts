/**
 * 回合流水线（CLAUDE.md「v2 内核重建 · 回合流水线」）：
 *
 *   【场外】→ 场外步：开思考，只认 revise_setting；不结算，不出选项
 *   正戏  → ① 组装上下文
 *         → ② 正文步：开思考，工具只认 roll_check（auto），流式推送
 *         → ③ 结算步：关思考，tool_choice 指定 settle_turn，由代码裁决落账
 *         → ④ 写入事件，推送面板和选项
 *         → ⑤ 纯函数观测
 *         → ⑥ 后台按需生成前情提要（不占玩家的等待时间）
 *   其他：手写开场直接作为第 1 回合，不调模型；加点直接写一条事件；
 *         重写上一回合 = 截断日志后重跑；取消 = 中止请求
 *
 * 玩家等待路径上只有同一个 GM（护栏 1）：正文步与结算步是同一段上下文的两次续写。
 */
import type { AgentTool, ChatMessage, ChatResult, LlmClient, ReasoningEffort, ToolCall } from '@taleforge/llm'
import { applyAllocations } from '@taleforge/mechanics'
import { renderPersona, type Lexicon, type Story } from '@taleforge/scenario-compiler'
import type { SessionStore, StoredEvent } from '@taleforge/store'
import type {
  ActAdvancedData,
  AgentMessageData,
  ChapterData,
  CheckData,
  CreatedData,
  Effort,
  ModelChoice,
  PlayerInputData,
  PointsSpentData,
  RecapData,
  ReplyData,
  SettlementData,
  StepUsage,
  ToolResultData,
  TurnEndData,
  TurnStartData,
} from './events.ts'
import { actsOf, attributeDefs, foldSession, phaseOf, type SessionState } from './fold.ts'
import { inspectTurn, lastTurnSlice, writeRecord } from './observer.ts'
import {
  hotStory,
  proseOf,
  renderOffstageMessage,
  renderPlayMessage,
  renderRecapMessage,
  settlementBrief,
  windowChapters,
} from './prompts.ts'
import { SETTLE_TOOL, adjudicate } from './settle.ts'
import { CHECK_TOOL, REVISE_TOOL, gameTools, parseArgs, runCheck, runRevise } from './tools.ts'
import { sessionView, type SessionView } from './view.ts'

export interface EngineSettings {
  model: string
  effort: Effort
  /** 正文窗口保留的最近章数 K */
  recentChapters: number
  /** 每攒满多少章滚一次前情提要 N（窗口在 K 与 K+N-1 章之间摆动） */
  recapEvery: number
}

export interface EngineDeps {
  store: SessionStore
  llm: LlmClient
  settings: () => EngineSettings
  /** 剧本现行正式版（进行中的局从这里取热字段）；找不到就只用开局快照 */
  currentStory?: (id: string) => Story | undefined
  /** 词库现行版：按 id 现读（改了重新导入，下一回合就用上），缺的、坏的跳过 */
  lexicons?: (ids: readonly string[]) => Lexicon[]
  /** 工坊与修改对话的 persona 与工具 */
  agentPersona?: string
  agentTools?: () => AgentTool[]
  /** 被动观测日志路径；不给就不写 */
  observerLog?: string
  /** 掷骰（测试注入） */
  randInt?: (sides: number) => number
}

export type Frame =
  | { type: 'event'; event: StoredEvent }
  | { type: 'delta'; seq: number; channel: 'text'; text: string }
  | { type: 'phase'; seq: number; phase: string }
  | { type: 'state'; state: SessionView }
  | { type: 'reset' }

export class EngineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

interface Running {
  controller: AbortController
  kind: TurnStartData['kind']
  startedAt: number
  partial: string
  lastDeltaSeq: number
  phase?: string
  done: Promise<void>
}

export interface Inflight {
  kind: TurnStartData['kind']
  partial: string
  lastChunkSeq: number
  startedAt: number
  phase?: string
}

const OFFSTAGE_PREFIX = /^\s*【场外】\s*/
const MAX_PROSE_ROUNDS = 4
const MAX_AGENT_ROUNDS = 12

const stepOf = (model: string, r: ChatResult): StepUsage => ({
  model,
  ms: r.ms,
  ...r.firstTextMs !== undefined ? { firstTextMs: r.firstTextMs } : {},
  ...r.usage ? { usage: r.usage } : {},
})

/**
 * 发给界面的事件：剥掉开局剧本快照（含隐藏真相与人物暗线，下发等于剧透）、推理文本与
 * 结算原始参数（体积大且界面用不到）。
 */
export function publicEvent(event: StoredEvent): StoredEvent {
  const data = { ...event.data }
  if (event.type === 'session/created') delete data.story
  if (event.type === 'chapter' || event.type === 'reply' || event.type === 'agent/message') delete data.reasoning
  if (event.type === 'settlement') delete data.args
  return { ...event, data }
}

/**
 * 玩家行动里的【加点】行（前端按属性显示名写：`【加点】力量 +2、敏捷 +1`）→ 属性 id 与点数。
 * 换算用现行属性名录（含改名修订），认不出的名字忽略。返回去掉这一行的行动原话。
 */
export function extractAllocations(text: string, defs: { id: string; label: string }[]): { text: string; allocations: { id: string; points: number }[] } {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.trim().startsWith('【加点】'))
  if (at < 0) return { text, allocations: [] }
  const allocations: { id: string; points: number }[] = []
  for (const part of lines[at].trim().slice('【加点】'.length).split(/[、,，;；]/)) {
    const m = /^(.+?)\s*\+\s*(\d+)\s*$/.exec(part.trim())
    if (!m) continue
    const def = defs.find(d => d.label === m[1] || d.id === m[1])
    if (!def) continue
    const hit = allocations.find(a => a.id === def.id)
    if (hit) hit.points += Number(m[2])
    else allocations.push({ id: def.id, points: Number(m[2]) })
  }
  lines.splice(at, 1)
  return { text: lines.join('\n').trim(), allocations }
}

export class Engine {
  private readonly deps: EngineDeps
  private readonly listeners = new Map<string, Set<(frame: Frame) => void>>()
  private readonly running = new Map<string, Running>()
  private readonly recaps = new Map<string, Promise<void>>()

  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  // ---- 订阅与推送 ----

  subscribe(sessionId: string, listener: (frame: Frame) => void): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  private emit(sessionId: string, frame: Frame): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(frame)
      } catch (err) {
        console.warn('[engine] 推送失败：', err)
      }
    }
  }

  private append<T extends object>(sessionId: string, type: string, data: T): StoredEvent {
    const event = this.deps.store.append(sessionId, type, data as unknown as Record<string, unknown>)
    this.emit(sessionId, { type: 'event', event: publicEvent(event) })
    return event
  }

  private phase(sessionId: string, phase: string): void {
    const run = this.running.get(sessionId)
    if (run) run.phase = phase
    this.emit(sessionId, { type: 'phase', seq: this.deps.store.nextSeq(sessionId), phase })
  }

  private delta(sessionId: string, text: string): void {
    const seq = this.deps.store.nextSeq(sessionId)
    const run = this.running.get(sessionId)
    if (run) {
      run.partial += text
      run.lastDeltaSeq = seq
      run.phase = undefined
    }
    this.emit(sessionId, { type: 'delta', seq, channel: 'text', text })
  }

  private pushState(sessionId: string): void {
    this.emit(sessionId, { type: 'state', state: this.view(sessionId) })
  }

  // ---- 会话 ----

  private defaultModel(): ModelChoice {
    const s = this.deps.settings()
    return { model: s.model, effort: s.effort }
  }

  createGame(story: Story): string {
    const created: CreatedData = {
      kind: 'game',
      title: `《${story.title}》`,
      model: this.defaultModel(),
      story,
      storyId: story.id,
    }
    return this.deps.store.create(created as unknown as Record<string, unknown>)
  }

  createAgent(kind: 'workshop' | 'edit', scenarioId?: string): string {
    const created: CreatedData = {
      kind,
      title: kind === 'workshop' ? '剧本工坊' : '修改剧本',
      model: this.defaultModel(),
      ...scenarioId ? { scenarioId } : {},
    }
    return this.deps.store.create(created as unknown as Record<string, unknown>)
  }

  state(sessionId: string): SessionState {
    if (!this.deps.store.exists(sessionId)) throw new EngineError('not-found', '会话不存在')
    return foldSession(this.deps.store.read(sessionId))
  }

  view(sessionId: string): SessionView {
    return sessionView(this.state(sessionId))
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  inflight(sessionId: string): Inflight | undefined {
    const run = this.running.get(sessionId)
    if (!run) return undefined
    return {
      kind: run.kind,
      partial: run.partial,
      lastChunkSeq: run.lastDeltaSeq,
      startedAt: run.startedAt,
      ...run.phase ? { phase: run.phase } : {},
    }
  }

  /** 等当前回合（与后台前情提要）跑完。测试与关停用。 */
  async idle(sessionId: string): Promise<void> {
    await this.running.get(sessionId)?.done
    await this.recaps.get(sessionId)
  }

  selectModel(sessionId: string, choice: ModelChoice): void {
    this.state(sessionId)
    this.append(sessionId, 'model/selected', choice)
    this.pushState(sessionId)
  }

  // ---- 回合入口 ----

  /** 收下玩家的一条消息，在后台跑完整个回合；立即返回。 */
  prompt(sessionId: string, rawText: string): void {
    const text = rawText.trim()
    if (!text) throw new EngineError('bad-request', '内容不能为空')
    if (this.running.has(sessionId)) throw new EngineError('busy', 'GM 还在写上一回合——等它写完，或先停止')
    const state = this.state(sessionId)
    if (state.created.kind !== 'game') {
      this.start(sessionId, 'agent', signal => this.runAgent(sessionId, text, signal))
      return
    }
    if (OFFSTAGE_PREFIX.test(text)) {
      const ask = text.replace(OFFSTAGE_PREFIX, '')
      if (!ask) throw new EngineError('bad-request', '场外消息不能为空')
      this.start(sessionId, 'offstage', signal => this.runOffstage(sessionId, ask, signal))
      return
    }
    if (phaseOf(state) === 'ended') throw new EngineError('ended', '这一局已经剧终')
    const story = state.created.story!
    const { text: action, allocations } = extractAllocations(text, attributeDefs(story, state.progress.revisions))
    const input: PlayerInputData = {
      text: action || text,
      offstage: false,
      ...state.chapters.length === 0 ? { opening: true } : {},
      ...allocations.length ? { allocations } : {},
    }
    this.start(sessionId, 'play', signal => this.runPlay(sessionId, input, signal))
  }

  cancel(sessionId: string): void {
    this.running.get(sessionId)?.controller.abort()
  }

  /**
   * 重写上一回合：把日志截到上一个正戏回合的玩家输入之前（原稿先进归档），原样重发那条输入。
   * 被截掉的场外往来与修订一并回退——它们发生在被重写的那一章之后。
   */
  async retry(sessionId: string): Promise<void> {
    const run = this.running.get(sessionId)
    if (run) {
      run.controller.abort()
      await run.done
    }
    const state = this.state(sessionId)
    const cut = state.lastPlayInput
    if (!cut || state.created.kind !== 'game') throw new EngineError('no-turn', '还没有可重写的回合')
    await this.recaps.get(sessionId)
    this.deps.store.truncate(sessionId, cut.seq)
    this.emit(sessionId, { type: 'reset' })
    const input = cut.data
    this.start(sessionId, 'play', signal => this.runPlay(sessionId, input, signal))
  }

  /**
   * 回退到第 toTurn 回合结束时（Rpgforge 的"后悔药"）：其后的回合整段截掉（原稿先归档），
   * 不重跑——玩家看到第 toTurn 回合的正文与选项，重新选择。toTurn = 0 即从头重开，
   * 界面会像新开局一样补发开场。第 toTurn 回合之后的场外往来与修订一并回退。
   */
  async rewind(sessionId: string, toTurn: number): Promise<void> {
    const run = this.running.get(sessionId)
    if (run) {
      run.controller.abort()
      await run.done
    }
    await this.recaps.get(sessionId)
    const events = this.deps.store.read(sessionId)
    if (foldSession(events).created.kind !== 'game') throw new EngineError('no-turn', '只有游戏会话能回退')
    let lastInput: number | undefined
    let cut: number | undefined
    for (const e of events) {
      if (e.type === 'player/input') lastInput = e.seq
      if (e.type === 'turn/start') {
        const data = e.data as unknown as TurnStartData
        if (data.kind === 'play' && data.turn > toTurn) {
          cut = lastInput
          break
        }
      }
    }
    if (cut === undefined) throw new EngineError('no-turn', `第 ${toTurn} 回合之后没有可回退的内容`)
    this.deps.store.truncate(sessionId, cut)
    this.emit(sessionId, { type: 'reset' })
  }

  /** 日志被外部整份替换（读档）后通知在线的界面重拉。 */
  notifyReset(sessionId: string): void {
    this.emit(sessionId, { type: 'reset' })
  }

  private start(sessionId: string, kind: TurnStartData['kind'], body: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    const run: Running = {
      controller,
      kind,
      startedAt: Date.now(),
      partial: '',
      lastDeltaSeq: -1,
      done: Promise.resolve(),
    }
    this.running.set(sessionId, run)
    run.done = (async () => {
      try {
        await body(controller.signal)
      } catch (err) {
        const state = this.safeState(sessionId)
        const open = state?.open?.data
        if (open) {
          const aborted = controller.signal.aborted
          const end: TurnEndData = {
            kind: open.kind,
            turn: open.turn,
            reason: aborted ? 'cancelled' : 'error',
            ...aborted ? {} : { error: err instanceof Error ? err.message : String(err) },
          }
          this.append(sessionId, 'turn/end', end)
          this.observe(sessionId)
        }
        if (!controller.signal.aborted) console.warn(`[engine] 回合失败（${sessionId}）：`, err)
      } finally {
        this.running.delete(sessionId)
      }
    })()
  }

  private safeState(sessionId: string): SessionState | undefined {
    try {
      return this.state(sessionId)
    } catch {
      return undefined
    }
  }

  private observe(sessionId: string): void {
    const log = this.deps.observerLog
    if (!log) return
    const state = this.safeState(sessionId)
    const events = this.deps.store.read(sessionId)
    const record = inspectTurn(sessionId, lastTurnSlice(events), state?.created.story?.craft.action_options ?? 4)
    writeRecord(log, record)
  }

  private request(state: SessionState): { model: string; thinking: boolean; reasoningEffort?: ReasoningEffort } {
    const { model, effort } = state.model
    return effort === 'off' ? { model, thinking: false } : { model, thinking: true, reasoningEffort: effort }
  }

  private storyFor(state: SessionState): Story {
    const snapshot = state.created.story!
    return hotStory(snapshot, this.deps.currentStory?.(snapshot.id))
  }

  /** 剧本选用的词库现行版（craft.lexicons 是热字段，词库内容也现读）。 */
  private lexiconsFor(story: Story): Lexicon[] {
    const ids = story.craft.lexicons ?? []
    return ids.length && this.deps.lexicons ? this.deps.lexicons(ids) : []
  }

  private persona(story: Story, state: SessionState): string {
    return renderPersona(story, {
      acts: actsOf(story, state.progress.revisions),
      actIndex: state.progress.actIndex,
      lexicons: this.lexiconsFor(story),
    })
  }

  // ---- 正戏回合 ----

  private async runPlay(sessionId: string, input: PlayerInputData, signal: AbortSignal): Promise<void> {
    const store = this.deps.store
    let state = foldSession(store.read(sessionId))
    // 回合号跟着已写成的章走：被取消、被重写的回合不占号
    const turn = (state.chapters[state.chapters.length - 1]?.turn ?? 0) + 1
    this.append(sessionId, 'player/input', input)
    this.append(sessionId, 'turn/start', { kind: 'play', turn } satisfies TurnStartData)
    this.phase(sessionId, '构思中')

    const story = this.storyFor(state)
    if (input.allocations?.length) {
      state = foldSession(store.read(sessionId))
      const defs = attributeDefs(story, state.progress.revisions)
      const outcome = applyAllocations(state.attrs, defs, state.progression.granted - state.progression.spent, input.allocations)
      this.append(sessionId, 'points/spent', {
        turn,
        changes: outcome.changes,
        spent: outcome.spent,
        rejected: outcome.rejected,
      } satisfies PointsSpentData)
      this.pushState(sessionId)
    }

    state = foldSession(store.read(sessionId))
    const finale = phaseOf(state) === 'finale'
    const system: ChatMessage = { role: 'system', content: this.persona(story, state) }
    const userText = renderPlayMessage({ state, story, input: input.text, opening: Boolean(input.opening), lexicons: this.lexiconsFor(story) })
    const handwritten = input.opening && story.opening.chapter ? story.opening.chapter : undefined

    let prose: { text: string; reasoning: string; steps: StepUsage[]; toolRounds: number; messages: ChatMessage[] }
    if (handwritten) {
      // 手写开场：原文直接作为第 1 回合，不调模型；照样逐字推给界面，体验与生成一致
      this.delta(sessionId, handwritten)
      prose = { text: handwritten, reasoning: '', steps: [], toolRounds: 0, messages: [] }
    } else {
      prose = await this.proseStep(sessionId, story, state, [system, { role: 'user', content: userText }], signal)
    }
    this.append(sessionId, 'chapter', {
      turn,
      text: prose.text,
      ...prose.reasoning ? { reasoning: prose.reasoning } : {},
      ...handwritten ? { handwritten: true } : {},
      ...finale ? { ending: true } : {},
      toolRoundsBeforeText: prose.toolRounds,
      steps: prose.steps,
    } satisfies ChapterData)

    if (!finale) {
      this.phase(sessionId, '结算中')
      state = foldSession(store.read(sessionId))
      const settleMessages: ChatMessage[] = handwritten
        ? [system, { role: 'user', content: `${userText}\n\n【开场章（作者亲笔，已经呈现给玩家）】\n${handwritten}\n\n${settlementBrief(state, story, { finale: false })}` }]
        : [...prose.messages, { role: 'user', content: settlementBrief(state, story, { finale: false }) }]
      const settlement = await this.settleStep(story, state, settleMessages, signal)
      this.append(sessionId, 'settlement', { turn, ...settlement } satisfies SettlementData)
      const r = settlement.receipt
      if (r.advancedTo !== undefined && !r.ended) {
        const acts = actsOf(story, state.progress.revisions)
        this.append(sessionId, 'act/advanced', { from: state.progress.actIndex, to: r.advancedTo, title: acts[r.advancedTo]?.title ?? '' } satisfies ActAdvancedData)
      }
      if (r.ended) this.append(sessionId, 'ending/declared', { turn })
    }
    this.pushState(sessionId)
    this.append(sessionId, 'turn/end', { kind: 'play', turn, reason: 'completed' } satisfies TurnEndData)
    this.observe(sessionId)
    this.scheduleRecap(sessionId)
  }

  /** 正文步：开思考、流式推送；模型要掷骰就在这里掷（代码裁决），掷完接着写。 */
  private async proseStep(
    sessionId: string,
    story: Story,
    state: SessionState,
    base: ChatMessage[],
    signal: AbortSignal,
  ): Promise<{ text: string; reasoning: string; steps: StepUsage[]; toolRounds: number; messages: ChatMessage[] }> {
    const req = this.request(state)
    const tools = gameTools(story, state)
    const canRoll = Boolean(story.mechanics?.checks)
    // 模型偶尔把整章写进推理通道（界面一片空白）：这种情况原地再写一遍，最多一次
    for (let attempt = 0; ; attempt++) {
      const messages = [...base]
      let text = ''
      let reasoning = ''
      let toolRounds = 0
      const steps: StepUsage[] = []
      let live = { ...state }
      for (let round = 0; round < MAX_PROSE_ROUNDS; round++) {
        const result = await this.deps.llm.chat({
          ...req,
          messages,
          tools,
          // 思考模式下只能 none / auto；没开判定的剧本干脆不让调工具
          toolChoice: canRoll && round < MAX_PROSE_ROUNDS - 1 ? 'auto' : 'none',
          // 思考模式缺省上限 64K（含推理）够用；关思考时缺省只有 8K，一整章可能写不完
          ...req.thinking ? {} : { maxTokens: 16000 },
        }, {
          signal,
          handlers: {
            onText: t => this.delta(sessionId, t),
            onReasoning: () => {
              const run = this.running.get(sessionId)
              if (run && run.phase !== '构思中' && !run.partial) this.phase(sessionId, '构思中')
            },
            onToolCall: name => this.phase(sessionId, name === CHECK_TOOL ? '掷骰判定' : '整理中'),
          },
        })
        steps.push(stepOf(req.model, result))
        text += result.content
        reasoning += result.reasoning
        const assistant: ChatMessage = {
          role: 'assistant',
          content: result.content || null,
          ...result.reasoning ? { reasoning_content: result.reasoning } : {},
          ...result.toolCalls.length ? { tool_calls: result.toolCalls } : {},
        }
        messages.push(assistant)
        if (!result.toolCalls.length) break
        if (!text.trim()) toolRounds++
        for (const call of result.toolCalls) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: this.proseTool(sessionId, story, live, call) })
          live = foldSession(this.deps.store.read(sessionId))
        }
      }
      if (text.trim() || attempt >= 1 || signal.aborted) {
        return { text: proseOf(text.trim()), reasoning, steps, toolRounds, messages }
      }
    }
  }

  private proseTool(sessionId: string, story: Story, state: SessionState, call: ToolCall): string {
    if (call.function.name !== CHECK_TOOL) {
      return call.function.name === SETTLE_TOOL
        ? '现在是写正文的时候：结算由系统在你写完这一章之后发起。接着写正文。'
        : '这一步只能调 roll_check。修订设定走场外通道。接着写正文。'
    }
    const out = runCheck(story, state, parseArgs(call.function.arguments), this.deps.randInt)
    if ('error' in out) return `判定没有执行：${out.error}`
    this.append(sessionId, 'check/rolled', { turn: state.progress.turn, ...out.result } satisfies CheckData)
    return out.text
  }

  /** 结算步：关思考、强制 settle_turn；拿不到合法调用重试一次，仍失败则只落周期收支。 */
  private async settleStep(
    story: Story,
    state: SessionState,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<Omit<SettlementData, 'turn'>> {
    const { model } = state.model
    let lastError = ''
    let lastStep: StepUsage | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: ChatResult
      try {
        result = await this.deps.llm.chat({
          model,
          messages,
          tools: gameTools(story, state),
          toolChoice: { type: 'function', function: { name: SETTLE_TOOL } },
          thinking: false,
          maxTokens: 4000,
          temperature: 0.3,
        }, { signal })
      } catch (err) {
        if (signal.aborted) throw err
        lastError = err instanceof Error ? err.message : String(err)
        continue
      }
      lastStep = stepOf(model, result)
      const call = result.toolCalls.find(c => c.function.name === SETTLE_TOOL)
      if (!call) {
        lastError = '模型没有调用 settle_turn'
        continue
      }
      let args: unknown
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        lastError = 'settle_turn 的参数不是合法 JSON'
        continue
      }
      return { receipt: adjudicate(story, state, args), args, step: lastStep }
    }
    // 两次都拿不到：数值与进度这一回合不动，但周期收支照滚（由代码保证）
    return { receipt: adjudicate(story, state, {}), failed: lastError, ...lastStep ? { step: lastStep } : {} }
  }

  // ---- 场外回合 ----

  private async runOffstage(sessionId: string, ask: string, signal: AbortSignal): Promise<void> {
    const store = this.deps.store
    this.append(sessionId, 'player/input', { text: ask, offstage: true } satisfies PlayerInputData)
    this.append(sessionId, 'turn/start', { kind: 'offstage', turn: 0 } satisfies TurnStartData)
    this.phase(sessionId, '构思中')
    let state = foldSession(store.read(sessionId))
    const story = this.storyFor(state)
    const req = this.request(state)
    const messages: ChatMessage[] = [
      { role: 'system', content: this.persona(story, state) },
      { role: 'user', content: renderOffstageMessage(state, story, ask) },
    ]
    const tools = gameTools(story, state)
    let text = ''
    let reasoning = ''
    const steps: StepUsage[] = []
    for (let round = 0; round < MAX_PROSE_ROUNDS; round++) {
      const result = await this.deps.llm.chat({
        ...req,
        messages,
        tools,
        toolChoice: round < MAX_PROSE_ROUNDS - 1 ? 'auto' : 'none',
      }, { signal, handlers: { onText: t => this.delta(sessionId, t), onToolCall: () => this.phase(sessionId, '修订设定') } })
      steps.push(stepOf(req.model, result))
      text += result.content
      reasoning += result.reasoning
      messages.push({
        role: 'assistant',
        content: result.content || null,
        ...result.reasoning ? { reasoning_content: result.reasoning } : {},
        ...result.toolCalls.length ? { tool_calls: result.toolCalls } : {},
      })
      if (!result.toolCalls.length) break
      for (const call of result.toolCalls) {
        let reply = '场外只能调 revise_setting：正戏与结算不在这里发生。'
        if (call.function.name === REVISE_TOOL) {
          const out = runRevise(story, state, parseArgs(call.function.arguments))
          if (out.accepted.length) {
            this.append(sessionId, 'revision', { revisions: out.accepted })
            state = foldSession(store.read(sessionId))
            this.pushState(sessionId)
          }
          reply = out.text
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: reply })
      }
    }
    this.append(sessionId, 'reply', { text: text.trim(), ...reasoning ? { reasoning } : {}, steps } satisfies ReplyData)
    this.append(sessionId, 'turn/end', { kind: 'offstage', turn: 0, reason: 'completed' } satisfies TurnEndData)
    this.observe(sessionId)
  }

  // ---- 工坊与修改对话 ----

  /** 从日志重建工坊对话：带工具时每条 assistant 消息都要带回 reasoning_content。 */
  private agentHistory(events: readonly StoredEvent[]): ChatMessage[] {
    const messages: ChatMessage[] = []
    for (const e of events) {
      if (e.type === 'player/input') messages.push({ role: 'user', content: (e.data as unknown as PlayerInputData).text })
      if (e.type === 'agent/message') {
        const d = e.data as unknown as AgentMessageData
        messages.push({
          role: 'assistant',
          content: d.content || null,
          ...d.reasoning ? { reasoning_content: d.reasoning } : {},
          ...d.toolCalls?.length ? { tool_calls: d.toolCalls } : {},
        })
      }
      if (e.type === 'tool/result') {
        const d = e.data as unknown as ToolResultData
        messages.push({ role: 'tool', tool_call_id: d.toolCallId, content: d.text })
      }
    }
    // 被取消的回合可能留下没有回执的工具调用：补一条占位回执，否则下一次请求直接 400
    const answered = new Set(messages.filter(m => m.role === 'tool').map(m => (m as { tool_call_id: string }).tool_call_id))
    const out: ChatMessage[] = []
    for (const m of messages) {
      out.push(m)
      if (m.role === 'assistant' && m.tool_calls) {
        for (const call of m.tool_calls) {
          if (!answered.has(call.id)) out.push({ role: 'tool', tool_call_id: call.id, content: '（这次调用被中止了，没有执行）' })
        }
      }
    }
    return out
  }

  private async runAgent(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const store = this.deps.store
    this.append(sessionId, 'player/input', { text, offstage: false } satisfies PlayerInputData)
    this.append(sessionId, 'turn/start', { kind: 'agent', turn: 0 } satisfies TurnStartData)
    this.phase(sessionId, '构思中')
    const state = foldSession(store.read(sessionId))
    const req = this.request(state)
    const tools = this.deps.agentTools?.() ?? []
    const messages: ChatMessage[] = [
      { role: 'system', content: this.deps.agentPersona ?? '' },
      ...this.agentHistory(store.read(sessionId)),
    ]
    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
      const result = await this.deps.llm.chat({
        ...req,
        messages,
        ...tools.length ? { tools: tools.map(t => t.def), toolChoice: round < MAX_AGENT_ROUNDS - 1 ? 'auto' as const : 'none' as const } : {},
      }, {
        signal,
        handlers: {
          onText: t => this.delta(sessionId, t),
          onToolCall: name => this.phase(sessionId, { list_stories: '查看剧本库', read_story: '载入剧本', publish_story: '发布剧本' }[name] ?? '调用工具'),
        },
      })
      const message: AgentMessageData = {
        content: result.content,
        ...result.reasoning ? { reasoning: result.reasoning } : {},
        ...result.toolCalls.length ? { toolCalls: result.toolCalls } : {},
        step: stepOf(req.model, result),
      }
      this.append(sessionId, 'agent/message', message)
      messages.push({
        role: 'assistant',
        content: result.content || null,
        ...result.reasoning ? { reasoning_content: result.reasoning } : {},
        ...result.toolCalls.length ? { tool_calls: result.toolCalls } : {},
      })
      const run = this.running.get(sessionId)
      if (run) run.partial = ''
      if (!result.toolCalls.length) break
      for (const call of result.toolCalls) {
        const tool = tools.find(t => t.def.function.name === call.function.name)
        let out: { text: string; meta?: Record<string, unknown> }
        try {
          out = tool ? await tool.run(parseArgs(call.function.arguments)) : { text: `没有这个工具：${call.function.name}` }
        } catch (err) {
          out = { text: `工具执行失败：${err instanceof Error ? err.message : String(err)}` }
        }
        this.append(sessionId, 'tool/result', {
          toolCallId: call.id,
          name: call.function.name,
          text: out.text,
          ...out.meta ? { meta: out.meta } : {},
        } satisfies ToolResultData)
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.text })
      }
    }
    this.append(sessionId, 'turn/end', { kind: 'agent', turn: 0, reason: 'completed' } satisfies TurnEndData)
  }

  // ---- 前情提要（后台） ----

  /**
   * 正文窗口攒满 K+N 章就把最早的 N 章并进前情提要（K 章原文留着）。在玩家读正文时后台跑，
   * 不占等待时间（护栏 1 修订）；没跑完之前下一回合照旧用更长的窗口，不等它。
   */
  private scheduleRecap(sessionId: string): void {
    if (this.recaps.has(sessionId)) return
    const { recentChapters: k, recapEvery: n } = this.deps.settings()
    const state = foldSession(this.deps.store.read(sessionId))
    const window = windowChapters(state)
    if (window.length < k + n) return
    const fold = window.slice(0, window.length - k)
    const through = fold[fold.length - 1]
    // 先登记再开跑：同步阶段抛错也不会留下一个永远"进行中"的登记
    const job = Promise.resolve().then(async () => {
      try {
        const story = this.storyFor(state)
        const result = await this.deps.llm.chat({
          model: state.model.model,
          messages: [
            { role: 'system', content: this.persona(story, state) },
            { role: 'user', content: renderRecapMessage(state.recap?.text, fold) },
          ],
          // 带同一份工具列表：工具定义排在提示词最前面，保持一致才能共享固定前缀的缓存
          tools: gameTools(story, state),
          toolChoice: 'none',
          thinking: false,
          maxTokens: 6000,
          temperature: 0.4,
        })
        const text = result.content.trim()
        if (!text) return
        // 生成期间日志被重写回合截断过：要并进去的章节已经不在了，这份提要作废
        const now = foldSession(this.deps.store.read(sessionId))
        if (!now.chapters.some(c => c.seq === through.seq) || (now.recap?.through ?? 0) >= through.turn) return
        this.append(sessionId, 'recap', { through: through.turn, text, step: stepOf(state.model.model, result) } satisfies RecapData)
      } catch (err) {
        console.warn(`[engine] 前情提要生成失败（${sessionId}），下一回合沿用更长的窗口：`, err)
      } finally {
        this.recaps.delete(sessionId)
      }
    })
    this.recaps.set(sessionId, job)
  }
}
