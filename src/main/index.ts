import { app, BrowserWindow, Menu, powerSaveBlocker, shell } from 'electron'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { registerIpcHandlers } from './ipc'
import { createAgentContext } from './agent/runner'
import { resolveWorkspaceRoot } from './store/workspace'
import { initLogger, createLogger } from './log'
import { installCrashGuards } from './crash-guard'
import { createConfirmBridge } from './confirm'
import { createAskBridge } from './ask'
import { IPC } from '@shared/ipc'
import {
  browserClick,
  browserCurrentUrl,
  browserNavigate,
  browserReadPage,
  browserType,
  initBrowser,
  setBrowserStateListener
} from './browser'
import { setBrowserAdapter } from './agent/browser-bridge'
import { createBackgroundTaskStore } from './agent/background-tasks'
import { createTerminalSessionStore, type PtyModuleLike } from './terminal-session'
import { createSystemIntegration } from './system-integration'
import { getPermissionPreset, getSystemSettings, setSystemSettings } from './store/settings'
import { installPreviewProtocol, registerPreviewScheme } from './preview-protocol'
import { createChatEmitter } from './chat-emitter'
import { isExternallyOpenable, isInternalUrl } from './url-guard'

// 主进程入口：窗口生命周期 + IPC 注册（Agent 内核跑在 worker_threads，不在这里）。

/**
 * **单实例锁**（plan8 R13，2026-09-12 用户定案）。
 *
 * 两个实例共享同一数据目录，"读旧快照 → 整文件覆盖写"会让**后写的把先写的整个抹掉**（静默丢会话）；
 * 位置迁移时还会两个进程**同时判"新目录是空的" → 同时复制**，造出半迁移状态。
 *
 * ① 锁按数据目录区分 —— `--user-data-dir` 不同的实例**互不影响**：冒烟测试与验证脚本都跑在
 *    `%TEMP%` 隔离目录里，加了锁照样能跑（否则每次都得先关掉主人的窗口）；② 拿不到锁的第二个
 *    实例**直接退出**（不是"再开一个窗口"）；③ 第二个实例启动时把**已有窗口叫到前面**（用户意图是"我要用它"）。
 */
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 已有实例在跑：本进程什么也不做，安静退出（不是崩溃，所以不打 ERROR）
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

// HTML 预览协议：**必须赶在 ready 之前**注册（迟了就只是个普通死链）
registerPreviewScheme()

/** 提问归属哨兵：`AskRequest.conversationId` 是可选字段（桥是通用的），但**绝不留空** ——
 *  空值查不出"这条问题是谁问的"（同 `ipc.ts` 的 `UI_RUN_OWNER` 口径）。 */
const ASK_OWNER_UNKNOWN = 'unknown'

/**
 * 安全基线（plan8 R3）：主窗口「只能停在自家页面」—— 两条 Electron 安全检查清单必做项，此前都缺失。
 * ① `setWindowOpenHandler`：markdown 里 `<a target="_blank">` 会弹出**无地址栏的新 Electron 窗口**（钓鱼风险）；
 * ② `will-navigate`：主窗口可被导航到任意网站，**整个应用被替换成外部网页**。
 * 外部 http(s) 一律交给**系统浏览器**，其余协议（file: / javascript: 等）直接拒绝 —— 交给 openExternal 是危险的。
 * ⚠️ **内置浏览器面板是独立 WebContents，导航自由，不受本函数约束**。
 */
function applyNavigationGuards(win: BrowserWindow): void {
  const log = createLogger('security')
  const devURL = process.env['ELECTRON_RENDERER_URL']

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url)
    } else {
      log.warn('拒绝打开非 http(s) 外部链接', { url })
    }
    return { action: 'deny' } // 绝不新建 Electron 窗口
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url, devURL)) return
    event.preventDefault()
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url)
    } else {
      log.warn('拦截非法导航', { url })
    }
  })
}

