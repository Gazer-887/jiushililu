// S3-40C0：权限代次的真实来源。真实 Conf 后端落在私域临时目录，禁止碰本机用户配置。
// 行为验证走真实 setter/getter 与真实 IPC 消费者，不用静态字符串检查代替。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'

const fixture = vi.hoisted(() => ({
  root: '',
  failNextSet: false,
  failStoreRead: false,
  conf: null as null | { onDidAnyChange: (callback: () => void) => unknown },
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  killed: 0,
  events: [] as string[]
}))

const providerCtl = vi.hoisted(() => ({
  calls: 0,
  mainCalls: 0,
  schemas: [] as string[][],
  onCall: null as null | ((index: number, schemas: string[], prompt: string) => {
    text: string | null
    toolCalls: Array<{ id: string; name: string; arguments: string }>
  } | Promise<{
    text: string | null
    toolCalls: Array<{ id: string; name: string; arguments: string }>
  }>)
}))

const fileToolsCtl = vi.hoisted(() => ({
  created: [] as Array<{ write: { execute: (args: Record<string, unknown>) => Promise<unknown> } }>
}))

vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  ipcMain: {
    handle: (key: string, fn: (event: unknown, payload: unknown) => unknown) => fixture.handlers.set(key, fn)
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  clipboard: {},
  // 真实 IPC 聊天入口要读模型 Key：用可往返的内存加密，不引入系统密钥链。
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf8')
  }
}))

vi.mock('electron-store', async () => {
  const { default: Conf } = await import('conf')
  return {
    default: class extends Conf {
      constructor(options: { name: string }) {
        if (!fixture.root) throw new Error('必须先指定隔离数据根')
        super({
          cwd: fixture.root,
          configName: options.name,
          projectName: 'isolated-permission',
          projectVersion: '0.0.0'
        })
        // 其他 store（如记忆）也可能实例化同一个 mock；只认 settings 这一份
        if (options.name === 'settings') {
          fixture.conf = this as unknown as { onDidAnyChange: (callback: () => void) => unknown }
        }
      }

      get store(): Record<string, unknown> {
        if (fixture.failStoreRead) throw new Error('store read boom')
        return super.store
      }

      set store(value: Record<string, unknown>) {
        super.store = value
      }

      set(key: string, value: unknown): void {
        if (fixture.failNextSet) {
          fixture.failNextSet = false
          // 受控写前注入：在 super.set 之前抛出，不代表真实磁盘满
          throw new Error('pre-write boom')
        }
        super.set(key, value)
      }
    }
  }
})

vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: async (...args: unknown[]) => {
    const schemas = ((args[3] ?? []) as Array<{ name: string }>).map((tool) => tool.name)
    providerCtl.schemas.push(schemas)
    const messages = (args[2] ?? []) as Array<{ role: string; content: string | null }>
    const prompt = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const index = providerCtl.calls++
    return providerCtl.onCall
      ? providerCtl.onCall(index, schemas, prompt)
      : { text: 'done', toolCalls: [] }
  },
  chatWithToolsOpenAI: vi.fn()
}))

vi.mock('@main/agent/tools/file-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools/file-tools')>()
  return {
    ...actual,
    createFileTools: (...args: Parameters<typeof actual.createFileTools>) => {
      const tools = actual.createFileTools(...args)
      fileToolsCtl.created.push({
        write: tools[1] as unknown as { execute: (args: Record<string, unknown>) => Promise<unknown> }
      })
      return tools
    }
  }
})

const roots: string[] = []

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jsl-permission-'))
  roots.push(fixture.root)
  fixture.failNextSet = false
  fixture.failStoreRead = false
  fixture.conf = null
  fixture.handlers.clear()
  fixture.killed = 0
  fixture.events = []
  providerCtl.calls = 0
  providerCtl.mainCalls = 0
  providerCtl.schemas = []
  providerCtl.onCall = null
  fileToolsCtl.created = []
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-permission-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

