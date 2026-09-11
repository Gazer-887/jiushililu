import { describe, expect, it } from 'vitest'
import { ToolCallAccumulator } from '@main/providers/tool-accumulator'
import { buildToolsBody } from '@main/providers/openai-agent'
import { buildAnthropicToolsBody } from '@main/providers/anthropic-agent'
import type { ModelSettings } from '@shared/ipc'

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'm',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  supportsImages: false
}

describe('ToolCallAccumulator（流式工具调用累积）', () => {
  it('OpenAI：首片带 id/name，后续片只带 arguments → 正确拼接', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }])
    acc.pushOpenAI([{ index: 0, function: { arguments: 'th":"notes/' } }])
    acc.pushOpenAI([{ index: 0, function: { arguments: 'todo.md"}' } }])
    expect(acc.finish()).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"path":"notes/todo.md"}' }
    ])
  })

  it('OpenAI：多个工具并行（不同 index）各自归位', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([
      { index: 0, id: 'c0', function: { name: 'read_file', arguments: '{"path":"a"' } },
      { index: 1, id: 'c1', function: { name: 'list_dir', arguments: '{"path":"."' } }
    ])
    acc.pushOpenAI([
      { index: 1, function: { arguments: '}' } },
      { index: 0, function: { arguments: '}' } }
    ])
    const calls = acc.finish()
    expect(calls.map((c) => c.name)).toEqual(['read_file', 'list_dir'])
    expect(calls[0]!.arguments).toBe('{"path":"a"}')
    expect(calls[1]!.arguments).toBe('{"path":"."}')
  })

  it('Anthropic：content_block_start + input_json_delta 分片拼接', () => {
    const acc = new ToolCallAccumulator()
    acc.startAnthropic(0, 'toolu_1', 'write_file')
    acc.appendAnthropicJson(0, '{"path":"a.txt",')
    acc.appendAnthropicJson(0, '"content":"hi"}')
    expect(acc.finish()).toEqual([
      { id: 'toolu_1', name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' }
    ])
  })

  it('Anthropic：start 时已带完整 input 对象（非流式回退）', () => {
    const acc = new ToolCallAccumulator()
    acc.startAnthropic(0, 't1', 'list_dir', { path: '.' })
    expect(acc.finish()[0]!.arguments).toBe('{"path":"."}')
  })

  it('无参数工具：finish 补空对象（而非空串）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'ping' } }])
    expect(acc.finish()[0]!.arguments).toBe('{}')
  })

  it('残片（无 name）被丢弃：不产生半截调用', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { arguments: '{}' } }])
    expect(acc.finish()).toEqual([])
  })

  it('缺 id 时按 index 兜底生成，不产生空 id', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 2, function: { name: 'read_file', arguments: '{}' } }])
    expect(acc.finish()[0]!.id).toBe('call_2')
  })

  it('没有 start 就来 delta（协议异常）不抛错', () => {
    const acc = new ToolCallAccumulator()
    acc.appendAnthropicJson(5, '{"a":1}')
    expect(acc.finish()).toEqual([])
  })

  it('size 反映已开启的调用数', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, function: { name: 'a' } }, { index: 1, function: { name: 'b' } }])
    expect(acc.size).toBe(2)
  })
})

describe('工具请求体构造（两协议都下发 tools）', () => {
  const tools = [
    { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }
  ]

  it('OpenAI 流式请求体带 tools 且 stream=true', () => {
    const body = buildToolsBody(settings, [{ role: 'user', content: 'hi' }], tools, true)
    expect(body['stream']).toBe(true)
    expect((body['tools'] as unknown[]).length).toBe(1)
    expect(body['max_tokens']).toBe(4096)
  })

  it('OpenAI：采样参数为 null 时不发送', () => {
    const body = buildToolsBody(settings, [], tools, true)
    expect('temperature' in body).toBe(false)
    expect('top_p' in body).toBe(false)
  })

  it('OpenAI：reasoningEffort 非 default 时发送', () => {
    const body = buildToolsBody({ ...settings, reasoningEffort: 'max' }, [], tools, true)
    expect(body['reasoning_effort']).toBe('max')
  })

  it('Anthropic：工具定义用 input_schema，且工具模式下不发 thinking（互斥）', () => {
    const body = buildAnthropicToolsBody(
      { ...settings, providerType: 'anthropic', reasoningEffort: 'high' },
      [{ role: 'user', content: 'hi' }],
      tools,
      true
    )
    const defs = body['tools'] as Array<{ input_schema: unknown }>
    expect(defs[0]!.input_schema).toEqual({ type: 'object', properties: {} })
    expect('thinking' in body).toBe(false)
  })

  it('Anthropic：无工具时才允许 thinking', () => {
    const body = buildAnthropicToolsBody(
      { ...settings, providerType: 'anthropic', reasoningEffort: 'high' },
      [{ role: 'user', content: 'hi' }],
      [],
      false
    )
    expect('thinking' in body).toBe(true)
  })
})
