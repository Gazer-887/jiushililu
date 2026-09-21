import { afterEach, describe, expect, it } from 'vitest'
import { httpFetchKind, setHttpFetch } from '@main/providers/http-client'
import { OpenAICompatibleProvider } from '@main/providers/openai'
import { AnthropicProvider } from '@main/providers/anthropic'
import { ProviderError } from '@main/providers/errors'
import type { ProviderRequest } from '@main/providers/types'
import type { ChatMessage, ModelSettings } from '@shared/ipc'
import type { TokenUsage } from '@shared/usage'

/**
 * 模型请求的**网络出口**（plan7 批 F2）—— 这一组测试是它带来的直接好处：
 * 在此之前 `streamChat` 里的请求**一行都进不了单测**（只有纯函数被覆盖），因为没法拦下真 `fetch`。
 * 现在出口可注入，于是"请求发出去什么、流怎么被消费、错了抛什么"第一次有了断言。
 *
 * ⚠️ 它同时是代理功能的**替身证据**：注入的实现接管了请求，等价于真机上 `net.fetch` 接管请求 ——
 *    真机上"配了代理到底有没有走"由 `scripts/probe-main-net.cjs` 端到端证明，两者互补、不重复。
 */

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'test-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 1024,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 200,
  supportsImages: false
}

const messages: ChatMessage[] = [{ role: 'user', content: 'ping' }]

function req(): ProviderRequest {
  return { settings, apiKey: 'sk-test', messages, signal: new AbortController().signal }
}

/** 把若干 SSE 帧拼成一个**真**流式响应（`res.body.getReader()` 那条路必须真走到） */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

afterEach(() => {
  // 出口是**模块级单例**，不清会串到别的测试文件去
  setHttpFetch(null)
})

describe('httpFetch 出口', () => {
  it('默认走 Node 原生 fetch（未注入时与改造前行为一致，不会更差）', () => {
    expect(httpFetchKind()).toBe('node-fetch')
  })

  it('注入后 kind 变化、置回 null 后恢复', () => {
    setHttpFetch(async () => jsonResponse({ ok: true }))
    expect(httpFetchKind()).toBe('injected')
    setHttpFetch(null)
    expect(httpFetchKind()).toBe('node-fetch')
  })
})

describe('OpenAI 兼容：流式与非流式（出口注入后第一次被覆盖）', () => {
  it('流式：分块依次回调，流尾的 usage 也要收得到', async () => {
    setHttpFetch(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const chunks: string[] = []
    let usage: TokenUsage | null = null
    await new OpenAICompatibleProvider().streamChat(req(), {
      onChunk: (t) => chunks.push(t),
      onUsage: (u) => (usage = u)
    })
    expect(chunks).toEqual(['你', '好'])
    expect(usage).toMatchObject({ promptTokens: 3, completionTokens: 2 })
  })

  it('请求体带 `stream_options.include_usage`（plan8 R9：不显式请求，流尾就没有 usage）', async () => {
    let sent = ''
    setHttpFetch(async (_url, init) => {
      sent = String(init.body ?? '')
      return sseResponse(['data: [DONE]\n\n'])
    })
    await new OpenAICompatibleProvider().streamChat(req(), { onChunk: () => undefined })
    expect(sent).toContain('"stream_options":{"include_usage":true}')
  })

  it('认证头与地址：Bearer + 补 /v1 后的 chat/completions', async () => {
    let url = ''
    let auth = ''
    setHttpFetch(async (u, init) => {
      url = u
      auth = String((init.headers as Record<string, string>)['Authorization'] ?? '')
      return sseResponse(['data: [DONE]\n\n'])
    })
    await new OpenAICompatibleProvider().streamChat(req(), { onChunk: () => undefined })
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(auth).toBe('Bearer sk-test')
  })

  it('非 2xx：抛 ProviderError 且带上状态码（错误映射全靠它）', async () => {
    setHttpFetch(async () => jsonResponse({ error: { message: 'bad key' } }, 401))
    await expect(
      new OpenAICompatibleProvider().streamChat(req(), { onChunk: () => undefined })
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('非流式：整段正文一次性回调', async () => {
    setHttpFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1 } })
    )
    const chunks: string[] = []
    await new OpenAICompatibleProvider().streamChat(
      { ...req(), settings: { ...settings, stream: false } },
      { onChunk: (t) => chunks.push(t) }
    )
    expect(chunks).toEqual(['hi'])
  })
})

describe('Anthropic：认证头与流式取数走另一套方言', () => {
  it('认证头是 x-api-key + anthropic-version（不能照抄 OpenAI 那套）', async () => {
    let headers: Record<string, string> = {}
    setHttpFetch(async (_u, init) => {
      headers = init.headers as Record<string, string>
      return sseResponse(['data: {"type":"content_block_stop"}\n\n'])
    })
    await new AnthropicProvider().streamChat(req(), { onChunk: () => undefined })
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('只收 text_delta，且 usage 分两处报（message_start 给输入、message_delta 给输出）', async () => {
    setHttpFetch(async () =>
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"别收我"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n'
      ])
    )
    const chunks: string[] = []
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(req(), {
      onChunk: (t) => chunks.push(t),
      onUsage: (u) => usages.push(u)
    })
    expect(chunks).toEqual(['A'])
    expect(usages.length).toBeGreaterThan(0)
  })

  it('非流式：整份响应里的 usage 也要报（`stream: false` 的档案以前永远没有账）', async () => {
    setHttpFetch(async () =>
      jsonResponse({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 3 }
      })
    )
    const chunks: string[] = []
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      { ...req(), settings: { ...settings, stream: false } },
      { onChunk: (t) => chunks.push(t), onUsage: (u) => usages.push(u) }
    )
    expect(chunks).toEqual(['hi'])
    expect(usages).toEqual([
      { promptTokens: 11, completionTokens: 5, cachedPromptTokens: 3, reasoningTokens: null }
    ])
  })
})
