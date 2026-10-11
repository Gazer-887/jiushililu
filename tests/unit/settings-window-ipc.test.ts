// 设置窗口 IPC：settingsCloseWindow 只能关「设置窗口本人」（2026-10-11 交付链批 II）。
// 背景：预置桥（window.api）在任何渲染进程可达 —— 实机测验发现从主窗口调
// closeSettingsWindow 会把主窗一起关掉、应用退出。根因在 ipc.ts 的 handler
// 假设「发起方必是设置窗口」。这里用 mock electron + 真 registerIpcHandlers +
// 真 window-registry 接缝钉住：① 非设置窗口发起 → 任何窗口都不得被关；
// ② 设置窗口本人发起 → 设置窗口被关（守卫不许把功能也废掉）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  settings: {} as Record<string, unknown>,
  byWebContents: new Map<unknown, FakeWin>(),
  liveWins: [] as FakeWin[]
}))

interface FakeWin {
  webContents: { id: number }
  close: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  on: ReturnType<typeof vi.fn>
  _destroy: () => void
}

function mkWin(): FakeWin {
  let destroyed = false
  const win: FakeWin = {
    webContents: { id: Math.floor(Math.random() * 1e9) },
    close: vi.fn(),
    isDestroyed: () => destroyed,
    on: vi.fn(),
    _destroy: () => {
      destroyed = true
    }
  }
  fixture.liveWins.push(win)
  fixture.byWebContents.set(win.webContents, win)
  return win
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (key: string, fn: (event: unknown, payload: unknown) => unknown) =>
      fixture.handlers.set(key, fn)
  },
  dialog: {},
  BrowserWindow: {
    getAllWindows: () => [...fixture.byWebContents.values()],
    fromWebContents: (wc: unknown) => fixture.byWebContents.get(wc) ?? null
  },
  shell: {},
  clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({ default: class {
  get store(): Record<string, unknown> { return fixture.settings }
  get(key: string): unknown { return fixture.settings[key] }
  set(key: string, value: unknown): void { fixture.settings[key] = value }
} }))

const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { registerWindow } = await import('@main/window-registry')

beforeEach(() => {
  // 上个用例登记的假窗全部标销毁（registry 的 getWindow 跳过销毁件，防跨用例串味）
  for (const w of fixture.liveWins) w._destroy()
  fixture.liveWins.length = 0
  fixture.byWebContents.clear()
  fixture.settings = { memoryEnabled: true }
  fixture.handlers.clear()
})
afterEach(() => {
  for (const w of fixture.liveWins) w._destroy()
})

function setup(): { handler: (e: unknown, p: unknown) => unknown } {
  registerIpcHandlers({
    userDataDir: 'C:/tmp/jsl-settings-win-test', memory: {} as never, playbook: {} as never,
    agent: { getWorkspaceRoot: () => 'C:/tmp/jsl-settings-win-test', builtinAgentsDir: 'C:/tmp/jsl-settings-win-test/b', userAgentsDir: 'C:/tmp/jsl-settings-win-test/a', checkpoints: {} } as never,
    trash: async () => {}, confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: { ask: async () => ({ answered: false as const, reason: 'no-window' as const }), respond: () => false, abortAll: () => {} },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {} as never, system: { getBlockers: () => [] } as never,
    execEventSink: { record: () => {} } as never, network: {} as never
  })
  const handler = fixture.handlers.get(IPC.settingsCloseWindow)
  expect(handler, 'settings:close-window handler 应已注册').toBeTypeOf('function')
  return { handler: handler! }
}

describe('settingsCloseWindow 只关设置窗口本人', () => {
  it('① 从非设置窗口（主窗口）调用：任何窗口都不得被关闭', () => {
    const settingsWin = mkWin()
    registerWindow('settings', settingsWin as never)
    const mainWin = mkWin()
    const { handler } = setup()
    handler({ sender: mainWin.webContents }, undefined)
    expect(mainWin.close, '主窗口不得被 settings:close-window 关掉（实机实证的缺陷）').not.toHaveBeenCalled()
    expect(settingsWin.close).not.toHaveBeenCalled()
  })

  it('①b 未登记任何窗口时从主窗口调用：不炸也不误关', () => {
    const mainWin = mkWin()
    const { handler } = setup()
    handler({ sender: mainWin.webContents }, undefined)
    expect(mainWin.close).not.toHaveBeenCalled()
  })

  it('② 从设置窗口本人调用：设置窗口被关闭一次', () => {
    const settingsWin = mkWin()
    registerWindow('settings', settingsWin as never)
    const mainWin = mkWin()
    const { handler } = setup()
    handler({ sender: settingsWin.webContents }, undefined)
    expect(settingsWin.close, '守卫不许把功能也废掉').toHaveBeenCalledTimes(1)
    expect(mainWin.close).not.toHaveBeenCalled()
  })
})
