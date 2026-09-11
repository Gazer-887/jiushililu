import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { createAgentContext } from './agent/runner'
import { resolveWorkspaceRoot } from './store/workspace'
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

// 主进程入口：窗口生命周期 + IPC 注册。Agent 内核将来跑在 worker_threads，不在这里（P1）。

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
  // 去掉默认的 File/Edit/View 菜单栏（P0 用不到，界面更干净）
  Menu.setApplicationMenu(null)
  // Agent 运行时上下文：内置定义随打包资源分发；工作区惰性解析（用户可切换，免重启）
  const userDataDir = app.getPath('userData')
  const agentCtx = createAgentContext({
    getWorkspaceRoot: () => resolveWorkspaceRoot(userDataDir).root,
    builtinAgentsDir: app.isPackaged
      ? join(process.resourcesPath, 'agents')
      : join(app.getAppPath(), 'resources/agents'),
    userAgentsDir: join(userDataDir, 'agents')
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
