import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  addUsage,
  anyEstimated,
  cacheHitRate,
  emptyUsage,
  formatRate,
  formatTokens,
  mergeOptionalMax,
  mergeUsageHalves,
  reasoningShare,
  sumRecords,
  totalTokens,
  type TokenUsage,
  type UsageRecord
} from '@shared/usage'
import {
  describeUsageShape,
  usageFromAnthropicEvent,
  usageFromOpenAIChunk
} from '../../src/main/providers/usage-parsers'

/**
 * 用量（plan8 R9）。
 *
 * 三条要盯住的：
 *   ① **真实 usage 优先、估算要标出来**（混在一起不标注 = 用户把两笔账当一回事）
 *   ② **认不出来就 null，绝不硬编 0** —— 0 会被下游当成"真的没用量"，一路显示成"这轮不花钱"
 *   ③ 两个协议的 usage 形状不同（OpenAI 在最后一个 chunk、Anthropic 分两处报），解析器各认各家的
 *
 * ⚠️ 这里**没有**"费用"用例：用户定调"不用记钱，计量就好"，那盘单价算术已删（见 usage.ts 顶注）。
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
    ).toEqual({
      promptTokens: 120,
      completionTokens: 45,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
  })

  it('非流式响应（choices 里带 message）也认', () => {
    expect(
      usageFromOpenAIChunk({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 }
      })
    ).toEqual({
      promptTokens: 7,
      completionTokens: 2,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
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
    ).toEqual({
      promptTokens: 321,
      completionTokens: 1,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
  })

  it('message_delta → 输出 token（这一处才是最终值）', () => {
    expect(
      usageFromAnthropicEvent({
        type: 'message_delta',
        usage: { output_tokens: 88 }
      })
    ).toEqual({
      promptTokens: 0,
      completionTokens: 88,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
  })

  it('其它事件 / 脏数据 → null', () => {
    expect(usageFromAnthropicEvent({ type: 'content_block_delta' })).toBeNull()
    expect(usageFromAnthropicEvent({ type: 'message_delta' })).toBeNull()
    expect(usageFromAnthropicEvent({ type: 'message_delta', usage: { output_tokens: 'x' } })).toBeNull()
    expect(usageFromAnthropicEvent(null)).toBeNull()
  })
})

/**
 * 缓存命中 / 推理用量（plan8 R9.1 §七①）。
 *
 * 这一组用例的**依据是真机实测**，不是文档抄来的字段名 —— 见下面的 `REAL_DEEPSEEK_USAGE`。
 * 当初"凭记忆写字段名"的教训：字段错了**不报错**，只是永远解析不出东西（最难查的那类 bug）。
 */
const REAL_DEEPSEEK_USAGE = {
  prompt_tokens: 2210,
  completion_tokens: 2,
  total_tokens: 2212,
  prompt_tokens_details: { cached_tokens: 2048 },
  completion_tokens_details: { reasoning_tokens: 0 },
  prompt_cache_hit_tokens: 2048,
  prompt_cache_miss_tokens: 162
}

describe('缓存命中与推理量：真机实测样本回归', () => {
  it('DeepSeek 实测（2026-09-12）：两套字段同报，命中量与推理量都取到', () => {
    expect(usageFromOpenAIChunk({ choices: [], usage: REAL_DEEPSEEK_USAGE })).toEqual({
      promptTokens: 2210,
      completionTokens: 2,
      cachedPromptTokens: 2048,
      reasoningTokens: 0
    })
  })

  it('只有 OpenAI 系嵌套字段（没有 DeepSeek 顶层）也认', () => {
    const u = usageFromOpenAIChunk({
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 64 } }
    })
    expect(u?.cachedPromptTokens).toBe(64)
  })

  it('**没报就是 null**（明确的"未知"）—— 绝不是补 0，也不是"省掉这个键"', () => {
    const u = usageFromOpenAIChunk({ usage: { prompt_tokens: 100, completion_tokens: 10 } })
    // 为什么不能省掉键：省掉的含义是"这份账不含这条信息"，累加时会被静默跳过，
    // 于是"没报"被偷偷记成 0 —— 那正是要防的假数字（见 addOptional 那张表）
    expect(u?.cachedPromptTokens).toBeNull()
    expect(u?.reasoningTokens).toBeNull()
  })

  it('报了 0 就是**真的 0**（这轮没思考），不许跟"没报"混为一谈', () => {
    const u = usageFromOpenAIChunk({
      usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } }
    })
    expect(u?.reasoningTokens).toBe(0)
    expect(u ? reasoningShare(u) : null).toBe(0)
  })

  it('脏数据（命中量是字符串 / 负数）→ 当没报，不硬塞进账里', () => {
    const u = usageFromOpenAIChunk({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_cache_hit_tokens: '2048',
        prompt_tokens_details: { cached_tokens: -1 }
      }
    })
    expect(u?.cachedPromptTokens).toBeNull()
  })

  it('Anthropic：`cache_read_input_tokens` 才是命中', () => {
    const u = usageFromAnthropicEvent({
      type: 'message_start',
      message: { usage: { input_tokens: 321, output_tokens: 1, cache_read_input_tokens: 300 } }
    })
    expect(u?.cachedPromptTokens).toBe(300)
  })

  it('Anthropic：`cache_creation_input_tokens`（**写入**缓存）不算命中', () => {
    const u = usageFromAnthropicEvent({
      type: 'message_start',
      message: { usage: { input_tokens: 321, output_tokens: 1, cache_creation_input_tokens: 20 } }
    })
    expect(u?.cachedPromptTokens).toBeNull()
  })
})

