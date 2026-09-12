import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { createAgentContext } from './agent/runner'
import { resolveWorkspaceRoot } from './store/workspace'
import { initLogger, createLogger } from './log'
import { installCrashGuards } from './crash-guard'
import { createConfirmBridge } from './confirm'
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
import { installPreviewProtocol, registerPreviewScheme } from './preview-protocol'
import { isExternallyOpenable, isInternalUrl } from './url-guard'

// 主进程入口：窗口生命周期 + IPC 注册。Agent 内核将来跑在 worker_threads，不在这里（P1）。

/**
 * **单实例锁**（plan8 R13，2026-09-12 用户定案）——
 *
 * 为什么必须有：两个实例共享同一个数据目录，各自"读旧快照 → 整文件覆盖写"，
 * **后写的把先写的整个抹掉**，而且是静默的（会话就这么少了）。
 * 位置迁移（plan10 C 批）更要靠它：两个进程会**同时判"新目录是空的" → 同时复制**，
 * 正好造出"两边都有、都对不上"的半迁移状态。
 *
 * 三个要点：
 *   ① **锁按数据目录区分** —— `--user-data-dir` 不同的实例**互不影响**。
 *      这一条对本项目很关键：冒烟测试与验证脚本全都跑在 `%TEMP%` 的隔离目录里，
 *      加了锁之后它们照样能跑（否则每次都得先关掉主人的窗口）。
 *   ② 拿不到锁的**第二个实例直接退出**，不是"再开一个窗口"。
 *   ③ 第二个实例启动时把**已有窗口叫到前面** —— 用户的意图是"我要用它"，
 *      结果应该是"它出现在我面前"，而不是"什么都没发生"。
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

/**
 * 安全基线（plan8 R3）：主窗口「只能停在自家页面」。
 *
 * 两条都属 Electron 安全检查清单必做项，此前**都缺失**：
 *   ① setWindowOpenHandler —— markdown 里 `<a target="_blank">` 会弹出**新的 Electron 窗口**
 *      （无地址栏、看似应用内页面）→ 钓鱼风险
 *   ② will-navigate —— 主窗口可被导航到任意网站，**整个应用被替换成外部网页**
 *
 * 处理原则：外部 http(s) 一律交给**系统浏览器**打开；其余协议（file: / javascript: 等）
 * 直接拒绝——把它们交给 openExternal 是危险的。（判定逻辑见 ./url-guard，纯函数可单测）
 *
 * 注意：**内置浏览器面板是独立 WebContents，导航自由，不受本函数约束**。
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
  // 没拿到锁的第二个实例**到这里就停**：`app.quit()` 是异步的，而 ready 回调仍会跑到，
  // 结果是它在退出的路上还初始化了一遍日志与异常兜底 —— 日志里会多出一条「应用启动」，
  // 排查时看着像"开了两次却只有一次运行"。一行守卫换日志干净，值。
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
      win.webContents.send(IPC.confirmRequest, req)
      return true
    },
    log: (message, extra) => log.info(message, extra)
  })

  // 后台任务注册表（plan7 批 D）：**进程级单例** —— 窗口关闭时统一终止，
  // 与危险操作确认桥同一口径（留一堆没人管的进程是隐患）
  const background = createBackgroundTaskStore()

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
  registerIpcHandlers({ agent: agentCtx, userDataDir, confirm })
  // HTML 沙箱预览：把 `jsl-preview://doc/<相对路径>` 映射到工作区文件，
  // 带上断脚本/断网的响应头（真源见 src/shared/html-preview.ts）
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 窗口全关时，把待决的危险操作确认按**拒绝**处理 ——
  // 否则那个 Agent 会一直卡在等待上直到 60s 超时。
  app.on('window-all-closed', () => {
    confirm.abortAll('窗口已全部关闭')
    // 后台命令跟着终止（plan7 批 D 边界①）—— 与确认桥同一口径
    background.killAll()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})