const disk = (): Record<string, unknown> => {
  const path = join(fixture.root, 'settings.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

async function setup(): Promise<{
  settings: typeof import('@main/store/settings')
  policy: typeof import('@shared/request-policy')
  get: () => unknown
  set: (value: unknown) => unknown
}> {
  const { IPC } = await import('@shared/ipc')
  const { registerIpcHandlers } = await import('@main/ipc')
  const { createMemoryStore } = await import('@main/store/memory-store')
  const settings = await import('@main/store/settings')
  const policy = await import('@shared/request-policy')

  registerIpcHandlers({
    userDataDir: fixture.root,
    memory: createMemoryStore(fixture.root),
    playbook: {} as never,
    agent: {
      getWorkspaceRoot: () => fixture.root,
      builtinAgentsDir: join(fixture.root, 'builtin'),
      userAgentsDir: join(fixture.root, 'agents'),
      checkpoints: {}
    } as never,
    trash: async () => {},
    confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: {
      ask: async () => ({ answered: false as const, reason: 'no-window' as const }),
      respond: () => false,
      abortAll: () => {}
    },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {
      killAll: () => {
        fixture.killed += 1
      }
    } as never,
    system: { getBlockers: () => [] } as never,
    execEventSink: { record: () => {} } as never,
    network: {} as never,
    onSettingsChanged: (key: string) => fixture.events.push(key)
  })

  const getHandler = fixture.handlers.get(IPC.permissionGet)
  const setHandler = fixture.handlers.get(IPC.permissionSet)
  expect(getHandler).toBeTypeOf('function')
  expect(setHandler).toBeTypeOf('function')
  return {
    settings,
    policy,
    get: () => getHandler!({}, undefined),
    set: (value: unknown) => setHandler!({}, value)
  }
}

describe('S3-40C0 权限代次真实来源', () => {
  it('初始档位与代次可同步读取，默认档不写盘', async () => {
    const { settings, get } = await setup()
    expect(settings.getPermissionPreset()).toBe('write')
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 0 })
    expect(get()).toBe('write')
    expect(disk()).toEqual({})
  }, 20000)

  it('收紧/放宽/同值重复都按真实变化推进代次，IPC 消费者读到新档位', async () => {
    const { settings, get, set } = await setup()

    expect(set('read-only')).toBe('read-only')
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
    expect(get()).toBe('read-only')
    expect(fixture.killed).toBe(1)
    expect(fixture.events).toEqual(['permission'])
    expect(disk()).toEqual({ permissionPreset: 'read-only' })

    expect(set('full-access')).toBe('full-access')
    expect(settings.getPermissionState()).toEqual({ preset: 'full-access', generation: 2 })
    expect(get()).toBe('full-access')

    expect(set('full-access')).toBe('full-access')
    expect(settings.getPermissionState()).toEqual({ preset: 'full-access', generation: 2 })
  })

  it('先收紧再放宽回原档：最终档位相同，代次仍能区分中途变化', async () => {
    const { settings, policy, set } = await setup()
    const start = settings.getPermissionState()
    expect(start).toEqual({ preset: 'write', generation: 0 })

    set('read-only')
    set('write')
    const end = settings.getPermissionState()
    expect(end.preset).toBe(start.preset)
    expect(end.generation).not.toBe(start.generation)
    expect(end.generation).toBe(2)
    expect(policy.isPermissionGenerationCurrent(start.generation, end.generation)).toBe(false)
  })

  it('写后同步变更回调抛错：持久化已发生，代次仍推进且重入读取安全', async () => {
    const { settings, policy } = await setup()
    const start = settings.getPermissionState()
    const observed: Array<{ preset: string; generation: number }> = []
    const unsafeDuringCallback: boolean[] = []
    let baseline = start.generation

    fixture.conf!.onDidAnyChange(() => {
      // 真实 Conf 在 _write 之后同步 emit：监听器重入读取必须看到「新档位 + 新代次」。
      // 受控注册，仅用于本用例；当前产品未注册此类权限变更回调。
      const snapshot = settings.getPermissionState()
      observed.push(snapshot)
      unsafeDuringCallback.push(policy.isPermissionGenerationCurrent(baseline, snapshot.generation))
      // 回调抛错且随后读取不可用：代次必须已经推进，不能回退成旧值
      fixture.failStoreRead = true
      throw new Error('change listener boom')
    })

    expect(() => settings.setPermissionPreset('read-only')).toThrow('change listener boom')
    fixture.failStoreRead = false
    expect(unsafeDuringCallback).toEqual([false])
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
    expect(disk()).toEqual({ permissionPreset: 'read-only' })

    baseline = settings.getPermissionState().generation
    expect(() => settings.setPermissionPreset('write')).toThrow('change listener boom')
    fixture.failStoreRead = false
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 2 })
    expect(disk()).toEqual({ permissionPreset: 'write' })

    expect(observed).toEqual([
      { preset: 'read-only', generation: 1 },
      { preset: 'write', generation: 2 }
    ])
    // 回调期间旧代次均不得通过比较（修复前第一条为 true，即主脑复现的误判）
    expect(unsafeDuringCallback).toEqual([false, false])
    expect(policy.isPermissionGenerationCurrent(start.generation, observed[0]!.generation)).toBe(false)
    expect(policy.isPermissionGenerationCurrent(observed[0]!.generation, observed[1]!.generation)).toBe(false)
  })

  it('写后读取失败：不得假报未变化，代次保守推进', async () => {
    const { settings } = await setup()
    fixture.conf!.onDidAnyChange(() => {
      fixture.failStoreRead = true
    })

    expect(() => settings.setPermissionPreset('read-only')).toThrow('store read boom')
    fixture.failStoreRead = false
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
    expect(disk()).toEqual({ permissionPreset: 'read-only' })
  })

  it('同值设置的回调抛错：档位与代次都不推进，异常仍可见', async () => {
    const { settings } = await setup()
    fixture.conf!.onDidAnyChange(() => {
      throw new Error('same-value boom')
    })

    expect(() => settings.setPermissionPreset('write')).toThrow('same-value boom')
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 0 })
    expect(disk()).toEqual({ permissionPreset: 'write' })
  })

  it('同值重复设置保持现有写盘与返回行为，但不推进代次', async () => {
    const { settings } = await setup()
    expect(disk()).toEqual({})

    expect(settings.setPermissionPreset('write')).toBe('write')
    expect(disk()).toEqual({ permissionPreset: 'write' })
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 0 })
  })

  it('非法输入与受控写前失败都不产生新代次或副作用', async () => {
    const { settings, set } = await setup()

    expect(() => set('bogus')).toThrow()
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 0 })
    expect(fixture.killed).toBe(0)
    expect(fixture.events).toEqual([])

    // 受控写前注入：在 super.set 之前抛出，不等于真实磁盘满；
    // 与下方“写后同步回调抛错”分开，避免把两者混为一谈。
    fixture.failNextSet = true
    expect(() => settings.setPermissionPreset('read-only')).toThrow('pre-write boom')
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 0 })
    expect(fixture.killed).toBe(0)
    expect(fixture.events).toEqual([])
    expect(disk()).toEqual({})

    expect(settings.setPermissionPreset('read-only')).toBe('read-only')
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
  })

  it('连续调用只按真实变化推进，FAST/模型/省 token 配置不冒充权限', async () => {
    const { settings, policy } = await setup()

    settings.setPermissionPreset('read-only')
    settings.setPermissionPreset('read-only')
    settings.setPermissionPreset('full-access')
    settings.setPermissionPreset('read-only')
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 3 })

    settings.setTokenTier('light')
    settings.setAutoMemoryEnabled(false)
    policy.resolveRequestPolicy({ modelDefault: 'fast', tierSupport: 'supported' })
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 3 })
  })

  it('代码层比较合同：非法/负数/非整数/不同代次一律判为已变化', async () => {
    const { policy } = await setup()
    expect(policy.isPermissionGenerationCurrent(0, 0)).toBe(true)
    expect(policy.isPermissionGenerationCurrent(0, 1)).toBe(false)
    expect(policy.isPermissionGenerationCurrent(1, 0)).toBe(false)
    for (const bad of [Number.NaN, -1, 1.5, '1', null, undefined]) {
      expect(policy.isPermissionGenerationCurrent(bad, 0)).toBe(false)
      expect(policy.isPermissionGenerationCurrent(0, bad)).toBe(false)
    }
  })

  it('模块重载后档位持久，代次按新进程从 0 起算', async () => {
    const { settings } = await setup()
    settings.setPermissionPreset('read-only')
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })

    vi.resetModules()
    const fresh = await import('@main/store/settings')
    expect(fresh.getPermissionPreset()).toBe('read-only')
    expect(fresh.getPermissionState()).toEqual({ preset: 'read-only', generation: 0 })
  })
})

