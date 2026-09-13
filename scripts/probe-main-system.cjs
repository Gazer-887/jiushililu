/**
 * 真组合根探针（plan7 批 F1）—— 证明**真主进程确实调了真 Electron API**。
 *
 * 为什么非有它不可：单测全是替身、`verify-shot.cjs` 全是 IPC 存根，两边都只能证明"界面与逻辑对"，
 * 证明不了"真 API 被调到"。而 `powerSaveBlocker` 的 id 与 `isStarted` 的真值、注册表到底动没动，
 * 只有真 Electron + 真组合根给得出。
 *
 * 用法（**构建之后**跑）：`npm run build && npx electron scripts/probe-main-system.cjs`
 * 做法：① 包一层 `powerSaveBlocker` / `setLoginItemSettings` 记录调用（先自检补丁是否真的生效，
 *      否则"记不到"会被误读成"没调用"）；② `require` **真产物** `out/main/index.js`；
 *      ③ 从渲染端 `window.api.setSystem(...)` 驱动整条真链路（真 store / 真 IPC / 真 preload）。
 *
 * ⚠️ 三条纪律：
 *   1. **阴性对照**：驱动之前记录必须为 0 —— 否则"记到了"可能来自启动时别处，等于自证。
 *   2. **隔离**：跑在 `%TEMP%` 的独立 userData 里，绝不碰用户真实的 settings.json；开发态本就该
 *      拒绝写启动项，探针顺带把这条也端到端验掉。
 *   3. 退出码：任一条不成立即 1（CI 不跑它：需要真 Electron 与桌面环境，它是**实机验收**工具）。
 */