describe('命中率 / 思考占比', () => {
  it('真机样本：2210 输入里命中 2048 → 93%', () => {
    expect(formatRate(cacheHitRate({ promptTokens: 2210, completionTokens: 2, cachedPromptTokens: 2048 }))).toBe('93%')
  })

  it('**厂商没报 → null**，显示成破折号而不是 0%', () => {
    expect(cacheHitRate({ promptTokens: 100, completionTokens: 10 })).toBeNull()
    expect(reasoningShare({ promptTokens: 100, completionTokens: 10 })).toBeNull()
    expect(formatRate(null)).toBe('—')
  })

  it('报了 0 → 真的是 0%（"没命中"和"没报"是两回事）', () => {
    expect(cacheHitRate({ promptTokens: 100, completionTokens: 10, cachedPromptTokens: 0 })).toBe(0)
    expect(formatRate(0)).toBe('0%')
  })

  it('分母为 0 → null（不返回 NaN）', () => {
    expect(cacheHitRate({ promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 })).toBeNull()
    expect(reasoningShare({ promptTokens: 10, completionTokens: 0, reasoningTokens: 0 })).toBeNull()
  })

  it('脏数据（命中量大于输入量）→ 夹到 100%，不显示 130%', () => {
    expect(cacheHitRate({ promptTokens: 100, completionTokens: 10, cachedPromptTokens: 130 })).toBe(1)
  })

  it('思考占比：输出 100 里推理 52 → 52%', () => {
    expect(formatRate(reasoningShare({ promptTokens: 10, completionTokens: 100, reasoningTokens: 52 }))).toBe('52%')
  })
})

describe('累加与合并时的可选计数', () => {
  it('两侧都报 → 相加', () => {
    expect(
      addUsage(
        { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 80, reasoningTokens: 5 },
        { promptTokens: 200, completionTokens: 20, cachedPromptTokens: 150, reasoningTokens: 15 }
      )
    ).toEqual({ promptTokens: 300, completionTokens: 30, cachedPromptTokens: 230, reasoningTokens: 20 })
  })

  it('一侧**明确没报**（null）→ 合计也是"不知道"，不假装那一侧是 0', () => {
    const sum = addUsage(
      { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 80 },
      { promptTokens: 200, completionTokens: 20, cachedPromptTokens: null, reasoningTokens: null }
    )
    expect(sum.cachedPromptTokens).toBeNull()
    // 命中率随之变成"不知道"—— 这是对的：混进一轮没报的，谁也不知道真实命中率
    expect(cacheHitRate(sum)).toBeNull()
  })

  it('一侧只是**不含这条信息**（undefined：空账单位元 / 升级前的老数据）→ 取有值那侧', () => {
    const sum = addUsage(
      { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 80 },
      { promptTokens: 200, completionTokens: 20 }
    )
    expect(sum.cachedPromptTokens).toBe(80)
  })

  it('第一轮就报 0 命中 → 累计**是 0 而不是未知**（真渲染门禁抓出来的那个缺陷）', () => {
    // 曾经把 undefined 和 null 一起当"未知"，于是 `addUsage(空账, 报了0)` = 未知，
    // 界面从此再不显示命中率 —— 功能等于没做，而单测当时还是绿的
    const first = addUsage(emptyUsage(), {
      promptTokens: 1200,
      completionTokens: 340,
      cachedPromptTokens: 0,
      reasoningTokens: 0
    })
    expect(first.cachedPromptTokens).toBe(0)
    expect(cacheHitRate(first)).toBe(0)
  })

  it('两侧都不含这条信息 → 结果也不含（老数据原样，不被塞进 null）', () => {
    const sum = addUsage({ promptTokens: 1, completionTokens: 1 }, { promptTokens: 2, completionTokens: 2 })
    expect(sum).toEqual({ promptTokens: 3, completionTokens: 3 })
    expect(sum.cachedPromptTokens).toBeUndefined()
  })

  it('盘上合并取大：任一来源报过就是已知（与账本"只许往前长"同一条规矩）', () => {
    expect(mergeOptionalMax(100, 80)).toBe(100)
    expect(mergeOptionalMax(undefined, 80)).toBe(80)
    expect(mergeOptionalMax(100, undefined)).toBe(100)
    expect(mergeOptionalMax(null, null)).toBeUndefined()
    expect(mergeOptionalMax(undefined, undefined)).toBeUndefined()
  })
})

