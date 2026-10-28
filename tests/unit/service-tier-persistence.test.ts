import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/src/store'

/**
 * 实际服务档的请求归属与持久化消费：真实 handler / 真实持久函数 / 真实 renderer store。
 *
 * ⚠️ 平台边界只有 Electron、electron-store 与网络出口（127.0.0.1 本地服务）是替身；
 * 存档链走 schema → conversations-core → 磁盘 → 新仓储实例重读。
 * 本地身份与策略是本地事实：既要能持久关联，又不得进入模型请求。
 */

const platform = vi.hoisted(() => ({ userDataDir: '' }))
const ipcPlatform = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>()
}))

vi.mock('electron', () => {
  const noop = (): void => undefined
  class BrowserWindow {
    static fromWebContents(): null {
      return null
    }
    static getAllWindows(): unknown[] {
      return []
    }
  }
  return {
    app: {
      getVersion: () => '0.13.110-cr1',
      getPath: () => platform.userDataDir || (process.env['TMP'] ?? process.env['TEMP'] ?? '/tmp'),
      getAppPath: () => process.cwd(),
      isPackaged: false,
      on: noop,
      whenReady: async () => undefined
    },
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
        ipcPlatform.handlers.set(channel, fn)
      },
      on: noop,
      removeHandler: noop
    },
    BrowserWindow,
    shell: { openExternal: async () => undefined, trashItem: async () => undefined },
    clipboard: { writeText: noop, readText: () => '' },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    powerSaveBlocker: { start: () => 1, stop: noop },
    session: { defaultSession: {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8')
    },
    protocol: { registerSchemesAsPrivileged: noop, handle: noop },
    net: {
      fetch: () => {
        throw new Error('net.fetch 不在本测试范围')
      }
    },
    nativeImage: { createFromPath: () => ({}) },
    WebContentsView: class {},
    nativeTheme: { on: noop, shouldUseDarkColors: false }
  }
})

vi.mock('electron-store', () => {
  class MemoryStore {
    private data: Record<string, unknown> = {}
    readonly path = '/tmp/jsl-cr1-mock-store.json'
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (opts?.defaults) this.data = { ...opts.defaults }
    }
    get(key: string, fallback?: unknown): unknown {
      return key in this.data ? this.data[key] : fallback
    }
    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'object') Object.assign(this.data, key)
      else this.data[key] = value
    }
    get store(): Record<string, unknown> {
      return this.data
    }
    set store(next: Record<string, unknown>) {
      this.data = next
    }
    has(key: string): boolean {
      return key in this.data
    }
    delete(key: string): void {
      delete this.data[key]
    }
    clear(): void {
      this.data = {}
    }
    onDidChange(): () => void {
      return () => undefined
    }
  }
  return { default: MemoryStore }
})

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'jsl-cr1-'))
platform.userDataDir = DATA_ROOT

