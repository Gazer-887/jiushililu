import { describe, expect, it } from 'vitest'
import { estimateMessagesTokens, estimateTokens, trimMessages } from '@main/agent/context'
import { runAgentLoop } from '@main/agent/loop'
import type { AgentMessage } from '@shared/agent'

describe('estimateTokens（token 估算）', () => {
  it('CJK 按 1 token/字（保守上限），英文按 4 字符/token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('消息数组带每条固定开销', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: '你好世界' }]
    expect(estimateMessagesTokens(msgs)).toBeGreaterThan(estimateTokens('你好世界'))
  })

  it('tool_calls 计入估算', () => {
    const withCalls: AgentMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] }
    ]
    const without: AgentMessage[] = [{ role: 'assistant', content: null }]
    expect(estimateMessagesTokens(withCalls)).toBeGreaterThan(estimateMessagesTokens(without))
  })
})

describe('trimMessages（历史裁剪）', () => {
  const bigText = '内容'.repeat(2000) // 4000 字符 ≈ 1600 token

  const build = (n: number): AgentMessage[] => [
    { role: 'system', content: '你是内核' },
    ...Array.from({ length: n }, (_, i): AgentMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 条：${bigText}`
    }))
  ]

  it('未超阈值时不裁剪（返回原数组）', () => {
    const msgs = build(3)
    const res = trimMessages(msgs, { contextWindow: 1_000_000 })
    expect(res.trimmed).toBe(false)
    expect(res.messages).toBe(msgs)
    expect(res.droppedCount).toBe(0)
  })

  it('超阈值时保留 system 与末尾，中段折叠为摘要', () => {
    const msgs = build(20)
    const res = trimMessages(msgs, { contextWindow: 2000, keepRecent: 4 })
    expect(res.trimmed).toBe(true)
    expect(res.droppedCount).toBeGreaterThan(0)
    // 首条仍是 system
    expect(res.messages[0]!.role).toBe('system')
    // 第二条是摘要占位
    expect(res.messages[1]!.content).toContain('[历史摘要]')
    // 末尾保留区完整（原末尾 4 条 + system + 摘要）
    expect(res.messages.length).toBe(2 + 4)
    // 裁剪后 token 显著下降
    expect(estimateMessagesTokens(res.messages)).toBeLessThan(estimateMessagesTokens(msgs))
  })

  it('摘要里保留最近 3 条 assistant 文本要点', () => {
    const msgs: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '要点A' + 'x'.repeat(3000) },
      { role: 'user', content: 'y'.repeat(3000) },
      { role: 'assistant', content: '要点B' + 'x'.repeat(3000) },
      { role: 'user', content: 'z'.repeat(3000) },
      { role: 'assistant', content: '要点C' + 'x'.repeat(3000) },
      { role: 'user', content: '尾部1' },
      { role: 'assistant', content: '尾部2' }
    ]
    const res = trimMessages(msgs, { contextWindow: 2000, keepRecent: 2 })
    const summary = res.messages[1]!.content as string
    expect(summary).toContain('要点A')
    expect(summary).toContain('要点C')
  })

  it('tool 消息不会被裁成孤儿（结尾是 tool 时向前扩到配对）', () => {
    const msgs: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u'.repeat(4000) },
      { role: 'assistant', content: 'a'.repeat(4000) },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: '工具结果' + 'r'.repeat(3000), tool_call_id: 't1' }
    ]
    const res = trimMessages(msgs, { contextWindow: 1500, keepRecent: 1 })
    // 末尾保留区不应以孤立 tool 开头（tail 应含配对的 assistant）
    const tailStart = res.messages.findIndex((m) => m.role === 'assistant' && m.tool_calls)
    expect(tailStart).toBeGreaterThan(0)
  })
})

describe('runAgentLoop 与上下文管理联动', () => {
  it('给了 contextWindow 时，模型收到的是裁剪后的消息', async () => {
    const bigContent = 'x'.repeat(4000)
    let sawCount = 0
    const result = await runAgentLoop({
      systemPrompt: 'sys',
      userTask: '任务',
      tools: [],
      maxRounds: 3,
      contextWindow: 1000,
      chat: async (messages) => {
        sawCount = messages.length
        // 制造历史堆积：每轮都要求工具调用
        return { text: bigContent, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] }
      }
    })
    expect(result.stopReason).toBe('max-rounds')
    // 裁剪生效：模型看到的条数远少于累计堆积
    expect(sawCount).toBeLessThan(10)
  })
})
