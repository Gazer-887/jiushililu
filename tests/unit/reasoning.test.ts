// plan58 片① · 档位**强度序**与 chips 数据源（`shared/reasoning.ts` 的纯逻辑）。
//
// 为什么强度序值得单测：它是**界面显示顺序**的来源，而 `levels` 存的是用户添加顺序
// （用户多半先加 `max` 再加 `low`）。顺序错了不影响功能，但会让"从低到高"这句话变成假的
// —— 而那句话是写在界面上的（照 Zcode 的形态）。
//
// 强度序本身抄自 Zcode 的 `Effort` 枚举（`zerx-lab/zcode` · `packages/catalog/src/effort.ts`），
// 与 R6「可用集合按模型存」**不冲突**：R6 管集合，本表管强弱。

import { describe, expect, it } from 'vitest'
import {
  ADDABLE_EFFORT_LEVELS,
  EFFORT_ORDER,
  KNOWN_EFFORT_LEVELS,
  sortEffortLevels
} from '@shared/reasoning'

describe('EFFORT_ORDER（规范强度序，抄自 Zcode 的 Effort 枚举）', () => {
  it('★ 顺序本身要钉住 —— 界面那句「从低到高」是照它说的', () => {
    // 强度序错了不会让任何功能坏，只会让界面上那句话变成假的 ⇒ 只能靠这条钉住。
    expect([...EFFORT_ORDER]).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('已知词表是强度序的子集（否则 `+` 的候选池会漏掉已登记的档）', () => {
    for (const k of KNOWN_EFFORT_LEVELS) {
      expect(EFFORT_ORDER, `${k} 不在强度序里`).toContain(k)
    }
  })

  it('★ 候选池（`+` 那份）覆盖强度序全部 —— 不许因为"没实测过"就不让用户选', () => {
    // 我们三家端点的档位支持情况一格都没实测过（plan58 §丁 / R9），
    // 但 `minimal` / `xhigh` 是**官方确有**的值（09-27 查证 Azure 文档 + Anthropic SDK）。
    // 因为没测过就不让用户选 = 替厂商下结论，违反 R9。
    expect([...ADDABLE_EFFORT_LEVELS]).toEqual([...EFFORT_ORDER])
  })
})

describe('sortEffortLevels（按强度排，未知档名排末尾）', () => {
  it('打乱输入也排成低→高', () => {
    expect(sortEffortLevels(['max', 'low', 'xhigh', 'medium'])).toEqual(['low', 'medium', 'xhigh', 'max'])
  })

  it('已排好的原样返回（幂等）', () => {
    const inOrder = ['low', 'high', 'max']
    expect(sortEffortLevels(inOrder)).toEqual(inOrder)
  })

  it('★ 未知档名排末尾，且彼此保持输入相对顺序', () => {
    // 厂商自造词我们判不出强弱 ⇒ **猜一个强度可能排错档**，
    // 而"把 `xmax` 显示成比 `low` 弱"比"放在末尾"更有害。
    expect(sortEffortLevels(['vendor-x', 'high', 'vendor-y', 'low'])).toEqual([
      'low',
      'high',
      'vendor-x',
      'vendor-y'
    ])
  })

  it('空数组 / 单个都不炸', () => {
    expect(sortEffortLevels([])).toEqual([])
    expect(sortEffortLevels(['只有一档'])).toEqual(['只有一档'])
  })

  it('不改动传入的数组（纯函数，别把 props 里的顺序改了）', () => {
    const input = ['max', 'low']
    sortEffortLevels(input)
    expect(input).toEqual(['max', 'low'])
  })
})

// ── plan58 片② · 缺口 C 的出境形状（R15 / R16）────────────────────────────────
//
// 这一组是"控件不是摆设"的判据：`toggle` 的开关与 `budget_tokens` 的预算在片⓪ 只有契约层
// （存得进、读得出），出境层是空的 —— 控件上线而这里没判据，就是 plan58 反复警告的
// "更精致的假开关"。每条判据同时钉住"该发时发什么"与"未声明时什么都不发"两个方向。

import { anthropicThinkingBudget, openaiReasoningFields } from '@shared/reasoning'

describe('openaiReasoningFields（toggle / budget_tokens 的出境字段，R15/R16）', () => {
  it('★ toggle 关 + 声明关闭编码 ⇒ 发显式关闭信号（否则对默认开思考的端点"关不掉"）', () => {
    const base = { reasoningEffort: 'default' }
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: false, offEncoding: 'enable_thinking_false' }
      })
    ).toEqual({ enable_thinking: false })
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: false, offEncoding: 'chat_template_kwargs' }
      })
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: false, offEncoding: 'reasoning_enabled_false' }
      })
    ).toEqual({ reasoning: { enabled: false } })
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: false, offEncoding: 'effort_minimal' }
      })
    ).toEqual({ reasoning_effort: 'minimal' })
  })

  it('★ toggle 开 ⇒ 与关对称的显式开启信号（omit 与 effort_minimal 没有"开"线形，不发）', () => {
    const base = { reasoningEffort: 'default' }
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: true, offEncoding: 'enable_thinking_false' }
      })
    ).toEqual({ enable_thinking: true })
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: true, offEncoding: 'reasoning_enabled_false' }
      })
    ).toEqual({ reasoning: { enabled: true } })
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: true, offEncoding: 'omit' }
      })
    ).toEqual({})
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'toggle', enabled: true, offEncoding: 'effort_minimal' }
      })
    ).toEqual({})
  })

  it('toggle 未设过开关（enabled 缺）⇒ 什么都不发（维持厂商默认，不替用户表态）', () => {
    expect(
      openaiReasoningFields({ reasoningEffort: 'default', reasoning: { kind: 'toggle' } })
    ).toEqual({})
  })

  it('★ budget_tokens：声明了预算字段才发，发的是声明的那个字段', () => {
    const base = { reasoningEffort: 'default' }
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'budget_tokens', budget: 8192, budgetEncoding: 'thinking_budget' }
      })
    ).toEqual({ thinking_budget: 8192 })
    expect(
      openaiReasoningFields({
        ...base,
        reasoning: { kind: 'budget_tokens', budget: 4096, budgetEncoding: 'reasoning_max_tokens' }
      })
    ).toEqual({ reasoning: { max_tokens: 4096 } })
  })

  it('budget_tokens 未声明预算字段 ⇒ 不发（猜一个字段名 = 拿猜测冒充承诺，R9）', () => {
    expect(
      openaiReasoningFields({ reasoningEffort: 'default', reasoning: { kind: 'budget_tokens', budget: 8192 } })
    ).toEqual({})
  })

  it('budget 为 0 或缺 ⇒ 不发（预算 0 不是合法出境值）', () => {
    expect(
      openaiReasoningFields({
        reasoningEffort: 'default',
        reasoning: { kind: 'budget_tokens', budget: 0, budgetEncoding: 'thinking_budget' }
      })
    ).toEqual({})
    expect(
      openaiReasoningFields({
        reasoningEffort: 'default',
        reasoning: { kind: 'budget_tokens', budgetEncoding: 'thinking_budget' }
      })
    ).toEqual({})
  })

  it('effort / none 形态本函数一概不管（effort 走 effortToSend 通道，不双发）', () => {
    expect(
      openaiReasoningFields({ reasoningEffort: 'high', reasoning: { kind: 'effort', levels: ['high'] } })
    ).toEqual({})
    expect(openaiReasoningFields({ reasoningEffort: 'high', reasoning: { kind: 'none' } })).toEqual({})
    expect(openaiReasoningFields({ reasoningEffort: 'high' })).toEqual({})
  })
})

