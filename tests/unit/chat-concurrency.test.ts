import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createChatGate } from '../../src/main/agent/concurrency'

const ROOT = process.cwd()

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

/**
 * **源码结构守卫**（与 `stream-envelope.test.ts` 同一手法）：`ipc.ts` 一起手就要真 Electron，
 * 单测里进不去，所以这里查的是"这道闸有没有接进这个 handler"。它只挡**改着改着漏掉**，不替代行为测试。
 */
describe('哪些会话操作必须过并发闸（K10 / K11）', () => {
  const src = readFileSync(`${ROOT}/src/main/ipc.ts`, 'utf8')

  /** 取某个 handler 的函数体（到下一个 `ipcMain.handle(` 为止） */
  const handlerBody = (channel: string): string => {
    const head = `ipcMain.handle(IPC.${channel}`
    const start = src.indexOf(head)
    // 找不到就先红：通道改了名，这条守卫会静默空转（这正是它要防的那类事）
    if (start < 0) throw new Error(`ipc.ts 里找不到 ${head} —— 守卫的坐标失效了，去同步它`)
    const rest = src.slice(start + head.length)
    const next = rest.indexOf('ipcMain.handle(')
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('回滚与**撤销回滚**都查 `isRunning`（撤销此前漏了：流式中途恢复尾巴会把两轮内容搅在一起）', () => {
    expect(handlerBody('convRollback')).toContain('chatGate.isRunning')
    expect(handlerBody('convUndoRollback')).toContain('chatGate.isRunning')
  })

  it('删除会话先**停掉**它那一轮（不停 = 一轮还在烧 token，而它要落的那条会话已经没了）', () => {
    expect(handlerBody('convDelete')).toContain('chatGate.abort')
  })

  // plan54 断链 #2：`store/goal.ts` 的 `removeGoalsOf` 定义了却**全仓零调用点** ⇒ 删会话后它的目标永久留盘，
  // 面板上会挂着"属于一条已经不存在的会话"的目标。守卫同 K10 那条：只钉接线在不在。
  it('删除会话连带清掉它的目标（孤儿目标不许留在盘上）', () => {
    expect(handlerBody('convDelete')).toContain('removeGoalsOf')
  })
})
