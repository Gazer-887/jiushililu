import { describe, expect, it } from 'vitest'
import { estimateMessagesTokens, estimateTokens, historyForModel, trimMessages } from '@main/agent/context'
import { runAgentLoop } from '@main/agent/loop'
import { mapAnthropicMessages } from '@main/providers/anthropic'
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
    expect(res.messages[0]!.role).toBe('system')
    expect(res.messages[1]!.content).toContain('[历史摘要]')
    // 末尾保留区完整（原末尾 4 条 + system + 摘要）
    expect(res.messages.length).toBe(2 + 4)
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
      history: [{ role: 'user', content: '任务' }],
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
    expect(sawCount).toBeLessThan(10)
  })
})

// K8：被「停止生成」留下的空正文 assistant 轮，**不许以 content:'' 出境**。
// 放行只是让它能发出去，这一半才是让它不坑到模型：换成一句说明性占位，
// 因为直接丢掉会造出两条连续 user 消息 —— Anthropic 要求角色交替，那是把一个坑换成另一个坑。
describe('historyForModel（空正文助手轮不出境）', () => {
  it('空正文的 assistant 被换成占位，条数与角色序列一条不差', () => {
    const out = historyForModel([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '第二问' }
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[1]?.content).toBeTruthy()
    expect(String(out[1]?.content)).toContain('中断')
  })

  it('有正文的消息原样不动（不改写历史）', () => {
    const out = historyForModel([
      { role: 'user', content: '照旧' },
      { role: 'assistant', content: '  带空格的正文  ' }
    ])
    expect(out[0]?.content).toBe('照旧')
    expect(out[1]?.content).toBe('  带空格的正文  ')
  })

  it('tool 角色不碰（它靠 tool_call_id 配对，改了就断链）', () => {
    const out = historyForModel([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', content: '', tool_call_id: 'c1' }
    ])
    expect(out[1]?.content).toBe('')
    expect(out[1]?.tool_call_id).toBe('c1')
    // 带 tool_calls 的助手轮**不是**"什么都没产出"，它的空正文是合法形状，不许改写
    expect(out[0]?.content).toBe('')
  })

  it('出境集合里不存在任何空的 assistant 正文', () => {
    const out = historyForModel([
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: null }
    ])
    for (const m of out) {
      if (m.role !== 'assistant') continue
      expect(String(m.content).trim().length).toBeGreaterThan(0)
    }
  })

  /** 真接线：走一遍 runAgentLoop，看模型侧**实际收到**什么（函数写了没接上=假覆盖） */
  it('runAgentLoop 把它接上了：模型收到的那条不是空串', async () => {
    let seen: AgentMessage[] = []
    await runAgentLoop({
      systemPrompt: 'sys',
      history: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '第二问' }
      ],
      tools: [],
      maxRounds: 2,
      contextWindow: 8000,
      chat: async (messages) => {
        seen = messages
        return { text: '收到', toolCalls: [] }
      }
    })
    const assistant = seen.find((m) => m.role === 'assistant')
    expect(assistant).toBeTruthy()
    expect(String(assistant?.content).trim().length).toBeGreaterThan(0)
    expect(seen.filter((m) => m.role === 'user')).toHaveLength(2)
  })
})

/**
 * 出境不变量（第二轮复查提的判据）：前面几条都停在 `chat(messages)` 那道边界，
 * 这一条钉到**真正上线的请求体** —— 从这以后谁再往 provider 里塞空正文助手轮，这里会红。
 */
describe('出境不变量：Anthropic 请求体里不存在空正文助手轮', () => {
  it('historyForModel 整形后，映射出的 messages 不含 content:""', () => {
    const wire = mapAnthropicMessages(
      historyForModel([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '第二问' },
        { role: 'assistant', content: '   ' }
      ])
    ).messages
    expect(JSON.stringify(wire)).not.toContain('"content":""')
    expect(wire).toHaveLength(4)
  })
})
