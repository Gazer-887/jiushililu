// 协议统计资格：通过既有HTTP注入缝喂真SSE解析器，不进行外网调用。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamWithToolsAnthropic } from '@main/providers/anthropic-agent'
import { setHttpFetch } from '@main/providers/http-client'
import { fromAnthropicResponse } from '@main/providers/anthropic-agent'
import { usageFromAnthropicMessage } from '@main/providers/usage-parsers'
import type { ModelSettings } from '@shared/ipc'

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
    expect(result.usage).toEqual({ promptTokens: 90, completionTokens: 12, cachedPromptTokens: 20, reasoningTokens: 4 })
  })

  it('非流式工具响应也带计量，明确思考0不能变未知', () => {
    const json = { content: [{ type: 'text', text: '合成回复。' }], usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { thinking_tokens: 0 } } }
    expect(fromAnthropicResponse(json).usage).toEqual({ promptTokens: 10, completionTokens: 2, cachedPromptTokens: null, reasoningTokens: 0 })
  })

  it('非法思考明细保持未知，不影响有效基础报告', () => {
    expect(usageFromAnthropicMessage({ usage: { input_tokens: 10, output_tokens: 2, output_tokens_details: { thinking_tokens: -1 } } })).toEqual({ promptTokens: 10, completionTokens: 2, cachedPromptTokens: null, reasoningTokens: null })
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
      promptTokens: 100,
      completionTokens: 0,
      cachedPromptTokens: 30,
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
      reasoningTokens: null
    })
  })
})