describe('anthropicThinkingBudget（kind 感知的预算出口，片② 暗病修）', () => {
  // 注入的换算函数 = anthropic.ts 的 EFFORT_BUDGET 路径；shared 层不 import provider
  const fakeEffortBudget = (effort: string, maxTokens: number): number | null =>
    effort === 'high' ? Math.min(32768, maxTokens - 1024) : null

  it('★ kind:none / toggle 即便存着 effort 档也不发（inert 数据永不出境，两条通路都要成立）', () => {
    expect(
      anthropicThinkingBudget({ reasoningEffort: 'high', reasoning: { kind: 'none' } }, 65536, fakeEffortBudget)
    ).toBe(null)
    expect(
      anthropicThinkingBudget(
        { reasoningEffort: 'high', reasoning: { kind: 'toggle', enabled: true } },
        65536,
        fakeEffortBudget
      )
    ).toBe(null)
  })

  it('★ kind:budget_tokens 用声明的预算，仍受 max_tokens 硬约束（余量不足显式降级，不 NaN）', () => {
    expect(
      anthropicThinkingBudget(
        { reasoningEffort: 'default', reasoning: { kind: 'budget_tokens', budget: 4096 } },
        65536,
        fakeEffortBudget
      )
    ).toBe(4096)
    // 预算大于余量 ⇒ 钳到余量
    expect(
      anthropicThinkingBudget(
        { reasoningEffort: 'default', reasoning: { kind: 'budget_tokens', budget: 999999 } },
        65536,
        fakeEffortBudget
      )
    ).toBe(64512)
    // 余量不足 ⇒ 不开思考
    expect(
      anthropicThinkingBudget(
        { reasoningEffort: 'default', reasoning: { kind: 'budget_tokens', budget: 4096 } },
        2000,
        fakeEffortBudget
      )
    ).toBe(null)
  })

  it('kind:effort / 未声明 ⇒ 走注入的换算路径（存量行为不变）', () => {
    expect(
      anthropicThinkingBudget(
        { reasoningEffort: 'high', reasoning: { kind: 'effort', levels: ['high'] } },
        65536,
        fakeEffortBudget
      )
    ).toBe(32768)
    expect(anthropicThinkingBudget({ reasoningEffort: 'high' }, 65536, fakeEffortBudget)).toBe(32768)
    expect(anthropicThinkingBudget({ reasoningEffort: 'default' }, 65536, fakeEffortBudget)).toBe(null)
  })
})
