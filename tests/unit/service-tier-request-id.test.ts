import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatEmitter } from '@main/chat-emitter'

/**
 * 本地轮次身份（requestId）与冻结请求策略：真实 `registerIpcHandlers` + 本地 HTTP。
 *
 * ⚠️ 断言对象是**真实** chatSend handler、真实 runner 与真实 emitter；只把 Electron 平台边界、
 * electron-store 与网络出口（指向 127.0.0.1 本地服务）替换为替身。
 * 身份只用于本地信封：出站 headers / body 一律不得出现 requestId 或策略诊断字段。
 */

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
      getVersion: () => '0.13.110-c0',
      getPath: () => process.env['TMP'] ?? process.env['TEMP'] ?? '/tmp',
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
    readonly path = '/tmp/jsl-c0-mock-store.json'
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

function successBody(): Record<string, unknown> {
  return { content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }
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
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'jsl-c0-'))
  localDirs.push(base)
  const workspace = join(base, 'ws')
  mkdirSync(workspace, { recursive: true })
  const userAgentsDir = join(base, 'user')
  mkdirSync(userAgentsDir, { recursive: true })
  const agent = {
    getWorkspaceRoot: () => workspace,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir,
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
  const events: SentEvent[] = []
  registerIpcHandlers({
    agent,
    userDataDir: base,
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
    clientVersion: '0.13.110-c0'
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

/** 保存并激活一个 Anthropic 端点；opencode-v1 身份用于验证本地 ID 不撞供应商会话键。 */
async function seedEndpoint(
  baseURL: string,
  options: { speedMode?: 'fast' | 'normal'; tier?: string[] } = {}
): Promise<{ id: string }> {
  const store = await import('@main/store/models')
  const saved = store.saveEndpoint({
    name: `c0-${Math.random().toString(36).slice(2, 8)}`,
    providerType: 'anthropic',
    baseURL,
    timeoutMs: 60_000,
    stream: true,
    apiKey: 'sk-c0',
    models: [
      {
        id: 'm-c0',
        model: 'c0-model',
        ...(options.speedMode ? { speedMode: options.speedMode } : {}),
        ...(options.tier
          ? {
              metadata: {
                serviceTiers: { official: { value: options.tier, observedAt: Date.now() } }
              }
            }
          : {}),
        settings: { authentication: 'bearer', requestIdentity: 'opencode-v1' }
      }
    ]
  })
  store.setActiveProfile(saved.id)
  return { id: saved.id }
}

async function setOverride(conversationId: string, mode: 'inherit' | 'normal' | 'fast'): Promise<void> {
  const ui = await import('@main/store/ui-prefs')
  ui.setUIPref({ conversationSpeedOverrides: { [conversationId]: mode } })
}

function eventOf(events: SentEvent[], kind: 'done' | 'error'): SentEvent | undefined {
  return events.find((event) => event.channel.includes(kind))
}

function payloadOf(event: SentEvent | undefined): Record<string, unknown> {
  const inner = event?.envelope.payload
  expect(inner, '事件必须带载荷').toBeTypeOf('object')
  return inner as Record<string, unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

afterEach(async () => {
  while (localServers.length > 0) {
    const handle = localServers.pop()
    if (handle) await handle.close()
  }
  const { rmSync } = await import('node:fs')
  for (const dir of localDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('本地轮次身份：输入校验', () => {
  it('非法 / 空 / 超长 / 非字符串 requestId 在网络前拒绝，请求数 0', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, successBody()))
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    for (const requestId of ['not-a-uuid', '', '1'.repeat(200), 123]) {
      await expect(
        harness.call(IPC.chatSend, {
          conversationId: 'conv-c0-invalid',
          messages: [{ role: 'user', content: '干活' }],
          requestId
        })
      ).rejects.toThrow()
    }
    expect(server.requests).toHaveLength(0)
    expect(harness.events).toHaveLength(0)
  })
})

describe('本地轮次身份：早退与失败路径', () => {
  it('缺配置早退仍带同一个显式 requestId', async () => {
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const requestId = '11111111-1111-4111-8111-111111111111'
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-nocfg',
      messages: [{ role: 'user', content: '干活' }],
      requestId
    })
    const error = eventOf(harness.events, 'error')
    expect(error?.envelope.requestId).toBe(requestId)
    expect(error?.envelope.requestPolicy).toMatchObject({ mode: 'normal' })
    expect(String(error?.envelope.payload)).toContain('尚未配置模型')
  })

  it('零 chunk 的 HTTP 失败：错误信封带同一个显式 requestId，请求数 1', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, { error: { message: '炸了' } }, 500))
    await seedEndpoint(server.baseURL, { speedMode: 'normal' })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const requestId = '22222222-2222-4222-8222-222222222222'
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-fail',
      messages: [{ role: 'user', content: '干活' }],
      requestId
    })
    const error = eventOf(harness.events, 'error')
    expect(error?.envelope.requestId).toBe(requestId)
    expect(payloadOf(error)['terminal']).toMatchObject({ state: 'failed' })
    expect(server.requests).toHaveLength(1)
  })

  it('流已开始后取消：错误信封仍带同一个显式 requestId', async () => {
    const server = await startLocalServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      res.write(
        `data: ${JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 1, output_tokens: 0 } }
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '开始' }
        })}\n\n`
      )
      // 不主动结束：由 chatAbort 中断
    })
    await seedEndpoint(server.baseURL, { speedMode: 'normal' })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const requestId = '33333333-3333-4333-8333-333333333333'
    const pending = harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-abort',
      messages: [{ role: 'user', content: '干活' }],
      requestId
    })
    await vi.waitFor(() => {
      expect(harness.events.some((event) => event.channel.includes('chunk'))).toBe(true)
    })
    await harness.call(IPC.chatAbort, 'conv-c0-abort')
    await pending
    const error = eventOf(harness.events, 'error')
    expect(error?.envelope.requestId).toBe(requestId)
    expect(payloadOf(error)['terminal']).toEqual({ state: 'cancelled', code: 'user-stop' })
    const done = eventOf(harness.events, 'done')
    expect(done).toBeUndefined()
  })
})

