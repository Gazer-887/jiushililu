import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import { resolveApiUrl } from './url'
import { usageFromOpenAIChunk } from './usage-parsers'
import type { TokenUsage } from '@shared/usage'
import { ProviderError, mapHttpError } from './errors'
import { createSSEParser } from './sse'
import { ToolCallAccumulator } from './tool-accumulator'
import { httpFetch } from './http-client'
import { createStreamGuard, type StreamGuardOptions } from './stream-guard'

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
  const res = await httpFetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
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

/** 流式 + 工具（D-032 核心）：文本增量实时回调、工具调用参数分片累积；一条通道同时承担"聊天"与"干活" */
export async function streamWithToolsOpenAI(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
  /** 思考增量（DeepSeek 系返回 `reasoning_content`）；不传 = 忽略 */
  onReasoning?: (delta: string) => void,
  /** 两层守卫的时长（plan29 D-090）。不传 = 用默认口径；**单测传短值** */
  guardOpts?: StreamGuardOptions
): Promise<AgentChatResult> {
  // 守卫在**这里**建、而不是由调用方传进来：首包口径是"从发起请求到第一个分片"，
  // 只有紧挨着 httpFetch 的地方才数得准；让调用方建就多了一段"还没开始请求但已经在计时"的空转。
  const guard = createStreamGuard(signal, guardOpts)
  try {
    const res = await httpFetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildToolsBody(settings, messages, tools, true)),
      signal: guard.signal
    })
    if (!res.ok) await throwHttpError(res)

    // 上游不返回流（或后端强制非流）时降级为一次性读取
    if (!res.body) return await chatWithToolsOpenAI(settings, apiKey, messages, tools, signal)

    const acc = new ToolCallAccumulator()
    let text = ''
    /**
     * 这一轮的用量（plan8 R9）。⚠️ **主循环这条才是真正花钱的**（一次对话可能调好几轮模型）——
     * 上游只在**最后一个 chunk** 报 usage（且必须显式请求 `stream_options.include_usage`），
     * 所以每个 chunk 都要试着取一次；厂商不报就留 null，上层据此退回估算并**标注**。
     */
    let usage: TokenUsage | null = null

    const parser = createSSEParser((data) => {
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as {
          usage?: unknown
          choices?: Array<{
            delta?: {
              content?: string
              /** DeepSeek 系（reasoner / v4）把思考放这里；OpenAI 系通常不返回内容 */
              reasoning_content?: string
              tool_calls?: Array<Record<string, unknown>>
            }
          }>
        }
        const chunkUsage = usageFromOpenAIChunk(json)
        if (chunkUsage) usage = chunkUsage
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
      // 分片到齐 → 重置分片间隔计时（"还在来数据"与"卡死了"就是靠这一下分开的）
      guard.onChunk()
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.end()

    const toolCalls = acc.finish()
    return { text: text.length > 0 ? text : null, toolCalls, ...(usage ? { usage } : {}) }
  } catch (err) {
    // 守卫开的枪 → 换成**说清是哪一层超时**的话（不是笼统的"请求超时"）
    const timedOut = guard.timeoutMessage()
    if (timedOut) throw new ProviderError(timedOut, 0)
    throw err
  } finally {
    guard.dispose()
  }
}
