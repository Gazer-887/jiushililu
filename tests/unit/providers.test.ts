import { describe, expect, it } from 'vitest'
import { resolveApiUrl } from '@main/providers/url'
import { buildOpenAIChatBody } from '@main/providers/openai'
import {
  buildAnthropicBody,
  mapAnthropicMessages,
  thinkingBudgetFor
} from '@main/providers/anthropic'
import { maskKey } from '@main/store/mask'
import type { ChatMessage, ModelSettings } from '@shared/ipc'

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'test-model',
  temperature: 0.3,
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

describe('resolveApiUrl（/v1 归一化，头号 404 坑）', () => {
  it('无 /v1 自动补', () => {
    expect(resolveApiUrl('https://api.openai.com', 'chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
  })

  it('已带 /v1 不重复拼', () => {
    expect(resolveApiUrl('https://api.openai.com/v1', 'chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
  })

  it('去掉结尾斜杠', () => {
    expect(resolveApiUrl('https://api.deepseek.com/', 'chat/completions')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
  })

  it('本地 Ollama', () => {
    expect(resolveApiUrl('http://localhost:11434', 'chat/completions')).toBe(
      'http://localhost:11434/v1/chat/completions'
    )
  })

  it('Anthropic messages 路径', () => {
    expect(resolveApiUrl('https://api.anthropic.com', 'messages')).toBe(
      'https://api.anthropic.com/v1/messages'
    )
  })
})

describe('buildOpenAIChatBody', () => {
  it('使用 snake_case 的 max_tokens 并带上 stream', () => {
    const body = buildOpenAIChatBody(settings, [{ role: 'user', content: 'hi' }], true)
    expect(body).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      max_tokens: 1024,
      stream: true
    })
  })

  it('思考强度非 default 时发 reasoning_effort，default 不发', () => {
    const withEffort = buildOpenAIChatBody(
      { ...settings, reasoningEffort: 'high' },
      [{ role: 'user', content: 'hi' }],
      true
    )
    expect(withEffort.reasoning_effort).toBe('high')
    const without = buildOpenAIChatBody(settings, [{ role: 'user', content: 'hi' }], true)
    expect('reasoning_effort' in without).toBe(false)
  })

  it('采样参数留空（null）不发，设置则发 snake_case', () => {
    const body = buildOpenAIChatBody(
      { ...settings, temperature: null, topP: 0.9, topK: 40 },
      [{ role: 'user', content: 'hi' }],
      true
    )
    expect('temperature' in body).toBe(false)
    expect(body.top_p).toBe(0.9)
    expect(body.top_k).toBe(40)
  })
})

describe('mapAnthropicMessages', () => {
  it('system 提取为顶层，其余保留顺序', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '再见' }
    ]
    const mapped = mapAnthropicMessages(messages)
    expect(mapped.system).toBe('你是助手')
    expect(mapped.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '再见' }
    ])
  })
})

describe('buildAnthropicBody', () => {
  it('max_tokens 必填、system 进顶层字段', () => {
    const body = buildAnthropicBody(
      settings,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ],
      true
    )
    expect(body).toMatchObject({ model: 'test-model', max_tokens: 1024, system: 'sys' })
    const msgs = body.messages as Array<{ role: string }>
    expect(msgs.every((m) => m.role !== 'system')).toBe(true)
  })

  it('无 system 时不出 system 字段', () => {
    const body = buildAnthropicBody(settings, [{ role: 'user', content: 'hi' }], false)
    expect('system' in body).toBe(false)
  })

  it('思考强度 default：无 thinking 块，temperature 正常发', () => {
    const body = buildAnthropicBody(settings, [{ role: 'user', content: 'hi' }], true)
    expect('thinking' in body).toBe(false)
    expect(body.temperature).toBe(0.3)
  })

  it('思考强度 high：发 thinking 预算且不发 temperature', () => {
    const body = buildAnthropicBody(
      { ...settings, reasoningEffort: 'high', maxTokens: 65536 },
      [{ role: 'user', content: 'hi' }],
      true
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 })
    expect('temperature' in body).toBe(false)
  })

  it('temperature 与 top_p 互斥：top_p 设置时优先', () => {
    const body = buildAnthropicBody(
      { ...settings, temperature: 0.3, topP: 0.9 },
      [{ role: 'user', content: 'hi' }],
      true
    )
    expect(body.top_p).toBe(0.9)
    expect('temperature' in body).toBe(false)
  })

  it('top_k 独立发送', () => {
    const body = buildAnthropicBody(
      { ...settings, topK: 40 },
      [{ role: 'user', content: 'hi' }],
      true
    )
    expect(body.top_k).toBe(40)
  })
})

describe('thinkingBudgetFor（思考预算方言映射）', () => {
  it('default 不开思考', () => {
    expect(thinkingBudgetFor('default', 65536)).toBe(null)
  })

  it('按强度给预算（预算必须小于 max_tokens）', () => {
    expect(thinkingBudgetFor('low', 65536)).toBe(8192)
    expect(thinkingBudgetFor('max', 70000)).toBe(65536)
    expect(thinkingBudgetFor('max', 65536)).toBe(64512)
  })

  it('max_tokens 不足 2048 时空间不够，直接不开思考', () => {
    expect(thinkingBudgetFor('high', 2000)).toBe(null)
    expect(thinkingBudgetFor('max', 1024)).toBe(null)
  })
})

describe('maskKey（Key 掩码，日志防泄露）', () => {
  it('空串返回空', () => {
    expect(maskKey('')).toBe('')
  })

  it('短 Key 全掩码', () => {
    expect(maskKey('sk-abc')).toBe('****')
  })

  it('正常 Key 首三尾四', () => {
    expect(maskKey('sk-1234567890abcd')).toBe('sk-****abcd')
  })
})