/**
 * 关窗口前先让渲染端把会话落盘（plan11 P0-2）。
 *
 * 内容在**渲染端**（主进程只有流式增量），而 `conv:save` 是异步 IPC —— 窗口一关，渲染进程连同
 * 未落盘的内容一起没了；并发之后**后台会话根本没人存**（整轮白跑、用户完全不知道）。
 * 做法：拦下第一次 `close` → 请渲染端 flush 全部 → 回执 → 才真关。
 * ⚠️ **必须带超时兜底**：渲染端卡死时窗口不能关不掉（"点叉没反应"比丢一次内容更糟，用户会开始强杀进程）。
 */
const FLUSH_TIMEOUT_MS = 2000

/** 当前窗口的"落盘完成 → 真关"回调；由 createWindow 装上，IPC 层回调它 */
let finishClose: (() => void) | null = null

function installFlushBeforeClose(win: BrowserWindow): void {
  const log = createLogger('main')
  let flushed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const closeNow = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    flushed = true
    finishClose = null
    if (!win.isDestroyed()) win.close()
  }

  finishClose = closeNow

  win.on('close', (event) => {
    if (flushed || win.webContents.isDestroyed()) return
    event.preventDefault()
    try {
      win.webContents.send(IPC.flushRequest)
    } catch {
      // 发不出去（窗口正在销毁）→ 直接放行，别把关闭卡死
      flushed = true
      return
    }
    timer = setTimeout(() => {
      log.warn('落盘回执超时，照关窗口（渲染端可能已卡死）', { timeoutMs: FLUSH_TIMEOUT_MS })
      closeNow()
    }, FLUSH_TIMEOUT_MS)
  })

  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    finishClose = null
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '九十里路',
    show: false,
    // dev 态取项目内 resources/；打包态图标经 extraResources 落在 resources/ 根（asar 外）
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(app.getAppPath(), 'resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  applyNavigationGuards(win)
  installFlushBeforeClose(win)

  win.on('ready-to-show', () => win.show())

  // electron-vite 约定：开发态注入 ELECTRON_RENDERER_URL，生产态加载构建产物
  const devURL = process.env['ELECTRON_RENDERER_URL']
  if (devURL) {
    void win.loadURL(devURL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 没拿到锁的第二个实例**到这里就停**：`app.quit()` 是异步的、ready 回调仍会跑到，否则它在退出的
  // 路上还会初始化一遍日志与异常兜底 —— 日志里多出一条「应用启动」，看着像"开了两次却只跑了一次"。
  if (!gotTheLock) return

  const userDataDir = app.getPath('userData')

  // ① 日志系统（plan8 R2）：先于一切初始化，让后续所有环节都能留痕
  initLogger(join(userDataDir, 'logs'), app.isPackaged ? 'info' : 'debug')
  // ② 异常兜底（plan8 R1）：依赖日志，故紧随其后
  installCrashGuards()
  const log = createLogger('main')
  log.info('应用启动', { version: app.getVersion(), packaged: app.isPackaged })

  // 去掉默认的 File/Edit/View 菜单栏（P0 用不到，界面更干净）
  Menu.setApplicationMenu(null)

  // 危险操作确认桥（plan8 R5）：推到当前窗口问用户。
  // 注意用**惰性取窗口**（调用时才查），因为桥是在 createWindow 之前建的。
  const confirm = createConfirmBridge({
    send: (req) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) return false
      // 走同一发送口（plan11 §2.5）：确认请求也带会话身份 —— 否则并发时用户会批了另一条会话的命令
      createChatEmitter(win.webContents, req.conversationId).confirm(req)
      return true
    },
    log: (message, extra) => log.info(message, extra)
  })

  // 后台任务注册表（plan7 批 D）：**进程级单例** —— 窗口关闭时统一终止，留一堆没人管的进程是隐患
  const background = createBackgroundTaskStore()

  // ── 系统集成（plan7 批 F1）：锁屏/熄屏后继续运行 + 开机自启 ──────
  //
  // 依赖全部注入（连 store 也是）：`system-integration.ts` **不 import electron** ——
  // 架构守卫禁止单测 import 图里出现 electron / electron-store，注入才让它进得了单测链路。
  //
  // ⚠️ 启动项要写的是**用户手里那个可执行文件**：portable 版每次运行解压到不同的临时目录，
  //    写 `process.execPath` 会得到一个下次开机根本不存在的路径（electron-builder 为 portable 注入了
  //    `PORTABLE_EXECUTABLE_FILE`，指向用户解压/存放的那个 .exe）。
  const systemExecPath = process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.execPath
  const system = createSystemIntegration({
    packaged: app.isPackaged,
    platform: process.platform,
    execPath: systemExecPath,
    powerSaveBlocker,
    loginItem: {
      set: (input) => app.setLoginItemSettings(input),
      // ⚠️ 读也要传同一个 path：Electron 只在 set/get 参数一致时才认得出那条启动项
      get: (input) => app.getLoginItemSettings(input)
    },
    store: { read: getSystemSettings, write: setSystemSettings },
    log: (message, extra) => log.info(message, extra)
  })
  // 重启后仍生效靠这一步：blocker 是**进程级**的，进程没了就没了，每次启动都要按落盘意图重新起
  const systemAtStart = system.applyStored()
  // 记录 execPath：portable 版自启项指向哪儿，只有日志能事后查（也是安装版验收的一条证据）
  log.info('系统集成已就绪', {
    packaged: app.isPackaged,
    execPath: systemExecPath,
    keepRunning: systemAtStart.keepRunning,
    keepRunningActive: systemAtStart.keepRunningActive,
    openAtLogin: systemAtStart.openAtLogin,
    openAtLoginSupported: systemAtStart.openAtLoginSupported
  })

  // Agent 提问桥（带选项）：与确认桥同样是"惰性取窗口"。
  // ⚠️ 推送走**所有窗口**（同后台任务 / 终端的广播写法），不是 `getAllWindows()[0]`：只推第一个窗口的话，
  //    用户关窗重开（macOS activate）那条问题就没人看得见 —— 而桥还在等答复，白等到超时。
  const ask = createAskBridge({
    send: (req) => {
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      if (wins.length === 0) return false
      for (const w of wins) {
        createChatEmitter(w.webContents, req.conversationId ?? ASK_OWNER_UNKNOWN).ask(req)
      }
      return true
    },
    log: (message, extra) => log.info(message, extra)
  })

  // Agent 运行时上下文：内置定义随打包资源分发；工作区惰性解析（用户可切换，免重启）
  const agentCtx = createAgentContext({
    getWorkspaceRoot: () => resolveWorkspaceRoot(userDataDir).root,
    builtinAgentsDir: app.isPackaged
      ? join(process.resourcesPath, 'agents')
      : join(app.getAppPath(), 'resources/agents'),
    userAgentsDir: join(userDataDir, 'agents'),
    // 检查点（plan8 R4）：Agent 每轮改动前的文件快照存这里，供回滚
    checkpointDir: join(userDataDir, 'checkpoints'),
    // 危险操作确认（plan8 R5）：run_command 执行前问用户
    confirmCommand: (req) => confirm.ask(req),
    // 提问口（ask_user）：注入的是**桥本体**（只用到 ask 一个方法）—— runner 不许 import electron，故由组合根注入
    ask,
    background,
    // 回收站（plan7 批 A2）：界面与 Agent 的删除都走它（非硬删）
    trash: (abs) => shell.trashItem(abs)
  })

  // 后台任务状态变化 → 推给所有窗口（右栏「任务」页签据此刷新）
  background.onChange(() => {
    const list = background.list()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.bgChanged, list)
    }
  })

  // ── 内置终端（plan7 批 C）────────────────────────────────────
  //
  // 会话在组合根建、不建在 `ipc.ts` 里：**广播代码必须在这一层** —— `ipc.ts` 里一个裸 `.send(` 都不许有
  // （`tests/unit/stream-envelope.test.ts` 有守卫；那条守卫守的是一次真实事故：绕开唯一发送口就会漏带会话身份、界面串台）。
  // ⚠️ `node-pty` 是**原生模块**：**延迟到第一次真开终端时才 require** —— 这样它加载失败的结果是
  //    "终端开不起来（会话层变成 spawn-failed）"，而**不是整个应用起不来**。
  let ptyModule: PtyModuleLike | null = null
  const cjsRequire = createRequire(__filename)
  const loadPty = (): PtyModuleLike => {
    if (!ptyModule) {
      // 用 createRequire 而不是 `require(...)`：主进程产物是 CJS，而 eslint 禁了裸 require。
      // ⚠️ **不能**提到顶层：顶层加载会让"原生模块坏了"从"终端不可用"升级成"应用起不来"。
      ptyModule = cjsRequire('node-pty') as PtyModuleLike
    }
    return ptyModule
  }

  const terminal = createTerminalSessionStore({
    getPermission: getPermissionPreset,
    getWorkspaceRoot: () => agentCtx.getWorkspaceRoot(),
    pty: { spawn: (file, args, opts) => loadPty().spawn(file, args, opts) }
  })

  // 终端输出 → 推给所有窗口（**进程级**通道，不带会话信封；理由见 shared/ipc.ts 那段注释）
  terminal.onData((sessionId, chunk) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send(IPC.terminalData, { sessionId, seq: chunk.seq, data: chunk.data })
      }
    }
  })
  terminal.onState((sessionId) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.terminalState, sessionId)
    }
  })

  registerIpcHandlers({
    agent: agentCtx,
    userDataDir,
    confirm,
    ask,
    terminal,
    system,
    // 渲染端回执"落盘完成" → 才真关窗口（plan11 P0-2）
    onFlushDone: () => finishClose?.()
  })
  // HTML 沙箱预览：`jsl-preview://doc/<相对路径>` → 工作区文件，带断脚本/断网响应头（真源见 src/shared/html-preview.ts）
  installPreviewProtocol(() => agentCtx.getWorkspaceRoot())
  createWindow()

  // 内置浏览器：真 Chromium 视图，用户与 Agent 共用同一实例
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    initBrowser(win)
    // 状态变化推给所有窗口（地址栏/标题/前进后退可用性）
    setBrowserStateListener((state) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('browser:changed', state)
      }
    })
    // 把真实实现注入 agent 层的浏览器接缝（那边不 import electron）
    setBrowserAdapter({
      currentUrl: browserCurrentUrl,
      navigate: async (url) => {
        const s = await browserNavigate(url)
        return { url: s.url, title: s.title }
      },
      readPage: browserReadPage,
      click: browserClick,
      type: browserType
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      // macOS 关窗即 `teardownAll`（cookie：两个入口都调它）→ blocker 被收掉；窗口重建时按落盘意图重新应用，
      // 否则"设置里开着、实际没生效"。`applyStored` 幂等，window 已存在时不会走到这里。
      system.applyStored()
    }
  })

  // 窗口全关时，把待决的危险操作确认按**拒绝**处理 —— 否则那个 Agent 会一直卡在等待上直到超时。
  // ⚠️ 收尾清单**只有这一处实现**，`before-quit` 与 `window-all-closed` 两个入口都调它。
  //    为什么两个都要挂：Electron 文档写得很死 —— 用户按 **Cmd+Q** 或代码调 `app.quit()` 时
  //    **不会**触发 `window-all-closed`（它先关窗口、直接进 `will-quit`）；只挂一个入口，macOS 上每次退出都留个没人管的 shell。
  const teardownAll = (): void => {
    confirm.abortAll('窗口已全部关闭')
    // 提问同理 —— 没人能作答了，按未作答结束，而不是让那条 Agent 干等满 5 分钟
    ask.abortAll('窗口已全部关闭')
    // 后台命令跟着终止（plan7 批 D 边界①）—— 与确认桥同一口径
    background.killAll()
    // 终端会话同理：**不留没人管的 shell**（它可能正跑着 dev server / 数据库）。
    terminal.killAll()
    // 系统请求也要收（不清掉的话退出瞬间系统仍被我们按着不休眠）。它**只收系统请求、不改用户的落盘选择**
    system.dispose()
  }

  app.on('window-all-closed', teardownAll)
  app.on('before-quit', teardownAll)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})