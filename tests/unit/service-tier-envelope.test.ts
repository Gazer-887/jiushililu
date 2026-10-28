import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoop, type AgentLoopOptions } from '@main/agent/loop'
import { createChatEmitter } from '@main/chat-emitter'
import { observeServiceTier, type ServiceTierObservation } from '@shared/request-policy'
import type { AgentChatResult } from '@shared/agent'
import type { ChatDonePayload, ChatErrorPayload } from '@shared/ipc'
import type { TokenUsage } from '@shared/usage'

/**
 * S3-30E：服务档观测在 loop 内按 run 局部汇聚，并经 done/error 信封传给消费者。
 *
 * ⚠️ 断言对象是真 `runAgentLoop` 与真 `createChatEmitter`（平台边界只有一个假 WebContents），
 * 不是纯函数快照；服务档与 usage / usageComplete / terminal 的独立性逐格验证。
 */

const PRIORITY: ServiceTierObservation = observeServiceTier('priority', 'priority')
const MISSING_REPORT: ServiceTierObservation = observeServiceTier('priority', null)

function chatResult(overrides: Partial<AgentChatResult> = {}): AgentChatResult {
  return { text: '好', toolCalls: [], ...overrides }
}

function toolTurn(): AgentChatResult {
  return {
    text: null,
    toolCalls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }]
  }
}

async function runLoop(
  replies: AgentChatResult[],
  overrides: Partial<AgentLoopOptions> = {}
): Promise<Awaited<ReturnType<typeof runAgentLoop>>> {
  let index = 0
  return await runAgentLoop({
    systemPrompt: '系统',
    history: [{ role: 'user', content: '干活' }],
    tools: [],
    maxRounds: 4,
    chat: async () => replies[Math.min(index++, replies.length - 1)]!,
    ...overrides
  })
}

describe('S3-30E ① loop 内按 run 局部汇聚', () => {
  it('completed：真实观测进结果；无观测时字段保持缺失', async () => {
    const observed = await runLoop([chatResult({ serviceTier: PRIORITY })])
    expect(observed.stopReason).toBe('completed')
    expect(observed.serviceTier).toEqual(PRIORITY)
    const none = await runLoop([chatResult()])
    expect('serviceTier' in none).toBe(false)
  })

  it('max-rounds：已观测档位同样带出', async () => {
    const result = await runLoop(
      [chatResult({ ...toolTurn(), serviceTier: PRIORITY })],
      { maxRounds: 2 }
    )
    expect(result.stopReason).toBe('max-rounds')
    expect(result.terminal).toEqual({ state: 'max-rounds', code: 'token-limit' })
    expect(result.serviceTier).toEqual(PRIORITY)
  })

  it('多轮：先有档、后缺报/无字段，不被覆盖', async () => {
    const missingField = await runLoop([
      chatResult({ ...toolTurn(), serviceTier: PRIORITY }),
      chatResult({ serviceTier: undefined })
    ])
    expect(missingField.serviceTier).toEqual(PRIORITY)

    const observedFalse = await runLoop([
      chatResult({ ...toolTurn(), serviceTier: PRIORITY }),
      chatResult({ serviceTier: MISSING_REPORT })
    ])
    expect(observedFalse.serviceTier).toEqual(PRIORITY)
  })

  it('先缺报后有真实值：以最后一次真实值为准', async () => {
    const later = observeServiceTier('auto', 'standard')
    const result = await runLoop([
      chatResult({ ...toolTurn(), serviceTier: MISSING_REPORT }),
      chatResult({ serviceTier: later })
    ])
    expect(result.serviceTier).toEqual(later)
  })

  it('usage / usageComplete / terminal 与档位完全独立（loop 不写 usage 字段）', async () => {
    const stored = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: null, reasoningTokens: null }
    const result = await runLoop([
      chatResult({ serviceTier: PRIORITY, usage: stored, usageComplete: true })
    ])
    expect(result.serviceTier).toEqual(PRIORITY)
    expect('usage' in result).toBe(false)
    expect('usageComplete' in result).toBe(false)
    expect(result.terminal).toEqual({ state: 'completed' })
  })
})

