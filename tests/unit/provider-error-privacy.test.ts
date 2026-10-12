import { afterEach, describe, expect, it } from 'vitest'
import { mapHttpError, ProviderError } from '@main/providers/errors'
import { setHttpFetch } from '@main/providers/http-client'
import { OpenAICompatibleProvider } from '@main/providers/openai'
import { AnthropicProvider } from '@main/providers/anthropic'
import type { ModelSettings } from '@shared/ipc'

const marker = 'PUBLIC_PRIVATE_BODY_MARKER'
afterEach(() => setHttpFetch(null))
describe('HTTP错误不回显任何上游正文', () => {
  it.each([400, 422, 418, 499, 502])('状态%s保留可排查状态，不含正文/嵌套假秘密', (status) => {
    const message = mapHttpError(status, JSON.stringify({ error: { message: marker }, authorization: marker }))
    expect(message).toContain(String(status)); expect(message).not.toContain(marker)
  })
  it('ProviderError不能用原始正文绕开状态文案，cause不进入message', () => {
    const error = new ProviderError(marker, 400)
    Object.assign(error, { cause: new Error(marker) })
    expect(error.status).toBe(400); expect(error.message).not.toContain(marker); expect(error.message).toContain('400')
  })
  it.each([OpenAICompatibleProvider, AnthropicProvider])('实际Provider响应错误走安全边界 %s', async (Provider) => {
    setHttpFetch(async () => new Response(JSON.stringify({ error: { message: marker } }), { status: 400 }))
    const provider = new Provider()
    const settings = { baseURL: 'https://public.invalid', model: 'public-model', maxTokens: 64, timeoutMs: 1000, stream: true } as ModelSettings
    try {
      await provider.streamChat({ settings, apiKey: 'public-fake-key', messages: [{ role: 'user', content: '公共文本' }], signal: new AbortController().signal }, { onChunk: () => {} })
      throw new Error('应拒绝HTTP400')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError); expect((error as Error).message).not.toContain(marker)
    }
  })
})
