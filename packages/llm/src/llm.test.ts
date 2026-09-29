import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBody, DeepSeekClient } from './client.ts'
import { ChunkAssembler, parseUsage, SseDecoder } from './stream.ts'
import { LlmError } from './types.ts'

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

test('SSE 分帧：任意切块都拼得回完整载荷，注释与空行不产出', () => {
  const d = new SseDecoder()
  const raw = `: keep-alive\n\n${frame({ a: 1 })}${frame({ b: 2 })}data: [DONE]\n\n`
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 7) out.push(...d.push(raw.slice(i, i + 7)))
  out.push(...d.flush())
  assert.deepEqual(out, ['{"a":1}', '{"b":2}', '[DONE]'])
})

test('工具调用按 index 归并：两个并行调用的参数碎片不串', () => {
  const a = new ChunkAssembler()
  a.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'roll_check', arguments: '{"diff' } }] } }] }))
  a.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'settle_turn', arguments: '{"x"' } }] } }] }))
  a.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'iculty":12}' } }] } }] }))
  a.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] }))
  const calls = a.toolCalls()
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { difficulty: 12 })
  assert.equal(calls[1].function.name, 'settle_turn')
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { x: 1 })
  assert.equal(a.finishReason, 'tool_calls')
})

test('推理与正文分通道累积；usage 取缓存命中字段', () => {
  const a = new ChunkAssembler()
  const d1 = a.push(JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] }))
  const d2 = a.push(JSON.stringify({ choices: [{ delta: { content: '正文' } }] }))
  a.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } }))
  assert.equal(d1.reasoning, '想一想')
  assert.equal(d2.text, '正文')
  assert.equal(a.reasoning, '想一想')
  assert.equal(a.content, '正文')
  assert.deepEqual(a.usage, { promptTokens: 100, completionTokens: 20, cacheHitTokens: 64, cacheMissTokens: 36 })
})

test('usage 兼容 prompt_tokens_details.cached_tokens 写法', () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } }), {
    promptTokens: 50, completionTokens: 5, cacheHitTokens: 30, cacheMissTokens: 20,
  })
})

test('请求体：开思考带强度不带 temperature；关思考才能指定工具', () => {
  const on = buildBody({ model: 'deepseek-flash', messages: [], thinking: true, reasoningEffort: 'high', temperature: 0.3 })
  assert.deepEqual(on.thinking, { type: 'enabled' })
  assert.equal(on.reasoning_effort, 'high')
  assert.equal(on.temperature, undefined)
  const off = buildBody({
    model: 'deepseek-flash',
    messages: [],
    thinking: false,
    reasoningEffort: 'high',
    toolChoice: { type: 'function', function: { name: 'settle_turn' } },
  })
  assert.deepEqual(off.thinking, { type: 'disabled' })
  assert.equal(off.reasoning_effort, undefined)
  assert.deepEqual(off.tool_choice, { type: 'function', function: { name: 'settle_turn' } })
})

function streamResponse(parts: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p))
      controller.close()
    },
  })
  return new Response(body, { status })
}

test('客户端：流式回调逐片到达，结果含首字耗时', async () => {
  const seen: string[] = []
  const client = new DeepSeekClient({
    apiKey: () => 'sk-test',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { stream: boolean }
      assert.equal(body.stream, true)
      return streamResponse([
        frame({ choices: [{ delta: { reasoning_content: 'r' } }] }),
        frame({ choices: [{ delta: { content: '甲' } }] }),
        frame({ choices: [{ delta: { content: '乙' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ])
    },
  })
  const result = await client.chat(
    { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], thinking: true },
    { handlers: { onText: t => seen.push(t) } },
  )
  assert.deepEqual(seen, ['甲', '乙'])
  assert.equal(result.content, '甲乙')
  assert.equal(result.reasoning, 'r')
  assert.equal(result.finishReason, 'stop')
  assert.equal(typeof result.firstTextMs, 'number')
})

test('客户端：5xx 在没有任何输出前重试，401 不重试', async () => {
  let calls = 0
  const flaky = new DeepSeekClient({
    apiKey: () => 'sk-test',
    fetch: async () => {
      calls++
      return calls === 1 ? new Response('busy', { status: 503 }) : streamResponse([frame({ choices: [{ delta: { content: 'ok' } }] })])
    },
  })
  // 重试退避 1s：测试里容忍这一秒
  assert.equal((await flaky.chat({ model: 'm', messages: [], thinking: false })).content, 'ok')
  assert.equal(calls, 2)

  let authCalls = 0
  const denied = new DeepSeekClient({
    apiKey: () => 'sk-bad',
    fetch: async () => {
      authCalls++
      return new Response('unauthorized', { status: 401 })
    },
  })
  await assert.rejects(denied.chat({ model: 'm', messages: [], thinking: false }), (err: unknown) =>
    err instanceof LlmError && err.code === 'auth')
  assert.equal(authCalls, 1)
})

test('客户端：没配 Key 直接报可读错误，不发请求', async () => {
  const client = new DeepSeekClient({ apiKey: () => undefined, fetch: async () => { throw new Error('不该发请求') } })
  await assert.rejects(client.chat({ model: 'm', messages: [], thinking: false }), (err: unknown) =>
    err instanceof LlmError && err.code === 'no-key')
})
