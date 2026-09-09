import { describe, expect, it } from 'vitest'
import { mapHttpError, isAbortError } from '@main/providers/errors'
import { chatMessagesSchema, settingsSchema } from '@main/schemas'

describe('mapHttpError（HTTP 错误翻译成人话）', () => {
  it('401/404/429 各有针对性提示', () => {
    expect(mapHttpError(401, '')).toContain('API Key')
    expect(mapHttpError(404, '')).toContain('/v1')
    expect(mapHttpError(429, '')).toContain('额度')
  })

  it('5xx 归为服务端问题', () => {
    expect(mapHttpError(503, '')).toContain('服务端')
  })

  it('未知状态码带原始片段', () => {
    expect(mapHttpError(418, 'teapot')).toContain('418')
    expect(mapHttpError(418, 'teapot')).toContain('teapot')
  })
})

describe('isAbortError', () => {
  it('识别 AbortError', () => {
    const err = new Error('x')
    err.name = 'AbortError'
    expect(isAbortError(err)).toBe(true)
    expect(isAbortError(new Error('y'))).toBe(false)
    expect(isAbortError('string')).toBe(false)
  })
})

describe('settingsSchema（入参闸门）', () => {
  const base = {
    providerType: 'openai-compatible',
    model: 'test-model',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 4096,
    timeoutMs: 60000,
    stream: true,
    contextWindow: 131072,
    reasoningEffort: 'default',
    maxToolRounds: 200,
    supportsImages: false
  }

  it('baseURL 不带协议头自动补 https://', () => {
    const parsed = settingsSchema.parse({ ...base, baseURL: 'api.deepseek.com' })
    expect(parsed.baseURL).toBe('https://api.deepseek.com')
  })

  it('baseURL 已带协议不重复补', () => {
    const parsed = settingsSchema.parse({ ...base, baseURL: 'https://api.deepseek.com/' })
    expect(parsed.baseURL).toBe('https://api.deepseek.com/')
  })

  it('非法 baseURL 拒绝', () => {
    expect(() => settingsSchema.parse({ ...base, baseURL: 'http://' })).toThrow()
  })

  it('max_tokens 超百万闸门拒绝', () => {
    expect(() => settingsSchema.parse({ ...base, baseURL: 'https://x.com', maxTokens: 10_000_000 })).toThrow()
    expect(() => settingsSchema.parse({ ...base, baseURL: 'https://x.com', maxTokens: 384_000 })).toBeTruthy()
  })

  it('采样参数接受 null', () => {
    const parsed = settingsSchema.parse({ ...base, baseURL: 'https://x.com' })
    expect(parsed.temperature).toBe(null)
  })
})

describe('chatMessagesSchema', () => {
  it('空数组拒绝', () => {
    expect(() => chatMessagesSchema.parse([])).toThrow()
  })

  it('合法消息通过', () => {
    expect(chatMessagesSchema.parse([{ role: 'user', content: 'hi' }])).toHaveLength(1)
  })
})