describe('S3-30E ② done / error 信封只携带真实观测', () => {
  interface FakeWindow {
    isDestroyed(): boolean
    send(channel: string, envelope: unknown): void
  }

  function emitterWithSink(): {
    emitter: ReturnType<typeof createChatEmitter>
    sent: Array<{ channel: string; payload: unknown }>
  } {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const win: FakeWindow = {
      isDestroyed: () => false,
      send: (channel, envelope) => {
        const payload = (envelope as { payload?: unknown }).payload
        sent.push({ channel, payload })
      }
    }
    return {
      emitter: createChatEmitter(win as unknown as Parameters<typeof createChatEmitter>[0], 'conv-e'),
      sent
    }
  }

  it('done：observed=true 才带；无字段/observed=false 都不带', () => {
    const a = emitterWithSink()
    a.emitter.done(null, 0, undefined, undefined, undefined, undefined, PRIORITY)
    expect((a.sent[0]!.payload as ChatDonePayload).serviceTier).toEqual(PRIORITY)

    const b = emitterWithSink()
    b.emitter.done(null)
    expect('serviceTier' in (b.sent[0]!.payload as ChatDonePayload)).toBe(false)

    const c = emitterWithSink()
    c.emitter.done(null, 0, undefined, undefined, undefined, undefined, MISSING_REPORT)
    expect('serviceTier' in (c.sent[0]!.payload as ChatDonePayload)).toBe(false)
  })

  it('error：失败前已观测的真实档位进 details；无观测不带', () => {
    const a = emitterWithSink()
    a.emitter.error('失败', {
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false,
      serviceTier: PRIORITY
    })
    const payloadA = a.sent[0]!.payload as ChatErrorPayload
    expect(payloadA.serviceTier).toEqual(PRIORITY)
    expect(payloadA.terminal).toEqual({ state: 'failed', code: 'upstream-error' })

    const b = emitterWithSink()
    b.emitter.error('失败', {
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false
    })
    expect('serviceTier' in (b.sent[0]!.payload as ChatErrorPayload)).toBe(false)
  })

  it('单结算语义不变：done 后 error 被丢弃，error 后 done 被丢弃', () => {
    const a = emitterWithSink()
    a.emitter.done(null, 0, undefined, undefined, undefined, undefined, PRIORITY)
    a.emitter.error('迟到失败', { terminal: { state: 'failed', code: 'upstream-error' }, usage: null, usageComplete: false })
    expect(a.sent).toHaveLength(1)
    expect(a.sent[0]!.channel).toContain('done')

    const b = emitterWithSink()
    b.emitter.error('失败', {
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false,
      serviceTier: PRIORITY
    })
    b.emitter.done(null)
    expect(b.sent).toHaveLength(1)
    expect((b.sent[0]!.payload as ChatErrorPayload).serviceTier).toEqual(PRIORITY)
  })

  it('信封字段不改变 usage / usageComplete / terminal 的既有语义', () => {
    const zero: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: null, reasoningTokens: null }
    const emitter = emitterWithSink()
    emitter.emitter.done(zero, 0, undefined, undefined, true, { state: 'completed' }, PRIORITY)
    const payload = emitter.sent[0]!.payload as ChatDonePayload
    expect(payload.usage).toEqual(zero)
    expect(payload.usageComplete).toBe(true)
    expect(payload.terminal).toEqual({ state: 'completed' })
    expect(payload.serviceTier).toEqual(PRIORITY)
  })
})

