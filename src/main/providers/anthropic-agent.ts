import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import type { RunTerminal } from '@shared/execution-outcome'
import type { TokenUsage } from '@shared/usage'
import type { ProviderExecutionContext } from '@shared/request-policy'
import { resolveApiUrl } from './url'
import { ProviderError, mapHttpError } from './errors'
import { thinkingBudgetForSettings } from './anthropic'
import { createSSEParser } from './sse'
import {
  createAnthropicUsageAccumulator,
  usageFromAnthropicMessage
} from './usage-parsers'
import { ToolCallAccumulator, ToolCallIntegrityError } from './tool-accumulator'
import { httpFetch } from './http-client'
import { attachmentTextForModel } from '@shared/attachment-block'
import { createStreamGuard, type StreamGuard, type StreamGuardOptions } from './stream-guard'
import { buildAnthropicHeaders } from './wire'

// Anthropic tool_use 适配（plan6 → P1）：把 OpenAI 风格的 Agent 消息翻译成 Anthropic 块结构。
// 三个纯函数（toAnthropicAgentMessages / fromAnthropicResponse / buildTools）可独立单测。

type AnthropicBlock =
  | { type: 'text'; text: string }
  /**
   * 图片块（plan57 片③）。`transformations.oversized_image` **必须显式给**：
   * 厂商默认是 `downsize`，SDK 原文写它"改变了模型实际看到的尺寸而不告诉你"（D-146 E）——
   * 我们宁可收一个点名尺寸的 400，也不要"图发出去了但模型看的是缩过的"这种静默。
   */
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
      transformations: { oversized_image: 'error' }
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/**
 * 出境块映射：有 `parts` 就以它为准（`content` 那份文本是同源的投影，不重复下发）。
 * ⚠️ 视频到这儿**必须抛错**而不是悄悄丢掉那个块：Anthropic 没有视频块形状，
 * 而"provider 收到视频块却当没看见"正是本项目最恨的静默形状 —— 上游的模态闸按协议拦，
 * 这儿再兜一道，免得将来有人绕过闸直接喂。
 */
function blocksOfUserTurn(m: AgentMessage): AnthropicBlock[] {
  if (!m.parts) return [{ type: 'text', text: attachmentTextForModel(m.content ?? '') }]
  if (m.parts.some((p) => p.type === 'video')) {
    throw new Error('Anthropic 协议不支持视频输入块：请改用 OpenAI 兼容端点，或把视频先转成关键帧图片')
  }
  return m.parts.map((p): AnthropicBlock =>
    p.type === 'text'
      ? { type: 'text', text: attachmentTextForModel(p.text) }
      : {
          type: 'image',
          source: { type: 'base64', media_type: p.mime, data: p.base64 },
          transformations: { oversized_image: 'error' }
        }
  )
}

interface AnthropicAgentMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** OpenAI 风格 Agent 消息 → Anthropic 块结构。
 * 关键规则：同一轮的全部 tool_result 必须合并进**一条** user 消息（Anthropic 禁止相邻同角色消息）。 */
