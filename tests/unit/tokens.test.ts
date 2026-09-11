import { describe, expect, it } from 'vitest'
import { estimateMessageTokens, estimateTokens } from '@shared/tokens'
import { decideWorkspace } from '@main/store/workspace-core'

describe('estimateTokens（共用口径，主/渲染同源）', () => {
  it('CJK 按 1 token/字，其余按 4 字符/token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('中文abc')).toBe(3) // 2 CJK + ceil(0.75)
    expect(estimateTokens('')).toBe(0)
  })

  it('单条消息含固定开销，工具调用一并计入', () => {
    expect(estimateMessageTokens('你好世界')).toBe(8) // 4 + 4
    expect(estimateMessageTokens('你好世界', '{"a":1}')).toBeGreaterThan(8)
  })
})

describe('decideWorkspace（工作区回退规则）', () => {
  const fallback = 'C:/default/agent-workspace'

  it('自定义目录可用 → 采用并标记 custom', () => {
    expect(decideWorkspace('D:/myproj', () => true, fallback)).toEqual({ root: 'D:/myproj', custom: true })
  })

  it('目录已被删除/移走 → 回退内置默认（不报错）', () => {
    expect(decideWorkspace('D:/gone', () => false, fallback)).toEqual({ root: fallback, custom: false })
  })

  it('未设置过 → 回退内置默认', () => {
    expect(decideWorkspace(undefined, () => true, fallback)).toEqual({ root: fallback, custom: false })
    expect(decideWorkspace('', () => true, fallback)).toEqual({ root: fallback, custom: false })
    expect(decideWorkspace(null, () => true, fallback)).toEqual({ root: fallback, custom: false })
  })
})
