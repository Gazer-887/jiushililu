import type { ChatMessage, ModelSettings, TestResult } from '@shared/ipc'
import { createSSEParser } from './sse'
import { ProviderError, isAbortError, mapHttpError } from './errors'
import { resolveApiUrl } from './url'
import type { IProvider, ProviderRequest, StreamCallbacks } from './types'

// 纯函数：构造请求体（单元测试覆盖）
export function buildOpenAIChatBody(
  settings: ModelSettings,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  return {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream,
    // 思考强度方言：OpenAI 系是 reasoning_effort（low/medium/high）；
    // DeepSeek 同名兼容（官方示例另带 thinking 开关，若实测不生效再补发）。
    // 'max' 是 DeepSeek 词表，发 给 OpenAI 可能 400——取值依厂商支持。
    ...(settings.reasoningEffort !== 'default' ? { reasoning_effort: settings.reasoningEffort } : {})
  }
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
      const json = (await res.json()) as OpenAIChunk
      const text = json.choices?.[0]?.message?.content ?? ''
      if (text) cb.onChunk(text)
      return
    }

    const parser = createSSEParser((data) => {
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as OpenAIChunk
        const delta = json.choices?.[0]?.delta?.content
        if (delta) cb.onChunk(delta)
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
}