const { app, powerSaveBlocker, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`PROBE ${ok ? 'ok  ' : 'FAIL'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

// ── ① 独立数据目录（必须在 anything else 之前）──
const userData = mkdtempSync(join(tmpdir(), 'jsl-probe-system-'))
app.setPath('userData', userData)

// ── ② 记录器 + **仪表自检**（补丁没生效就必须失败，不许把"记不到"当成"没调用"）──
const calls = { start: [], stop: [], setLoginItem: [], getLoginItem: 0 }
const real = {
  start: powerSaveBlocker.start,
  stop: powerSaveBlocker.stop,
  setLoginItem: app.setLoginItemSettings,
  getLoginItem: app.getLoginItemSettings
}
powerSaveBlocker.start = (type) => {
  const id = real.start.call(powerSaveBlocker, type)
  calls.start.push({ type, id })
  return id
}
powerSaveBlocker.stop = (id) => {
  calls.stop.push(id)
  return real.stop.call(powerSaveBlocker, id)
}
app.setLoginItemSettings = (settings) => {
  calls.setLoginItem.push({ ...settings })
  return real.setLoginItem.call(app, settings)
}
app.getLoginItemSettings = () => {
  calls.getLoginItem += 1
  return real.getLoginItem.call(app)
}
const instrumentOk =
  powerSaveBlocker.start !== real.start &&
  powerSaveBlocker.stop !== real.stop &&
  app.setLoginItemSettings !== real.setLoginItem &&
  app.getLoginItemSettings !== real.getLoginItem
check('仪表自检：四个真 API 都被成功包住（没包住的话后面的记录全不可信）', instrumentOk)
if (!instrumentOk) {
  console.log('PROBE_ABORT 仪表没包住 —— 记录不可信，直接失败（不许把"记不到"当成"没调用"）')
  process.exit(1)
}

/** 系统层的外部证据：注册表 Run 键（非提权可读）。这是"没写自启项"的独立证据，不是自证 */
function runKeySnapshot() {
  if (process.platform !== 'win32') return null
  try {
    return execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], {
      encoding: 'utf8'
    })
  } catch {
    return null
  }
}

const runKeyBefore = runKeySnapshot()
check('阴性对照基线的外部证据可用（HKCU Run 键可读，非提权）', runKeyBefore !== null || process.platform !== 'win32')

require(join(__dirname, '..', 'out', 'main', 'index.js'))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForApi() {
  for (let i = 0; i < 60; i += 1) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
      try {
        const kind = await win.webContents.executeJavaScript('typeof window.api')
        if (kind === 'object') return win
      } catch {
        // 渲染端还没就绪：继续等
      }
    }
    await wait(250)
  }
  return null
}

let primed = false
async function run() {
  const win = await waitForApi()
  check('真组合根起来了，真 preload 暴露了 window.api', win !== null)
  if (!win) return

  // ── ③ 阴性对照：还没驱动时，真 API 一次都不该被调过 ──
  check(
    '阴性对照：驱动之前**零次** start（落盘默认是关，启动时不该按着系统不休眠）',
    calls.start.length === 0,
    { starts: calls.start }
  )

  // ── ④ 打开「锁屏与熄屏后继续运行」：真主进程 → 真 blocker ──
  const on = await win.webContents.executeJavaScript(
    "window.api.setSystem({ keepRunning: true })"
  )
  const started = calls.start[0]
  check('真 `powerSaveBlocker.start` 被调到，且用的是 prevent-app-suspension（不是屏幕常亮那档）',
    calls.start.length === 1 && started.type === 'prevent-app-suspension', { calls: calls.start })
  check('返回的视图来自真主进程：意图为开、且报告"生效"', on.keepRunning === true && on.keepRunningActive === true, on)
  check('真 `isStarted(id)` 为真（id 就是真 Electron 给的那个，首个 id 为 0 也认）',
    started !== undefined && powerSaveBlocker.isStarted(started.id), { id: started && started.id })
  check('视图字段完整（8 项，不是被存根/旧契约截断的形状）', Object.keys(on).length === 8, Object.keys(on))

  // 落盘证据：真 store（electron-store）写进了隔离目录里的 settings.json
  const file = join(userData, 'settings.json')
  await wait(300)
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  check('意图真的落盘了（真 settings.json 里 keepRunning=true）', stored !== null && stored.keepRunning === true, stored)

  // ── ⑤ 关掉：真 stop + 真释放 ──
  const off = await win.webContents.executeJavaScript(
    "window.api.setSystem({ keepRunning: false })"
  )
  check('真 `powerSaveBlocker.stop` 被调到，且 id 是 start 给的那个', calls.stop.includes(started.id), { stops: calls.stop })
  check('真 `isStarted(id)` 变假、视图报告未生效', !powerSaveBlocker.isStarted(started.id) && off.keepRunningActive === false, off)

  // ── ⑥ 开发态开机自启：端到端必须被拒（绝不能写出指向 electron.exe 的启动项）──
  const login = await win.webContents.executeJavaScript(
    "window.api.setSystem({ openAtLogin: true })"
  )
  const runKeyAfter = runKeySnapshot()
  check('开发态下**真 `setLoginItemSettings` 一次都没被调**（不是"调了但没成功"）',
    calls.setLoginItem.length === 0, { calls: calls.setLoginItem })
  check('注册表 HKCU Run 键前后**逐字一致**（外部证据，不是自证）',
    runKeyBefore === null || runKeyBefore === runKeyAfter)
  check('界面拿到的答案诚实：不支持 + 给出原因 + 值仍为关',
    login.openAtLoginSupported === false && login.openAtLogin === false && Boolean(login.openAtLoginReason),
    { supported: login.openAtLoginSupported, reason: login.openAtLoginReason })
  check('开发态下**读也没读**（不支持的平台不该碰登录项 API —— 读写两条路一起拦住）',
    calls.getLoginItem === 0, { getLoginItem: calls.getLoginItem })
  // 单测里 `executableWillLaunchAtLogin` 这个字段名不是猜的：拿真机的返回核对一遍
  // （用 real 调用，不污染记录器 —— 否则上面那条"读也没读"就被自己破坏了）
  const realLogin = real.getLoginItem.call(app)
  check('真机 `getLoginItemSettings()` 的确返回 `executableWillLaunchAtLogin`（"被系统停用"只有它看得见）',
    typeof realLogin.executableWillLaunchAtLogin === 'boolean', {
      keys: Object.keys(realLogin),
      willLaunch: realLogin.executableWillLaunchAtLogin
    })

  // ── ⑦ 再开一次，然后退出：`dispose` 必须把 blocker 收掉 ──
  await win.webContents.executeJavaScript("window.api.setSystem({ keepRunning: true })")
  const second = calls.start[calls.start.length - 1]
  app.on('will-quit', () => {
    check('退出时 `dispose()` 收掉了 blocker（teardownAll 真跑到了，不是只有源码里的字符串）',
      calls.stop.includes(second.id), { stops: calls.stop })
    const failed = results.filter((r) => !r.ok)
    console.log(`PROBE_DONE checks=${results.length} failed=${failed.length}`)
    primed = true
    process.exit(failed.length === 0 ? 0 : 1)
  })
  // 兜底：真机上万一 flush 流程没回执，别把探针挂死
  setTimeout(() => {
    if (primed) return
    const failed = results.filter((r) => !r.ok)
    console.log(`PROBE_TIMEOUT checks=${results.length} failed=${failed.length}`)
    process.exit(failed.length === 0 ? 0 : 1)
  }, 8000).unref()
  app.quit()
}

app.whenReady().then(() =>
  run().catch((err) => {
    check(`探针自身异常：${err instanceof Error ? err.message : String(err)}`, false)
    const failed = results.filter((r) => !r.ok)
    console.log(`PROBE_DONE checks=${results.length} failed=${failed.length}`)
    process.exit(1)
  })
)