describe('本地轮次身份：成功与每次 run 各自冻结', () => {
  it('显式 requestId 原样进入成功信封；策略与真实档位彼此独立，请求数 1', async () => {
    const server = await startLocalServer((_req, res) =>
      replyJson(res, {
        content: [{ type: 'text', text: '完成' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2, service_tier: 'priority' }
      })
    )
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const requestId = '44444444-4444-4444-8444-444444444444'
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-ok',
      messages: [{ role: 'user', content: '干活' }],
      requestId
    })
    const done = eventOf(harness.events, 'done')
    expect(done?.envelope.conversationId).toBe('conv-c0-ok')
    expect(done?.envelope.requestId).toBe(requestId)
    expect(done?.envelope.requestPolicy).toEqual({
      mode: 'fast',
      maxLocalReadConcurrency: 2,
      requestedServiceTier: 'priority',
      tierSupport: 'supported'
    })
    // 策略是意图；实际档位只能来自真实观测
    expect(payloadOf(done)['serviceTier']).toEqual({
      requested: 'auto',
      actual: 'priority',
      observed: true
    })
    expect(server.requests).toHaveLength(1)
    // 本 run 的每个信封都带同一身份
    for (const event of harness.events) expect(event.envelope.requestId).toBe(requestId)
  })

  it('同会话两次 run：自动 ID 各不相同，各自冻结自己的策略', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, successBody()))
    await seedEndpoint(server.baseURL, { speedMode: 'normal', tier: ['priority'] })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')

    await setOverride('conv-c0-two', 'fast')
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-two',
      messages: [{ role: 'user', content: '第一次' }]
    })
    const first = eventOf(harness.events, 'done')!
    harness.events.length = 0

    await setOverride('conv-c0-two', 'normal')
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-two',
      messages: [{ role: 'user', content: '第二次' }]
    })
    const second = eventOf(harness.events, 'done')!

    expect(first.envelope.requestId).toMatch(UUID_RE)
    expect(second.envelope.requestId).toMatch(UUID_RE)
    expect(first.envelope.requestId).not.toBe(second.envelope.requestId)
    expect(first.envelope.requestPolicy).toMatchObject({ mode: 'fast', maxLocalReadConcurrency: 2 })
    expect(second.envelope.requestPolicy).toMatchObject({ mode: 'normal', maxLocalReadConcurrency: 1 })
    expect(server.requests).toHaveLength(2)
  })

  it('请求在途时改设置：本 run 的冻结策略不变', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const server = await startLocalServer((_req, res) => {
      void gate.then(() => replyJson(res, successBody()))
    })
    await seedEndpoint(server.baseURL, { speedMode: 'normal', tier: ['priority'] })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    await setOverride('conv-c0-freeze', 'normal')

    const pending = harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-freeze',
      messages: [{ role: 'user', content: '干活' }]
    })
    await vi.waitFor(() => {
      expect(server.requests).toHaveLength(1)
    })
    await setOverride('conv-c0-freeze', 'fast')
    release()
    await pending

    const done = eventOf(harness.events, 'done')!
    expect(done.envelope.requestPolicy).toMatchObject({ mode: 'normal', maxLocalReadConcurrency: 1 })
    expect(server.requests).toHaveLength(1)
  })

  it('旧调用缺 requestId：主进程补一个本地 UUID，信封其余字段不变', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, successBody()))
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-legacy',
      messages: [{ role: 'user', content: '干活' }]
    })
    const done = eventOf(harness.events, 'done')!
    expect(done.envelope.requestId).toMatch(UUID_RE)
    expect(done.envelope.requestPolicy).toMatchObject({ mode: 'fast', requestedServiceTier: 'priority' })
    // 响应未报档位 → payload 不造字段；策略不是实际档位
    expect('serviceTier' in payloadOf(done)).toBe(false)
    expect(payloadOf(done)['terminal']).toEqual({ state: 'completed' })
    expect(server.requests).toHaveLength(1)
  })
})