// ── S3-40C1：主 run 权限实时收紧 ─────────────────────────────────────

const MODEL_SETTINGS = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'test-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  inputModalities: ['text']
} as ModelSettings

const FAST_POLICY = {
  mode: 'fast' as const,
  maxLocalReadConcurrency: 2 as const,
  requestedServiceTier: 'priority',
  tierSupport: 'supported' as const
}

function writeFileAt(root: string, rel: string, text: string): string {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
  return abs
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: JSON.stringify(args)
})

async function runnerSetup(): Promise<{
  settings: typeof import('@main/store/settings')
  runAgent: typeof import('@main/agent/runner').runAgent
  ctx: never
  ws: string
}> {
  const { settings } = await setup()
  const { runAgent } = await import('@main/agent/runner')
  const base = fixture.root
  const ws = join(base, 'ws')
  mkdirSync(ws, { recursive: true })
  const ctx = {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: {
      begin: () => 'run-1',
      finish: () => {},
      get: () => ({ changes: [] }),
      record: () => {}
    }
  } as never
  return { settings, runAgent, ctx, ws }
}

async function setupChatEntry(): Promise<{
  IPC: typeof import('@shared/ipc').IPC
  settings: typeof import('@main/store/settings')
  models: typeof import('@main/store/models')
  ws: string
}> {
  vi.resetModules()
  const { registerIpcHandlers } = await import('@main/ipc')
  const { createAgentContext } = await import('@main/agent/runner')
  const { createMemoryStore } = await import('@main/store/memory-store')
  const { createPlaybookStore } = await import('@main/store/playbook-store')
  const { IPC } = await import('@shared/ipc')
  const ws = join(fixture.root, 'chat-ws')
  mkdirSync(ws, { recursive: true })
  const memory = createMemoryStore(join(fixture.root, 'chat-memory'), undefined, {
    ftsPath: null,
    modelWritesNeedApproval: () => false
  })
  const agent = createAgentContext({
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(fixture.root, 'builtin'),
    userAgentsDir: join(fixture.root, 'agents'),
    checkpointDir: join(fixture.root, 'checkpoints'),
    memory: { repo: memory, enabled: () => true }
  })
  fixture.handlers.clear()
  registerIpcHandlers({
    agent,
    memory,
    userDataDir: fixture.root,
    playbook: createPlaybookStore(fixture.root),
    trash: async () => {},
    confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: {
      ask: async () => ({ answered: false as const, reason: 'no-window' as const }),
      respond: () => false,
      abortAll: () => {}
    },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {} as never,
    system: { getBlockers: () => [] } as never,
    execEventSink: { append: () => {} } as never,
    network: {} as never
  })
  return {
    IPC,
    settings: await import('@main/store/settings'),
    models: await import('@main/store/models'),
    ws
  }
}