export function toAnthropicAgentMessages(messages: AgentMessage[]): {
  system: string
  messages: AnthropicAgentMessage[]
} {
  let system = ''
  const out: AnthropicAgentMessage[] = []
  let pendingToolResults: AnthropicBlock[] = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
  }

  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content ?? ''}` : (m.content ?? '')
      continue
    }
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content ?? ''
      })
      continue
    }
    flushToolResults()
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(tc.function.arguments || '{}')
          if (typeof parsed === 'object' && parsed !== null) input = parsed as Record<string, unknown>
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: blocksOfUserTurn(m) })
    }
  }
  flushToolResults()
  return { system, messages: out }
}

/** Anthropic 响应 JSON → AgentChatResult（text 块拼接为回复；tool_use 块转 toolCalls） */
export function fromAnthropicResponse(json: {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
  usage?: unknown
}): AgentChatResult {
  const blocks = json.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => ({
      id: b.id as string,
      name: b.name as string,
      arguments: JSON.stringify(b.input ?? {})
    }))
  return { text: text.length > 0 ? text : null, toolCalls, usage: usageFromAnthropicMessage(json) }
}

/** 工具定义 → Anthropic tools 字段（OpenAI 的 parameters 在 Anthropic 叫 input_schema） */
export function toAnthropicToolDefs(tools: ToolSchema[]): Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

/** 受控失败（E23-R1）：固定本地文案 + 白名单事实，不带厂商原文/cause。 */
function failRequest(terminal: RunTerminal, usage: TokenUsage | null): never {
  throw new ProviderError('本次请求未正常完成', 0, {
    scope: 'request',
    terminal,
    usage,
    usageComplete: usage !== null
  })
}

/**
 * 非流 JSON 响应 → AgentChatResult（E23-R1）。
 * ⚠️ **同一响应的唯一消费点**：stream 收到 application/json 时也走它，不重新发请求。
 * ⚠️ 不改 `fromAnthropicResponse` 的旧宽松解析契约 —— 终因校验只在这里（网络入口）加。
 */
function resultFromAnthropicJson(json: {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
  usage?: unknown
  stop_reason?: string | null
}): AgentChatResult {
  const result = fromAnthropicResponse(json)
  const usage = result.usage ?? null
  const terminal = anthropicStopReasonToTerminal(json.stop_reason)
  // 缺终因 / 未知值 / 截断 / 拒绝一律受控失败，绝不静默当成功
  if (terminal === null) failRequest({ state: 'unknown', code: 'missing-terminal' }, usage)
  if (terminal.state !== 'completed') failRequest(terminal, usage)
  return { ...result, usageComplete: usage !== null }
}

export async function chatWithToolsAnthropic(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal,
  /** 运行态上下文（S3-30B）：缺省 = 旧请求，不发身份头 */
  context?: ProviderExecutionContext
): Promise<AgentChatResult> {
  const { system, messages: anthropicMessages } = toAnthropicAgentMessages(messages)
  // ⚠️ thinking 与 tools 互斥（交叉验证结论）：部分 Anthropic 模型 / 版本拒收二者同时下发，且带 thinking 的
  // assistant 续轮必须回带 thinking 块（我们只回放 text/tool_use）。工具模式下内核优先保工具 → 自动降级思考。
  const budget = tools.length === 0 ? thinkingBudgetForSettings(settings) : null
  const res = await httpFetch(resolveApiUrl(settings.baseURL, 'messages'), {
    method: 'POST',
    headers: buildAnthropicHeaders(settings, apiKey, context),
    body: JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      stream: false,
      ...(system ? { system } : {}),
      ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      ...(tools.length > 0 ? { tools: toAnthropicToolDefs(tools) } : {}),
      messages: anthropicMessages
    }),
    signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // HTTP 层失败挂结构化事实（E23-R1）；detail 只用于映射文案，绝不进 message/facts
    throw new ProviderError(mapHttpError(res.status, detail), res.status, {
      scope: 'request',
      terminal: { state: 'failed', code: 'http-error', httpStatus: res.status },
      usage: null,
      usageComplete: false
    })
  }
  return resultFromAnthropicJson(
    (await res.json()) as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
      usage?: unknown
      stop_reason?: string | null
    }
  )
}

/** 构造带工具请求体（流式/非流式共用，纯函数便于单测） */
export function buildAnthropicToolsBody(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: ToolSchema[],
  stream: boolean
): Record<string, unknown> {
  const { system, messages: anthropicMessages } = toAnthropicAgentMessages(messages)
  // thinking 与 tools 互斥（见上）；流式同样只保工具
  const budget = tools.length === 0 ? thinkingBudgetForSettings(settings) : null
  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    stream,
    ...(system ? { system } : {}),
    ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(tools.length > 0 ? { tools: toAnthropicToolDefs(tools) } : {}),
    messages: anthropicMessages
  }
}

/**
 * 流式 + 工具（D-032）：按 SSE 事件类型分发 —— content_block_start(tool_use) 开一个工具调用块，
 * content_block_delta(text_delta) 文本增量上屏，content_block_delta(input_json_delta) 工具参数分片累积
 */
/**
 * Anthropic `stop_reason` → 业务终态（E23）。
 * ⚠️ **`message_stop` 只是信封结束，不单独构成成功**：必须同时有合法的 stop_reason。
 * 未知值一律 unknown/unsupported-stop，绝不猜成 completed。
 */
function anthropicStopReasonToTerminal(reason: string | null | undefined): RunTerminal | null {
  if (reason === null || reason === undefined) return null
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { state: 'completed' }
    case 'tool_use':
      // 工具能否放行还要看 finishStrict；这里只标"业务上正常收束"
      return { state: 'completed' }
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return { state: 'truncated', code: 'token-limit' }
    case 'refusal':
      return { state: 'denied', code: 'content-filter' }
    default:
      return { state: 'unknown', code: 'unsupported-stop' }
  }
}

export async function streamWithToolsAnthropic(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
  /** 两层守卫的时长（plan29 D-090）。不传 = 用默认口径；**单测传短值** */
  guardOpts?: StreamGuardOptions,
  /** 运行态上下文（S3-30B）：缺省 = 旧请求，不发身份头 */
  context?: ProviderExecutionContext
): Promise<AgentChatResult> {
  // 与 OpenAI 侧同款（见 stream-guard.ts）：首包 + 分片间隔两层，取代原来的整轮墙钟。
  // 结构上把"守卫的收尾"与"流本身"拆成两个函数：超时的**分型文案**只在包装层出现一次，
  // 免得日后有人往内层再加一条 return 路径时忘了报出真实原因。
  const guard = createStreamGuard(signal, guardOpts)
  try {
    return await anthropicStreamBody(settings, apiKey, messages, tools, onText, guard, context)
  } catch (err) {
    const timedOut = guard.timeoutMessage()
    if (timedOut) throw new ProviderError(timedOut, 0)
    throw err
  } finally {
    guard.dispose()
  }
}

/** 真正干活的：`guard.signal` 同时承载「用户停止」与「守卫超时」两个语义 */
async function anthropicStreamBody(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  onText: (delta: string) => void,
  guard: StreamGuard,
  context: ProviderExecutionContext | undefined
): Promise<AgentChatResult> {
  const res = await httpFetch(resolveApiUrl(settings.baseURL, 'messages'), {
    method: 'POST',
    headers: buildAnthropicHeaders(settings, apiKey, context),
    body: JSON.stringify(buildAnthropicToolsBody(settings, messages, tools, true)),
    signal: guard.signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ProviderError(mapHttpError(res.status, detail), res.status, {
      scope: 'request',
      terminal: { state: 'failed', code: 'http-error', httpStatus: res.status },
      usage: null,
      usageComplete: false
    })
  }
  // ⚠️ E23-R1：无 body 时**不得再发一次请求** —— 自动模型重放固定为 0。
  if (!res.body) failRequest({ state: 'unknown', code: 'missing-terminal' }, null)

  // ⚠️ E23-R1：端点忽略 stream 回退成 JSON 时，消费**同一响应**，不发新请求（hits 保持 1）。
  {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.toLowerCase().includes('application/json')) {
      return resultFromAnthropicJson((await res.json()) as never)
    }
  }

  const acc = new ToolCallAccumulator()
  let text = ''
  /** 这一轮的用量（plan8 R9）：Anthropic **分两处报**（message_start 输入 / message_delta 输出） */
  const usage = createAnthropicUsageAccumulator()
  /** 最后一次看到的 stop_reason（E23）：业务终态的唯一依据之一 */
  let stopReason: string | null = null
  /** 是否收到 message_stop（E23）：信封闭合信号，**单独不足以判成功** */
  let sawMessageStop = false
  /** 上游明确报错（E23）：type=error 或 event:error */
  let upstreamError = false
  /** 业务帧 JSON 损坏（E23）：形似业务消息却解析失败，不得静默成功 */
  let malformedBusinessFrame = false

  const parser = createSSEParser((data) => {
    let evt: {
      type?: string
      index?: number
      usage?: unknown
      message?: { usage?: unknown }
      content_block?: { type?: string; id?: string; name?: string; input?: unknown }
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null }
      error?: unknown
    }
    try {
      evt = JSON.parse(data) as typeof evt
    } catch {
      // 只有**形似业务帧**的损坏才算错；心跳/注释/裸文本仍按协议忽略
      if (/"(type|content_block|delta|message)"\s*:/.test(data)) malformedBusinessFrame = true
      return
    }
    // 上游明确报错：type=error（含 event:error 走同一 payload）
    if (evt.type === 'error' || (evt.error !== undefined && evt.error !== null)) {
      upstreamError = true
      return
    }
    // 计量与文本/工具独立：只有基础输入及最终输出齐全才发布报告。
    usage.addEvent(evt)
    if (evt.type === 'message_stop') {
      sawMessageStop = true
      return
    }
    if (evt.type === 'message_delta' && evt.delta?.stop_reason !== undefined && evt.delta.stop_reason !== null) {
      stopReason = evt.delta.stop_reason
      return
    }
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      try {
        acc.startAnthropic(
          evt.index ?? 0,
          evt.content_block.id ?? '',
          evt.content_block.name ?? '',
          evt.content_block.input
        )
      } catch {
        // 冲突已记进 accumulator 的 conflict 状态；finishStrict 会拒绝
      }
      return
    }
    if (evt.type === 'content_block_delta' && evt.delta) {
      if (evt.delta.type === 'text_delta' && evt.delta.text) {
        text += evt.delta.text
        onText(evt.delta.text)
      } else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json) {
        acc.appendAnthropicJson(evt.index ?? 0, evt.delta.partial_json)
      }
    }
    // 其余合法未知事件（ping / content_block_stop 等）按协议忽略
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // 分片到齐 → 重置分片间隔计时（"还在来数据"与"卡死了"就是靠这一下分开的）
    guard.onChunk()
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.push(decoder.decode())
  parser.end()

  // ── 业务终态判定（E23）：先确定结局，再决定要不要交工具 ──
  const knownUsage = usage.getUsage()
  const failWith: (terminal: RunTerminal) => never = (terminal) => {
    throw new ProviderError('本次请求未正常完成', 0, {
      scope: 'request',
      terminal,
      usage: knownUsage,
      usageComplete: knownUsage !== null
    })
  }

  if (upstreamError) failWith({ state: 'failed', code: 'upstream-error' })
  if (malformedBusinessFrame) failWith({ state: 'unknown', code: 'malformed-stream' })

  const terminal = anthropicStopReasonToTerminal(stopReason)
  if (terminal === null) failWith({ state: 'unknown', code: 'missing-terminal' })
  // stop_reason 合法但信封没闭合 → 仍是未知（不能凭半截流当成功）
  if (!sawMessageStop) failWith({ state: 'unknown', code: 'missing-terminal' })
  if (terminal.state !== 'completed') failWith(terminal)

  let toolCalls
  try {
    toolCalls = acc.finishStrict()
  } catch (err) {
    if (err instanceof ToolCallIntegrityError) {
      failWith({ state: 'failed', code: 'incomplete-tool-call' })
    }
    throw err
  }

  // ── 结构一致性（E23-R1）：**先固定结构，再决定工具放行** ──
  // stop_reason 与「工具是否真的存在」必须互相印证；矛盾一律受控失败，绝不执行工具。
  const expectsTools = stopReason === 'tool_use'
  if (expectsTools && toolCalls.length === 0) {
    // 说本轮是工具调用，却一个完整 tool_use 块都没解析出来
    failWith({ state: 'failed', code: 'incomplete-tool-call' })
  }
  if (!expectsTools && toolCalls.length > 0) {
    // end_turn / stop_sequence 却冒出工具块 → 结构矛盾，执行它等于凭空干活
    failWith({ state: 'failed', code: 'incomplete-tool-call' })
  }

  return {
    text: text.length > 0 ? text : null,
    toolCalls,
    usage: knownUsage,
    usageComplete: knownUsage !== null
  }
}
