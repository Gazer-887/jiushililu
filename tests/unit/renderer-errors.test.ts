// K58 · 渲染层错误通路的**纯逻辑**部分（去重节流 / 截断 / 载荷定型）。
//
// 为什么这些能单测而 `console-message` 挂载不能：挂载那半在 electron 运行时里
// （`app` / `ipcMain` / `WebContents`），单测环境起不来；而这半是纯函数 ——
// 尤其**时钟由调用方注入**，所以"60 秒内不重复"这条能真测，不必真等一分钟。
//
// ⚠️ 与 e2e 的分工（`tests/e2e/renderer-error.spec.ts`）：那边证"链路真的通"，
// 这边证"通之前的那些取舍写对了"。**两边缺一不可** —— 只有 e2e 的话，
// 有人把节流窗口改成 0 只会让日志变大，e2e 照样全绿。

import { describe, expect, it } from 'vitest'
import {
  createThrottleState,
  oneLine,
  sanitizeReport,
  throttle
} from '@main/renderer-errors'

describe('throttle（同一条渲染层错误不该把日志刷爆）', () => {
  it('窗口期内只记一次，第二次起只回重复计数', () => {
    const s = createThrottleState()
    expect(throttle(s, 'k', 1000)).toEqual({ record: true, sinceMs: -1 })
    expect(throttle(s, 'k', 2000)).toEqual({ record: false, repeat: 1 })
    expect(throttle(s, 'k', 3000)).toEqual({ record: false, repeat: 2 })
    expect(throttle(s, 'k', 4000)).toEqual({ record: false, repeat: 3 })
  })

  it('★ 过了窗口期重新记，并带上"距上次多少毫秒"', () => {
    // 没有 `sinceMs` 的话，日志里就是两条孤立的记录，读者得自己算间隔 ——
    // 而"这条每 5 秒来一次"正是最该被一眼看出的那种现场。
    const s = createThrottleState()
    throttle(s, 'k', 1000)
    expect(throttle(s, 'k', 1000 + 60_000)).toEqual({ record: true, sinceMs: 60_000 })
  })

  it('不同的 key 互不影响（去重不能跨消息，否则两条不同的错只剩一条）', () => {
    const s = createThrottleState()
    expect(throttle(s, 'a', 1000).record).toBe(true)
    expect(throttle(s, 'b', 1000).record).toBe(true)
  })

  it('★ 重新计时后重复计数清零（否则会报一个隔了很久的重复次数）', () => {
    const s = createThrottleState()
    throttle(s, 'k', 1000)
    throttle(s, 'k', 2000)
    throttle(s, 'k', 3000) // 连续第 3 次 ⇒ 计数 2
    // 窗口过了，重新记 ⇒ 计数作废
    expect(throttle(s, 'k', 3000 + 60_000).record).toBe(true)
    expect(throttle(s, 'k', 3000 + 60_001)).toEqual({ record: false, repeat: 1 })
  })

  it('★ 连续 100 次只占一个"计数槽"（否则 map 会被同一条撑爆 —— 那是另一种刷屏）', () => {
    const s = createThrottleState()
    throttle(s, 'k', 1000)
    for (let i = 1; i < 100; i++) throttle(s, 'k', 1000 + i)
    // 计数存在 `${key}#n` 一个键里，不随次数增长
    expect([...s.lastAt.keys()].filter((k) => k.startsWith('k#n')).length).toBe(1)
  })
})

describe('oneLine（日志是一行一条记录）', () => {
  it('换行压成可见的 \\n 而不是真的断行', () => {
    // 真断行会让一条堆栈在 app.log 里散成十几行，grep 一次只看到第一行。
    // 注意替换串 `' \\n '` 自身带前后空格，原文的两空格缩进仍留着 ⇒ 标记后共三个空格。
    expect(oneLine('Error: x\n  at foo\n  at bar')).toBe('Error: x \\n   at foo \\n   at bar')
    // 反向：压完之后**整条里一个真换行都不能有**（这是这条判据真正在守的东西）
    expect(oneLine('a\nb\nc')).not.toMatch(/[\r\n]/)
  })

  it('★ 超长时截断但**标出原长度**（否则读者会以为错误信息就那么长）', () => {
    const out = oneLine('x'.repeat(5000), 100)
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('已截断')
    expect(out).toContain('5000')
  })
})

describe('sanitizeReport（载荷来自一个刚抛了异常的上下文，全部不可信）', () => {
  it('正常 Error 形状原样收', () => {
    const r = sanitizeReport({ kind: 'error', message: 'boom', stack: 'at foo', source: 'app.js', line: 12, column: 3 })
    expect(r).toEqual({ kind: 'error', message: 'boom', stack: 'at foo', source: 'app.js', line: 12, column: 3 })
  })

  it('★ 非对象载荷直接拒（宁可不记，也不要拿半截东西写进日志）', () => {
    expect(sanitizeReport(null)).toBeNull()
    expect(sanitizeReport('字符串')).toBeNull()
    expect(sanitizeReport(undefined)).toBeNull()
  })

  it('★ 字段类型不对时自己定型，不把 [object Object] / undefined 写进日志', () => {
    // `Promise.reject({code:1})` 的 reason 就是这样 —— 真实存在，不是假想
    const r = sanitizeReport({ kind: 'unhandledrejection', message: { code: 1 }, stack: null, line: 'x' })
    expect(r?.kind).toBe('unhandledrejection')
    expect(r?.message).toBe('(无 message)')
    expect(r?.stack).toBe('')
    expect(r?.line).toBe(0)
    expect(JSON.stringify(r)).not.toContain('[object Object]')
  })

  it('未知 kind 归到 error（宁可归错档，不要把整条丢掉）', () => {
    expect(sanitizeReport({ kind: '外星', message: 'x' })?.kind).toBe('error')
  })
})
