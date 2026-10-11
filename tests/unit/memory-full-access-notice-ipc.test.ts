// B1-14 完全访问告知（判据 14）：真 registerIpcHandlers 接缝上的 memorySetSwitch。
// 判据：full-access 下 关→开 warnFullAccess=true 且 meta 落 fullAccessNoticeShownAt；
// 重复开不再告；关→开再告；其他档不误告；标记落盘、重建 store 后仍读得到。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  settings: {} as Record<string, unknown>
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, fn: (e: unknown, p: unknown) => unknown) => fixture.handlers.set(key, fn) },
  dialog: {}, BrowserWindow: { getAllWindows: () => [] }, shell: {}, clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({ default: class {
  get store(): Record<string, unknown> { return fixture.settings }
  get(key: string): unknown { return fixture.settings[key] }
  set(key: string, value: unknown): void { fixture.settings[key] = value }
} }))
const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { createMemoryStore } = await import('@main/store/memory-store')

const roots: string[] = []
beforeEach(() => {
  fixture.settings = { memoryEnabled: false, permissionPreset: 'write' }
  fixture.handlers.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-fullnotice-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

function setup(): { root: string; memory: ReturnType<typeof createMemoryStore>; handler: (e: unknown, p: unknown) => unknown } {
  const root = mkdtempSync(join(tmpdir(), 'jsl-fullnotice-'))
  roots.push(root)
  const memory = createMemoryStore(root)
  registerIpcHandlers({
    userDataDir: root, memory, playbook: {} as never,
    agent: { getWorkspaceRoot: () => root, builtinAgentsDir: join(root, 'builtin'), userAgentsDir: join(root, 'agents'), checkpoints: {} } as never,
    trash: async () => {}, confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: { ask: async () => ({ answered: false as const, reason: 'no-window' as const }), respond: () => false, abortAll: () => {} },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {} as never, system: { getBlockers: () => [] } as never,
    execEventSink: { record: () => {} } as never, network: {} as never
  })
  const handler = fixture.handlers.get(IPC.memorySetSwitch)
  expect(handler, 'memory:set-switch handler 应已注册').toBeTypeOf('function')
  return { root, memory, handler: handler! }
}

interface SwitchResult {
  enabled: boolean
  warnFullAccess: boolean
}

describe('B1-14 完全访问告知（真 handler 接缝）', () => {
  it('full-access 下 关→开：warnFullAccess=true，meta 落 fullAccessNoticeShownAt', () => {
    fixture.settings.permissionPreset = 'full-access'
    const { memory, handler } = setup()
    const r = handler({}, true) as SwitchResult
    expect(r.enabled).toBe(true)
    expect(r.warnFullAccess).toBe(true)
    const meta = memory.backend.readMeta()
    expect(typeof meta.fullAccessNoticeShownAt, '告知痕迹应落 meta').toBe('string')
  })

  it('重复开不再告：已开着再 setMemorySwitch(true) → warnFullAccess=false', () => {
    fixture.settings.permissionPreset = 'full-access'
    const { handler } = setup()
    const first = handler({}, true) as SwitchResult
    expect(first.warnFullAccess).toBe(true)
    const again = handler({}, true) as SwitchResult
    expect(again.warnFullAccess, '已开着再开 = 幂等，不该重复告').toBe(false)
  })

  it('关→开→关→开：第二次开仍告（风险组合是重新成立的）', () => {
    fixture.settings.permissionPreset = 'full-access'
    const { handler } = setup()
    handler({}, true)
    handler({}, false)
    const reopen = handler({}, true) as SwitchResult
    expect(reopen.warnFullAccess).toBe(true)
  })

  it('write 档不误告、不落标记', () => {
    fixture.settings.permissionPreset = 'write'
    const { memory, handler } = setup()
    const r = handler({}, true) as SwitchResult
    expect(r.warnFullAccess).toBe(false)
    expect(memory.backend.readMeta().fullAccessNoticeShownAt).toBeUndefined()
  })

  it('read-only 档同样不误告', () => {
    fixture.settings.permissionPreset = 'read-only'
    const { handler } = setup()
    const r = handler({}, true) as SwitchResult
    expect(r.warnFullAccess).toBe(false)
  })

  it('meta 标记落盘重读：重建 store 后 fullAccessNoticeShownAt 仍在', () => {
    fixture.settings.permissionPreset = 'full-access'
    const { root, handler } = setup()
    handler({}, true)
    const restarted = createMemoryStore(root)
    expect(typeof restarted.backend.readMeta().fullAccessNoticeShownAt).toBe('string')
  })
})
