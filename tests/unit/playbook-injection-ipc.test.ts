// 真主IPC与真手册事件流；只替换模型运行入口，验证交给runner的生产注入段。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAYBOOK_LIMITS } from '@shared/playbook'
const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  run: vi.fn(async () => ({ output: '隔离结果', rounds: 1, stopReason: 'completed', agent: '内核默认' }))
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, fn: (e: unknown, p: unknown) => unknown) => fixture.handlers.set(key, fn) },
  dialog: {}, BrowserWindow: { getAllWindows: () => [] }, shell: {}, clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({ default: class {
  store: Record<string, unknown> = {}
  get(key: string): unknown { return this.store[key] }
  set(key: string, value: unknown): void { this.store[key] = value }
} }))
vi.mock('@main/store/models', async (original) => ({
  ...await original<typeof import('@main/store/models')>(),
  getSettingsView: () => ({ baseURL: 'https://isolated.invalid', model: 'fixture' }),
  getDecryptedApiKey: () => 'noncredential-fixture'
}))
vi.mock('@main/agent/runner', async (original) => ({
  ...await original<typeof import('@main/agent/runner')>(),
  runAgent: fixture.run
}))
const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { createMemoryStore } = await import('@main/store/memory-store')
const { createPlaybookStore } = await import('@main/store/playbook-store')
const roots: string[] = []
beforeEach(() => { fixture.handlers.clear(); fixture.run.mockClear() })
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-pb-ipc-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-pb-ipc-')); roots.push(root)
  const playbook = createPlaybookStore(root)
  registerIpcHandlers({
    userDataDir: root, memory: createMemoryStore(root), playbook,
    agent: { getWorkspaceRoot: () => root, builtinAgentsDir: join(root, 'builtin'), userAgentsDir: join(root, 'agents'), checkpoints: {} } as never,
    trash: async () => {}, confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: { ask: async () => ({ answered: false as const, reason: 'no-window' as const }), respond: () => false, abortAll: () => {} },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {} as never, system: { getBlockers: () => [] } as never,
    execEventSink: { record: () => {} } as never, network: {} as never
  })
  const run = async (task: string) => {
    const handler = fixture.handlers.get(IPC.agentRun)
    expect(handler).toBeTypeOf('function')
    expect(await handler!({ sender: { id: 21 } }, { task, conversationId: 'pb-conversation' })).toMatchObject({ ok: true })
    return (fixture.run.mock.calls.at(-1) as unknown as [unknown, { playbookBlock: string | null }])[1].playbookBlock
  }
  return { playbook, run }
}
describe('真主IPC手册注入事件', () => {
  it('事件names等于runner实际注入集合，排除不匹配与预算外条目', async () => {
    const { playbook, run } = setup()
    const matching: string[] = []
    for (let i = 0; i < 24; i++) {
      const name = `debug-item-${String(i).padStart(2, '0')}`; matching.push(name)
      expect(playbook.save({ name, description: '经验摘要'.repeat(28), tags: ['debug'], body: '确定步骤' }).ok).toBe(true)
    }
    expect(playbook.save({ name: 'unmatched', description: '编辑经验', tags: ['file-edit'], body: '编辑步骤' }).ok).toBe(true)
    const before = playbook.backend.readEvents().events.length
    const block = await run('debug this failure')
    expect(block).toBeTypeOf('string')
    const names = Array.from(block!.matchAll(/^- (debug-item-\d+)：/gm), (m) => m[1])
    expect(names.length).toBeGreaterThan(0); expect(names.length).toBeLessThan(matching.length)
    expect(names.every((name) => matching.includes(name))).toBe(true)
    expect(block).not.toContain('- unmatched：')
    expect(Buffer.byteLength(names.map((name) => `- ${name}：${'经验摘要'.repeat(28)}\n`).join(''))).toBeLessThanOrEqual(PLAYBOOK_LIMITS.maxInjectBytes)
    const events = playbook.backend.readEvents().events.slice(before)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'playbook_inject', conversationId: 'pb-conversation', names })
  })
  it.each(['plain greeting', 'debug this failure'])('无激活标签或无匹配：%s不记inject', async (task) => {
    const { playbook, run } = setup()
    expect(playbook.save({ name: 'only-file-edit', description: '编辑步骤', tags: ['file-edit'], body: '经验正文' }).ok).toBe(true)
    const before = playbook.backend.readEvents().events.length
    expect(await run(task)).toBeNull()
    expect(playbook.backend.readEvents().events.slice(before)).toEqual([])
  })
  it('真delete handler新增事件仅为delete，不借recall或inject', () => {
    const { playbook } = setup()
    const saved = playbook.save({ name: 'delete-me', description: '临时经验', tags: ['debug'], body: '正文' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error('删除夹具未保存')
    const before = playbook.backend.readEvents().events.length
    expect(fixture.handlers.get(IPC.playbookDelete)!({}, saved.file)).toBe(true)
    expect(playbook.backend.readEvents().events.slice(before)).toHaveLength(1)
    expect(playbook.backend.readEvents().events.at(-1)).toMatchObject({ kind: 'playbook_delete', name: 'delete-me' })
  })
})
