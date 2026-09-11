import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import { resolveApiUrl } from './url'
import { ProviderError, mapHttpError } from './errors'
import { thinkingBudgetFor } from './anthropic'

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
