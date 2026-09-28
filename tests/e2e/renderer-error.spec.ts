// K58 · 渲染层未捕获异常的**真进程**通路（plan8 R18 的"可排查性那一半"）。
//
// 为什么必须真起进程（而不是 verify-shot 的隔离验证进程）：这条通路的一半在**主进程**
// （`web-contents-created` 上挂 `console-message` + `ipcMain.on('renderer:error')`），
// 而 `scripts/verify-shot.cjs` **不加载 `src/main`**、自建 `ipcMain.handle` ⇒ 它天生测不到这一半。
// 这与"复制通路要在门禁里测"（那条主进程侧是 `clipboard.writeText`，门禁桩能真写）是两种情况。
//
// 断言的是**隔离 userData 里的 app.log**，不是页面自报、也不是探针 stdout ——
// 与 plan53 拼写载荷那条判据同口径：让主进程自己回读。
//
// ⚠️ 本文件**不发任何厂商请求**、不需要 Key ⇒ 归 B 类，CI 每次必跑。

import { expect, test } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, type E2EApp } from './helpers'

/** 探针标记：唯一串，绝不与真实日志撞词（撞了就等于这条判据恒真） */
const MARK = 'K58-PROBE-7f3a91'

function appLog(dataDir: string): string {
  const p = join(dataDir, 'logs', 'app.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

test.describe('K58 · 渲染层错误进得了 app.log', () => {
  let h: E2EApp

  test.beforeEach(async () => {
    h = await launchApp()
  })

  test.afterEach(async () => {
    await h?.close()
    await h?.cleanup()
  })

  test('K1 未捕获异常 ⇒ app.log 里有现场（message + 堆栈）', async () => {
    // 触发方式：**异步**抛 —— 同步抛在 `evaluate` 里会被 Playwright 当成调用失败
    await h.page.evaluate((mark) => {
      setTimeout(() => {
        throw new Error(`${mark}: 故意抛的未捕获异常`)
      }, 0)
    }, MARK)

    // 日志是 appendFileSync 同步落盘，但事件派发要过一轮 ⇒ 轮询而不是死等
    await expect
      .poll(() => appLog(h.dataDir).includes(MARK), { timeout: 20_000, message: 'app.log 里没等到探针标记' })
      .toBe(true)

    const log = appLog(h.dataDir)
    // 顺带证明**走的是哪条通路**：preload 装的 error 监听（不是 console-message 顺带收的）
    expect(log, '走的是哪条通路？（应含 preload 那条的特征行）').toContain('渲染进程未捕获异常')
    // 堆栈是排查的命根子 —— 只记 message 等于只记"错了"不记"错在哪"
    expect(log, '缺堆栈：只留 message 等于把排查难度原样送回给用户').toMatch(/at\s+\S/)
    // 窗口身份要能看出来是哪个窗口（多窗口下这条日志得能定位）
    expect(log).toMatch(/主窗口|设置窗口|内置浏览器/)
  })

  test('K2 未处理的 Promise 拒绝 ⇒ 进得了日志，且原因不是 Error 也认', async () => {
    await h.page.evaluate((mark) => {
      // 刻意用**非 Error** 的拒绝原因：`Promise.reject({code:'X'})` 合法，
      // 那种载荷如果直接 JSON.stringify 或直接取 .message，落盘的就是 "[object Object]" 或空
      setTimeout(() => {
        void Promise.reject({ code: mark, why: '对象形状的拒绝原因' })
      }, 0)
    }, MARK)

    await expect
      .poll(() => appLog(h.dataDir).includes(MARK), { timeout: 20_000, message: 'app.log 里没等到对象形状的拒绝原因' })
      .toBe(true)
    expect(appLog(h.dataDir)).toContain('渲染进程未处理的 Promise 拒绝')
    // 反向：不能是 "[object Object]"（那是"记了但没用"）
    expect(appLog(h.dataDir)).not.toContain('[object Object]')
  })

  test('K3 渲染层 console.error ⇒ 进得了日志（抓"有人打了日志但没人看"那一档）', async () => {
    await h.page.evaluate((mark) => {
      setTimeout(() => console.error(`${mark}: 渲染层自己打的 error`), 0)
    }, MARK)
    await expect
      .poll(() => appLog(h.dataDir).includes(MARK), { timeout: 20_000, message: 'app.log 里没等到 console.error' })
      .toBe(true)
    expect(appLog(h.dataDir)).toContain('渲染层 console.error')
  })

  test('K4 ★ 反向：console.log（info 档）不进日志 —— 用户正文最可能出现在那里', async () => {
    // 这条是**取舍的判据**，不是"功能"：全收会把 app.log 变成应用自己的输出流水，
    // 还会把用户消息正文写进日志文件（K48 的 828 条重复 WARN 教训：记录手段本身不能是故障放大器）。
    await h.page.evaluate((mark) => {
      setTimeout(() => console.log(`${mark}: 渲染层的普通输出`), 0)
    }, MARK)
    // ���反的是"不该进" ⇒ 必须**等够时间**再断言没进（立刻断言会假绿）
    await h.page.waitForTimeout(3000)
    expect(appLog(h.dataDir), 'info 档被收进 app.log 了 ⇒ 隐私与刷屏两头都开口子').not.toContain(MARK)
  })
})
