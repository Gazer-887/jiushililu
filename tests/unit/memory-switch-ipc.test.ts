// 反思停在受控Promise上，验证真实IPC先返回、真实队列仍落盘。
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
beforeEach(() => { fixture.settings = { memoryEnabled: true, autoMemoryEnabled: true }; fixture.handlers.clear() })
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-switch-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-switch-')); roots.push(root)
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
  const handler = fixture.handlers.get(IPC.convSwitch)
  expect(handler).toBeTypeOf('function')
  return { root, memory, handler: handler! }
}
describe('真主IPC会话切换', () => {
  it('pending反思不拖住handler，prevId只运行一次且队列可重读', async () => {
    const { root, memory, handler } = setup()
    let release!: () => void
    let settled = false
    const pending = new Promise<boolean>((resolvePending) => { release = () => resolvePending(true) })
    void pending.then(() => { settled = true })
    const run = vi.spyOn(memory, 'runReflection').mockReturnValue(pending)
    try {
      const returned = handler({}, { prevId: 'previous', nextId: 'next' })
      let handlerReturned = false
      void Promise.resolve(returned).then(() => { handlerReturned = true })
      await Promise.resolve(); await Promise.resolve()
      expect(handlerReturned).toBe(true)
      expect(settled).toBe(false)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledWith('previous')
      const restarted = createMemoryStore(root)
      expect(restarted.dequeueReflection()).toBe('previous')
      expect(restarted.dequeueReflection()).toBeNull()
    } finally { release(); await pending }
  })
  it.each([
    ['同会话', { prevId: 'same', nextId: 'same' }, {}],
    ['无前会话', { prevId: null, nextId: 'next' }, {}],
    ['记忆关闭', { prevId: 'previous', nextId: 'next' }, { memoryEnabled: false }],
    ['自动记忆关闭', { prevId: 'previous', nextId: 'next' }, { autoMemoryEnabled: false }]
  ])('%s不入队也不触发反思', (_label, payload, overrides) => {
    Object.assign(fixture.settings, overrides)
    const { root, memory, handler } = setup()
    const run = vi.spyOn(memory, 'runReflection').mockResolvedValue(false)
    handler({}, payload)
    expect(run).not.toHaveBeenCalled()
    expect(createMemoryStore(root).dequeueReflection()).toBeNull()
  })
})
