import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import { resolveApiUrl } from './url'
import { ProviderError, mapHttpError } from './errors'
import { thinkingBudgetFor } from './anthropic'
import { createSSEParser } from './sse'
import { usageFromAnthropicEvent } from './usage-parsers'
import type { TokenUsage } from '@shared/usage'
import { mergeUsageHalves } from '@shared/usage'
import { ToolCallAccumulator } from './tool-accumulator'

// Anthropic tool_use 适配（plan6 → P1）：把 OpenAI 风格的 Agent 消息翻译成 Anthropic 块结构。
// 三个纯函数（toAnthropicAgentMessages / fromAnthropicResponse / buildTools）可独立单测。

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

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
      out.push({ role: 'user', content: [{ type: 'text', text: m.content ?? '' }] })
    }
  }
  flushToolResults()
  return { system, messages: out }
}

/** Anthropic 响应 JSON → AgentChatResult（text 块拼接为回复；tool_use 块转 toolCalls） */
export function fromAnthropicResponse(json: {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
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
  return { text: text.length > 0 ? text : null, toolCalls }
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

export async function chatWithToolsAnthropic(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal
): Promise<AgentChatResult> {
  const { system, messages: anthropicMessages } = toAnthropicAgentMessages(messages)
  // thinking 与 tools 互斥（交叉验证结论）：部分 Anthropic 模型/版本拒收二者同时下发，
  // 且带 thinking 的 assistant 在续轮必须回带 thinking 块（我们只回放 text/tool_use）。
  // 工具模式下内核优先保工具能力 → 自动降级思考，并记入设置页提示（P2 UI）。
  const allowThinking = tools.length === 0
  const budget = allowThinking ? thinkingBudgetFor(settings.reasoningEffort, settings.maxTokens) : null

  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    stream: false,
    ...(system ? { system } : {}),
    ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(tools.length > 0 ? { tools: toAnthropicToolDefs(tools) } : {}),
    messages: anthropicMessages
  }

  const res = await fetch(resolveApiUrl(settings.baseURL, 'messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ProviderError(mapHttpError(res.status, detail), res.status)
  }
  return fromAnthropicResponse((await res.json()) as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> })
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
  const budget = tools.length === 0 ? thinkingBudgetFor(settings.reasoningEffort, settings.maxTokens) : null
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
 * 流式 + 工具（D-032）：按 SSE 事件类型分发——
 *   content_block_start(tool_use) → 开一个工具调用块
 *   content_block_delta(text_delta) → 文本增量上屏
 *   content_block_delta(input_json_delta) → 工具参数分片累积
 */
export async function streamWithToolsAnthropic(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  onText: (delta: string) => void,
  signal?: AbortSignal
): Promise<AgentChatResult> {
  const res = await fetch(resolveApiUrl(settings.baseURL, 'messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(buildAnthropicToolsBody(settings, messages, tools, true)),
    signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ProviderError(mapHttpError(res.status, detail), res.status)
  }
  if (!res.body) return chatWithToolsAnthropic(settings, apiKey, messages, tools, signal)

  const acc = new ToolCallAccumulator()
  let text = ''
  /** 这一轮的用量（plan8 R9）：Anthropic **分两处报**（message_start 输入 / message_delta 输出） */
  let usage: TokenUsage | null = null

  const parser = createSSEParser((data) => {
    try {
      const evt = JSON.parse(data) as {
        type?: string
        index?: number
        usage?: unknown
        message?: { usage?: unknown }
        content_block?: { type?: string; id?: string; name?: string; input?: unknown }
        delta?: { type?: string; text?: string; partial_json?: string }
      }
      // 两处都收：只收一处账面会少一半（输入那半在 message_start 里就报完了）
      // ⚠️ 这里必须是**合并**，不能是覆盖 —— 原来的 `usage = evtUsage` 会让后到的
      //    `message_delta`（只报输出）把 `message_start` 报的**输入量抹成 0**：
      //    账面少一半，而日志里什么都看不出来（2026-09-13 修）。
      //    合并规则（逐字段取有值的那份）见 `@shared/usage` 的 `mergeUsageHalves`。
      const evtUsage = usageFromAnthropicEvent(evt)
      if (evtUsage) usage = usage ? mergeUsageHalves(usage, evtUsage) : evtUsage
      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        acc.startAnthropic(
          evt.index ?? 0,
          evt.content_block.id ?? '',
          evt.content_block.name ?? '',
          evt.content_block.input
        )
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
    } catch {
      // 非 JSON 行（心跳等）忽略
    }
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parser.push(decoder.decode(value, { stream: true }))
  }
  parser.push(decoder.decode())
  parser.end()

  const toolCalls = acc.finish()
  return { text: text.length > 0 ? text : null, toolCalls, ...(usage ? { usage } : {}) }
}