describe('S3-40C1 主 run 权限实时收紧', () => {
  it('收紧立即生效：write 起点收紧到 read-only 后 write_file 不启动', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    const file = writeFileAt(ws, 'a.txt', 'original')
    providerCtl.onCall = () => {
      settings.setPermissionPreset('read-only')
      return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'a.txt', content: 'hacked' })] }
    }

    await expect(
      runAgent(ctx, {
        settings: MODEL_SETTINGS,
        apiKey: 'k',
        history: [{ role: 'user', content: '写文件' }],
        conversationId: 'c1',
        readPermissionState: settings.getPermissionState,
        isRunActive: () => true
      })
    ).rejects.toThrow(/权限守卫|未提交|工具启动/)
    expect(providerCtl.calls).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('观察到收紧后放宽回原档：同一 run 的后续 write_file 仍不被授权', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    const file = writeFileAt(ws, 'a.txt', 'original')
    let reads = 0
    const readPermissionState = () => {
      reads++
      // 第 1 次是 run 起点；第 2 次让 read_file 观察到 read-only；第 3 次让写前放宽回 write
      if (reads === 3) settings.setPermissionPreset('write')
      return settings.getPermissionState()
    }
    providerCtl.onCall = () => {
      settings.setPermissionPreset('read-only')
      return {
        text: null,
        toolCalls: [
          toolCall('r1', 'read_file', { path: 'a.txt' }),
          toolCall('w1', 'write_file', { path: 'a.txt', content: 'hacked' })
        ]
      }
    }

    await expect(
      runAgent(ctx, {
        settings: MODEL_SETTINGS,
        apiKey: 'k',
        history: [{ role: 'user', content: '先读后写' }],
        conversationId: 'c1',
        readPermissionState,
        isRunActive: () => true
      })
    ).rejects.toThrow(/权限守卫|未提交|工具启动/)
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 2 })
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('读取暂存期间先收紧再放宽回原档：代次变化使提交门 discard', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    const a = writeFileAt(ws, 'a.txt', 'A')
    const b = writeFileAt(ws, 'b.txt', 'B')
    let reads = 0
    const readPermissionState = () => {
      reads++
      // 第 8 次是提交门：两次读取均已暂存，收紧后立刻放宽回原档
      if (reads === 8) {
        settings.setPermissionPreset('read-only')
        settings.setPermissionPreset('write')
      }
      return settings.getPermissionState()
    }
    providerCtl.onCall = () => ({
      text: null,
      toolCalls: [toolCall('r1', 'read_file', { path: 'a.txt' }), toolCall('r2', 'read_file', { path: 'b.txt' })]
    })

    await expect(
      runAgent(ctx, {
        settings: MODEL_SETTINGS,
        apiKey: 'k',
        history: [{ role: 'user', content: '并行读两个文件' }],
        conversationId: 'c1',
        requestPolicy: FAST_POLICY,
        readPermissionState,
        isRunActive: () => true
      })
    ).rejects.toThrow(/未提交|权限守卫/)
    expect(reads).toBe(8)
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 2 })
    const write = fileToolsCtl.created.at(-1)!.write
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(a, 'utf8')).toBe('A')
    expect(readFileSync(b, 'utf8')).toBe('B')
  })

  it('非法档位/代次/权限源抛错：保守拒绝且文件未改写', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    const file = writeFileAt(ws, 'a.txt', 'original')
    const baseArgs = {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '写文件' }],
      conversationId: 'c1'
    }

    await expect(
      runAgent(ctx, {
        ...baseArgs,
        readPermissionState: () => ({ preset: 'bogus', generation: 0 } as never)
      })
    ).rejects.toThrow(/权限档位非法/)
    expect(providerCtl.calls).toBe(0)

    await expect(
      runAgent(ctx, {
        ...baseArgs,
        readPermissionState: () => ({ preset: 'write', generation: -1 } as never)
      })
    ).rejects.toThrow(/权限代次非法/)
    expect(providerCtl.calls).toBe(0)

    let reads = 0
    const throwing = () => {
      reads++
      if (reads === 1) return settings.getPermissionState()
      throw new Error('permission source down')
    }
    providerCtl.onCall = () => ({
      text: null,
      toolCalls: [toolCall('w1', 'write_file', { path: 'a.txt', content: 'hacked' })]
    })
    await expect(
      runAgent(ctx, { ...baseArgs, readPermissionState: throwing, isRunActive: () => true })
    ).rejects.toThrow(/权限守卫|未提交|工具启动/)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('放宽不扩权，新 run 读取新档位', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    const target = join(ws, 'new.txt')
    settings.setPermissionPreset('read-only')
    providerCtl.onCall = (index) => {
      if (index === 0) {
        settings.setPermissionPreset('full-access')
        return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'new.txt', content: 'run1' })] }
      }
      return { text: 'done', toolCalls: [] }
    }

    const baseArgs = {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '写新文件' }],
      conversationId: 'c1',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    }
    await runAgent(ctx, baseArgs)
    expect(providerCtl.schemas[0]).not.toContain('write_file')
    expect(existsSync(target)).toBe(false)
    expect(settings.getPermissionState()).toEqual({ preset: 'full-access', generation: 2 })

    providerCtl.calls = 0
    providerCtl.schemas = []
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('w2', 'write_file', { path: 'new.txt', content: 'run2' })] }
        : { text: 'done', toolCalls: [] }
    await runAgent(ctx, { ...baseArgs, conversationId: 'c2' })
    expect(providerCtl.schemas[0]).toContain('write_file')
    expect(readFileSync(target, 'utf8')).toBe('run2')
  })

  it('未观察到中间收紧但代次已变：write_file 仍被保守拒绝', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    const file = writeFileAt(ws, 'a.txt', 'original')
    providerCtl.onCall = () => {
      // 消费者第一次重读前已回到起始档；中间最低权限无法还原，只能靠代次保守拒绝
      settings.setPermissionPreset('read-only')
      settings.setPermissionPreset('write')
      return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'a.txt', content: 'hacked' })] }
    }

    await expect(
      runAgent(ctx, {
        settings: MODEL_SETTINGS,
        apiKey: 'k',
        history: [{ role: 'user', content: '写文件' }],
        conversationId: 'c1',
        readPermissionState: settings.getPermissionState,
        isRunActive: () => true
      })
    ).rejects.toThrow(/权限守卫|未提交|工具启动/)
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 2 })
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('权限源报告更严档但代次未变：仍按收紧档拒绝写工具', async () => {
    const { runAgent, ctx, ws } = await runnerSetup()
    const file = writeFileAt(ws, 'a.txt', 'original')
    let reads = 0
    const readPermissionState = () => {
      reads++
      // 受控不一致源：更严档却未推进代次；守卫不能只看代次，必须按更严档收口
      if (reads === 1) return { preset: 'write' as const, generation: 0 }
      return { preset: 'read-only' as const, generation: 0 }
    }
    providerCtl.onCall = () => ({
      text: null,
      toolCalls: [toolCall('w1', 'write_file', { path: 'a.txt', content: 'hacked' })]
    })

    await expect(
      runAgent(ctx, {
        settings: MODEL_SETTINGS,
        apiKey: 'k',
        history: [{ role: 'user', content: '写文件' }],
        conversationId: 'c1',
        readPermissionState,
        isRunActive: () => true
      })
    ).rejects.toThrow(/权限守卫|未提交|工具启动/)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('full-access 起跑降到 write：旧 run_command 实例不得跳过确认直接执行', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    mkdirSync(join(fixture.root, 'user'), { recursive: true })
    writeFileSync(
      join(fixture.root, 'user', 'cmd-runner.md'),
      '---\nname: cmd-runner\ndescription: 命令执行\ntools: [run_command]\n---\n执行命令。',
      'utf8'
    )
    settings.setPermissionPreset('full-access')
    const marker = join(ws, 'marker.txt')
    providerCtl.onCall = () => {
      settings.setPermissionPreset('write')
      return {
        text: null,
        toolCalls: [toolCall('c1', 'run_command', { command: `echo hacked > "${marker}"` })]
      }
    }

    await expect(
      runAgent(ctx, {
        settings: MODEL_SETTINGS,
        apiKey: 'k',
        history: [{ role: 'user', content: '执行命令' }],
        conversationId: 'c1',
        agentName: 'cmd-runner',
        readPermissionState: settings.getPermissionState,
        isRunActive: () => true
      })
    ).rejects.toThrow(/权限守卫|未提交|工具启动/)
    expect(existsSync(marker)).toBe(false)
  })

  it('命令确认等待期间撤权：批准后也不得启动命令', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    mkdirSync(join(fixture.root, 'user'), { recursive: true })
    writeFileSync(
      join(fixture.root, 'user', 'cmd-wait.md'),
      '---\nname: cmd-wait\ndescription: 命令等待\ntools: [run_command]\n---\n执行命令。',
      'utf8'
    )
    const marker = join(ws, 'confirm-marker.txt')
    let releaseConfirm!: (approved: boolean) => void
    let confirmStarted!: () => void
    const started = new Promise<void>((resolve) => {
      confirmStarted = resolve
    })
    ;(ctx as unknown as { confirmCommand: (req: unknown) => Promise<boolean> }).confirmCommand =
      async () => {
        confirmStarted()
        return new Promise<boolean>((resolve) => {
          releaseConfirm = resolve
        })
      }
    providerCtl.onCall = (index) =>
      index === 0
        ? {
            text: null,
            toolCalls: [toolCall('c1', 'run_command', { command: `echo hacked > "${marker}"` })]
          }
        : { text: 'done', toolCalls: [] }

    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '执行命令' }],
      conversationId: 'c1',
      agentName: 'cmd-wait',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    await started
    settings.setPermissionPreset('read-only')
    releaseConfirm(true)
    await expect(run).resolves.toBeTruthy()
    expect(existsSync(marker)).toBe(false)
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
  })

  it('真实 IPC 聊天入口：收紧后后续文件写被拒绝', async () => {
    const { IPC, settings, models, ws } = await setupChatEntry()
    const file = writeFileAt(ws, 'a.txt', 'original')
    const profile = models.saveEndpoint({
      name: '端点A',
      providerType: 'openai-compatible',
      baseURL: 'https://api.example.com',
      models: [{ id: 'm1', model: 'test-model' } as never],
      apiKey: ''
    })
    settings.setProfileKey(profile.id, 'ipc-test-key')
    providerCtl.onCall = () => {
      settings.setPermissionPreset('read-only')
      return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'a.txt', content: 'hacked' })] }
    }

    const handler = fixture.handlers.get(IPC.chatSend)
    expect(handler).toBeTypeOf('function')
    await handler!(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          once: () => {},
          removeListener: () => {},
          send: () => {}
        }
      },
      { conversationId: 'ipc-c1', messages: [{ role: 'user', content: '写文件' }] }
    )
    expect(providerCtl.calls).toBe(1)
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('真实主运行入口两处都传权威权限读取器', () => {
    // 行为已由上面的真实 IPC/runner/loop 用例覆盖；这里只钉住入口装配不丢读取器。
    const source = readFileSync(resolve('src/main/ipc.ts'), 'utf8')
    const hits = source.match(/readPermissionState: getPermissionState/g) ?? []
    expect(hits).toHaveLength(2)
  })
})

