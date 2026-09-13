import type { ChatMessage, ModelSettings, ReasoningEffort, TestResult } from '@shared/ipc'
import { createSSEParser } from './sse'
import { usageFromAnthropicEvent } from './usage-parsers'
import { ProviderError, isAbortError, mapHttpError } from './errors'
import { resolveApiUrl } from './url'
import type { IProvider, ProviderRequest, StreamCallbacks } from './types'

// 思考强度 → Anthropic extended thinking 预算（方言映射）
const EFFORT_BUDGET: Record<Exclude<ReasoningEffort, 'default'>, number> = {
  low: 8192,
  medium: 16384,
  high: 32768,
  max: 65536
}

// 纯函数：default 不开思考；其余按强度给预算。
// Anthropic 硬性要求 max_tokens > budget_tokens：空间不足 2048 时空间不够，干脆不开思考。
export function thinkingBudgetFor(effort: ReasoningEffort, maxTokens: number): number | null {
  if (effort === 'default') return null
  const ceiling = maxTokens - 1024
  if (ceiling < 1024) return null
  return Math.min(EFFORT_BUDGET[effort], ceiling)
}

// 纯函数：Anthropic 的 system 是顶层字段，不走 messages 数组（单元测试覆盖）
export function mapAnthropicMessages(
  messages: ChatMessage[]
): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return { system, messages: rest }
}

// 纯函数：构造请求体。注意 max_tokens 在 Anthropic 是必填项（单元测试覆盖）
export function buildAnthropicBody(
  settings: ModelSettings,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  const { system, messages: rest } = mapAnthropicMessages(messages)
  const budget = thinkingBudgetFor(settings.reasoningEffort, settings.maxTokens)
  // Anthropic 规定 temperature 与 top_p 互斥——top_p 设置时优先，temperature 让位；
  // 思考模式下两者都不发（必须走默认采样）。
  const sampling: Record<string, unknown> = budget
    ? {}
    : settings.topP != null
      ? { top_p: settings.topP }
      : settings.temperature != null
        ? { temperature: settings.temperature }
        : {}
  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    ...sampling,
    stream,
    ...(system ? { system } : {}),
    ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(settings.topK != null ? { top_k: settings.topK } : {}),
    messages: rest
  }
}

async function throwHttpError(res: Response): Promise<never> {
  const body = await res.text().catch(() => '')
  throw new ProviderError(mapHttpError(res.status, body), res.status)
}

interface AnthropicEvent {
  type?: string
  delta?: { type?: string; text?: string }
}

export class AnthropicProvider implements IProvider {
  readonly type = 'anthropic' as const

  async streamChat(req: ProviderRequest, cb: StreamCallbacks): Promise<void> {
    const { settings, apiKey, signal } = req
    const res = await fetch(resolveApiUrl(settings.baseURL, 'messages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(buildAnthropicBody(settings, req.messages, settings.stream)),
      signal
    })
    if (!res.ok) await throwHttpError(res)

    if (!settings.stream || !res.body) {
      const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text) cb.onChunk(text)
      return
    }

    const parser = createSSEParser((data) => {
      try {
        const json = JSON.parse(data) as AnthropicEvent
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
          cb.onChunk(json.delta.text)
        }
        // 用量**分两处报**（plan8 R9）：`message_start` 给输入、`message_delta` 给输出；只收一处账面就少一半
        const usage = usageFromAnthropicEvent(json)
        if (usage) cb.onUsage?.(usage)
      } catch {
        // 忽略无法解析的行
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
  }

  async testConnection(req: ProviderRequest): Promise<TestResult> {
    const start = Date.now()
    try {
      const res = await fetch(resolveApiUrl(req.settings.baseURL, 'messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: req.settings.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false
        }),
        signal: req.signal
      })
      if (!res.ok) await throwHttpError(res)
      return { ok: true, message: '连接成功，接口地址、模型名与 API Key 均有效', latencyMs: Date.now() - start }
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, message: '连接超时：请检查 baseURL 是否可达，网络、代理与 DNS 是否正常' }
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 「获取可用模型」：`GET {baseURL}/models`。认证头与对话不同（`x-api-key` + `anthropic-version`），不能照抄 OpenAI 那套 */
  async listModels(req: ProviderRequest) {
    try {
      const res = await fetch(resolveApiUrl(req.settings.baseURL, 'models'), {
        method: 'GET',
        headers: {
          'x-api-key': req.apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: req.signal
      })
      if (!res.ok) await throwHttpError(res)
      const body = (await res.json()) as unknown
      const list =
        body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
          ? ((body as { data: unknown[] }).data as unknown[])
          : []
      const models = list
        .map((m) =>
          m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'
            ? (m as { id: string }).id
            : ''
        )
        .filter((s) => s.length > 0)
      if (models.length === 0) {
        return { ok: false, message: '该端点未返回任何模型（可能它不提供模型列表接口）', models: [] }
      }
      return { ok: true, message: `获取到 ${models.length} 个模型`, models }
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, message: '获取模型列表超时：请检查 baseURL 是否可达', models: [] }
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err), models: [] }
    }
  }
}