describe('S3-30E ③ AgentChatResult 的三交叉（真实 0 与缺报不混淆）', () => {
  const zero: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: null, reasoningTokens: null }

  it('有档无 usage / 有 usage 无档 / 皆无', () => {
    const tierOnly: AgentChatResult = { text: null, toolCalls: [], serviceTier: PRIORITY }
    expect(tierOnly.usage).toBeUndefined()
    expect(tierOnly.serviceTier).toEqual(PRIORITY)

    const usageOnly: AgentChatResult = { text: null, toolCalls: [], usage: zero, usageComplete: true }
    expect('serviceTier' in usageOnly).toBe(false)
    expect(usageOnly.usage).toEqual(zero)

    const neither: AgentChatResult = { text: null, toolCalls: [] }
    expect('usage' in neither).toBe(false)
    expect('serviceTier' in neither).toBe(false)
  })

  it('真实 0 用量与档位并存：0 仍是真值，不被当成缺报', () => {
    const both: AgentChatResult = { text: null, toolCalls: [], usage: zero, usageComplete: true, serviceTier: PRIORITY }
    expect(both.usage).toEqual(zero)
    expect(both.usageComplete).toBe(true)
    expect(both.serviceTier).toEqual(PRIORITY)
  })
})

// ── ④ S3-30E1 chatSend 错误信封的 run 局部观测（真实 IPC + 本地 HTTP）──────

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
      getVersion: () => '0.13.110-e1',
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
    readonly path = '/tmp/jsl-e1-mock-store.json'
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

function parseBody(captured: CapturedHttp): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>
}

function sawToolResult(body: Record<string, unknown>): boolean {
  const messages = body['messages']
  if (!Array.isArray(messages)) return false
  return messages.some((entry) => {
    const record = entry as { role?: string; content?: unknown }
    if (record.role === 'tool') return true
    return (
      Array.isArray(record.content) &&
      record.content.some((block) => (block as { type?: string }).type === 'tool_result')
    )
  })
}

interface EnvelopeEvent {
  channel: string
  payload: unknown
}

interface E1Harness {
  call(channel: string, raw?: unknown): Promise<unknown>
  events: EnvelopeEvent[]
  observed: Array<{ scope: string; actual: string | null; observed: boolean; agentName?: string }>
}

async function bootE1(
  options: {
    prepare?: (dirs: { userAgentsDir: string; writeFile: (path: string, body: string) => void }) => void
  } = {}
): Promise<E1Harness> {
  const { registerIpcHandlers } = await import('@main/ipc')
  const { createCheckpointStore } = await import('@main/store/checkpoints')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'jsl-e1-'))
  localDirs.push(base)
  const workspace = join(base, 'ws')
  mkdirSync(workspace, { recursive: true })
  const userAgentsDir = join(base, 'user')
  mkdirSync(userAgentsDir, { recursive: true })
  options.prepare?.({
    userAgentsDir,
    writeFile: (path, body) => writeFileSync(path, body, 'utf8')
  })
  const agent = {
    getWorkspaceRoot: () => workspace,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir,
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
  const events: EnvelopeEvent[] = []
  const observed: E1Harness['observed'] = []
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
    clientVersion: '0.13.110-e1',
    onServiceTierObservation: (observation, scope, agentName) => {
      observed.push({
        scope,
        actual: observation.actual,
        observed: observation.observed,
        ...(agentName ? { agentName } : {})
      })
    }
  } as unknown as Parameters<typeof registerIpcHandlers>[0])
  return {
    events,
    observed,
    call: async (channel, raw) => {
      const handler = ipcPlatform.handlers.get(channel)
      if (!handler) throw new Error(`handler 未注册：${channel}`)
      const sender = {
        isDestroyed: () => false,
        send: (ch: string, payload: unknown) => events.push({ channel: ch, payload })
      }
      return await handler({ sender }, raw)
    }
  }
}

