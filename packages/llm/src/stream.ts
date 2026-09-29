/**
 * 流式响应的纯逻辑：SSE 分帧 + 增量拼装。与网络无关，单测直接喂字符串。
 *
 * 工具调用是按 index 分片到达的：第一片带 id 与函数名，后续只带 arguments 的碎片，
 * 必须按 index 归并再拼接——按到达顺序直接连起来，两个并行调用的参数会搅在一起。
 */
import type { ToolCall, Usage } from './types.ts'

/**
 * SSE 分帧：喂进任意切分的文本块，吐出完整的 data 载荷。
 * 网络层给的块边界与事件边界毫无关系，半行要留到下一块再拼。
 */
export class SseDecoder {
  private buffer = ''

  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      if (line.startsWith('data:')) out.push(line.slice(5).trimStart())
      // 注释行（: keep-alive）、event:/id: 行与空行都不携带载荷
    }
    return out
  }

  /** 流结束时残留的最后一行（服务端没以换行收尾时） */
  flush(): string[] {
    const rest = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    return rest.startsWith('data:') ? [rest.slice(5).trimStart()] : []
  }
}

interface RawToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface RawChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: RawToolCallDelta[] }
    finish_reason?: string | null
  }[]
  usage?: RawUsage | null
  error?: { message?: string; code?: string }
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export function parseUsage(raw: RawUsage | null | undefined): Usage | undefined {
  if (!raw) return undefined
  const prompt = raw.prompt_tokens ?? 0
  const hit = raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0
  const usage: Usage = {
    promptTokens: prompt,
    completionTokens: raw.completion_tokens ?? 0,
    cacheHitTokens: hit,
    cacheMissTokens: raw.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit),
  }
  if (raw.completion_tokens_details?.reasoning_tokens !== undefined) {
    usage.reasoningTokens = raw.completion_tokens_details.reasoning_tokens
  }
  return usage
}

export interface AssembledDelta {
  text?: string
  reasoning?: string
  /** 本片里新出现名字的工具调用 */
  toolNames?: string[]
}

/** 增量拼装器：逐片喂 JSON 载荷，最后取整份结果。 */
export class ChunkAssembler {
  content = ''
  reasoning = ''
  finishReason = ''
  usage: Usage | undefined
  private calls = new Map<number, { id: string; name: string; args: string }>()

  /** 喂一片；返回这一片里对界面有意义的增量。遇到 [DONE] 或无法解析的载荷返回空对象。 */
  push(payload: string): AssembledDelta {
    if (payload === '[DONE]') return {}
    let chunk: RawChunk
    try {
      chunk = JSON.parse(payload) as RawChunk
    } catch {
      return {}
    }
    if (chunk.error) throw new Error(chunk.error.message ?? '模型返回了错误')
    if (chunk.usage) this.usage = parseUsage(chunk.usage)
    const out: AssembledDelta = {}
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      if (delta?.reasoning_content) {
        this.reasoning += delta.reasoning_content
        out.reasoning = (out.reasoning ?? '') + delta.reasoning_content
      }
      if (delta?.content) {
        this.content += delta.content
        out.text = (out.text ?? '') + delta.content
      }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0
        let call = this.calls.get(index)
        if (!call) {
          call = { id: '', name: '', args: '' }
          this.calls.set(index, call)
        }
        if (tc.id) call.id = tc.id
        if (tc.function?.name) {
          const fresh = !call.name
          call.name += tc.function.name
          if (fresh) (out.toolNames ??= []).push(call.name)
        }
        if (tc.function?.arguments) call.args += tc.function.arguments
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason
    }
    return out
  }

  toolCalls(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id || `call_${index}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      }))
  }
}
