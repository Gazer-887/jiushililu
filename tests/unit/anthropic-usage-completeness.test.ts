// 协议统计资格：通过既有HTTP注入缝喂真SSE解析器，不进行外网调用。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamWithToolsAnthropic } from '@main/providers/anthropic-agent'
import { setHttpFetch } from '@main/providers/http-client'
import { fromAnthropicResponse } from '@main/providers/anthropic-agent'
import { usageFromAnthropicEvent, usageFromAnthropicMessage, usageFromOpenAIChunk } from '@main/providers/usage-parsers'
import type { ModelSettings } from '@shared/ipc'
import { cacheHitRate, type TokenUsage } from '@shared/usage'

const settings: ModelSettings = {
  providerType: 'anthropic',
  baseURL: 'http://127.0.0.1:1',
  model: 'synthetic-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 1024,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  inputModalities: ['text']
}

afterEach(() => setHttpFetch(null))

async function response(usageEvents: unknown[]) {
  const events = [
    ...usageEvents,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '文本正常完成。' }
    },
    { type: 'message_stop' }
  ]
  const fetch = vi.fn(
    async () =>
      new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' }
      })
  )
  setHttpFetch(fetch)
  const result = await streamWithToolsAnthropic(
    settings,
    'synthetic-test-key',
    [{ role: 'user', content: '合成任务' }],
    [],
    () => {}
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(result.text).toBe('文本正常完成。')
  return result
}

describe('Anthropic输入与最终输出成对才是完整计量', () => {
  it('最终输入与缓存字段覆盖阶段值，不重复累计；思考明细包含在输出里', async () => {
    const result = await response([
      { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 30 } } },
      { type: 'message_delta', usage: { input_tokens: 90, cache_read_input_tokens: 20, output_tokens: 12, output_tokens_details: { thinking_tokens: 4 } } }
    ])
    // A 口径：最终输入按 message_delta 报的值归一（90 未缓存 + 20 读命中 + 写缓存未报按 0 = 110）
    expect(result.usage).toEqual({ promptTokens: 110, completionTokens: 12, cachedPromptTokens: 20, cacheWritePromptTokens: null, reasoningTokens: 4 })
  })

  it('非流式工具响应也带计量，明确思考0不能变未知', () => {
    const json = { content: [{ type: 'text', text: '合成回复。' }], usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { thinking_tokens: 0 } } }
    expect(fromAnthropicResponse(json).usage).toEqual({ promptTokens: 10, completionTokens: 2, cachedPromptTokens: null, cacheWritePromptTokens: null, reasoningTokens: 0 })
  })

  it('非法思考明细保持未知，不影响有效基础报告', () => {
    expect(usageFromAnthropicMessage({ usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { thinking_tokens: -1 } } })).toEqual({ promptTokens: 10, completionTokens: 2, cachedPromptTokens: null, cacheWritePromptTokens: null, reasoningTokens: null })
  })
  it('只有输入时仍可返回文本，但用量不能伪造输出0', async () => {
    const result = await response([
      { type: 'message_start', message: { usage: { input_tokens: 100 } } }
    ])
    expect(result.usage).toBeNull()
  })

  it('只有最终输出时不能伪造输入0', async () => {
    const result = await response([{ type: 'message_delta', usage: { output_tokens: 10 } }])
    expect(result.usage).toBeNull()
  })

  it('开始阶段输出1不能覆盖最终明确报告的0', async () => {
    const result = await response([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 30 } }
      },
      { type: 'message_delta', usage: { output_tokens: 0 } }
    ])
    expect(result.usage).toEqual({
      // A 口径：100 未缓存 + 30 读命中 + 写未报按 0 = 130 总输入
      promptTokens: 130,
      completionTokens: 0,
      cachedPromptTokens: 30,
      cacheWritePromptTokens: null,
      reasoningTokens: null
    })
  })

  it('成对的真实0仍是报告数据', async () => {
    const result = await response([
      { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 0 } }
    ])
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: null,
      cacheWritePromptTokens: null,
      reasoningTokens: null
    })
  })
})

describe('A 口径：Anthropic 输入归一为总输入（读+写+未缓存）', () => {
  it('非流式整份：未缓存100 + 读30 + 写20 = 输入150，命中比例20%', () => {
    const u = usageFromAnthropicMessage({
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 }
    })
    expect(u).toEqual({
      promptTokens: 150,
      completionTokens: 50,
      cachedPromptTokens: 30,
      cacheWritePromptTokens: 20,
      reasoningTokens: null
    })
    expect(cacheHitRate(u as TokenUsage)).toBeCloseTo(30 / 150, 5)
  })

  it('写缓存字段缺失 → null（老 API 未报），归一时按 0 计入总数', () => {
    const u = usageFromAnthropicMessage({ usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 30 } })
    expect(u?.promptTokens).toBe(130)
    expect(u?.cacheWritePromptTokens).toBeNull()
  })

  it('事件半账 message_start：写缓存一并归一', () => {
    const u = usageFromAnthropicEvent({
      type: 'message_start',
      message: { usage: { input_tokens: 321, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 } }
    })
    expect(u?.promptTokens).toBe(641)
    expect(u?.cachedPromptTokens).toBe(300)
    expect(u?.cacheWritePromptTokens).toBe(20)
  })

  it('流式累计器：delta 覆盖的输入字段按同公式归一', async () => {
    const result = await response([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 } }
      },
      {
        type: 'message_delta',
        usage: { input_tokens: 90, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 12 }
      }
    ])
    // 90 未缓存 + 20 读命中 + 10 写缓存 = 120
    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 12,
      cachedPromptTokens: 20,
      cacheWritePromptTokens: 10,
      reasoningTokens: null
    })
  })

  it('OpenAI 兼容侧口径不变：prompt_tokens 本即总输入，不引入写字段', () => {
    const u = usageFromOpenAIChunk({
      choices: [],
      usage: { prompt_tokens: 2210, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 2048 } }
    })
    expect(u).toEqual({
      promptTokens: 2210,
      completionTokens: 2,
      cachedPromptTokens: 2048,
      reasoningTokens: null
    })
    expect('cacheWritePromptTokens' in (u as object)).toBe(false)
  })
})