// ── S3-40C1-R1：外部工具确认后的异步撤权 ─────────────────────────────

async function mcpSetup(): Promise<{
  settings: typeof import('@main/store/settings')
  runAgent: typeof import('@main/agent/runner').runAgent
  ctx: never
  entered: Promise<void>
  release: (approved: boolean) => void
  invoked: () => number
}> {
  const { settings, runAgent, ctx } = await runnerSetup()
  let invoked = 0
  let notifyEntered!: () => void
  let releaseConfirm!: (approved: boolean) => void
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve
  })
  const confirmation = new Promise<boolean>((resolve) => {
    releaseConfirm = resolve
  })
  const mutable = ctx as unknown as { mcp: unknown; confirmCommand: unknown }
  mutable.mcp = {
    manager: {
      hasConnected: () => true,
      activeTools: () => [
        {
          server: 'example',
          name: 'mutate',
          fullName: 'mcp__example__mutate',
          inputSchema: { type: 'object' }
        }
      ],
      callTool: async () => {
        invoked++
        return { text: 'controlled external transport invoked', images: [] }
      }
    }
  }
  mutable.confirmCommand = async () => {
    notifyEntered()
    return confirmation
  }
  return {
    settings,
    runAgent,
    ctx,
    entered,
    release: (approved) => releaseConfirm(approved),
    invoked: () => invoked
  }
}

