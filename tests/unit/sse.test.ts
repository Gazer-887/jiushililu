import { describe, expect, it } from 'vitest'
import { createSSEParser } from '@main/providers/sse'

function collect(): { parser: ReturnType<typeof createSSEParser>; lines: string[] } {
  const lines: string[] = []
  return { parser: createSSEParser((d) => lines.push(d)), lines }
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
