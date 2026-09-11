import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import { resolveApiUrl } from './url'
import { ProviderError, mapHttpError } from './errors'
import { createSSEParser } from './sse'
import { ToolCallAccumulator } from './tool-accumulator'

// OpenAI tool-calls 适配（plan6 → P1；D-032 增补流式）：主循环的模型通道。
// DeepSeek / V4 全系原生兼容 OpenAI tool-calls 协议；采样字段与 chat 路径同规则（可空不发）。

/** 构造带工具请求体（纯函数，单测覆盖） */
export function buildToolsBody(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: ToolSchema[],
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.maxTokens,
    stream,
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }
  if (settings.temperature !== null) body['temperature'] = settings.temperature
  if (settings.topP !== null) body['top_p'] = settings.topP
  if (settings.topK !== null) body['top_k'] = settings.topK
  if (settings.reasoningEffort !== 'default') body['reasoning_effort'] = settings.reasoningEffort
  return body
}

async function throwHttpError(res: Response): Promise<never> {
  const detail = await res.text().catch(() => '')
  throw new ProviderError(mapHttpError(res.status, detail), res.status)
}

export async function chatWithToolsOpenAI(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal
): Promise<AgentChatResult> {
  const res = await fetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildToolsBody(settings, messages, tools, false)),
    signal
  })
  if (!res.ok) await throwHttpError(res)

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
    }>
  }
  const msg = json.choices?.[0]?.message ?? {}
  return {
    text: typeof msg.content === 'string' && msg.content.length > 0 ? msg.content : null,
    toolCalls: (msg.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '{}'
    }))
  }
}

/**
 * 流式 + 工具（D-032 核心）：文本增量实时回调，工具调用参数分片累积。
 * 一条通道同时承担"聊天"与"干活"——由模型自己决定这轮要不要调工具。
 */
export async function streamWithToolsOpenAI(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
  /** 思考增量（DeepSeek 系返回 `reasoning_content`）；不传 = 忽略 */
  onReasoning?: (delta: string) => void
): Promise<AgentChatResult> {
  const res = await fetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildToolsBody(settings, messages, tools, true)),
    signal
  })
  if (!res.ok) await throwHttpError(res)

  // 上游不返回流（或后端强制非流）时降级为一次性读取
  if (!res.body) return chatWithToolsOpenAI(settings, apiKey, messages, tools, signal)

  const acc = new ToolCallAccumulator()
  let text = ''

  const parser = createSSEParser((data) => {
    if (data === '[DONE]') return
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string
            /** DeepSeek 系（reasoner / v4）把思考放这里；OpenAI 系通常不返回内容 */
            reasoning_content?: string
            tool_calls?: Array<Record<string, unknown>>
          }
        }>
      }
      const delta = json.choices?.[0]?.delta
      if (!delta) return
      // 思考增量：**不进 text**，只外送 —— 它是过程，不是回答
      if (delta.reasoning_content) onReasoning?.(delta.reasoning_content)
      if (delta.content) {
        text += delta.content
        onText(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        acc.pushOpenAI(
          delta.tool_calls as Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        )
      }
    } catch {
      // 心跳 / 注释等非 JSON 行忽略
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
  return { text: text.length > 0 ? text : null, toolCalls }
}