describe('S3-40C1-R1 外部工具确认后的异步撤权', () => {
  it('MCP 授权等待期间撤权：批准后也不得调用外部工具', async () => {
    const { settings, runAgent, ctx, entered, release, invoked } = await mcpSetup()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('m1', 'mcp__example__mutate', {})] }
        : { text: 'done', toolCalls: [] }

    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'local-fake',
      history: [{ role: 'user', content: '调用外部工具' }],
      conversationId: 'mcp-c1',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    await entered
    settings.setPermissionPreset('read-only')
    release(true)
    await run
    expect(invoked(), '撤权后不应调用受控外部工具').toBe(0)
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
  })

  it('MCP 授权等待期间取消：批准后也不得调用外部工具', async () => {
    const { settings, runAgent, ctx, entered, release, invoked } = await mcpSetup()
    const controller = new AbortController()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('m1', 'mcp__example__mutate', {})] }
        : { text: 'done', toolCalls: [] }

    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'local-fake',
      history: [{ role: 'user', content: '调用外部工具' }],
      conversationId: 'mcp-c2',
      signal: controller.signal,
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    await entered
    controller.abort()
    release(true)
    await expect(run).rejects.toThrow()
    expect(invoked(), '取消后不应调用受控外部工具').toBe(0)
  })

  it('MCP 正常批准且权限未变：外部工具正常调用一次', async () => {
    const { settings, runAgent, ctx, entered, release, invoked } = await mcpSetup()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('m1', 'mcp__example__mutate', {})] }
        : { text: 'done', toolCalls: [] }

    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'local-fake',
      history: [{ role: 'user', content: '调用外部工具' }],
      conversationId: 'mcp-c3',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    await entered
    release(true)
    await run
    expect(invoked()).toBe(1)
    expect(settings.getPermissionState()).toEqual({ preset: 'write', generation: 0 })
  })
})

// ── S3-40C1-R2：记忆/经验异步确认撤权 ─────────────────────────────────

async function confirmableMemorySetup(): Promise<{
  settings: typeof import('@main/store/settings')
  runAgent: typeof import('@main/agent/runner').runAgent
  ctx: never
  repo: ReturnType<typeof import('@main/store/memory-store').createMemoryStore>
  entered: Promise<void>
  release: (approved: boolean) => void
}> {
  const { settings, runAgent, ctx } = await runnerSetup()
  const { createMemoryStore } = await import('@main/store/memory-store')
  const repo = createMemoryStore(join(fixture.root, 'memory-r2'), undefined, {
    ftsPath: null,
    modelWritesNeedApproval: () => false
  })
  let notifyEntered!: () => void
  let releaseConfirm!: (approved: boolean) => void
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve
  })
  const confirmation = new Promise<boolean>((resolve) => {
    releaseConfirm = resolve
  })
  ;(ctx as unknown as { memory: unknown }).memory = {
    repo,
    enabled: () => true,
    confirm: async () => {
      notifyEntered()
      return confirmation
    }
  }
  return {
    settings,
    runAgent,
    ctx,
    repo,
    entered,
    release: (approved) => releaseConfirm(approved)
  }
}

async function confirmablePlaybookSetup(): Promise<{
  settings: typeof import('@main/store/settings')
  runAgent: typeof import('@main/agent/runner').runAgent
  ctx: never
  repo: ReturnType<typeof import('@main/store/playbook-store').createPlaybookStore>
  entered: Promise<void>
  release: (approved: boolean) => void
}> {
  const { settings, runAgent, ctx } = await runnerSetup()
  const { createPlaybookStore } = await import('@main/store/playbook-store')
  const repo = createPlaybookStore(join(fixture.root, 'playbook-r2'))
  let notifyEntered!: () => void
  let releaseConfirm!: (approved: boolean) => void
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve
  })
  const confirmation = new Promise<boolean>((resolve) => {
    releaseConfirm = resolve
  })
  ;(ctx as unknown as { playbook: unknown }).playbook = {
    repo,
    conversationId: 'c1',
    confirm: async () => {
      notifyEntered()
      return confirmation
    }
  }
  return {
    settings,
    runAgent,
    ctx,
    repo,
    entered,
    release: (approved) => releaseConfirm(approved)
  }
}

const MEMORY_CALL = {
  name: 'r2-memory',
  description: '确认等待测试',
  class: 'default',
  body: '跑测试前自动执行 lint'
}
const PLAYBOOK_CALL = {
  name: 'r2-playbook',
  description: '确认等待测试',
  tags: ['file-edit'],
  body: '调用时带上 a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0 即可'
}

describe('S3-40C1-R2 记忆/经验异步确认撤权', () => {
  it('remember 确认等待撤权：批准后不写入', async () => {
    const { settings, runAgent, ctx, repo, entered, release } = await confirmableMemorySetup()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('m1', 'remember', MEMORY_CALL)] }
        : { text: 'done', toolCalls: [] }
    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '记住' }],
      conversationId: 'mem-c1',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })
    await entered
    settings.setPermissionPreset('read-only')
    release(true)
    await run
    expect(repo.listActiveEntries().some((entry) => entry.name === 'r2-memory')).toBe(false)
  })

  it('remember 确认等待取消：批准后不写入', async () => {
    const { settings, runAgent, ctx, repo, entered, release } = await confirmableMemorySetup()
    const controller = new AbortController()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('m1', 'remember', MEMORY_CALL)] }
        : { text: 'done', toolCalls: [] }
    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '记住' }],
      conversationId: 'mem-c2',
      signal: controller.signal,
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })
    await entered
    controller.abort()
    release(true)
    await expect(run).rejects.toThrow()
    expect(repo.listActiveEntries().some((entry) => entry.name === 'r2-memory')).toBe(false)
  })

  it('remember 正常批准：写入一次', async () => {
    const { settings, runAgent, ctx, repo, entered, release } = await confirmableMemorySetup()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('m1', 'remember', MEMORY_CALL)] }
        : { text: 'done', toolCalls: [] }
    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '记住' }],
      conversationId: 'mem-c3',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })
    await entered
    release(true)
    await run
    expect(repo.listActiveEntries().some((entry) => entry.name === 'r2-memory')).toBe(true)
  })

  it('save_playbook 确认等待撤权：批准后不写入', async () => {
    const { settings, runAgent, ctx, repo, entered, release } = await confirmablePlaybookSetup()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('p1', 'save_playbook', PLAYBOOK_CALL)] }
        : { text: 'done', toolCalls: [] }
    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '保存经验' }],
      conversationId: 'pb-c1',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })
    await entered
    settings.setPermissionPreset('read-only')
    release(true)
    await run
    expect(repo.list().entries.some((entry) => entry.name === 'r2-playbook')).toBe(false)
  })

  it('save_playbook 确认等待取消：批准后不写入', async () => {
    const { settings, runAgent, ctx, repo, entered, release } = await confirmablePlaybookSetup()
    const controller = new AbortController()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('p1', 'save_playbook', PLAYBOOK_CALL)] }
        : { text: 'done', toolCalls: [] }
    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '保存经验' }],
      conversationId: 'pb-c2',
      signal: controller.signal,
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })
    await entered
    controller.abort()
    release(true)
    await expect(run).rejects.toThrow()
    expect(repo.list().entries.some((entry) => entry.name === 'r2-playbook')).toBe(false)
  })

  it('save_playbook 正常批准：写入一次', async () => {
    const { settings, runAgent, ctx, repo, entered, release } = await confirmablePlaybookSetup()
    providerCtl.onCall = (index) =>
      index === 0
        ? { text: null, toolCalls: [toolCall('p1', 'save_playbook', PLAYBOOK_CALL)] }
        : { text: 'done', toolCalls: [] }
    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '保存经验' }],
      conversationId: 'pb-c3',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })
    await entered
    release(true)
    await run
    expect(repo.list().entries.some((entry) => entry.name === 'r2-playbook')).toBe(true)
  })
})

