import { describe, expect, it } from 'vitest'
import { ToolCallAccumulator, ToolCallIntegrityError } from '@main/providers/tool-accumulator'
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
  inputModalities: ['text']
}

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：旧宽松 API（finish）—— 行为必须与 E21 基线逐字一致，不得改弱
// ══════════════════════════════════════════════════════════════════════════

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

describe('E22-R1 · 旧宽松 finish 保持原样（严格检查不进默认路径）', () => {
  it('坏 JSON 参数：旧 finish 不抛错，原样交出（宽松语义保留给旧调用方）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'f', arguments: '{"path":' } }])
    expect(() => acc.finish()).not.toThrow()
    expect(acc.finish()[0]!.arguments).toBe('{"path":')
  })

  it('非对象参数：旧 finish 不抛错，原样交出', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'f', arguments: '[1,2]' } }])
    expect(() => acc.finish()).not.toThrow()
    expect(acc.finish()[0]!.arguments).toBe('[1,2]')
  })

  it('缺 id：旧 finish 仍按 call_index 兜底（宽松语义不变）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 7, function: { name: 'f', arguments: '{}' } }])
    expect(acc.finish()[0]!.id).toBe('call_7')
  })

  it('无 name 残片：旧 finish 仍丢弃并返回空数组（宽松语义不变）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { arguments: '{}' } }])
    expect(acc.finish()).toEqual([])
  })

  it('constructor 无参数构造仍可用', () => {
    expect(() => new ToolCallAccumulator()).not.toThrow()
    expect(new ToolCallAccumulator().size).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：生产严格入口 finishStrict() —— 新增能力，逐条拒绝并结构化报告
// ══════════════════════════════════════════════════════════════════════════

describe('E22-R1 · strict 拒绝：missing-start（无 start 的 Anthropic delta）', () => {
  it('未 start 就 appendAnthropicJson → strict 抛 missing-start', () => {
    const acc = new ToolCallAccumulator()
    acc.appendAnthropicJson(5, '{"a":1}')
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallIntegrityError)
      expect((err as ToolCallIntegrityError).reason).toBe('missing-start')
      expect((err as ToolCallIntegrityError).index).toBe(5)
    }
  })

  it('missing-start 不被旧 finish 影响（两者互不干扰）', () => {
    const acc = new ToolCallAccumulator()
    acc.appendAnthropicJson(5, '{"a":1}')
    expect(acc.finish()).toEqual([]) // 旧路径仍静默忽略
    expect(() => acc.finishStrict()).toThrow(ToolCallIntegrityError) // 严格路径拒绝
  })
})

describe('E22-R1 · strict 拒绝：missing-id / missing-name', () => {
  it('缺 id → strict 抛 missing-id，不生成 call_index', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 2, function: { name: 'read_file', arguments: '{}' } }])
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallIntegrityError)
      expect((err as ToolCallIntegrityError).reason).toBe('missing-id')
      expect((err as ToolCallIntegrityError).index).toBe(2)
      expect((err as ToolCallIntegrityError).callName).toBe('read_file')
    }
  })

  it('缺 name → strict 抛 missing-name，不 filter 成空数组当无工具', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { arguments: '{}' } }])
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallIntegrityError)
      expect((err as ToolCallIntegrityError).reason).toBe('missing-name')
      expect((err as ToolCallIntegrityError).index).toBe(0)
    }
  })

  it('多 index 里只要有一个缺 id 就整体拒绝（不放过任何残片）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([
      { index: 0, id: 'c0', function: { name: 'ok_tool', arguments: '{}' } },
      { index: 1, function: { name: 'broken_tool', arguments: '{}' } }
    ])
    expect(() => acc.finishStrict()).toThrow(ToolCallIntegrityError)
  })
})

describe('E22-R1 · strict 拒绝：invalid-arguments / arguments-not-object', () => {
  it('参数不是合法 JSON → strict 抛 invalid-arguments', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'f', arguments: '{"path":' } }])
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as ToolCallIntegrityError).reason).toBe('invalid-arguments')
    }
  })

  it('参数是合法 JSON 但非对象 → strict 抛 arguments-not-object', () => {
    for (const bad of ['[1,2]', '"text"', '42', 'true', 'null']) {
      const acc = new ToolCallAccumulator()
      acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'f', arguments: bad } }])
      try {
        acc.finishStrict()
        throw new Error(`payload=${bad} 应当抛错`)
      } catch (err) {
        expect((err as ToolCallIntegrityError).reason, `payload=${bad}`).toBe('arguments-not-object')
      }
    }
  })

  it('完全没收到参数分片但 id/name 完整 → 规范化为 {} 并允许（普通无参工具）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'ping' } }])
    expect(acc.finishStrict()).toEqual([{ id: 'c', name: 'ping', arguments: '{}' }])
  })

  it('缺 id/name 时不因"可补 {}"而放过（补参只针对完整身份）', () => {
    const noId = new ToolCallAccumulator()
    noId.pushOpenAI([{ index: 0, function: { name: 'ping' } }])
    expect(() => noId.finishStrict()).toThrow(ToolCallIntegrityError)

    const noName = new ToolCallAccumulator()
    noName.pushOpenAI([{ index: 0, id: 'c', function: {} }])
    expect(() => noName.finishStrict()).toThrow(ToolCallIntegrityError)
  })

  it('Anthropic 提供非对象 input（数组/字符串/数字）→ arguments-not-object，不静默变无参', () => {
    for (const bad of [[1, 2], 'text', 42, true] as unknown[]) {
      const acc = new ToolCallAccumulator()
      acc.startAnthropic(0, 't1', 'f', bad)
      try {
        acc.finishStrict()
        throw new Error(`input=${JSON.stringify(bad)} 应当抛错`)
      } catch (err) {
        expect((err as ToolCallIntegrityError).reason, `input=${JSON.stringify(bad)}`).toBe(
          'arguments-not-object'
        )
      }
    }
  })

  it('Anthropic 提供空对象 input → 合法无参，允许 {}', () => {
    const acc = new ToolCallAccumulator()
    acc.startAnthropic(0, 't1', 'ping', {})
    expect(acc.finishStrict()).toEqual([{ id: 't1', name: 'ping', arguments: '{}' }])
  })

  it('Anthropic 非对象 input 在旧 finish 仍被忽略（宽松路径不受影响）', () => {
    const acc = new ToolCallAccumulator()
    acc.startAnthropic(0, 't1', 'f', [1, 2])
    expect(() => acc.finish()).not.toThrow()
    expect(acc.finish()[0]!.arguments).toBe('{}')
  })
})