interface CapturedHttp {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface LocalServer {
  baseURL: string
  requests: CapturedHttp[]
  close(): Promise<void>
}

const localServers: LocalServer[] = []
const localDirs: string[] = []

async function startLocalServer(
  responder: (req: CapturedHttp, res: import('node:http').ServerResponse, index: number) => void
): Promise<LocalServer> {
  const { createServer } = await import('node:http')
  const requests: CapturedHttp[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const captured: CapturedHttp = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }
      requests.push(captured)
      responder(captured, res, requests.length - 1)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('本地服务未取到端口')
  const handle: LocalServer = {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
  localServers.push(handle)
  return handle
}

function replyJson(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

interface SentEvent {
  channel: string
  envelope: Record<string, unknown>
}

interface Harness {
  call(channel: string, raw?: unknown): Promise<unknown>
  events: SentEvent[]
}

async function boot(): Promise<Harness> {
  const { registerIpcHandlers } = await import('@main/ipc')
  const { createCheckpointStore } = await import('@main/store/checkpoints')
  const { mkdirSync } = await import('node:fs')
  const workspace = join(DATA_ROOT, 'ws')
  mkdirSync(workspace, { recursive: true })
  const userAgentsDir = join(DATA_ROOT, 'user-agents')
  mkdirSync(userAgentsDir, { recursive: true })
  const agent = {
    getWorkspaceRoot: () => workspace,
    builtinAgentsDir: join(DATA_ROOT, 'builtin'),
    userAgentsDir,
    checkpoints: createCheckpointStore(join(DATA_ROOT, 'checkpoints'))
  }
  const events: SentEvent[] = []
  registerIpcHandlers({
    agent,
    userDataDir: DATA_ROOT,
    trash: async () => undefined,
    memory: {
      list: () => ({ entries: [] }),
      record: () => undefined,
      beginTurn: () => ({ drain: () => ({ written: [], rejected: [] }) })
    },
    playbook: { list: () => ({ entries: [] }), recall: () => [] },
    confirm: async () => true,
    ask: { ask: async () => ({ answer: '' }) },
    planApproval: { request: async () => false },
    terminal: {},
    system: {},
    network: {},
    execEventSink: { append: () => undefined },
    clientVersion: '0.13.110-cr1'
  } as unknown as Parameters<typeof registerIpcHandlers>[0])
  return {
    events,
    call: async (channel, raw) => {
      const handler = ipcPlatform.handlers.get(channel)
      if (!handler) throw new Error(`handler 未注册：${channel}`)
      const sender = {
        isDestroyed: () => false,
        send: (ch: string, enveloped: unknown) => {
          events.push({ channel: ch, envelope: enveloped as Record<string, unknown> })
        }
      }
      return await handler({ sender }, raw)
    }
  }
}

async function seedEndpoint(baseURL: string, options: { speedMode?: 'fast' | 'normal'; tier?: string[] } = {}): Promise<void> {
  const store = await import('@main/store/models')
  const saved = store.saveEndpoint({
    name: `cr1-${Math.random().toString(36).slice(2, 8)}`,
    providerType: 'anthropic',
    baseURL,
    timeoutMs: 60_000,
    stream: true,
    apiKey: 'sk-cr1',
    models: [
      {
        id: 'm-cr1',
        model: 'cr1-model',
        ...(options.speedMode ? { speedMode: options.speedMode } : {}),
        ...(options.tier
          ? { metadata: { serviceTiers: { official: { value: options.tier, observedAt: Date.now() } } } }
          : {}),
        settings: { authentication: 'bearer', requestIdentity: 'opencode-v1' }
      }
    ]
  })
  store.setActiveProfile(saved.id)
}

let conversationSeq = 0

async function createConversation(): Promise<{ id: string; firstMessage: string }> {
  const store = await import('@main/store/conversations')
  const firstMessage = `第一条-${++conversationSeq}`
  const conversation = store.createConversation({
    workspace: join(DATA_ROOT, 'ws'),
    model: 'cr1-model',
    firstMessage
  })
  return { id: conversation.id, firstMessage }
}

const POLICY = {
  mode: 'fast' as const,
  maxLocalReadConcurrency: 2 as const,
  requestedServiceTier: 'priority',
  tierSupport: 'supported' as const
}
const OBSERVED = { requested: 'auto', actual: 'priority', observed: true as const }

function assistantWithFacts(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: '上一轮回答',
    createdAt: Date.now(),
    terminal: { state: 'completed' },
    requestId: '88888888-8888-4888-8888-888888888888',
    requestPolicy: { ...POLICY },
    serviceTier: { ...OBSERVED },
    ...extra
  }
}

function userMessage(text: string): Record<string, unknown> {
  return { role: 'user', content: text, createdAt: Date.now() }
}

afterEach(async () => {
  while (localServers.length > 0) {
    const handle = localServers.pop()
    if (handle) await handle.close()
  }
  const { rmSync: rm } = await import('node:fs')
  for (const dir of localDirs.splice(0)) rm(dir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true })
})

describe('持久链：schema → core → 磁盘 → 重读', () => {
  it('assistant 的运行事实不被白名单剥离，磁盘与新仓储实例重读一致', async () => {
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const conv = await createConversation()
    const messages = [userMessage(conv.firstMessage), assistantWithFacts(), userMessage('继续')]
    await harness.call(IPC.convSave, { id: conv.id, messages })

    const reread = (await harness.call(IPC.convGet, conv.id)) as {
      messages: Array<Record<string, unknown>>
    }
    const saved = reread.messages[1]!
    expect(saved['requestId']).toBe('88888888-8888-4888-8888-888888888888')
    expect(saved['requestPolicy']).toEqual(POLICY)
    expect(saved['serviceTier']).toEqual(OBSERVED)

    const { messagesFilePath } = await import('@main/store/conversations-fs')
    const onDisk = JSON.parse(readFileSync(messagesFilePath(DATA_ROOT, conv.id), 'utf8')) as Array<
      Record<string, unknown>
    >
    expect(onDisk[1]!['requestId']).toBe('88888888-8888-4888-8888-888888888888')
    expect(onDisk[1]!['serviceTier']).toEqual(OBSERVED)

    // 模块重启等价：新仓储实例直接读同一目录
    const { createConversationsRepo } = await import('@main/store/conversations-core')
    const { createFsConversationsBackend, nodeFsAdapter } = await import('@main/store/conversations-fs')
    const fresh = createConversationsRepo(createFsConversationsBackend(DATA_ROOT, nodeFsAdapter))
    const restarted = fresh.getConversation(conv.id)!
    const restartedTail = restarted.messages[1]!
    expect(restartedTail.requestId).toBe('88888888-8888-4888-8888-888888888888')
    expect(restartedTail.requestPolicy).toEqual(POLICY)
    expect(restartedTail.serviceTier).toEqual(OBSERVED)
  })

  it('无观测不写 actual；下一轮缺报不继承上一轮 actual；旧档缺字段照常读取', async () => {
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const conv = await createConversation()
    const unknown = { requested: 'auto', actual: null, observed: false as const }
    const nextId = '99999999-9999-4999-8999-999999999999'
    await harness.call(IPC.convSave, {
      id: conv.id,
      messages: [
        userMessage(conv.firstMessage),
        assistantWithFacts(),
        userMessage('继续'),
        assistantWithFacts({ requestId: nextId, content: '下一轮回答', serviceTier: unknown })
      ]
    })
    const got = (await harness.call(IPC.convGet, conv.id)) as { messages: Array<Record<string, unknown>> }
    // 第一轮真实观测保留；第二轮缺报保持未知，不继承上一轮 actual
    expect(got.messages[1]!['serviceTier']).toEqual(OBSERVED)
    expect(got.messages[3]!['serviceTier']).toEqual(unknown)
    expect(got.messages[3]!['requestId']).toBe(nextId)

    const legacy = await createConversation()
    await harness.call(IPC.convSave, {
      id: legacy.id,
      messages: [userMessage(legacy.firstMessage), { role: 'assistant', content: '旧档' }, userMessage('继续')]
    })
    const legacyGot = (await harness.call(IPC.convGet, legacy.id)) as {
      messages: Array<Record<string, unknown>>
    }
    expect('requestId' in legacyGot.messages[1]!).toBe(false)
    expect('serviceTier' in legacyGot.messages[1]!).toBe(false)
  })

  it('矛盾数据与错误归属 fail-closed，且不落盘', async () => {
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const conv = await createConversation()
    const base = [userMessage(conv.firstMessage), assistantWithFacts(), userMessage('继续')]

    const cases: Array<Record<string, unknown>> = [
      // observed=false 但 actual 有值
      { ...assistantWithFacts({ serviceTier: { requested: 'auto', actual: 'priority', observed: false } }) },
      // 运行事实挂到 user 上
      { role: 'user', content: 'x', requestId: '99999999-9999-4999-8999-999999999999' },
      // 有策略但没有可归属的 requestId
      { role: 'assistant', content: 'y', terminal: { state: 'completed' }, requestPolicy: { ...POLICY } },
      // 非 UUID
      { role: 'assistant', content: 'z', terminal: { state: 'completed' }, requestId: 'not-a-uuid' }
    ]
    for (const bad of cases) {
      await expect(
        harness.call(IPC.convSave, {
          id: conv.id,
          messages: [base[0], bad, base[2]]
        })
      ).rejects.toThrow()
    }
    const got = (await harness.call(IPC.convGet, conv.id)) as { messages: Array<Record<string, unknown>> }
    expect(got.messages).toHaveLength(1) // 只有 createConversation 的首条 user，四次拒存都没落盘
  })
})

describe('出站 Canary：本地事实不进模型请求', () => {
  it('真实 HTTP 抓包：本地 ID / 策略 / 档位不出现在 headers 或 body', async () => {
    const server = await startLocalServer((_req, res) =>
      replyJson(res, {
        content: [{ type: 'text', text: '完成' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1, service_tier: 'priority' }
      })
    )
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const previousId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const currentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-cr1-canary',
      messages: [
        userMessage('上一轮'),
        assistantWithFacts({ requestId: previousId }),
        userMessage('这一轮')
      ],
      requestId: currentId
    })
    const done = harness.events.find((event) => event.channel.includes('done'))!
    expect(done.envelope.requestId).toBe(currentId)
    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    const headerText = JSON.stringify(captured.headers)
    for (const forbidden of [previousId, currentId, 'requestPolicy', 'serviceTier', 'maxLocalReadConcurrency', 'tierSupport']) {
      expect(headerText).not.toContain(forbidden)
      expect(captured.body).not.toContain(forbidden)
    }
    expect(captured.headers['x-opencode-session']).not.toBe(currentId)
  })
})

