import type { ChatMessage, ModelSettings, TestResult } from '@shared/ipc'
import { createSSEParser } from './sse'
import { ProviderError, isAbortError, mapHttpError } from './errors'
import { resolveApiUrl } from './url'
import { usageFromOpenAIChunk } from './usage-parsers'
import type { IProvider, ProviderRequest, StreamCallbacks } from './types'

// 纯函数：构造请求体（单元测试覆盖）
export function buildOpenAIChatBody(
  settings: ModelSettings,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.maxTokens,
    stream
  }
  // 流式必须**显式请求** usage（plan8 R9）：不写这句最后一个 chunk 里根本没有 usage，这轮就永远拿不到真实用量
  if (stream) body['stream_options'] = { include_usage: true }
  // 采样三兄弟：留空（null）不发，跟随厂商默认
  if (settings.temperature != null) body['temperature'] = settings.temperature
  if (settings.topP != null) body['top_p'] = settings.topP
  // top_k：官方 OpenAI 忽略未知参数；多家兼容端点（智谱/GLM 等）支持，按需填
  if (settings.topK != null) body['top_k'] = settings.topK
  // 思考强度方言：OpenAI 系叫 reasoning_effort（low/medium/high），DeepSeek 同名兼容；'max' 是 DeepSeek 词表，
  // 发给 OpenAI 可能 400 —— 取值依厂商支持
  if (settings.reasoningEffort !== 'default') body['reasoning_effort'] = settings.reasoningEffort
  return body
}

async function throwHttpError(res: Response): Promise<never> {
  const body = await res.text().catch(() => '')
  throw new ProviderError(mapHttpError(res.status, body), res.status)
}

interface OpenAIChunk {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
}

export class OpenAICompatibleProvider implements IProvider {
  readonly type = 'openai-compatible' as const

  async streamChat(req: ProviderRequest, cb: StreamCallbacks): Promise<void> {
    const { settings, apiKey, signal } = req
    const res = await fetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildOpenAIChatBody(settings, req.messages, settings.stream)),
      signal
    })
    if (!res.ok) await throwHttpError(res)

    if (!settings.stream || !res.body) {
      const json = (await res.json()) as unknown
      const text = (json as OpenAIChunk).choices?.[0]?.message?.content ?? ''
      if (text) cb.onChunk(text)
      // 非流式：usage 就在同一个响应里（plan8 R9）
      const u = usageFromOpenAIChunk(json)
      if (u) cb.onUsage?.(u)
      return
    }

    const parser = createSSEParser((data) => {
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as OpenAIChunk
        const delta = json.choices?.[0]?.delta?.content
        if (delta) cb.onChunk(delta)
        // **流式的 usage 在最后一个 chunk**（且必须显式请求，见 `buildOpenAIChatBody`）；空 choices 那一帧就是它
        const u = usageFromOpenAIChunk(json)
        if (u) cb.onUsage?.(u)
      } catch {
        // 心跳、注释等无法解析的行直接忽略
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
      const res = await fetch(resolveApiUrl(req.settings.baseURL, 'chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify({
          model: req.settings.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        signal: req.signal
      })
      if (!res.ok) await throwHttpError(res)
      return { ok: true, message: '连接成功，接口地址 / 模型名 / Key 三件套都有效', latencyMs: Date.now() - start }
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, message: '连接超时：检查 baseURL 是否可达，网络 / 代理 / DNS 是否正常' }
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 「获取可用模型」：`GET {baseURL}/models`；返回体约定 `{ data: [{ id }] }`（少数实现直接给数组，两种都认） */
  async listModels(req: ProviderRequest) {
    try {
      const res = await fetch(resolveApiUrl(req.settings.baseURL, 'models'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${req.apiKey}` },
        signal: req.signal
      })
      if (!res.ok) await throwHttpError(res)
      const body = (await res.json()) as unknown
      const list = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
          ? ((body as { data: unknown[] }).data as unknown[])
          : []
      const models = list
        .map((m) =>
          typeof m === 'string'
            ? m
            : m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string'
              ? (m as { id: string }).id
              : ''
        )
        .filter((s) => s.length > 0)
      if (models.length === 0) {
        return { ok: false, message: '这个端点没有返回任何模型（可能它不提供模型列表接口）', models: [] }
      }
      return { ok: true, message: `拉到 ${models.length} 个模型`, models }
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, message: '拉取模型列表超时：检查 baseURL 是否可达', models: [] }
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err), models: [] }
    }
  }
}
