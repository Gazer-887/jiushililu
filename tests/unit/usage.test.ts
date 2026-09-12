import { describe, expect, it } from 'vitest'
import {
  addUsage,
  anyEstimated,
  costOf,
  emptyUsage,
  formatCost,
  formatTokens,
  parsePrice,
  sumRecords,
  totalTokens,
  type UsageRecord
} from '@shared/usage'
import { usageFromAnthropicEvent, usageFromOpenAIChunk } from '../../src/main/providers/usage-parsers'

/**
 * 用量与费用（plan8 R9）。
 *
 * 三条要盯住的：
 *   ① **真实 usage 优先、估算要标出来**（混在一起不标注 = 用户把两笔账当一回事）
 *   ② **没填单价就不假装知道钱**（显示 "—" 而不是 0 —— 0 会让人以为"不要钱"）
 *   ③ 两个协议的 usage 形状不同（OpenAI 在最后一个 chunk、Anthropic 分两处报）——
 *      解析器必须各自认各家的，且**认不出来返回 null 而不是硬编一个 0**
 */

const rec = (p: number, c: number, estimated = false): UsageRecord => ({
  usage: { promptTokens: p, completionTokens: c },
  estimated,
  at: 0
})

describe('用量算术', () => {
  it('空用量是 0/0', () => {
    expect(emptyUsage()).toEqual({ promptTokens: 0, completionTokens: 0 })
  })

  it('累加：两份相加，不丢不重', () => {
    const a = addUsage({ promptTokens: 10, completionTokens: 3 }, { promptTokens: 5, completionTokens: 7 })
    expect(a).toEqual({ promptTokens: 15, completionTokens: 10 })
    expect(totalTokens(a)).toBe(25)
  })

  it('会话级累计 = 逐轮相加', () => {
    expect(sumRecords([rec(100, 20), rec(5, 5)])).toEqual({ promptTokens: 105, completionTokens: 25 })
  })

  it('**只要有一条是估算，整段就得标"含估算"**', () => {
    expect(anyEstimated([rec(1, 1), rec(2, 2, true)])).toBe(true)
    expect(anyEstimated([rec(1, 1)])).toBe(false)
  })
})

describe('费用：**没填单价就不假装知道钱**', () => {
  const price = { inputPerMillion: 2, outputPerMillion: 8 }

  it('按百万 token 算：100 万输入 = 输入单价', () => {
    expect(costOf({ promptTokens: 1_000_000, completionTokens: 0 }, price)).toBe(2)
  })

  it('输入输出分开计价（输出一般更贵）', () => {
    // 50 万输入(1) + 25 万输出(2) = 3
    expect(costOf({ promptTokens: 500_000, completionTokens: 250_000 }, price)).toBe(3)
  })

  it('**没填单价 → null**（不是 0 —— 0 会让用户以为"不要钱"）', () => {
    expect(costOf({ promptTokens: 1000, completionTokens: 1000 }, null)).toBeNull()
    expect(formatCost(null)).toBeNull()
  })

  it('极小金额也显示得出来（不然一律显示 0.00 等于没说）', () => {
    expect(formatCost(0.000123)).toBe('0.0001')
    expect(formatCost(0.5)).toBe('0.500')
    expect(formatCost(3.14159)).toBe('3.14')
  })

  it('单价解析：空串/非法/负数 → null（= 没填价）', () => {
    expect(parsePrice('')).toBeNull()
    expect(parsePrice('  ')).toBeNull()
    expect(parsePrice('abc')).toBeNull()
    expect(parsePrice('-1')).toBeNull()
    expect(parsePrice('0')).toBe(0) // 0 是**合法单价**（免费模型），不是"没填"
    expect(parsePrice(' 2.5 ')).toBe(2.5)
  })
})

describe('用量显示：小数字不说废话，大数字才换单位', () => {
  it('三位数原样显示（842 写成 0.8k 反而更糊涂）', () => {
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(999)).toBe('999')
  })

  it('上千用 k、上百万用 M', () => {
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(45_600)).toBe('46k')
    expect(formatTokens(1_250_000)).toBe('1.25M')
  })

  it('0 / 负数 / 非数字 → "0"（不显示 NaN）', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('OpenAI 兼容的 usage 解析', () => {
  it('标准 `usage` → 认得出（流式的最后一个 chunk 会带它）', () => {
    expect(
      usageFromOpenAIChunk({
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 }
      })
    ).toEqual({ promptTokens: 120, completionTokens: 45 })
  })

  it('非流式响应（choices 里带 message）也认', () => {
    expect(
      usageFromOpenAIChunk({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 }
      })
    ).toEqual({ promptTokens: 7, completionTokens: 2 })
  })

  it('**没有 usage → null**（绝不硬编一个 0 —— 那会被当成"真的没用量"）', () => {
    expect(usageFromOpenAIChunk({ choices: [{ delta: { content: 'x' } }] })).toBeNull()
    expect(usageFromOpenAIChunk({})).toBeNull()
    expect(usageFromOpenAIChunk(null)).toBeNull()
    expect(usageFromOpenAIChunk('nope')).toBeNull()
  })

  it('字段类型不对（字符串 / 负数是脏数据）→ null', () => {
    expect(usageFromOpenAIChunk({ usage: { prompt_tokens: '120', completion_tokens: 4 } })).toBeNull()
    expect(usageFromOpenAIChunk({ usage: { prompt_tokens: -1, completion_tokens: 4 } })).toBeNull()
  })
})

describe('Anthropic 的 usage 解析（**分两处报**：message_start 给输入、message_delta 给输出）', () => {
  it('message_start → 输入 token', () => {
    expect(
      usageFromAnthropicEvent({
        type: 'message_start',
        message: { usage: { input_tokens: 321, output_tokens: 1 } }
      })
    ).toEqual({ promptTokens: 321, completionTokens: 1 })
  })

  it('message_delta → 输出 token（这一处才是最终值）', () => {
    expect(
      usageFromAnthropicEvent({
        type: 'message_delta',
        usage: { output_tokens: 88 }
      })
    ).toEqual({ promptTokens: 0, completionTokens: 88 })
  })

  it('其它事件 / 脏数据 → null', () => {
    expect(usageFromAnthropicEvent({ type: 'content_block_delta' })).toBeNull()
    expect(usageFromAnthropicEvent({ type: 'message_delta' })).toBeNull()
    expect(usageFromAnthropicEvent({ type: 'message_delta', usage: { output_tokens: 'x' } })).toBeNull()
    expect(usageFromAnthropicEvent(null)).toBeNull()
  })
})
