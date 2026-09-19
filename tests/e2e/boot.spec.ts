// R6 可行性主干（plan48 S0）：先把"e2e 到底跑得通吗"变成**有数据的结论**，再往上盖用例
// —— plan8 里那句"headless 可行性待评估"挂了很久，一直没被实测过。
//
// 四条都**不打真实模型**（不花钱、不依赖网络、不受厂商可用性影响）。
// 需要 Key 的"发消息"链属 S1，且要先解决 CI 上 safeStorage 是否可用 —— 第 4 条就是去量这件事。

import { expect, test } from '@playwright/test'
import { apiCall, launchApp, type E2EApp } from './helpers'

test.describe('e2e 可行性主干', () => {
  let h: E2EApp

  test.beforeEach(async () => {
    h = await launchApp()
  })

  test.afterEach(async () => {
    await h?.close()
    await h?.cleanup()
  })

  test('真入口能起：渲染层挂载、数据与工作区都落在隔离沙箱', async () => {
    // 挂载哨兵用**结构类名**而非文案：文案会改，改了不该把 e2e 一起带红
    await h.page.waitForSelector('.chat-view, .new-task', { timeout: 45_000 })
    const mounted = await h.page.evaluate(() => ({
      hasRoot: !!document.getElementById('root'),
      rootHasChild: (document.getElementById('root')?.childElementCount ?? 0) > 0
    }))
    expect(mounted.hasRoot, '渲染根节点应在').toBe(true)
    expect(mounted.rootHasChild, '根节点下应挂出内容').toBe(true)

    // 隔离是否真生效：工作区必须就是我们给的临时目录（否则用例会写进用户的真实仓库）
    const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
    expect(ws.path.replace(/\\/g, '/')).toContain('jsl-e2e-ws-')
  })

  test('安全姿态没被验证环境偷偷放宽（plan8 R6附④）', async () => {
    const posture = await h.page.evaluate(() => ({
      // sandbox:true + nodeIntegration:false 时，渲染层拿不到这两个
      hasProcess: typeof (globalThis as Record<string, unknown>).process !== 'undefined',
      hasRequire: typeof (globalThis as Record<string, unknown>).require !== 'undefined'
    }))
    expect(posture.hasProcess, '渲染进程不该拿到 process（sandbox 被放宽了）').toBe(false)
    expect(posture.hasRequire, '渲染进程不该拿到 require').toBe(false)

    // ⚠️ 桥通不通**不能用 `Object.keys(window.api).length` 判**：contextBridge 给的是代理对象，
    //    实测枚举结果在 0 与真实条数之间飘（同一判据一次绿一次红）。只有"真调一次拿到值"才算证据。
    const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
    expect(typeof ws.path, '桥应能真调到值').toBe('string')
  })

  test('IPC 真往返 + 多窗口登记在真入口下都通', async () => {
    const prefs = await apiCall<Record<string, unknown>>(h.page, 'getUIPrefs')
    expect(prefs, 'getUIPrefs 应有返回').toBeTruthy()
    expect(typeof prefs).toBe('object')

    // ⚠️ 判据只能是**窗口数**：真 handler 是 `() => { deps.openSettingsWindow?.() }`，无返回值。
    //    verify-shot 的桩却返回 `{ok:true}` —— 桩与真契约已分叉，这正是"驱动真入口"才照得出来的东西。
    //
    // ⚠️ `app.evaluate` 的入参：实测（Playwright 1.63）注入的是**electron 模块本体**
    //    （顶层直接是 app / BrowserWindow / safeStorage…），**不是**其类型声明示例写的 `{app, electron}`。
    //    照文档写会静默拿到 undefined，所以这里按实测形状解构。
    const before = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    await apiCall(h.page, 'openSettingsWindow')
    await h.page.waitForTimeout(1500)
    const after = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(after, '开设置窗后窗口数应 +1').toBeGreaterThan(before)

    // 设置窗不许最小化/最大化（09-19 用户裁决：点「-」后任务栏缩略页签会挡在左下角）。
    // ⚠️ 这条**只有真入口测得到**：verify-shot 是自建窗口 + 自建桩，压根不加载这段主进程代码，
    //    窗口标志写错它也照样绿 —— 正是 e2e 相对桩式验证的增量价值。
    // ⚠️ 找窗口按 **URL 的 `#/settings`** 认，不按 `getTitle()`：页面 `<title>` 会覆盖
    //    BrowserWindow 的 `title` 选项（实测设置窗标题栏显示的是「九十里路」），
    //    拿标题找等于拿一个会被运行时改写的字段找身份。
    const flags = await h.app.evaluate(({ BrowserWindow }) => {
      const s = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings'))
      return s
        ? { found: true, title: s.getTitle(), minimizable: s.isMinimizable(), maximizable: s.isMaximizable() }
        : { found: false, title: null, minimizable: null, maximizable: null }
    })
    expect(flags.found, '应能找到 URL 带 settings 的窗口').toBe(true)
    // 标题必须是「设置」：index.html 的 `<title>九十里路</title>` 会覆盖 BrowserWindow 的 title，
    // 两窗同名会让人在任务栏里认不出哪个是设置窗（09-19 e2e 实测到的，不是推测）。跨平台都成立。
    expect(flags.title, '设置窗标题不该被文档 title 顶掉').toBe('设置')

    /**
     * ⚠️ `minimizable` / `maximizable` 是**平台限定**选项：只在 Windows 与 macOS 生效，
     * Linux(X11) 由窗口管理器决定、Electron 直接忽略 —— CI 实测 `isMinimizable()` 在
     * ubuntu runner 上仍返回 true。把它写成跨平台断言，就是拿一个不存在的要求去判红 CI。
     * 本项目的 dist 目标也只有 Windows（`electron-builder --win`），所以这里按平台收窄，
     * 且 Linux 分支**必须打日志说明跳过了什么**（静默跳过与静默绿同一种坏）。
     */
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(flags.minimizable, '设置窗不该可最小化').toBe(false)
      expect(flags.maximizable, '设置窗不该可最大化').toBe(false)
    } else {
      console.log(`SETTINGS_WIN_FLAGS_SKIPPED=${JSON.stringify({ platform: process.platform, reason: 'minimizable/maximizable 仅 Windows/macOS 生效，Linux 由 WM 决定' })}`)
    }
    console.log('SETTINGS_WIN_FLAGS=' + JSON.stringify(flags))
  })

  test('量出平台事实：这台机器的加密存储决定"发消息"链能不能进 CI', async () => {
    const facts = await h.app.evaluate(({ app, safeStorage }) => ({
      platform: process.platform,
      // Key 只走 safeStorage 加密落盘（D-013 红线，**不许为测试开明文后门**）。
      // 该值为 false 的平台，发消息链用例必须显式 skip 并说明原因，而不是悄悄红着。
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      appName: app.getName()
    }))
    console.log('E2E_ENV=' + JSON.stringify(facts))
    expect(typeof facts.encryptionAvailable).toBe('boolean')
  })
})