describe('S3-40C1-R2 新 run 不继承旧批准', () => {
  it('两次独立 run 各自通过真实计划批准桥弹卡，不复用上一轮批准', async () => {
    const { settings, runAgent, ctx } = await runnerSetup()
    mkdirSync(join(fixture.root, 'user'), { recursive: true })
    writeFileSync(
      join(fixture.root, 'user', 'plan-agent.md'),
      '---\nname: plan-agent\ndescription: 计划代理\ntools: []\napproval: plan\n---\n先出计划。',
      'utf8'
    )
    const approvedFor: string[] = []
    ;(ctx as unknown as { planApproval: unknown }).planApproval = {
      request: async (req: { conversationId: string }) => {
        approvedFor.push(req.conversationId)
        return true
      },
      respond: () => false,
      abortAll: () => {}
    }
    let call = 0
    providerCtl.onCall = () => {
      const index = call++
      return index % 2 === 0
        ? { text: '## 方案\n先读后写', toolCalls: [] }
        : { text: 'done', toolCalls: [] }
    }
    const base = {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '做个方案' }],
      agentName: 'plan-agent',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    }

    await runAgent(ctx, { ...base, conversationId: 'plan-c1' })
    await runAgent(ctx, { ...base, conversationId: 'plan-c2' })

    expect(approvedFor).toEqual(['plan-c1', 'plan-c2'])
    expect(providerCtl.calls).toBe(4)
  }, 20000)
})

// ── S3-40C2：子运行权限实时收紧 ─────────────────────────────────────

function writeSubagentDef(root: string, name: string, tools: string[]): void {
  mkdirSync(join(root, 'user'), { recursive: true })
  writeFileSync(
    join(root, 'user', `${name}.md`),
    `---\nname: ${name}\ndescription: 子运行权限测试\ntools: [${tools.join(', ')}]\n---\n执行分配的任务。`,
    'utf8'
  )
}

const spawnJobs = (jobs: Array<{ agent: string; task: string }>) => ({
  text: null,
  toolCalls: [toolCall('spawn-1', 'spawn_agents', { jobs })]
})