/** 保存并激活一个 Anthropic 端点；speedMode=fast + serviceTiers 声明用于让请求真的带 auto。 */
async function seedEndpoint(
  baseURL: string,
  options: { speedMode?: 'fast' | 'normal'; tier?: string[] } = {}
): Promise<{ id: string }> {
  const store = await import('@main/store/models')
  const saved = store.saveEndpoint({
    name: `e1-${Math.random().toString(36).slice(2, 8)}`,
    providerType: 'anthropic',
    baseURL,
    timeoutMs: 60_000,
    stream: true,
    apiKey: 'sk-e1',
    models: [
      {
        id: 'm-e1',
        model: 'e1-model',
        ...(options.speedMode ? { speedMode: options.speedMode } : {}),
        ...(options.tier
          ? {
              metadata: {
                serviceTiers: { official: { value: options.tier, observedAt: Date.now() } }
              }
            }
          : {}),
        settings: { authentication: 'bearer', requestIdentity: 'self-ua' }
      }
    ]
  })
  store.setActiveProfile(saved.id)
  return { id: saved.id }
}

function errorPayload(events: EnvelopeEvent[]): Record<string, unknown> | null {
  const found = events.find((event) => event.channel.includes('error'))
  if (!found || typeof found.payload !== 'object' || found.payload === null) return null
  // 假 sender 收到的是信封 {conversationId, payload}：断言对象是里面的 payload
  const inner = (found.payload as { payload?: unknown }).payload
  if (typeof inner !== 'object' || inner === null) return null
  return inner as Record<string, unknown>
}

afterEach(async () => {
  while (localServers.length > 0) {
    const handle = localServers.pop()
    if (handle) await handle.close()
  }
  const { rmSync } = await import('node:fs')
  for (const dir of localDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('S3-30E1 chatSend 错误信封携带 run 局部真实观测', () => {
  it('首请求先真实观测档位再断流：chat:error 带该观测，usageComplete 独立，请求数 1', async () => {
    const server = await startLocalServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      res.write(
        `data: ${JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 3, output_tokens: 0, service_tier: 'priority' } }
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '部分' } })}\n\n`
      )
      res.socket?.end()
    })
    const harness = await bootE1()
    const { IPC } = await import('@shared/ipc')
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-e1-fail',
      messages: [{ role: 'user', content: '干活' }]
    })
    const payload = errorPayload(harness.events)
    expect(payload).not.toBeNull()
    expect(payload!['serviceTier']).toEqual({ requested: 'auto', actual: 'priority', observed: true })
    expect(payload!['usageComplete']).toBe(false)
    expect(server.requests).toHaveLength(1)
  })

  it('前轮有档、后轮缺报失败：错误信封保留最后真实观测', async () => {
    const server = await startLocalServer((req, res) => {
      const body = parseBody(req)
      if (!sawToolResult(body)) {
        replyJson(res, {
          content: [{ type: 'tool_use', id: 't1', name: 'list_dir', input: { path: '.' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1, service_tier: 'priority' }
        })
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      res.write(
        `data: ${JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 2, output_tokens: 0 } }
        })}\n\n`
      )
      res.socket?.end()
    })
    const harness = await bootE1()
    const { IPC } = await import('@shared/ipc')
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-e1-prior',
      messages: [{ role: 'user', content: '看看目录' }]
    })
    const payload = errorPayload(harness.events)
    expect(payload).not.toBeNull()
    expect(payload!['serviceTier']).toEqual({ requested: 'auto', actual: 'priority', observed: true })
    expect(server.requests.length).toBeGreaterThanOrEqual(2)
  })

  it('无档失败：错误信封不出现 serviceTier 字段，且只请求一次', async () => {
    const server = await startLocalServer((_req, res) => replyJson(res, { error: { message: 'x' } }, 500))
    const harness = await bootE1()
    const { IPC } = await import('@shared/ipc')
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-e1-none',
      messages: [{ role: 'user', content: '干活' }]
    })
    const payload = errorPayload(harness.events)
    expect(payload).not.toBeNull()
    expect('serviceTier' in payload!).toBe(false)
    expect(server.requests).toHaveLength(1)
  })

  it('子代理观察不污染主域：父请求无档失败时信封不带 serviceTier', async () => {
    const server = await startLocalServer((req, res) => {
      const body = parseBody(req)
      if (body['model'] === 'child-model') {
        replyJson(res, {
          content: [{ type: 'text', text: '子完成' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' }
        })
        return
      }
      if (!sawToolResult(body)) {
        replyJson(res, {
          content: [
            {
              type: 'tool_use',
              id: 'spawn-1',
              name: 'spawn_agents',
              input: { jobs: [{ agent: 'child', task: '做子活' }] }
            }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 }
        })
        return
      }
      replyJson(res, { error: { message: 'x' } }, 500)
    })
    const harness = await bootE1({
      prepare: ({ userAgentsDir }) => {
        const { writeFileSync } = require('node:fs') as typeof import('node:fs')
        writeFileSync(
          `${userAgentsDir}/child.md`,
          '---\nname: child\ndescription: 子任务\nmodel: child-model\n---\n只做子活。',
          'utf8'
        )
      }
    })
    const { IPC } = await import('@shared/ipc')
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-e1-sub',
      messages: [{ role: 'user', content: '派活' }]
    })
    const payload = errorPayload(harness.events)
    expect(payload).not.toBeNull()
    // 父请求从未观测到真实档位；子代理的 standard 只应出现在 sub 域
    expect('serviceTier' in payload!).toBe(false)
    expect(harness.observed.some((item) => item.scope === 'sub' && item.actual === 'standard')).toBe(true)
    expect(harness.observed.filter((item) => item.scope === 'main' && item.observed)).toEqual([])
  })
})

