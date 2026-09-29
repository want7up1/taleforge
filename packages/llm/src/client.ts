/**
 * DeepSeek 直连客户端：fetch + SSE。不用 @ai-sdk/deepseek——它在多轮 reasoning 回传上
 * 出过 bug（vercel/ai #10778），而"带工具时每条 assistant 消息都要带回 reasoning_content"
 * 恰恰是本平台每回合都踩的路径，这一层必须自己看得见、测得到。
 */
import { ChunkAssembler, SseDecoder } from './stream.ts'
import {
  LlmError,
  type ChatOptions,
  type ChatRequest,
  type ChatResult,
  type LlmClient,
} from './types.ts'

export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 请求体。思考开关与强度的字段名以官方 OpenAI 格式为准。 */
export function buildBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: request.thinking ? 'enabled' : 'disabled' },
  }
  if (request.thinking && request.reasoningEffort) body.reasoning_effort = request.reasoningEffort
  if (request.tools?.length) body.tools = request.tools
  if (request.toolChoice) body.tool_choice = request.toolChoice
  if (request.maxTokens) body.max_tokens = request.maxTokens
  if (!request.thinking && request.temperature !== undefined) body.temperature = request.temperature
  return body
}

/** 可以重试的失败：网络断、限流、服务端 5xx、资源不足。4xx 的请求错误重试也是白搭。 */
function retryable(err: unknown): boolean {
  if (err instanceof LlmError) {
    return err.code === 'network' || err.code === 'overloaded'
      || (err.status !== undefined && (err.status === 429 || err.status >= 500))
  }
  return false
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(new LlmError('aborted', '已取消'))
  }, { once: true })
})

export class DeepSeekClient implements LlmClient {
  private readonly apiKey: () => string | undefined
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: { apiKey: () => string | undefined; baseUrl?: string; fetch?: typeof fetch }) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? fetch
  }

  async chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
    const delays = [1000, 3000]
    for (let attempt = 0; ; attempt++) {
      // 一旦有增量推给了界面就不再重试：重来一遍会让玩家看到两段开头
      const emitted = { any: false }
      try {
        return await this.once(request, options, emitted)
      } catch (err) {
        if (options.signal?.aborted) throw new LlmError('aborted', '已取消')
        if (emitted.any || attempt >= delays.length || !retryable(err)) throw err
        await sleep(delays[attempt], options.signal)
      }
    }
  }

  private async once(request: ChatRequest, options: ChatOptions, emitted: { any: boolean }): Promise<ChatResult> {
    const key = this.apiKey()
    if (!key) throw new LlmError('no-key', '还没有配置 DeepSeek API Key——去「设置」页填入')
    const started = Date.now()
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
        body: JSON.stringify(buildBody(request)),
        signal: options.signal,
      })
    } catch (cause) {
      if (options.signal?.aborted) throw new LlmError('aborted', '已取消')
      throw new LlmError('network', `连不上 DeepSeek：${String(cause)}`)
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      const code = res.status === 401 ? 'auth' : res.status === 402 ? 'balance' : res.status === 400 ? 'bad-request' : 'http'
      throw new LlmError(code, `DeepSeek ${res.status}：${detail.slice(0, 500)}`, res.status)
    }

    const decoder = new SseDecoder()
    const assembler = new ChunkAssembler()
    const utf8 = new TextDecoder()
    let firstTextMs: number | undefined
    const feed = (payloads: string[]) => {
      for (const payload of payloads) {
        const delta = assembler.push(payload)
        if (delta.reasoning) {
          emitted.any = true
          options.handlers?.onReasoning?.(delta.reasoning)
        }
        if (delta.text) {
          emitted.any = true
          firstTextMs ??= Date.now() - started
          options.handlers?.onText?.(delta.text)
        }
        for (const name of delta.toolNames ?? []) options.handlers?.onToolCall?.(name)
      }
    }
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        feed(decoder.push(utf8.decode(part, { stream: true })))
      }
      feed(decoder.push(utf8.decode()))
      feed(decoder.flush())
    } catch (cause) {
      if (options.signal?.aborted) throw new LlmError('aborted', '已取消')
      throw new LlmError('network', `DeepSeek 流中断：${String(cause)}`)
    }
    if (assembler.finishReason === 'insufficient_system_resource') {
      throw new LlmError('overloaded', 'DeepSeek 资源不足，本次生成被中止')
    }
    const result: ChatResult = {
      content: assembler.content,
      reasoning: assembler.reasoning,
      toolCalls: assembler.toolCalls(),
      finishReason: assembler.finishReason || 'stop',
      ms: Date.now() - started,
    }
    if (assembler.usage) result.usage = assembler.usage
    if (firstTextMs !== undefined) result.firstTextMs = firstTextMs
    return result
  }
}