describe('S3-40C2 子运行权限实时收紧', () => {
  it('父 run 收紧后：子运行未启动的写工具不启动，文件字节不变', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    writeSubagentDef(fixture.root, 'child-writer', ['write_file'])
    settings.setPermissionPreset('full-access')
    const file = join(ws, 'child-new.txt')
    providerCtl.onCall = (_index, schemas) => {
      if (schemas.includes('spawn_agents')) {
        if (++providerCtl.mainCalls > 1) return { text: 'done', toolCalls: [] }
        return spawnJobs([{ agent: 'child-writer', task: '写 child-new.txt' }])
      }
      settings.setPermissionPreset('write')
      return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'child-new.txt', content: 'hacked' })] }
    }

    const result = await runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '派发写文件' }],
      conversationId: 'c-sub-1',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    expect(existsSync(file)).toBe(false)
    expect(result.output).toBe('done')
    expect(providerCtl.calls).toBe(3)
  }, 20000)

  it('子运行观察到收紧后放宽回原档：写工具仍因代次变化被拒绝', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    writeSubagentDef(fixture.root, 'child-writer', ['write_file'])
    settings.setPermissionPreset('full-access')
    const file = join(ws, 'child-new.txt')
    providerCtl.onCall = (_index, schemas) => {
      if (schemas.includes('spawn_agents')) {
        if (++providerCtl.mainCalls > 1) return { text: 'done', toolCalls: [] }
        return spawnJobs([{ agent: 'child-writer', task: '写 child-new.txt' }])
      }
      settings.setPermissionPreset('read-only')
      settings.setPermissionPreset('full-access')
      return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'child-new.txt', content: 'hacked' })] }
    }

    await runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '派发写文件' }],
      conversationId: 'c-sub-2',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    expect(settings.getPermissionState()).toEqual({ preset: 'full-access', generation: 3 })
    expect(existsSync(file)).toBe(false)
  }, 20000)

  it('子运行读取暂存后父收紧：提交门丢弃读资格，后续写仍要求先读', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    writeSubagentDef(fixture.root, 'child-reader', ['read_file', 'write_file'])
    settings.setPermissionPreset('full-access')
    const a = writeFileAt(ws, 'a.txt', 'A')
    const b = writeFileAt(ws, 'b.txt', 'B')
    providerCtl.onCall = (_index, schemas) => {
      if (schemas.includes('spawn_agents')) {
        if (++providerCtl.mainCalls > 1) return { text: 'done', toolCalls: [] }
        return spawnJobs([{ agent: 'child-reader', task: '读两个文件' }])
      }
      settings.setPermissionPreset('read-only')
      return {
        text: null,
        toolCalls: [toolCall('r1', 'read_file', { path: 'a.txt' }), toolCall('r2', 'read_file', { path: 'b.txt' })]
      }
    }

    await runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '派发读文件' }],
      conversationId: 'c-sub-3',
      requestPolicy: FAST_POLICY,
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    expect(readFileSync(a, 'utf8')).toBe('A')
    expect(readFileSync(b, 'utf8')).toBe('B')
    const write = fileToolsCtl.created.at(-1)!.write
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
  }, 20000)

  it('子运行只能拿到自身声明与父起点的交集，不借用父 run 的写能力', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    writeSubagentDef(fixture.root, 'child-readonly', ['read_file'])
    settings.setPermissionPreset('full-access')
    const file = writeFileAt(ws, 'child.txt', 'original')
    let childSchemas: string[] | null = null
    providerCtl.onCall = (_index, schemas) => {
      if (schemas.includes('spawn_agents')) {
        if (++providerCtl.mainCalls > 1) return { text: 'done', toolCalls: [] }
        return spawnJobs([{ agent: 'child-readonly', task: '读 child.txt' }])
      }
      childSchemas = schemas
      return { text: null, toolCalls: [toolCall('w1', 'write_file', { path: 'child.txt', content: 'hacked' })] }
    }

    await runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '派发只读子代理' }],
      conversationId: 'c-sub-4',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    expect(childSchemas).not.toBeNull()
    expect(childSchemas).toContain('read_file')
    expect(childSchemas).not.toContain('write_file')
    expect(readFileSync(file, 'utf8')).toBe('original')
  }, 20000)

  it('兄弟子 run 的观察状态隔离：一个观察到收紧，另一个仍按原上限执行', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    writeSubagentDef(fixture.root, 'child-a', ['write_file'])
    writeSubagentDef(fixture.root, 'child-b', ['write_file'])
    settings.setPermissionPreset('full-access')
    const a = join(ws, 'a-new.txt')
    const b = join(ws, 'b-new.txt')
    let tighten = false
    let notifyAObserved!: () => void
    const aObserved = new Promise<void>((resolve) => {
      notifyAObserved = resolve
    })
    const readPermissionState = (): { preset: 'read-only' | 'full-access'; generation: number } => {
      if (tighten) {
        notifyAObserved()
        // 受控不一致源：更严档但代次不变 —— 只有真正读到它的那个子 run 应被收紧。
        return { preset: 'read-only', generation: 1 }
      }
      return settings.getPermissionState()
    }
    providerCtl.onCall = (_index, schemas, prompt) => {
      if (schemas.includes('spawn_agents')) {
        if (++providerCtl.mainCalls > 1) return { text: 'done', toolCalls: [] }
        return spawnJobs([
          { agent: 'child-a', task: 'job-A 写 a-new.txt' },
          { agent: 'child-b', task: 'job-B 写 b-new.txt' }
        ])
      }
      if (prompt.includes('job-A')) {
        tighten = true
        return { text: null, toolCalls: [toolCall('wa', 'write_file', { path: 'a-new.txt', content: 'hacked' })] }
      }
      return (async () => {
        await aObserved
        tighten = false
        return { text: null, toolCalls: [toolCall('wb', 'write_file', { path: 'b-new.txt', content: 'B2' })] }
      })()
    }

    await runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '并发派发两个写任务' }],
      conversationId: 'c-sub-5',
      readPermissionState,
      isRunActive: () => true
    })

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(true)
    expect(readFileSync(b, 'utf8')).toBe('B2')
  }, 20000)

  it('子运行命令确认等待期间父收紧：批准后不启动命令', async () => {
    const { settings, runAgent, ctx, ws } = await runnerSetup()
    writeSubagentDef(fixture.root, 'child-cmd', ['run_command'])
    settings.setPermissionPreset('write')
    const marker = join(ws, 'cmd-marker.txt')
    let releaseConfirm!: (approved: boolean) => void
    let confirmStarted!: () => void
    const started = new Promise<void>((resolve) => {
      confirmStarted = resolve
    })
    ;(ctx as unknown as { confirmCommand: (req: unknown) => Promise<boolean> }).confirmCommand =
      async () => {
        confirmStarted()
        return new Promise<boolean>((resolve) => {
          releaseConfirm = resolve
        })
      }
    let childCalls = 0
    providerCtl.onCall = (_index, schemas) => {
      if (schemas.includes('spawn_agents')) {
        if (++providerCtl.mainCalls > 1) return { text: 'done', toolCalls: [] }
        return spawnJobs([{ agent: 'child-cmd', task: '执行命令' }])
      }
      childCalls++
      return childCalls === 1
        ? { text: null, toolCalls: [toolCall('c1', 'run_command', { command: `echo hacked > "${marker}"` })] }
        : { text: 'done', toolCalls: [] }
    }

    const run = runAgent(ctx, {
      settings: MODEL_SETTINGS,
      apiKey: 'k',
      history: [{ role: 'user', content: '派发命令任务' }],
      conversationId: 'c-sub-6',
      readPermissionState: settings.getPermissionState,
      isRunActive: () => true
    })

    await started
    settings.setPermissionPreset('read-only')
    releaseConfirm(true)
    await expect(run).resolves.toBeTruthy()
    expect(existsSync(marker)).toBe(false)
    expect(settings.getPermissionState()).toEqual({ preset: 'read-only', generation: 1 })
  }, 20000)
})
