import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import { resolveApiUrl } from './url'
import { ProviderError, mapHttpError } from './errors'

// OpenAI tool-calls 适配（plan6 → P1）：主循环的非流式模型通道。
// DeepSeek / V4 全系原生兼容 OpenAI tool-calls 协议；采样字段与 chat 路径同规则（可空不发）。

export async function chatWithToolsOpenAI(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal
): Promise<AgentChatResult> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.maxTokens,
    stream: false,
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }
  if (settings.temperature !== null) body['temperature'] = settings.temperature
  if (settings.topP !== null) body['top_p'] = settings.topP
  if (settings.topK !== null) body['top_k'] = settings.topK
  if (settings.reasoningEffort !== 'default') body['reasoning_effort'] = settings.reasoningEffort

  const res = await fetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ProviderError(mapHttpError(res.status, detail), res.status)
  }

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
