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
