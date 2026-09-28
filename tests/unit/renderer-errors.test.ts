// K58 · 渲染层错误通路的**纯逻辑**部分（收档判定 / 去重节流 / 截断 / 载荷定型）。
//
// 为什么这些能单测而 `console-message` 挂载不能：挂载那半在 electron 运行时里
// （`app` / `ipcMain` / `WebContents`），单测环境起不来；而这半是纯函数 ——
// 尤其**时钟由调用方注入**，所以"60 秒内不重复"这条能真测，不必真等一分钟。
//
// ⚠️ 与 e2e 的分工（`tests/e2e/renderer-error.spec.ts`）：那边证"链路真的通"，
// 这边证"通之前的那些取舍写对了"。**两边缺一不可** —— 只有 e2e 的话，
// 有人把节流窗口改成 0 只会让日志变大，e2e 照样全绿。

import { describe, expect, it } from 'vitest'
// ⚠️ import 的是 **`-core` 而不是 `renderer-errors`** —— 后者 import electron，
// 而 CI 的 `quality` job **跳过 electron 二进制下载** ⇒ 从它 import 会让本文件在 CI 上
// 直接 `Electron failed to install correctly`，**而本机全绿**（09-28 实测，第六次「本地全绿 ≠ 通过」）。
// 这条约束由 `no-dead-wiring.test.ts` 的「被单测 import 的模块不许碰 electron」守着。
import {
  createThrottleState,
  isRecordedConsoleLevel,
  oneLine,
  sanitizeReport,
  throttle
} from '@main/renderer-errors-core'

describe('isRecordedConsoleLevel（只收 warn + error，两种 level 形态都认）', () => {
  it('Electron ≤34 的数字形态：0 verbose / 1 info 不收，2 warning / 3 error 收', () => {
    expect(isRecordedConsoleLevel(0)).toBe(false)
    expect(isRecordedConsoleLevel(1)).toBe(false)
    expect(isRecordedConsoleLevel(2)).toBe(true)
    expect(isRecordedConsoleLevel(3)).toBe(true)
  })

  it('★ Electron ≥35 的字符串形态**同样收**（查证 35.0 breaking-changes）', () => {
    // 只认数字的话，升级 Electron 那天这条通路会**静默全灭**（字符串与数字比恒不等，
    // `level !== 2 && level !== 3` 恒真 → 全部 return），而症状与"没做"一模一样。
    // ⇒ 双形态是硬要求，不是兼容包袱。
    expect(isRecordedConsoleLevel('warning')).toBe(true)
    expect(isRecordedConsoleLevel('error')).toBe(true)
    expect(isRecordedConsoleLevel('info')).toBe(false)
    expect(isRecordedConsoleLevel('debug')).toBe(false)
  })

  it('认不出来的形态一律不收（宁可不收，也不要把"存疑"当"错误"写进日志）', () => {
    for (const v of [undefined, null, {}, 'WARN', 4, -1, 'verbose']) {
      expect(isRecordedConsoleLevel(v), String(v)).toBe(false)
    }
  })
})

describe('throttle（同一条渲染层错误不该把日志刷爆）', () => {
  it('窗口期内只记一次（第二次起**一个字都不写**）', () => {
    const s = createThrottleState()
    expect(throttle(s, 'k', 1000)).toEqual({ record: true, sinceMs: -1, repeat: 0 })
    expect(throttle(s, 'k', 2000)).toEqual({ record: false })
    expect(throttle(s, 'k', 3000)).toEqual({ record: false })
  })

  it('★ 累计次数在**下一条真记录**上带出（"这条每分钟炸 60 回"是读者要的信息）', () => {
    // 每次重复都写一条"已节流"是另一种刷屏；且打包版 `minLevel='info'`，
    // `log.debug` 那一档**根本不落盘**（`log.ts · write` 第一行就过滤掉）
    // ⇒ 把计数挂在下一条真记录上，是唯一在生产里看得见的形式。
    const s = createThrottleState()
    throttle(s, 'k', 1000)
    throttle(s, 'k', 2000)
    throttle(s, 'k', 3000)
    // `sinceMs` 是"距**上次记**"而不是"距首次记" —— 节流期内**故意不更新时间戳**，
    // 否则窗口会被无限延长（每来一次就往后推 60 秒 ⇒ 永远记不下来）
    expect(throttle(s, 'k', 3000 + 60_000)).toEqual({ record: true, sinceMs: 62_000, repeat: 2 })
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
    expect(throttle(s, 'k', 2000 + 60_000)).toEqual({ record: true, sinceMs: 61_000, repeat: 1 })
  })

  it('★ 高基数消息下去重表也**有上限**（否则是内存泄漏）', () => {
    // 09-28 独立审查抓出：键由**消息内容**构成，而只出现一次的消息**永远等不到第二次**
    // 去碰它 ⇒ 每次都是新键、60 秒节流对高基数 message 一次都不生效
    //（"AbortError: request 8f3a… cancelled" 这类带 id 的就是高基数）。
    // 不清扫 ⇒ 主进程内存单调上涨，**与磁盘轮转无关、不会自己停**。
    const s = createThrottleState()
    for (let i = 0; i < 5000; i++) throttle(s, `err-${i}`, i)
    expect(s.lastAt.size, '去重表无界增长 = 内存泄漏').toBeLessThanOrEqual(1024)
  })

  it('★ 上限触发后**老键被清掉**（否则上限只是把泄漏换成"不再更新"）', () => {
    const s = createThrottleState()
    throttle(s, '老键', 1)
    for (let i = 0; i < 2000; i++) throttle(s, `err-${i}`, 100 + i)
    // 整表清空后老键不再被记得 ⇒ 记一次（表若没清，它会被节流）
    expect(throttle(s, '老键', 200).record, '上限触发后应当整表清空').toBe(true)
  })

  it('同一个 key 连来 100 次也只占两个项（主项 + 计数项）', () => {
    const s = createThrottleState()
    throttle(s, 'k', 1000)
    for (let i = 1; i < 100; i++) throttle(s, 'k', 1000 + i)
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

  it('★ 非对象载荷返回 null（**调用方必须留痕**，静默丢弃就是这条通路要消灭的形态）', () => {
    // 上游发错形状时若零记录，现场会重演一次"app.log 什么都没有"——
    // 而那正是这条通路的立项原因。判据钉住"返回 null"，留痕由调用方的判据钉。
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
