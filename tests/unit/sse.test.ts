import { describe, expect, it } from 'vitest'
import { createSSEParser } from '@main/providers/sse'

function collect(options?: { mode?: 'line' | 'event' }): {
  parser: ReturnType<typeof createSSEParser>
  lines: string[]
} {
  const lines: string[] = []
  return { parser: createSSEParser((d) => lines.push(d), options), lines }
}

describe('createSSEParser', () => {
  it('解析单个 data 行', () => {
    const { parser, lines } = collect()
    parser.push('data: {"a":1}\n\n')
    expect(lines).toEqual(['{"a":1}'])
  })

  it('跨 chunk 拼接（一个事件被切成两半）', () => {
    const { parser, lines } = collect()
    parser.push('data: {"a"')
    parser.push(':1}\n\ndata: [DONE]\n')
    expect(lines).toEqual(['{"a":1}', '[DONE]'])
  })

  it('容忍 CRLF 换行', () => {
    const { parser, lines } = collect()
    parser.push('data: hello\r\ndata: world\r\n')
    expect(lines).toEqual(['hello', 'world'])
  })

  it('忽略非 data 行、空 data 与注释行', () => {
    const { parser, lines } = collect()
    parser.push('event: ping\ndata:\n\n: comment\ndata: x\n')
    expect(lines).toEqual(['x'])
  })

  it('end() 冲刷无换行的残包', () => {
    const { parser, lines } = collect()
    parser.push('data: tail')
    parser.end()
    expect(lines).toEqual(['tail'])
  })

  it('高频小 chunk 不丢不重', () => {
    const { parser, lines } = collect()
    const full = 'data: 1\ndata: 2\ndata: 3\n'
    for (const ch of full) parser.push(ch)
    expect(lines).toEqual(['1', '2', '3'])
  })
})

describe('E22 · 换行符三态（CR / LF / CRLF）', () => {
  it('纯 CR 换行也能分帧（旧实现只认 \\n，会把整个流当一行）', () => {
    const { parser, lines } = collect()
    parser.push('data: a\rdata: b\r')
    expect(lines).toEqual(['a', 'b'])
  })

  it('CRLF 不会在数据里留下 \\r', () => {
    const { parser, lines } = collect()
    parser.push('data: {"x":1}\r\n\r\n')
    expect(lines).toEqual(['{"x":1}'])
  })

  it('CR 与 LF 混用仍逐条派发', () => {
    const { parser, lines } = collect()
    parser.push('data: one\rdata: two\ndata: three\r\n')
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('CRLF 被切成两半（\\r 与 \\n 分属两个 chunk）不产生空帧', () => {
    const { parser, lines } = collect()
    parser.push('data: a\r')
    parser.push('\ndata: b\r')
    parser.push('\n')
    expect(lines).toEqual(['a', 'b'])
  })
})

describe('E22 · 多 data 行按空行派发（SSE 规范，event 模式）', () => {
  it('同一事件的多条 data 行以 \\n 拼接后一次派发', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: part1\ndata: part2\n\n')
    expect(lines).toEqual(['part1\npart2'])
  })

  it('空行才是事件边界；无空行不提前派发', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: a\ndata: b\n')
    expect(lines).toEqual([])
    parser.push('\n')
    expect(lines).toEqual(['a\nb'])
  })

  it('两个事件各自按空行切分', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: x\ndata: y\n\ndata: z\n\n')
    expect(lines).toEqual(['x\ny', 'z'])
  })

  it('多 data 行里的 JSON 分片能拼成完整对象', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: {"a":\ndata: 1}\n\n')
    expect(lines).toEqual(['{"a":\n1}'])
  })

  it('event: 字段与 data 分组互不干扰', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('event: message\ndata: hello\n\n')
    expect(lines).toEqual(['hello'])
  })

  it('纯注释/心跳块（无 data）不派发', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push(': keepalive\n\n: keepalive\n\n')
    expect(lines).toEqual([])
  })

  it('event 模式下 CRLF 同样按空行分事件', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: a\r\ndata: b\r\n\r\n')
    expect(lines).toEqual(['a\nb'])
  })
})

describe('E22 · EOF 未成事件的残片丢弃（event 模式）', () => {
  it('只有 data 行但缺空行 → end() 丢弃，不派发半截事件', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: incomplete\n')
    parser.end()
    expect(lines).toEqual([])
  })

  it('缺空行时不因为 end() 而把半截事件当成功', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: a\ndata: b\n')
    parser.end()
    expect(lines).toEqual([])
  })

  it('end() 后缓冲清空，重复 end() 不重复派发', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: done\n\n')
    parser.end()
    parser.end()
    expect(lines).toEqual(['done'])
  })

  it('完整事件在 end() 前已派发，end() 不再补发', () => {
    const { parser, lines } = collect({ mode: 'event' })
    parser.push('data: full\n\n')
    parser.end()
    expect(lines).toEqual(['full'])
  })
})

describe('E22 · 分块多字节字符', () => {
  it('多字节 UTF-8 被 chunk 边界切开时由调用方解码保证（本层只接字符串）', () => {
    const { parser, lines } = collect()
    // 调用方用 TextDecoder({stream:true}) 解码后传入，本层看到的是已完整字符
    parser.push('data: 中文\n\n')
    expect(lines).toEqual(['中文'])
  })

  it('data 内含 emoji 与组合字符不丢不破', () => {
    const { parser, lines } = collect()
    parser.push('data: 👨‍👩‍👧 é\n\n')
    expect(lines).toEqual(['👨‍👩‍👧 é'])
  })

  it('同一字符跨 chunk（已由调用方正确解码）仍正确拼接', () => {
    const { parser, lines } = collect()
    parser.push('data: 中')
    parser.push('文\n\n')
    expect(lines).toEqual(['中文'])
  })
})

describe('E22 · 坏业务事件交上层分类（本层不吞不猜）', () => {
  it('非 JSON 的 data 原样交给上层，不在本层丢弃', () => {
    const { parser, lines } = collect()
    parser.push('data: not-json\n\n')
    expect(lines).toEqual(['not-json'])
  })

  it('[DONE] 哨兵原样上交', () => {
    const { parser, lines } = collect()
    parser.push('data: [DONE]\n\n')
    expect(lines).toEqual(['[DONE]'])
  })

  it('本层不做 JSON 校验，坏 JSON 照样派发', () => {
    const { parser, lines } = collect()
    parser.push('data: {"broken":\n\n')
    expect(lines).toEqual(['{"broken":'])
  })
})

describe('E22 · 旧 line 模式默认不变', () => {
  it('不传 options 时行为与旧版逐字一致（逐 data 行立即派发）', () => {
    const { parser, lines } = collect()
    parser.push('data: 1\ndata: 2\ndata: 3\n')
    expect(lines).toEqual(['1', '2', '3'])
  })

  it('line 模式下缺空行也派发（保留旧行为，不因新规范改旧语义）', () => {
    const { parser, lines } = collect()
    parser.push('data: a\ndata: b\n')
    expect(lines).toEqual(['a', 'b'])
  })

  it('push/end API 签名不变', () => {
    const { parser } = collect()
    expect(typeof parser.push).toBe('function')
    expect(typeof parser.end).toBe('function')
  })

  it('显式传 mode:line 与不传等价', () => {
    const implicit = collect()
    const explicit = collect({ mode: 'line' })
    for (const p of [implicit.parser, explicit.parser]) p.push('data: a\ndata: b\n')
    expect(implicit.lines).toEqual(explicit.lines)
    expect(implicit.lines).toEqual(['a', 'b'])
  })
})