describe('E22-R1 · strict 拒绝：id-conflict / name-conflict', () => {
  it('同一 index 的 id 先有后换 → strict 抛 id-conflict', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c1', function: { name: 'read_file' } }])
    try {
      acc.pushOpenAI([{ index: 0, id: 'c2', function: { arguments: '{}' } }])
    } catch {
      /* 模拟 provider 上层 catch {} 吞掉 */
    }
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as ToolCallIntegrityError).reason).toBe('id-conflict')
    }
  })

  it('同一 index 的 name 先有后换 → strict 抛 name-conflict', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c1', function: { name: 'read_file' } }])
    try {
      acc.pushOpenAI([{ index: 0, function: { name: 'delete_file', arguments: '{}' } }])
    } catch {
      /* 模拟上层吞掉 */
    }
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as ToolCallIntegrityError).reason).toBe('name-conflict')
    }
  })

  it('冲突被上层 catch 吞掉后，strict finish 仍拒绝（防静默）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c1', function: { name: 'read_file' } }])
    try {
      acc.pushOpenAI([{ index: 0, id: 'c2', function: { arguments: '{}' } }])
    } catch {
      /* 关键：上层吞掉，strict 仍须拒绝 */
    }
    expect(() => acc.finishStrict()).toThrow(ToolCallIntegrityError)
  })
})

describe('E22-R1 · strict 阳性对照（合法输入必须通过）', () => {
  it('完整合法的 OpenAI 单调用通过', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }])
    expect(acc.finishStrict()).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }
    ])
  })

  it('完整合法的多调用并行通过，顺序按 index 升序', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([
      { index: 1, id: 'c1', function: { name: 'b_tool', arguments: '{}' } },
      { index: 0, id: 'c0', function: { name: 'a_tool', arguments: '{}' } }
    ])
    const calls = acc.finishStrict()
    expect(calls.map((c) => c.name)).toEqual(['a_tool', 'b_tool'])
  })

  it('真正无参数但 id/name 完整 → 允许 {}（这是合法空参数，不是修补缺陷）', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c', function: { name: 'ping', arguments: '{}' } }])
    expect(acc.finishStrict()).toEqual([{ id: 'c', name: 'ping', arguments: '{}' }])
  })

  it('Anthropic 完整 start + delta 通过', () => {
    const acc = new ToolCallAccumulator()
    acc.startAnthropic(0, 'toolu_1', 'write_file')
    acc.appendAnthropicJson(0, '{"path":"a.txt"}')
    expect(acc.finishStrict()).toEqual([
      { id: 'toolu_1', name: 'write_file', arguments: '{"path":"a.txt"}' }
    ])
  })

  it('Anthropic start 时带完整 input 对象通过', () => {
    const acc = new ToolCallAccumulator()
    acc.startAnthropic(0, 't1', 'list_dir', { path: '.' })
    expect(acc.finishStrict()[0]!.arguments).toBe('{"path":"."}')
  })

  it('没有任何调用时 strict 返回空数组（真空 ≠ 残片）', () => {
    const acc = new ToolCallAccumulator()
    expect(acc.finishStrict()).toEqual([])
  })

  it('同值重发不视为冲突，strict 通过', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 0, id: 'c1', function: { name: 'read_file' } }])
    acc.pushOpenAI([{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }])
    expect(acc.finishStrict()).toEqual([{ id: 'c1', name: 'read_file', arguments: '{}' }])
  })
})

describe('E22-R1 · strict 错误对象不含原文', () => {
  it('错误对象只带结构化定位信息，序列化不含坏参数片段', () => {
    const acc = new ToolCallAccumulator()
    acc.pushOpenAI([{ index: 3, id: 'c', function: { name: 'f', arguments: '{"secret":"LEAK_ME' } }])
    try {
      acc.finishStrict()
      throw new Error('应当抛错')
    } catch (err) {
      const e = err as ToolCallIntegrityError
      expect(e.reason).toBe('invalid-arguments')
      expect(e.index).toBe(3)
      expect(e.callName).toBe('f')
      expect(JSON.stringify({ r: e.reason, i: e.index, n: e.callName, m: e.message })).not.toContain(
        'LEAK_ME'
      )
      expect(e.message).not.toContain('LEAK_ME')
    }
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
