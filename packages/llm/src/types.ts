/**
 * DeepSeek Chat Completions 的最小类型面（OpenAI 兼容格式）。
 * 只声明本平台用到的字段；字段名与官方文档一致（api-docs.deepseek.com，2026-09 核实）。
 */

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
    role: 'assistant'
    content: string | null
    /**
     * 思考模式的推理文本。带 tools 的请求里，历史上每一条 assistant 消息都必须原样带回它
     * （哪怕那一轮没调工具），缺了 API 直接 400。不带 tools 时 API 会忽略它。
     */
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  | { role: 'tool'; tool_call_id: string; content: string }

/** JSON Schema 的子集：工具参数只用得到这些。 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: (string | number)[]
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  additionalProperties?: boolean
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: JsonSchema }
}

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }

export type ReasoningEffort = 'low' | 'high' | 'max'

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  /**
   * 思考模式下只能用 none / auto：required 与指定工具会直接 400。
   * 要"强制调某个工具"就得在同一请求里关掉思考（结算步就是这么做的）。
   */
  toolChoice?: ToolChoice
  /** 开思考（默认开）。关掉时出字最快，也是指定工具的前提。 */
  thinking: boolean
  /** 思考强度，只在 thinking=true 时发送 */
  reasoningEffort?: ReasoningEffort
  maxTokens?: number
  /** 只在非思考模式生效（思考模式下官方说明不报错但无效果） */
  temperature?: number
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  /** 命中上下文缓存的输入 token（按前缀单元整块命中） */
  cacheHitTokens: number
  cacheMissTokens: number
  reasoningTokens?: number
}

export interface ChatResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string
  usage?: Usage
  /** 请求发出到收完的毫秒数 */
  ms: number
  /** 请求发出到第一个可见正文字的毫秒数（没有正文则缺省） */
  firstTextMs?: number
}

export interface StreamHandlers {
  onText?: (text: string) => void
  onReasoning?: (text: string) => void
  /** 模型开始写某个工具调用（名字一出现就回调，供界面显示"掷骰判定"之类） */
  onToolCall?: (name: string) => void
}

export interface ChatOptions {
  signal?: AbortSignal
  handlers?: StreamHandlers
}

/** 引擎只依赖这个接口：真实客户端与测试里的脚本化假客户端都实现它。 */
export interface LlmClient {
  chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult>
}

export class LlmError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
  }
}

/**
 * 可执行的工具：定义（发给模型）+ 执行（代码侧）。引擎的通用对话循环（工坊、修改对话）
 * 与游戏回合都用它；返回的 text 回给模型，meta 进日志供界面与折叠使用。
 */
export interface AgentTool {
  def: ToolDef
  run(args: Record<string, unknown>): Promise<{ text: string; meta?: Record<string, unknown> }>
}

/** 工具定义的简写：name + description + parameters。 */
export function toolDef(name: string, description: string, parameters: JsonSchema): ToolDef {
  return { type: 'function', function: { name, description, parameters } }
}
