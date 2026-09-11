import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { createAgentContext } from './agent/runner'
import { resolveWorkspaceRoot } from './store/workspace'
import { initLogger, createLogger } from './log'
import { installCrashGuards } from './crash-guard'
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
import { isExternallyOpenable, isInternalUrl } from './url-guard'

// 主进程入口：窗口生命周期 + IPC 注册。Agent 内核将来跑在 worker_threads，不在这里（P1）。

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
  const userDataDir = app.getPath('userData')

  // ① 日志系统（plan8 R2）：先于一切初始化，让后续所有环节都能留痕
  initLogger(join(userDataDir, 'logs'), app.isPackaged ? 'info' : 'debug')
  // ② 异常兜底（plan8 R1）：依赖日志，故紧随其后
  installCrashGuards()
  const log = createLogger('main')
  log.info('应用启动', { version: app.getVersion(), packaged: app.isPackaged })

  // 去掉默认的 File/Edit/View 菜单栏（P0 用不到，界面更干净）
  Menu.setApplicationMenu(null)
  // Agent 运行时上下文：内置定义随打包资源分发；工作区惰性解析（用户可切换，免重启）
  const agentCtx = createAgentContext({
    getWorkspaceRoot: () => resolveWorkspaceRoot(userDataDir).root,
    builtinAgentsDir: app.isPackaged
      ? join(process.resourcesPath, 'agents')
      : join(app.getAppPath(), 'resources/agents'),
    userAgentsDir: join(userDataDir, 'agents'),
    // 检查点（plan8 R4）：Agent 每轮改动前的文件快照存这里，供回滚
    checkpointDir: join(userDataDir, 'checkpoints')
  })
  registerIpcHandlers({ agent: agentCtx, userDataDir })
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