// ── renderer store：发起绑定、迟到拒收、结算与持久载荷 ─────────────────────

const CONV = (id: string): Record<string, unknown> => ({
  id,
  title: 't',
  workspace: join(DATA_ROOT, 'ws'),
  model: 'cr1-model',
  skills: [],
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0
})

function freshState(activeId: string): void {
  useAppStore.setState({
    activeId,
    messages: [],
    streaming: false,
    streamError: null,
    reasoning: '',
    toolEvents: [],
    todos: [],
    subagents: [],
    runtimes: {},
    usageByConversation: {},
    conversations: [CONV(activeId) as never],
    saveError: null
  })
}

function stubApi(): {
  chatSend: ReturnType<typeof vi.fn>
  saveConversation: ReturnType<typeof vi.fn>
  chatAbort: ReturnType<typeof vi.fn>
} {
  const api = {
    chatSend: vi.fn(async () => undefined),
    saveConversation: vi.fn(async () => null),
    chatAbort: vi.fn(async () => undefined)
  }
  vi.stubGlobal('window', { api })
  return api
}

describe('renderer：发起即绑定与事件归属', () => {
  it('发起前生成 UUID 并绑定草稿，旧轮 chunk 不污染新轮', async () => {
    freshState('conv-r1')
    const api = stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const sendArg = api.chatSend.mock.calls[0]![0] as { requestId?: string }
    expect(sendArg.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    const draft = useAppStore.getState().messages.at(-1)!
    expect(draft.requestId).toBe(sendArg.requestId)
    expect(useAppStore.getState().streaming).toBe(true)

    useAppStore.getState().appendChunk({ conversationId: 'conv-r1', payload: '旧轮的字', requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    expect(useAppStore.getState().messages.at(-1)!.content).toBe('')
    useAppStore.getState().appendChunk({ conversationId: 'conv-r1', payload: '新轮的字', requestId: draft.requestId })
    expect(useAppStore.getState().messages.at(-1)!.content).toBe('新轮的字')
  })

  it('旧轮迟到 done 不改新轮终态/用量/档位，也不把 streaming 置 false', async () => {
    freshState('conv-r2')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const currentId = useAppStore.getState().messages.at(-1)!.requestId
    useAppStore.getState().markDone({
      conversationId: 'conv-r2',
      requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      requestPolicy: { ...POLICY },
      payload: { usage: null, usageComplete: true, terminal: { state: 'completed' }, serviceTier: { ...OBSERVED } }
    })
    const st = useAppStore.getState()
    expect(st.streaming).toBe(true)
    expect(st.messages.at(-1)!.terminal).toBeUndefined()
    expect(st.messages.at(-1)!.serviceTier).toBeUndefined()
    expect(st.usageByConversation['conv-r2']).toBeUndefined()
    expect(currentId).toBeTruthy()
  })

  it('停止后当轮迟到结算仍保留终态/档位/策略，且只计一次', async () => {
    freshState('conv-r3')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const requestId = useAppStore.getState().messages.at(-1)!.requestId!
    await useAppStore.getState().stopStreaming()
    expect(useAppStore.getState().streaming).toBe(false)

    const payload = {
      usage: { promptTokens: 7, completionTokens: 1, cachedPromptTokens: null, reasoningTokens: null },
      usageComplete: true,
      terminal: { state: 'cancelled' as const, code: 'user-stop' as const },
      serviceTier: { ...OBSERVED }
    }
    useAppStore.getState().markDone({ conversationId: 'conv-r3', requestId, requestPolicy: { ...POLICY }, payload })
    let st = useAppStore.getState()
    const tail = st.messages.at(-1)!
    expect(tail.terminal).toEqual({ state: 'cancelled', code: 'user-stop' })
    expect(tail.serviceTier).toEqual(OBSERVED)
    expect(tail.requestPolicy).toEqual(POLICY)
    expect(st.usageByConversation['conv-r3']?.total.promptTokens).toBe(7)

    // 重复 done 不累加
    useAppStore.getState().markDone({ conversationId: 'conv-r3', requestId, requestPolicy: { ...POLICY }, payload })
    st = useAppStore.getState()
    expect(st.usageByConversation['conv-r3']?.total.promptTokens).toBe(7)
    expect(st.messages.at(-1)!.terminal).toEqual({ state: 'cancelled', code: 'user-stop' })
  })

  it('成功后的迟到错误不改终态、不覆盖成功、不累加用量', async () => {
    freshState('conv-r4')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const requestId = useAppStore.getState().messages.at(-1)!.requestId!
    useAppStore.getState().markDone({
      conversationId: 'conv-r4',
      requestId,
      requestPolicy: { ...POLICY },
      payload: {
        usage: { promptTokens: 3, completionTokens: 2, cachedPromptTokens: null, reasoningTokens: null },
        usageComplete: true,
        terminal: { state: 'completed' },
        serviceTier: { ...OBSERVED }
      }
    })
    useAppStore.getState().markError({
      conversationId: 'conv-r4',
      requestId,
      requestPolicy: { ...POLICY },
      payload: {
        message: '迟到的错误',
        terminal: { state: 'failed', code: 'upstream-error' },
        usage: { promptTokens: 9, completionTokens: 9, cachedPromptTokens: null, reasoningTokens: null },
        usageComplete: true
      }
    })
    const st = useAppStore.getState()
    expect(st.messages.at(-1)!.terminal).toEqual({ state: 'completed' })
    expect(st.usageByConversation['conv-r4']?.total.promptTokens).toBe(3)
    expect(st.streamError).toBeNull()
  })

  it('零 chunk 失败也能按 requestId 结算并写回事实', async () => {
    freshState('conv-r5')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const requestId = useAppStore.getState().messages.at(-1)!.requestId!
    useAppStore.getState().markError({
      conversationId: 'conv-r5',
      requestId,
      requestPolicy: { ...POLICY },
      payload: {
        message: '上游失败',
        terminal: { state: 'failed', code: 'upstream-error' },
        usage: null,
        usageComplete: false,
        serviceTier: { requested: 'auto', actual: null, observed: false }
      }
    })
    const tail = useAppStore.getState().messages.at(-1)!
    expect(tail.terminal).toEqual({ state: 'failed', code: 'upstream-error' })
    expect(tail.requestPolicy).toEqual(POLICY)
    expect(tail.serviceTier).toEqual({ requested: 'auto', actual: null, observed: false })
    expect(useAppStore.getState().streaming).toBe(false)
  })

  it('双会话并发各自归属；已删会话的迟到事件不复活', async () => {
    freshState('conv-a')
    stubApi()
    await useAppStore.getState().sendMessage('A 的问题')
    const idA = useAppStore.getState().messages.at(-1)!.requestId!
    useAppStore.getState().archiveCurrent()

    useAppStore.setState({
      activeId: 'conv-b',
      messages: [],
      streaming: false,
      streamError: null,
      reasoning: '',
      toolEvents: [],
      todos: [],
      subagents: [],
      conversations: [CONV('conv-a') as never, CONV('conv-b') as never]
    })
    await useAppStore.getState().sendMessage('B 的问题')
    const idB = useAppStore.getState().messages.at(-1)!.requestId!

    useAppStore.getState().appendChunk({ conversationId: 'conv-a', payload: 'A 的字', requestId: idA })
    useAppStore.getState().appendChunk({ conversationId: 'conv-a', payload: '串台', requestId: idB })
    expect(useAppStore.getState().runtimes['conv-a']!.messages.at(-1)!.content).toBe('A 的字')

    // 删除 B 的现场后，B 的迟到终态不得复活它
    useAppStore.setState((s) => {
      const runtimes = { ...s.runtimes }
      delete runtimes['conv-b']
      return { runtimes, activeId: 'conv-a', messages: s.runtimes['conv-a']!.messages }
    })
    useAppStore.getState().markDone({
      conversationId: 'conv-b',
      requestId: idB,
      requestPolicy: { ...POLICY },
      payload: { usage: null, usageComplete: true, terminal: { state: 'completed' } }
    })
    expect(useAppStore.getState().runtimes['conv-b']).toBeUndefined()
    expect(useAppStore.getState().usageByConversation['conv-b']).toBeUndefined()
  })

  it('落盘载荷携带本地事实，供主进程白名单保存', async () => {
    freshState('conv-r6')
    const api = stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const requestId = useAppStore.getState().messages.at(-1)!.requestId!
    useAppStore.getState().markDone({
      conversationId: 'conv-r6',
      requestId,
      requestPolicy: { ...POLICY },
      payload: {
        usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: null, reasoningTokens: null },
        usageComplete: true,
        terminal: { state: 'completed' },
        serviceTier: { ...OBSERVED }
      }
    })
    await vi.waitFor(() => {
      expect(api.saveConversation).toHaveBeenCalled()
    })
    const lastCall = api.saveConversation.mock.calls.at(-1)!
    const messages = lastCall[1] as Array<Record<string, unknown>>
    const tail = messages.at(-1)!
    expect(tail['requestId']).toBe(requestId)
    expect(tail['requestPolicy']).toEqual(POLICY)
    expect(tail['serviceTier']).toEqual(OBSERVED)
  })
})

// ── 归属门：无身份旧帧不得落到已绑定身份的新草稿 ─────────────────────────

describe('renderer：新草稿的归属门', () => {
  const noId = { conversationId: 'conv-gate' }

  it('无身份旧帧一律拒收（chunk/reasoning/tool/done/error），不结算新轮', async () => {
    freshState('conv-gate')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    const requestId = useAppStore.getState().messages.at(-1)!.requestId!
    expect(requestId).toBeTruthy()

    useAppStore.getState().appendChunk({ ...noId, payload: '旧正文' })
    useAppStore.getState().appendReasoning({ ...noId, payload: '旧思考' })
    useAppStore.getState().pushToolEvent({
      ...noId,
      payload: { id: 't-old', name: '旧工具', phase: 'start' }
    })
    useAppStore.getState().markDone({
      ...noId,
      payload: {
        usage: { promptTokens: 9, completionTokens: 9, cachedPromptTokens: null, reasoningTokens: null },
        usageComplete: true,
        terminal: { state: 'completed' }
      }
    })
    useAppStore.getState().markError({ ...noId, payload: '旧错误' })

    const st = useAppStore.getState()
    expect(st.messages.at(-1)!.content).toBe('')
    expect(st.reasoning).toBe('')
    expect(st.toolEvents).toHaveLength(0)
    expect(st.messages.at(-1)!.terminal).toBeUndefined()
    expect(st.usageByConversation['conv-gate']).toBeUndefined()
    expect(st.streaming).toBe(true)
    expect(st.streamError).toBeNull()
  })

  it('已删会话的无身份事件不复活会话', async () => {
    freshState('conv-deleted')
    stubApi()
    await useAppStore.getState().sendMessage('问题')
    useAppStore.setState({ activeId: 'conv-elsewhere', messages: [], runtimes: {}, conversations: [] })

    useAppStore.getState().appendChunk({ conversationId: 'conv-deleted', payload: '迟到' })
    useAppStore.getState().markDone({
      conversationId: 'conv-deleted',
      payload: { usage: null, usageComplete: true, terminal: { state: 'completed' } }
    })
    const st = useAppStore.getState()
    expect(st.runtimes['conv-deleted']).toBeUndefined()
    expect(st.usageByConversation['conv-deleted']).toBeUndefined()
    expect(st.messages).toHaveLength(0)
  })

  it('旧草稿没有身份时仍按旧行为兼容', () => {
    useAppStore.setState({
      activeId: 'conv-legacy-draft',
      messages: [{ role: 'assistant', content: '', segments: [] }],
      streaming: true,
      streamError: null,
      reasoning: '',
      toolEvents: [],
      todos: [],
      subagents: [],
      runtimes: {},
      usageByConversation: {},
      conversations: [CONV('conv-legacy-draft') as never]
    })
    stubApi()

    useAppStore.getState().appendChunk({ conversationId: 'conv-legacy-draft', payload: '旧字' })
    useAppStore.getState().markDone({
      conversationId: 'conv-legacy-draft',
      payload: { usage: null, usageComplete: true, terminal: { state: 'completed' } }
    })
    const st = useAppStore.getState()
    expect(st.messages.at(-1)!.content).toBe('旧字')
    expect(st.messages.at(-1)!.terminal).toEqual({ state: 'completed' })
    expect(st.streaming).toBe(false)
  })

  it('后台来源的无身份 todos / subagents 刷新仍被接受', async () => {
    freshState('conv-bg')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    expect(useAppStore.getState().messages.at(-1)!.requestId).toBeTruthy()

    useAppStore.getState().setTodos({
      conversationId: 'conv-bg',
      payload: [{ id: 'todo-1', text: '后台刷新', status: 'pending' }]
    })
    useAppStore.getState().setSubagents({
      conversationId: 'conv-bg',
      payload: [{ runId: 'run-bg', name: 'child', index: 0, phase: 'start', task: '后台任务', startedAt: 1 }]
    })
    const st = useAppStore.getState()
    expect(st.todos).toHaveLength(1)
    expect(st.subagents).toHaveLength(1)
  })
})

// ── invoke 迟到拒绝：只结束自己的 Promise，不覆盖新轮/已结算事实 ───────────

describe('renderer：sendMessage 迟到拒绝的归属', () => {
  it('A 的 invoke 晚拒绝不回滚已开始的 B 轮', async () => {
    freshState('conv-late-a')
    const api = stubApi()
    let rejectA!: (err: Error) => void
    const deferredA = new Promise<void>((_resolve, reject) => {
      rejectA = reject
    })
    api.chatSend.mockImplementationOnce(() => deferredA)

    const pendingA = useAppStore.getState().sendMessage('A 的问题')
    const idA = useAppStore.getState().messages.at(-1)!.requestId!
    await useAppStore.getState().stopStreaming()

    api.chatSend.mockImplementationOnce(async () => undefined)
    await useAppStore.getState().sendMessage('B 的问题')
    const idB = useAppStore.getState().messages.at(-1)!.requestId!
    const before = useAppStore.getState().messages

    rejectA(new Error('A 的 invoke 迟到拒绝'))
    await pendingA

    const after = useAppStore.getState()
    expect(idA).not.toBe(idB)
    expect(after.messages).toEqual(before)
    expect(after.messages.at(-1)!.requestId).toBe(idB)
    expect(after.streaming).toBe(true)
    expect(after.streamError).toBeNull()
  })

  it('同一轮先收到成功终态后，invoke 迟到拒绝不丢终态与档位', async () => {
    freshState('conv-late-b')
    const api = stubApi()
    let rejectA!: (err: Error) => void
    const deferredA = new Promise<void>((_resolve, reject) => {
      rejectA = reject
    })
    api.chatSend.mockImplementationOnce(() => deferredA)

    const pendingA = useAppStore.getState().sendMessage('问题')
    const requestId = useAppStore.getState().messages.at(-1)!.requestId!
    useAppStore.getState().markDone({
      conversationId: 'conv-late-b',
      requestId,
      requestPolicy: { ...POLICY },
      payload: {
        usage: { promptTokens: 4, completionTokens: 1, cachedPromptTokens: null, reasoningTokens: null },
        usageComplete: true,
        terminal: { state: 'completed' },
        serviceTier: { ...OBSERVED }
      }
    })
    rejectA(new Error('迟到拒绝'))
    await pendingA

    const st = useAppStore.getState()
    expect(st.messages.at(-1)!.terminal).toEqual({ state: 'completed' })
    expect(st.messages.at(-1)!.serviceTier).toEqual(OBSERVED)
    expect(st.usageByConversation['conv-late-b']?.total.promptTokens).toBe(4)
    expect(st.streamError).toBeNull()
  })

  it('当前仍未接受的入参失败：保留友好错误与草稿回滚', async () => {
    freshState('conv-input-fail')
    const api = stubApi()
    api.chatSend.mockRejectedValueOnce(
      new Error('参数不合法：messages.0.content —— 不能为空')
    )
    const ok = await useAppStore.getState().sendMessage('新问题')
    const st = useAppStore.getState()
    expect(ok).toBe(false)
    expect(st.messages).toHaveLength(0)
    expect(st.streaming).toBe(false)
    expect(st.streamError).toContain('参数不合法')
  })
})

// ── 持久事实的形状与内部一致性（IPC 与 core 直调都收口） ─────────────────

describe('持久事实一致性：非法组合不落盘', () => {
  const badPolicies: Array<Record<string, unknown>> = [
    { mode: 'normal', maxLocalReadConcurrency: 2, requestedServiceTier: null, tierSupport: 'supported' },
    { mode: 'fast', maxLocalReadConcurrency: 2, requestedServiceTier: 'priority', tierSupport: 'unknown' },
    { mode: 'fast', maxLocalReadConcurrency: 2, requestedServiceTier: null, tierSupport: 'supported' },
    { mode: 'normal', maxLocalReadConcurrency: 1, requestedServiceTier: 'priority', tierSupport: 'supported' },
    { mode: 'fast', maxLocalReadConcurrency: 1, requestedServiceTier: 'priority', tierSupport: 'supported' }
  ]
  const badTiers: Array<Record<string, unknown>> = [
    { requested: 'auto', actual: '   ', observed: true },
    { requested: '   ', actual: null, observed: false },
    { requested: 'auto', actual: 'x'.repeat(65), observed: true }
  ]
  const badIds = ['', 'not-a-uuid', '1'.repeat(200)]

  it('IPC 白名单拒收 policy 矛盾 / 空白档 / 非法身份', async () => {
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const conv = await createConversation()
    const bads: Array<Record<string, unknown>> = [
      ...badPolicies.map((p) => assistantWithFacts({ requestPolicy: p })),
      ...badTiers.map((t) => assistantWithFacts({ serviceTier: t })),
      ...badIds.map((id) => assistantWithFacts({ requestId: id }))
    ]
    for (const bad of bads) {
      await expect(
        harness.call(IPC.convSave, {
          id: conv.id,
          messages: [userMessage(conv.firstMessage), bad, userMessage('继续')]
        })
      ).rejects.toThrow()
    }
    const got = (await harness.call(IPC.convGet, conv.id)) as { messages: Array<Record<string, unknown>> }
    expect(got.messages).toHaveLength(1)
  })

  it('直接调用 conversations-core 同样拒收同一批坏数据', async () => {
    const store = await import('@main/store/conversations')
    const conv = await createConversation()
    const base = [userMessage(conv.firstMessage), assistantWithFacts(), userMessage('继续')]
    const bads: Array<Record<string, unknown>> = [
      ...badPolicies.map((p) => assistantWithFacts({ requestPolicy: p })),
      ...badTiers.map((t) => assistantWithFacts({ serviceTier: t })),
      ...badIds.map((id) => assistantWithFacts({ requestId: id })),
      assistantWithFacts({ requestPolicy: { ...POLICY, mode: 'turbo' } }),
      assistantWithFacts({ requestId: undefined, requestPolicy: { ...POLICY } })
    ]
    for (const bad of bads) {
      expect(() => store.saveConversation(conv.id, [base[0] as never, bad as never, base[2] as never])).toThrow()
    }
  })

  it('合法 OpenAI / Anthropic 观测、未知与旧档仍可保存重读', async () => {
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const cases: Array<Record<string, unknown>> = [
      assistantWithFacts({ serviceTier: { requested: 'priority', actual: 'priority', observed: true } }),
      assistantWithFacts({ serviceTier: { requested: 'auto', actual: 'priority', observed: true } }),
      assistantWithFacts({ serviceTier: { requested: 'auto', actual: null, observed: false } }),
      assistantWithFacts({ serviceTier: { requested: null, actual: 'standard', observed: true } })
    ]
    for (const assistant of cases) {
      const conv = await createConversation()
      await harness.call(IPC.convSave, {
        id: conv.id,
        messages: [userMessage(conv.firstMessage), assistant, userMessage('继续')]
      })
      const got = (await harness.call(IPC.convGet, conv.id)) as { messages: Array<Record<string, unknown>> }
      expect(got.messages[1]!['serviceTier']).toEqual(assistant['serviceTier'])
    }
  })
})

// ── 进度事件：带身份的事件同样要过归属门，只有无身份后台刷新走会话级放行 ───

describe('renderer：带身份的旧轮进度事件同样归属', () => {
  const OLD_ID = 'aaaa1111-1111-4111-8111-111111111111'
  const todo = (id: string, text: string): Array<Record<string, unknown>> => [
    { id, text, status: 'pending' }
  ]
  const sub = (runId: string, name: string): Array<Record<string, unknown>> => [
    { runId, name, index: 0, phase: 'start', task: name, startedAt: 1 }
  ]

  it('新轮 B 在跑时，带 A 旧 requestId 的 todos / subagents 不覆盖 B', async () => {
    freshState('conv-prog')
    stubApi()
    await useAppStore.getState().sendMessage('B 的问题')
    const idB = useAppStore.getState().messages.at(-1)!.requestId!

    useAppStore.getState().setTodos({ conversationId: 'conv-prog', requestId: idB, payload: todo('b', 'B 待办') as never })
    useAppStore.getState().setSubagents({ conversationId: 'conv-prog', requestId: idB, payload: sub('rb', 'B-sub') as never })
    expect(useAppStore.getState().todos).toHaveLength(1)
    expect(useAppStore.getState().subagents).toHaveLength(1)

    useAppStore.getState().setTodos({ conversationId: 'conv-prog', requestId: OLD_ID, payload: todo('a', 'A 旧待办') as never })
    useAppStore.getState().setSubagents({ conversationId: 'conv-prog', requestId: OLD_ID, payload: sub('ra', 'A-sub') as never })
    const st = useAppStore.getState()
    expect(st.todos[0]!['id']).toBe('b')
    expect(st.subagents[0]!['runId']).toBe('rb')
  })

  it('无身份的合法后台刷新仍可消费', async () => {
    freshState('conv-prog-bg')
    stubApi()
    await useAppStore.getState().sendMessage('新问题')
    expect(useAppStore.getState().messages.at(-1)!.requestId).toBeTruthy()

    useAppStore.getState().setTodos({ conversationId: 'conv-prog-bg', payload: todo('bg', '后台待办') as never })
    useAppStore.getState().setSubagents({ conversationId: 'conv-prog-bg', payload: sub('rbg', '后台子代理') as never })
    expect(useAppStore.getState().todos).toHaveLength(1)
    expect(useAppStore.getState().subagents).toHaveLength(1)
  })

  it('已删会话的进度事件（带身份与无身份）都不复活', async () => {
    freshState('conv-prog-del')
    stubApi()
    await useAppStore.getState().sendMessage('问题')
    useAppStore.setState({
      activeId: 'conv-elsewhere',
      messages: [],
      todos: [],
      subagents: [],
      runtimes: {},
      conversations: []
    })

    useAppStore.getState().setTodos({ conversationId: 'conv-prog-del', requestId: OLD_ID, payload: todo('x', '迟到') as never })
    useAppStore.getState().setSubagents({ conversationId: 'conv-prog-del', payload: sub('rx', '迟到') as never })
    const st = useAppStore.getState()
    expect(st.runtimes['conv-prog-del']).toBeUndefined()
    expect(st.todos).toHaveLength(0)
    expect(st.subagents).toHaveLength(0)
  })

  it('旧草稿无身份时，带身份的进度事件仍按 R2 规则兼容', () => {
    useAppStore.setState({
      activeId: 'conv-prog-legacy',
      messages: [{ role: 'assistant', content: '', segments: [] }],
      streaming: true,
      streamError: null,
      reasoning: '',
      toolEvents: [],
      todos: [],
      subagents: [],
      runtimes: {},
      usageByConversation: {},
      conversations: [CONV('conv-prog-legacy') as never]
    })
    stubApi()
    useAppStore.getState().setTodos({ conversationId: 'conv-prog-legacy', requestId: OLD_ID, payload: todo('l', '旧草稿') as never })
    useAppStore.getState().setSubagents({ conversationId: 'conv-prog-legacy', requestId: OLD_ID, payload: sub('rl', '旧草稿') as never })
    expect(useAppStore.getState().todos).toHaveLength(1)
    expect(useAppStore.getState().subagents).toHaveLength(1)
  })
})
