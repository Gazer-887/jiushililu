// e2e 启动器（plan48 S0）。
//
// **驱动真入口 `out/main/index.js`，不自造窗口**：`verify-shot.cjs` 是隔离验证进程
// （自建窗口 + 自建 IPC 桩，不加载 src/main），它的 `sandbox` 曾经和真机不一致过（plan8 R6附④）。
// 走真入口，webPreferences 就只有一份定义，"验证环境≠生产环境"这类失真结构上不可能再发生。
//
// ⚠️ 前置：必须先 `npm run build`（渲染层由主进程 `loadFile` 指向 out/，没有 dev server 兜底）。

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '../..')
const MAIN_ENTRY = join(REPO_ROOT, 'out/main/index.js')

/** `require('electron')` 在本机 CJS 工程里直接返回 Electron 可执行文件路径 */
const ELECTRON_BINARY = require('electron') as string

export interface E2EApp {
  app: ElectronApplication
  /** 主窗口（按身份挑出来的，不是"第一个窗口"） */
  page: Page
  /** 本次专用的隔离 userData（临时目录，close 时删） */
  dataDir: string
  /** 本次专用的隔离工作区：Agent 真写文件也只落这里，绝不碰用户仓库 */
  workspaceDir: string
  close: () => Promise<void>
}

/**
 * 按**身份**取主窗口，不用 `firstWindow()`。
 *
 * 实测 `firstWindow()` 交回来的窗口有时不是主窗（真应用主窗以 `show:false` 创建，
 * 期间还有别的窗口在生成），于是"等 `window.api`"能 30s 不满足，而同一轮另一条用例
 * 调 `window.api` 却成功 —— 说明拿在手里的是另一个窗口。
 * 认窗口要三样齐：React 挂上了 + 桥上的方法真存在 + 等得到为止（超时抛错并交代见过谁）。
 */
async function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 60_000
  let lastSeen = '一个窗口都没有'
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      const ready = await w
        .waitForFunction(
          () =>
            !!document.getElementById('root')?.childElementCount &&
            typeof (window as unknown as { api?: { getWorkspace?: unknown } }).api?.getWorkspace ===
              'function',
          null,
          { timeout: 1500 }
        )
        .then(() => true)
        .catch(() => false)
      if (ready) return w
      lastSeen = `${w.url()} —— 未挂载或桥未就绪`
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`等不到就绪的主窗口；最后见到的窗口：${lastSeen}`)
}

/**
 * 起一个**完全隔离**的应用实例。
 *
 * 隔离靠两件事，缺一不可：
 * - `JSL_DATA_DIR`：数据目录引导（plan10）认这个环境变量，会话/设置/检查点全落临时目录；
 *   同时**绕开单实例锁**（锁按 userData 生效），所以能在用户自己的实例开着时并行跑。
 * - `workspace.json` 预置 `workspaceRoot`：工作区钉在临时目录（目录选择器是系统对话框，测不了）。
 */
export async function launchApp(): Promise<E2EApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'jsl-e2e-data-'))
  const workspaceDir = mkdtempSync(join(tmpdir(), 'jsl-e2e-ws-'))
  writeFileSync(join(dataDir, 'workspace.json'), JSON.stringify({ workspaceRoot: workspaceDir }), 'utf8')

  const app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    timeout: 90_000,
    env: {
      ...process.env,
      JSL_DATA_DIR: dataDir,
      // 主进程 console 落到 stderr，起不来时这是唯一线索
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  const page = await waitForMainWindow(app)

  const close = async (): Promise<void> => {
    try {
      await app.close()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }

  return { app, page, dataDir, workspaceDir, close }
}

/**
 * 渲染层桥调用的唯一出口。
 *
 * `window.api` 的类型声明在 `src/renderer/src/env.d.ts`（`declare global`），测试工程读不到它 ——
 * 与其在每个用例里散着写 `as any`，不如在这里收一次口。
 */
export async function apiCall<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([m, a]) =>
      (window as unknown as { api: Record<string, (...x: unknown[]) => unknown> }).api[m](...a) as T,
    [method, args] as [string, unknown[]]
  )
}