// ── ⑤ S3-30E1-R1 成功 chat:done 信封携带 run 最后真实观测 ──────────────────

function donePayload(events: EnvelopeEvent[]): Record<string, unknown> | null {
  const found = events.find((event) => event.channel.includes('done'))
  if (!found || typeof found.payload !== 'object' || found.payload === null) return null
  const inner = (found.payload as { payload?: unknown }).payload
  if (typeof inner !== 'object' || inner === null) return null
  return inner as Record<string, unknown>
}

describe('S3-30E1-R1 chatSend 成功结算的 done 信封', () => {
  it('有档成功：chat:done 带 serviceTier，usage/usageComplete/terminal 独立，请求数 1', async () => {
    const server = await startLocalServer((_req, res) =>
      replyJson(res, {
        content: [{ type: 'text', text: '完成' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2, service_tier: 'priority' }
      })
    )
    const harness = await bootE1()
    const { IPC } = await import('@shared/ipc')
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-e1r1-ok',
      messages: [{ role: 'user', content: '干活' }]
    })
    const payload = donePayload(harness.events)
    expect(payload).not.toBeNull()
    expect(payload!['serviceTier']).toEqual({ requested: 'auto', actual: 'priority', observed: true })
    expect(payload!['usageComplete']).toBe(true)
    expect(payload!['terminal']).toEqual({ state: 'completed' })
    expect(payload!['usage']).toMatchObject({ promptTokens: 3, completionTokens: 2 })
    expect(server.requests).toHaveLength(1)
    expect(harness.events.filter((event) => event.channel.includes('error'))).toHaveLength(0)
    expect(harness.events.filter((event) => event.channel.includes('done'))).toHaveLength(1)
  })

  it('无档成功：chat:done 不出现 serviceTier 字段，其余字段不受影响', async () => {
    const server = await startLocalServer((_req, res) =>
      replyJson(res, {
        content: [{ type: 'text', text: '完成' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 }
      })
    )
    const harness = await bootE1()
    const { IPC } = await import('@shared/ipc')
    await seedEndpoint(server.baseURL, { speedMode: 'fast', tier: ['priority'] })
    await harness.call(IPC.chatSend, {
      conversationId: 'conv-e1r1-none',
      messages: [{ role: 'user', content: '干活' }]
    })
    const payload = donePayload(harness.events)
    expect(payload).not.toBeNull()
    expect('serviceTier' in payload!).toBe(false)
    expect(payload!['usageComplete']).toBe(true)
    expect(payload!['terminal']).toEqual({ state: 'completed' })
    expect(server.requests).toHaveLength(1)
    expect(harness.events.filter((event) => event.channel.includes('done'))).toHaveLength(1)
  })
})