/**
 * Anthropic 把 usage **分两处报**（`message_start` 给输入、`message_delta` 给输出），
 * 主循环必须把两半**合**起来 —— 这一组是 2026-09-13 修掉一个真实缺陷后补的：
 * 原来那句 `usage = evtUsage` 是**覆盖**，后到的 `message_delta` 会把输入量抹成 0。
 */
describe('Anthropic 的两半合一份', () => {
  const start = (): TokenUsage => {
    const u = usageFromAnthropicEvent({
      type: 'message_start',
      message: { usage: { input_tokens: 321, output_tokens: 1, cache_read_input_tokens: 300 } }
    })
    if (!u) throw new Error('message_start 应当解析得出用量')
    return u
  }
  const delta = (): TokenUsage => {
    const u = usageFromAnthropicEvent({ type: 'message_delta', usage: { output_tokens: 88 } })
    if (!u) throw new Error('message_delta 应当解析得出用量')
    return u
  }

  it('**输入取 start、输出取 delta** —— 输入不许被抹成 0（覆盖式合并的旧病）', () => {
    const merged = mergeUsageHalves(start(), delta())
    expect(merged.promptTokens).toBe(321)
    expect(merged.completionTokens).toBe(88)
  })

  it('也不是相加：`message_start` 里那个 output_tokens=1 只是占位，加上去就多算一格', () => {
    expect(mergeUsageHalves(start(), delta()).completionTokens).not.toBe(89)
  })

  it('缓存命中只出现在 start 那半 —— 合并后**不许被抹掉**', () => {
    expect(mergeUsageHalves(start(), delta()).cachedPromptTokens).toBe(300)
  })
})

/**
 * 形状探针（`describeUsageShape`）：核对厂商字段名时用的那把尺。
 * 它是纯函数，所以可以直接钉住行为 —— 探针本身错了，后面所有"按实测写"的字段名就全跟着错。
 */
describe('usage 形状探针', () => {
  it('拍平成键路径，嵌套只走两层（`prompt_tokens_details.cached_tokens` 正好两层）', () => {
    expect(
      describeUsageShape({
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 8 },
        deeper: { a: { b: { c: 1 } } }
      })
    ).toEqual({
      prompt_tokens: 10,
      'prompt_tokens_details.cached_tokens': 8,
      'deeper.a': '{…}' // 第三层只留个占位（探针要的是"看得懂"，不是"全都展开"）
    })
  })

  it('字符串只记长度、不记内容（探针不该成为泄露的口子）', () => {
    expect(describeUsageShape({ model: 'deepseek-chat' })).toEqual({ model: 'string(13)' })
  })

  it('真机样本原样认出（这句话就是核对字段名时打印的那一行）', () => {
    expect(describeUsageShape(REAL_DEEPSEEK_USAGE)).toEqual({
      prompt_tokens: 2210,
      completion_tokens: 2,
      total_tokens: 2212,
      'prompt_tokens_details.cached_tokens': 2048,
      'completion_tokens_details.reasoning_tokens': 0,
      prompt_cache_hit_tokens: 2048,
      prompt_cache_miss_tokens: 162
    })
  })
})

/**
 * **接线守卫**：上面那些用例测的是纯函数，测不到"主循环到底调没调它"。
 *
 * 这是本项目踩过的坑（`stream-envelope` 那组守卫就是同一个道理）：
 * 纯函数全绿、调用点却把它换成了别的东西 —— 测试一点反应都没有。
 * 所以这里直接读源码断言那一句，**改回覆盖式合并就红**。
 */
describe('接线守卫：Anthropic 主循环真的在合并两半', () => {
  const src = readFileSync('src/main/providers/anthropic-agent.ts', 'utf8')

  it('调的是 `mergeUsageHalves`（把合并删掉 / 换成覆盖都会红）', () => {
    expect(src).toContain('mergeUsageHalves(usage, evtUsage)')
  })

  it('旧的覆盖写法不许回来（那正是"输入量被抹成 0"的病根）', () => {
    expect(src).not.toContain('if (evtUsage) usage = evtUsage')
  })
})
