// plan57 片③ P7：图片到底有没有进请求体（两协议各一条），以及**不该进去的东西有没有跟着进去**。
//
// 这一层是"界面有图、模型没图"那种假成功的唯一拦截点：门禁看不到请求体，真人点验也看不到。
// 判据都盯在**出境 JSON 的形状**上，而不是盯某个中间变量的值。
import { describe, expect, it } from 'vitest'
import { buildOpenAIChatBody } from '@main/providers/openai'
import { buildToolsBody, toOpenAIWireMessage } from '@main/providers/openai-agent'
import {
  buildAnthropicToolsBody,
  toAnthropicAgentMessages
} from '@main/providers/anthropic-agent'
import type { ModelSettings } from '@shared/ipc'
import type { AgentMessage } from '@shared/agent'

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
  supportsImages: true
}

const B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')

const turnWithImage: AgentMessage = {
  role: 'user',
  content: '看下这张图 <file name="shot.png" kind="image" ref="r.png" bytes="4" />',
  parts: [
    { type: 'text', text: '看下这张图' },
    { type: 'image', mime: 'image/png', base64: B64, ref: 'r.png' }
  ]
}

const tools = [
  { name: 'noop', description: 'd', parameters: { type: 'object', properties: {} } }
]

describe('Anthropic agent 线：user 轮的 parts → image block', () => {
  it('★ 请求体里真有 image block，且 base64 / media_type 都在位', () => {
    const { messages } = toAnthropicAgentMessages([turnWithImage])
    expect(messages[0]!.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: B64 },
      // D-146 E：厂商默认 downsize 且"不告诉你"，必须显式要 error
      transformations: { oversized_image: 'error' }
    })
    const wire = JSON.stringify(buildAnthropicToolsBody(settings, [turnWithImage], [], false))
    expect(wire).toContain('"image"')
    expect(wire).toContain(B64)
  })

  it('带 parts 时 content 那份同源文本不许重复下发（两处文本 = 两份真相）', () => {
    const { messages } = toAnthropicAgentMessages([turnWithImage])
    const texts = messages[0]!.content.filter((b) => b.type === 'text')
    expect(texts).toEqual([{ type: 'text', text: '看下这张图' }])
  })

  it('无 parts 的轮形状与改造前逐字节相同（这条防的是"顺手把老路径也改了"）', () => {
    const plain: AgentMessage = { role: 'user', content: '早' }
    expect(toAnthropicAgentMessages([plain]).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '早' }] }
    ])
  })
})

describe('OpenAI agent 线：parts → content 数组，且内部字段不外泄', () => {
  it('★ 请求体里有 image_url 的 data URL', () => {
    const body = buildToolsBody(settings, [turnWithImage], tools, false)
    const msgs = body['messages'] as Array<{ content: unknown }>
    expect(msgs[0]!.content).toEqual([
      { type: 'text', text: '看下这张图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } }
    ])
  })

  it('★ `parts` 这个键不许出现在出境 JSON 里（严格端点会按未知字段 400）', () => {
    const wire = JSON.stringify(buildToolsBody(settings, [turnWithImage], tools, false))
    expect(wire).not.toContain('"parts"')
    expect(wire).toContain(B64)
  })

  it('纯文本轮：只摘 parts，其余字段与顺序都不动', () => {
    const m: AgentMessage = { role: 'assistant', content: null, tool_calls: [] }
    expect(toOpenAIWireMessage(m)).toEqual({ role: 'assistant', content: null, tool_calls: [] })
    const t: AgentMessage = { role: 'tool', content: '结果', tool_call_id: 'c1' }
    expect(toOpenAIWireMessage({ ...t, parts: [{ type: 'text', text: '结果' }] })).toEqual(t)
  })

  it('乱码防线：出境内容里不许有 U+FFFD（plan57 病根就是二进制被当文本读）', () => {
    const wire = JSON.stringify(buildToolsBody(settings, [turnWithImage], tools, false))
    expect(wire).not.toContain('�')
  })
})

describe('纯 chat 线（反思 / 摘要）：扩展字段一律不外泄', () => {
  it('parts / segments / createdAt 都不该出现在出境 messages 里', () => {
    const body = buildOpenAIChatBody(
      settings,
      [
        {
          role: 'user',
          content: '早',
          parts: [{ type: 'text', text: '早' }],
          segments: [{ kind: 'text', text: '早' }],
          createdAt: 1
        }
      ],
      false
    )
    const wire = JSON.stringify(body['messages'])
    expect(wire).toBe('[{"role":"user","content":"早"}]')
  })
})
