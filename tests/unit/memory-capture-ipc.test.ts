// S147 缺口一（B1-登记表-3「选中即记」）：补**真主 IPC 整链**证据。
// 门禁（verify-shot）此前只桩了 memory:save，断言的是「桩收到的形状」；本文件真注册
// registerIpcHandlers + 真 MemoryStore 落盘，补主进程这半：schema 收不收、origin 钉没钉死、
// 证据指针是否逐字段落盘、整条链有没有碰到任何 provider 可达面。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      electronMock.handlers.set(channel, fn)
    }
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

// settings.ts 模块级就 new Store；这里只假「一个键值袋」，不碰盘、不经 electron
vi.mock('electron-store', () => {
  class FakeStore {
    private data = new Map<string, unknown>()
    get(key: string): unknown {
      return this.data.get(key)
    }
    set(key: string, value: unknown): void {
      this.data.set(key, value)
    }
    delete(key: string): void {
      this.data.delete(key)
    }
    clear(): void {
      this.data.clear()
    }
  }
  return { default: FakeStore }
})

const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { createMemoryStore } = await import('@main/store/memory-store')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-mem-capture-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('选中即记：真主 IPC 整链（S147 判据 3 缺口）', () => {
  it('「选中即记」载荷过真 handler → origin 钉死 user、证据指针逐字段落盘、agent 侧零调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsl-mem-capture-'))
    roots.push(root)
    const memory = createMemoryStore(root)

    // agent 运行时是 deps 里唯一可能碰到模型的缝；每个方法都记账，跑完必须全空
    const agentCalls: string[] = []
    const agentStub = {
      getWorkspaceRoot: (): string => {
        agentCalls.push('getWorkspaceRoot')
        return root
      },
      builtinAgentsDir: join(root, 'builtin'),
      userAgentsDir: join(root, 'agents'),
      checkpoints: {}
    }

    // system / execEventSink / network 是其余 handler 的依赖；memory:save 一条都不碰，
    // 给空壳即可（真值由组合根装配，本测试只走选中即记这一条通路）
    const systemEvents: string[] = []
    registerIpcHandlers({
      agent: agentStub as never,
      userDataDir: root,
      trash: async () => {},
      memory,
      playbook: {} as never,
      confirm: {
        ask: async () => true,
        respond: () => false,
        abortAll: () => {}
      },
      ask: {
        ask: async () => ({ answered: false as const, reason: 'no-window' as const }),
        respond: () => false,
        abortAll: () => {}
      },
      planApproval: {
        request: async () => true,
        respond: () => false,
        abortAll: () => {}
      },
      terminal: {} as never,
      system: { getBlockers: () => [] } as never,
      execEventSink: { record: (): void => { systemEvents.push('execEvent') } } as never,
      network: {} as never
    })

    const handler = electronMock.handlers.get(IPC.memorySave)
    expect(typeof handler).toBe('function')

    const result = (await handler!({}, {
      name: '选中即记整链夹具',
      description: '真主 IPC 落盘的形状验收',
      class: 'default',
      body: '用户选中的原话，一字不改。',
      evidence: { conversationId: 'conv-capture-precise', turnIndex: 1 }
    })) as { ok: boolean; file?: string }

    expect(result.ok).toBe(true)
    // 从盘上读回来（不是看返回值）：落盘的 origin 必须被钉成 user，证据指针逐字段相等
    const saved = memory.list().entries.find((e) => e.name === '选中即记整链夹具')
    expect(saved).toBeDefined()
    expect(saved!.origin).toBe('user')
    expect(saved!.evidence).toEqual({ conversationId: 'conv-capture-precise', turnIndex: 1 })
    // 选中即记是唯一不经过模型的写入通路：整条链没有任何 agent/provider 可达面被碰过
    expect(agentCalls).toEqual([])
    // 执行事件 sink 同样零记录（这条通路不进时间线——它是人写的，不是模型跑的）
    expect(systemEvents).toEqual([])
  })
})

/**
 * 源码结构守卫（与 `chat-concurrency.test.ts` 同一手法）：真接线之外再钉一层——
 * memory:save 的 handler 体不许出现 `deps.agent`（碰了就等于给这条通路开了一条通往模型的路）。
 */
describe('memory:save handler 不许碰 agent 运行时（结构守卫）', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/ipc.ts'), 'utf8')

  it('handler 体里没有 deps.agent', () => {
    const head = 'ipcMain.handle(IPC.memorySave'
    const start = src.indexOf(head)
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = src.slice(start + head.length)
    const next = rest.indexOf('ipcMain.handle(')
    const body = next === -1 ? rest : rest.slice(0, next)
    expect(body).not.toContain('deps.agent')
  })
})
