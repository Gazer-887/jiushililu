import { describe, expect, it } from 'vitest'
import { createChatGate } from '../../src/main/agent/concurrency'

/**
 * 对话并发闸（plan11 §2.1）。
 * ⚠️ 只能靠单测，`verify-shot` 兜不住：它把 `chat:send` 整个 stub 掉，渲染端自己就会把
 * `streaming` 置 true —— 实测把上限改回 1 再跑，那边 6 条并发断言照样全绿，**根本没碰到这道闸**。
 */

describe('对话并发闸', () => {
  it('同会话重复发送 → 拒绝，且理由是**人话**（带上"已经在跑"）', () => {
    const gate = createChatGate(3)
    expect(gate.begin('a').ok).toBe(true)
    const again = gate.begin('a')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.message).toContain('已经在跑')
  })

  it('**跨会话 → 放行**（这就是"多会话并发"本身）', () => {
    const gate = createChatGate(3)
    expect(gate.begin('a').ok).toBe(true)
    expect(gate.begin('b').ok).toBe(true)
    expect(gate.size()).toBe(2)
  })

  it('超上限 → 拒绝，且理由里带**上限数字**（用户才知道要等什么）', () => {
    const gate = createChatGate(2)
    expect(gate.begin('a').ok).toBe(true)
    expect(gate.begin('b').ok).toBe(true)
    const third = gate.begin('c')
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.message).toContain('2')
  })

  it('收尾后**位子立刻还回来**（否则跑完一条就再也发不出去了）', () => {
    const gate = createChatGate(1)
    expect(gate.begin('a').ok).toBe(true)
    expect(gate.begin('b').ok).toBe(false)
    gate.end('a')
    expect(gate.begin('b').ok).toBe(true)
  })

  it('**停止只停那一条**（并发时停错会话是事故）', () => {
    const gate = createChatGate(3)
    const a = gate.begin('a')
    const b = gate.begin('b')
    if (!a.ok || !b.ok) throw new Error('前置不成立：两条都该能开')
    gate.abort('a')
    expect(a.controller.signal.aborted).toBe(true)
    expect(b.controller.signal.aborted).toBe(false)
    // 停掉 ≠ 出闸：收尾仍要显式 end（否则异常路径会把位子漏在那儿）
    expect(gate.isRunning('a')).toBe(true)
    gate.end('a')
    expect(gate.isRunning('a')).toBe(false)
  })

  it('回滚判断用得上：`isRunning` 只认那一条会话', () => {
    const gate = createChatGate(3)
    gate.begin('a')
    expect(gate.isRunning('a')).toBe(true)
    expect(gate.isRunning('b')).toBe(false)
  })

  it('上限参数非法 → 立刻炸，而不是悄悄退化成"不限制"', () => {
    expect(() => createChatGate(0)).toThrow()
    expect(() => createChatGate(-1)).toThrow()
    expect(() => createChatGate(Number.NaN)).toThrow()
  })
})