describe('本地轮次身份：隔离与出站纯净', () => {
  it('双会话并发：各自信封的会话与身份不串', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, successBody()))
    await seedEndpoint(server.baseURL, { speedMode: 'normal' })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const idA = '55555555-5555-4555-8555-555555555555'
    const idB = '66666666-6666-4666-8666-666666666666'
    await Promise.all([
      harness.call(IPC.chatSend, {
        conversationId: 'conv-c0-a',
        messages: [{ role: 'user', content: 'A' }],
        requestId: idA
      }),
      harness.call(IPC.chatSend, {
        conversationId: 'conv-c0-b',
        messages: [{ role: 'user', content: 'B' }],
        requestId: idB
      })
    ])
    const doneA = harness.events.find(
      (event) => event.channel.includes('done') && event.envelope.conversationId === 'conv-c0-a'
    )
    const doneB = harness.events.find(
      (event) => event.channel.includes('done') && event.envelope.conversationId === 'conv-c0-b'
    )
    expect(doneA?.envelope.requestId).toBe(idA)
    expect(doneB?.envelope.requestId).toBe(idB)
    expect(server.requests).toHaveLength(2)
  })

  it('出站 headers / body 不含本地 ID 与策略字段，也不把供应商会话键当成本地 ID', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, successBody()))
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    const harness = await boot()
    const { IPC } = await import('@shared/ipc')
    const requestId = '77777777-7777-4777-8777-777777777777'
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-c0-wire',
      messages: [{ role: 'user', content: '干活' }],
      requestId
    })
    const done = eventOf(harness.events, 'done')!
    expect(done.envelope.requestId).toBe(requestId)
    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    const headerText = JSON.stringify(captured.headers)
    const providerSession = captured.headers['x-opencode-session']
    expect(typeof providerSession).toBe('string')
    expect(done.envelope.requestId).not.toBe(providerSession)
    expect(headerText).not.toContain(requestId)
    expect(captured.body).not.toContain(requestId)
    for (const forbidden of ['requestPolicy', 'maxLocalReadConcurrency', 'requestedServiceTier']) {
      expect(headerText).not.toContain(forbidden)
      expect(captured.body).not.toContain(forbidden)
    }
  })
})

describe('emitter 旧形状与单结算回归', () => {
  interface FakeWindow {
    isDestroyed(): boolean
    send(channel: string, envelope: unknown): void
  }

  function sink(): { events: SentEvent[]; win: FakeWindow } {
    const events: SentEvent[] = []
    return {
      events,
      win: {
        isDestroyed: () => false,
        send: (channel, envelope) => {
          events.push({ channel, envelope: envelope as Record<string, unknown> })
        }
      }
    }
  }

  const policy = Object.freeze({
    mode: 'fast' as const,
    maxLocalReadConcurrency: 2 as const,
    requestedServiceTier: 'priority',
    tierSupport: 'supported' as const
  })

  it('旧双参调用保持旧信封形状，不带身份字段', () => {
    const { events, win } = sink()
    const emitter = createChatEmitter(win as never, 'conv-old')
    emitter.done(null)
    expect(Object.keys(events[0]!.envelope).sort()).toEqual(['conversationId', 'payload'])
  })

  it('带身份调用：每个信封带同一 requestId 与冻结策略；单结算不变', () => {
    const { events, win } = sink()
    const emitter = createChatEmitter(win as never, 'conv-new', 'id-1', policy)
    emitter.done(null)
    emitter.error('迟到失败', {
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.channel).toContain('done')
    expect(events[0]!.envelope.requestId).toBe('id-1')
    expect(events[0]!.envelope.requestPolicy).toBe(policy)

    const second = sink()
    const emitter2 = createChatEmitter(second.win as never, 'conv-new-2', 'id-2', policy)
    emitter2.error('先失败', { terminal: { state: 'failed', code: 'upstream-error' }, usage: null, usageComplete: false })
    emitter2.done(null)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.channel).toContain('error')
    expect(second.events[0]!.envelope.requestId).toBe('id-2')
  })
})
