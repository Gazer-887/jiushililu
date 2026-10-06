// K51 单测：Anthropic `GET /v1/models` 顺手抽官方能力位（D-146 D）。
// 三态：supported true 进表 / false 进表 / 缺字段跳过（没声明≠不支持）。
// OpenAI 侧无官方位 ⇒ 不带 capabilities 字段（缺省，不猜）。
import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '@main/providers/http-client'
import { AnthropicProvider } from '@main/providers/anthropic'
import { OpenAICompatibleProvider } from '@main/providers/openai'
import type { ProviderRequest } from '@main/providers/types'
import type { ModelSettings } from '@shared/ipc'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function req(settings: ModelSettings): ProviderRequest {
  return { settings, apiKey: 'sk-test', messages: [], signal: new AbortController().signal }
}

const base: ModelSettings = {
  providerType: 'anthropic',
  baseURL: 'https://api.anthropic.com',
  model: 'm',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 1024,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 200,
  inputModalities: ['text']
}

afterEach(() => {
  setHttpFetch(null)
})

describe('K51 官方能力位抽取（listModels 顺手）', () => {
  it('true/false 进表，缺 capabilities 字段的模型跳过', async () => {
    setHttpFetch(async () =>
      jsonResponse({
        data: [
          { id: 'claude-yes', capabilities: { image_input: { supported: true } } },
          { id: 'claude-no', capabilities: { image_input: { supported: false } } },
          { id: 'claude-quiet' }
        ]
      })
    )
    const r = await new AnthropicProvider().listModels(req(base))
    expect(r.ok).toBe(true)
    expect(r.models).toEqual(['claude-yes', 'claude-no', 'claude-quiet'])
    expect(r.capabilities).toEqual({
      'claude-yes': { imageInput: true },
      'claude-no': { imageInput: false }
    })
  })

  it('supported 非布尔（字符串/数字）按缺字段处理，不进表', async () => {
    setHttpFetch(async () =>
      jsonResponse({ data: [{ id: 'claude-weird', capabilities: { image_input: { supported: 'yes' } } }] })
    )
    const r = await new AnthropicProvider().listModels(req(base))
    expect(r.ok).toBe(true)
    expect(r.capabilities ?? {}).toEqual({})
  })

  it('OpenAI 侧不带 capabilities 字段（无官方位，不猜）', async () => {
    setHttpFetch(async () => jsonResponse({ data: [{ id: 'gpt-x' }] }))
    const r = await new OpenAICompatibleProvider().listModels(
      req({ ...base, providerType: 'openai-compatible' })
    )
    expect(r.ok).toBe(true)
    expect('capabilities' in r).toBe(false)
  })
})
