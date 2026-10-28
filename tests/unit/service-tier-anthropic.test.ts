import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AnthropicProvider, buildAnthropicBody } from '@main/providers/anthropic'
import {
  buildAnthropicToolsBody,
  chatWithToolsAnthropic,
  streamWithToolsAnthropic
} from '@main/providers/anthropic-agent'
import { ProviderError } from '@main/providers/errors'
import type { ProviderRequest, StreamCallbacks } from '@main/providers/types'
import {
  createProviderExecutionContext,
  type ProviderCallPurpose,
  type ProviderExecutionContext,
  type RequestPolicySnapshot,
  type ServiceTierObservation
} from '@shared/request-policy'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import type { ChatMessage, ModelSettings } from '@shared/ipc'
import type { TokenUsage } from '@shared/usage'

/**
 * S3-30B：Anthropic 两条链（普通对话 / 带工具）的认证、窄身份与服务档（容量选择）。
 *
 * ⚠️ 断言对象是**真实发出并序列化后的请求**（本地 127.0.0.1 HTTP 服务抓 headers/body/次数），
 * 不是只快照纯 body 函数；请求次数据此证明 fail-closed 时 0 次、显式失败不重试。
 * ⚠️ Anthropic 的真实容量只报在 `usage.service_tier`（流式仅 `message_start.message.usage`），
 * 不从 requested / usage / HTTP 200 / 终态推断，也不把 OpenAI 的 priority/fast 原样发过去。
 * 本文件不联网真实供应商，也不读取任何真实 Key。
 */

const VERSION = '0.13.110'
const API_KEY = 'unit-test-key-not-a-secret'
const ANTHROPIC_VERSION = '2023-06-01'

const FAST_SUPPORTED: RequestPolicySnapshot = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: 'priority',
  tierSupport: 'supported'
}

const FAST_UNKNOWN: RequestPolicySnapshot = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: null,
  tierSupport: 'unknown'
}

const FAST_UNSUPPORTED: RequestPolicySnapshot = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: null,
  tierSupport: 'unsupported'
}

const NORMAL: RequestPolicySnapshot = {
  mode: 'normal',
  maxLocalReadConcurrency: 1,
  requestedServiceTier: null,
  tierSupport: 'supported'
}

function context(
  policy: RequestPolicySnapshot = FAST_SUPPORTED,
  purpose: ProviderCallPurpose = 'main-chat'
): ProviderExecutionContext {
  return createProviderExecutionContext({
    clientVersion: VERSION,
    purpose,
    policy: { ...policy }
  })
}

/** 恶意/越权上下文：手工构造以验证 provider 不盲信 policy 自称的能力位与 purpose。 */
function forgedContext(
  policy: RequestPolicySnapshot,
  overrides: Partial<ProviderExecutionContext> & Record<string, unknown> = {}
): ProviderExecutionContext {
  return Object.freeze({
    clientVersion: VERSION,
    purpose: 'main-chat',
    operationId: 'op-forged',
    sessionId: 'sess-forged',
    policy: Object.freeze({ ...policy }),
    ...overrides
  }) as unknown as ProviderExecutionContext
}

function settings(baseURL: string, overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    providerType: 'anthropic',
    baseURL,
    model: 'claude-test',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 1024,
    timeoutMs: 60_000,
    stream: true,
    contextWindow: 200_000,
    reasoningEffort: 'default',
    maxToolRounds: 8,
    inputModalities: ['text'],
    ...overrides
  }
}

const CHAT_MESSAGES: ChatMessage[] = [{ role: 'user', content: '你好' }]
const AGENT_MESSAGES: AgentMessage[] = [{ role: 'user', content: '你好' }]
const TOOLS: ToolSchema[] = []
const SHORT = { timeouts: { firstByteMs: 500, idleMs: 500 } }

function request(
  baseURL: string,
  overrides: Partial<ProviderRequest> = {},
  settingsOverrides: Partial<ModelSettings> = {}
): ProviderRequest {
  return {
    settings: settings(baseURL, settingsOverrides),
    apiKey: API_KEY,
    messages: CHAT_MESSAGES,
    signal: new AbortController().signal,
    ...overrides
  }
}

// ── 本地真实 HTTP 捕获 ──────────────────────────────────────────────────

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

type Responder = (req: CapturedRequest, res: ServerResponse, index: number) => void

interface TestServer {
  baseURL: string
  requests: CapturedRequest[]
  close(): Promise<void>
}

const servers: TestServer[] = []

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function startServer(responder: Responder): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body
      }
      requests.push(captured)
      responder(captured, res, requests.length - 1)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('本地测试服务未取得端口')
  const handle: TestServer = {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
  servers.push(handle)
  return handle
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (servers.length > 0) {
    const handle = servers.pop()
    if (handle) await handle.close()
  }
})

function jsonReply(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function sseReply(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(frames.join(''))
}

/** 按给定分片写 SSE：用于证明分片跨 chunk 边界仍能拿到真实档位与用量。 */
function sseReplyChunked(res: ServerResponse, chunks: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.flushHeaders()
  let index = 0
  const timer = setInterval(() => {
    if (index >= chunks.length) {
      clearInterval(timer)
      res.end()
      return
    }
    res.write(chunks[index])
    index += 1
  }, 5)
}

/** 写完 SSE 帧后半关连接：不写 chunked 终止块，客户端先收到帧、随后读到"流被截断" */
function sseReplyThenBreak(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.flushHeaders()
  for (const frame of frames) res.write(frame)
  res.socket?.end()
}

/** 写完 SSE 帧后保持连接：用于取消场景；收尾由 afterEach 的 closeAllConnections 释放 */
function sseReplyHoldOpen(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.flushHeaders()
  for (const frame of frames) res.write(frame)
}

/** 取 Promise 的拒绝原因；成功则回 null（不吞原失败，便于后续断言终态） */
async function rejectionOf(task: Promise<unknown>): Promise<unknown> {
  return task.then(
    () => null,
    (err: unknown) => err
  )
}

// ── Anthropic 报文夹具（只按官方字段位置构造） ─────────────────────────

interface FrameOptions {
  /** 真实容量：官方只在 `message_start.message.usage.service_tier` 报；缺省 = 不报 */
  tier?: string | null
  /** message_start 的 usage（缺省给一份完整输入用量） */
  startUsage?: Record<string, unknown>
  /** message_delta 的 usage；null = 该帧不带 usage */
  deltaUsage?: Record<string, unknown> | null
  text?: string | null
  stopReason?: string | null
  messageStop?: boolean
}

function messageFrames(options: FrameOptions = {}): string[] {
  const frames: string[] = []
  const startUsage: Record<string, unknown> = { ...(options.startUsage ?? { input_tokens: 7, output_tokens: 0 }) }
  if (typeof options.tier === 'string') startUsage['service_tier'] = options.tier
  frames.push(`data: ${JSON.stringify({ type: 'message_start', message: { usage: startUsage } })}\n\n`)
  if (options.text) {
    frames.push(
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: options.text } })}\n\n`
    )
  }
  if (options.stopReason !== null) {
    const delta: Record<string, unknown> = {
      type: 'message_delta',
      delta: { stop_reason: options.stopReason ?? 'end_turn' }
    }
    const deltaUsage = options.deltaUsage === undefined ? { output_tokens: 4 } : options.deltaUsage
    if (deltaUsage !== null) delta['usage'] = deltaUsage
    frames.push(`data: ${JSON.stringify(delta)}\n\n`)
  }
  if (options.messageStop !== false) frames.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
  return frames
}

interface MessageJsonOptions {
  content?: string
  usage?: Record<string, unknown> | null
  stop?: string | null
}

/** 非流整份响应：真实容量位置是顶层 `usage.service_tier` */
function messageJson(options: MessageJsonOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: [{ type: 'text', text: options.content ?? 'hi' }],
    stop_reason: options.stop === undefined ? 'end_turn' : options.stop
  }
  const usage = options.usage === undefined ? { input_tokens: 3, output_tokens: 2 } : options.usage
  if (usage !== null) body['usage'] = usage
  return body
}

function bodyJson(captured: CapturedRequest): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>
}

function authHeaderCount(headers: Record<string, string | string[] | undefined>): number {
  return ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].filter((name) => name in headers).length
}

function handleOf(captured: CapturedRequest, name: string): string {
  const raw = captured.headers[name]
  return Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
}

// 新出口用动态导入：实现前能逐条落点，而不是整文件一个解析错误。
interface AnthropicTierModule {
  ANTHROPIC_SERVICE_TIER_AUTO: string
  buildAnthropicHeaders(
    settings: ModelSettings,
    apiKey: string,
    context?: ProviderExecutionContext,
    options?: { json?: boolean }
  ): Record<string, string>
  anthropicServiceTierForRequest(context?: ProviderExecutionContext): string | null
  withAnthropicServiceTierField(
    body: Record<string, unknown>,
    context?: ProviderExecutionContext
  ): Record<string, unknown>
}

interface AnthropicUsageModule {
  serviceTierFromAnthropicEvent(json: unknown): string | null
  serviceTierFromAnthropicMessage(json: unknown): string | null
}

async function tierModule(): Promise<AnthropicTierModule> {
  return (await import('@main/providers/service-tier')) as unknown as AnthropicTierModule
}

async function usageModule(): Promise<AnthropicUsageModule> {
  return (await import('@main/providers/usage-parsers')) as unknown as AnthropicUsageModule
}

/** 收集一次请求里的档位观测（顺序保留，便于断言"不重复通知"） */
function collector(): { observations: ServiceTierObservation[]; cb: (o: ServiceTierObservation) => void } {
  const observations: ServiceTierObservation[] = []
  return { observations, cb: (observation) => observations.push(observation) }
}

// ── ① 出站字段：只有 fast + supported 才发本协议容量选择 auto ─────────────

describe('S3-30B ① 四条聊天路径的 service_tier 出站值', () => {
  it('fast + supported：四路径都发 service_tier="auto"，绝不发 OpenAI 的 priority/fast', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(messageFrames({ text: '好' }).join(''))
    })
    const jsonServer = await startServer((_req, res) => jsonReply(res, messageJson()))
    const ctx = context()

    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: ctx }),
      { onChunk: () => undefined }
    )
    await new AnthropicProvider().streamChat(
      { ...request(jsonServer.baseURL, { context: ctx }), settings: settings(jsonServer.baseURL, { stream: false }) },
      { onChunk: () => undefined }
    )
    await chatWithToolsAnthropic(
      settings(jsonServer.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      ctx
    )
    await streamWithToolsAnthropic(
      settings(server.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      SHORT,
      ctx
    )

    const bodies = [...server.requests, ...jsonServer.requests]
    expect(bodies).toHaveLength(4)
    for (const captured of bodies) {
      expect(bodyJson(captured)['service_tier']).toBe('auto')
      expect(bodyJson(captured)['service_tier']).not.toBe('priority')
      expect(bodyJson(captured)['service_tier']).not.toBe('fast')
    }
  })

  it('普通模式 / fast + unknown / fast + unsupported：四路径一律不加字段', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    const policies: RequestPolicySnapshot[] = [NORMAL, FAST_UNKNOWN, FAST_UNSUPPORTED]
    for (const policy of policies) {
      const ctx = context(policy)
      await new AnthropicProvider().streamChat(
        { ...request(server.baseURL, { context: ctx }), settings: settings(server.baseURL, { stream: false }) },
        { onChunk: () => undefined }
      )
      await chatWithToolsAnthropic(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS, undefined, ctx)
      await streamWithToolsAnthropic(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => undefined,
        undefined,
        SHORT,
        ctx
      )
    }
    expect(server.requests.length).toBeGreaterThan(0)
    for (const captured of server.requests) {
      expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
    }
  })

  it('缺 context（旧调用者）：四条聊天路径都不加字段，行为与改造前一致', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    await new AnthropicProvider().streamChat(
      { ...request(server.baseURL), settings: settings(server.baseURL, { stream: false }) },
      { onChunk: () => undefined }
    )
    await chatWithToolsAnthropic(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS)
    for (const captured of server.requests) {
      expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
    }
  })

  it('五类辅助 purpose 即使伪造 fast policy 也不请求容量档', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    const purposes: ProviderCallPurpose[] = [
      'reflection',
      'title',
      'prompt-polish',
      'connection-check',
      'model-catalog'
    ]
    for (const purpose of purposes) {
      const ctx = forgedContext(FAST_SUPPORTED, { purpose })
      await new AnthropicProvider().streamChat(
        { ...request(server.baseURL, { context: ctx }), settings: settings(server.baseURL, { stream: false }) },
        { onChunk: () => undefined }
      )
      const provider = new AnthropicProvider()
      await provider.testConnection(request(server.baseURL, { context: ctx }))
      await provider.listModels(request(server.baseURL, { context: ctx }))
    }
    expect(server.requests).toHaveLength(purposes.length * 3)
    for (const captured of server.requests) {
      if (captured.method === 'GET' || captured.body.length === 0) {
        expect(captured.body).toBe('')
        continue
      }
      expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
    }
  })

  it('目录与连接检查始终不带 service_tier（即使模型默认 FAST）', async () => {
    const server = await startServer((req, res) =>
      req.method === 'GET' ? jsonReply(res, { data: [{ id: 'claude-x' }] }) : jsonReply(res, {})
    )
    const provider = new AnthropicProvider()
    const req = request(server.baseURL, { context: context() })
    await provider.testConnection(req)
    await provider.listModels(req)
    expect(server.requests).toHaveLength(2)
    for (const captured of server.requests) {
      // GET 目录没有请求体：只核"没有容量字段"，不把空串当 JSON 解析
      if (captured.body.length === 0) continue
      expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
    }
  })

  it('附加 service_tier 不改变模型、思考预算、采样、stream 与消息', async () => {
    const tuned = settings('http://127.0.0.1:1', {
      maxTokens: 4096,
      reasoningEffort: 'high',
      temperature: 0.4,
      stream: true
    })
    const plain = buildAnthropicBody(tuned, CHAT_MESSAGES, true)
    const tiered = buildAnthropicBody(tuned, CHAT_MESSAGES, true, context())
    expect(tiered['service_tier']).toBe('auto')
    const { service_tier: _tier, ...rest } = tiered
    expect(rest).toEqual(plain)
    expect(rest['thinking']).toEqual({ type: 'enabled', budget_tokens: 3072 })
    expect(rest['max_tokens']).toBe(4096)
  })
})

// ── ② 实际容量：只认 usage.service_tier，缺报保持未知 ───────────────────

describe('S3-30B ② 实际容量的真实位置与缺报', () => {
  it('非流式普通：usage.service_tier=priority → 请求 auto、实际 priority', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, messageJson({ usage: { input_tokens: 3, output_tokens: 2, service_tier: 'priority' } }))
    )
    const seen = collector()
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: context() }),
        settings: settings(server.baseURL, { stream: false })
      },
      { onChunk: () => undefined, onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
  })

  it('服务端回标准容量就保留 standard，不因请求 auto 写成优先', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, messageJson({ usage: { input_tokens: 3, output_tokens: 2, service_tier: 'standard' } }))
    )
    const seen = collector()
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: context() }),
        settings: settings(server.baseURL, { stream: false })
      },
      { onChunk: () => undefined, onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'standard', observed: true }])
  })

  it('缺报：actual=null / observed=false，且不从 requested、HTTP 200 或终态回填', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, messageJson({ usage: { input_tokens: 3, output_tokens: 2 } }))
    )
    const seen = collector()
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: context() }),
        settings: settings(server.baseURL, { stream: false })
      },
      { onChunk: () => undefined, onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: 'auto', actual: null, observed: false }])
  })

  it('旧调用者无 context 但服务端有真实值：只报告实际值，requested 保持 null', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, messageJson({ usage: { input_tokens: 1, output_tokens: 1, service_tier: 'priority' } }))
    )
    const seen = collector()
    await new AnthropicProvider().streamChat(
      { ...request(server.baseURL), settings: settings(server.baseURL, { stream: false }) },
      { onChunk: () => undefined, onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: null, actual: 'priority', observed: true }])
  })

  it('流式：只有 message_start.message.usage 提供容量；随后无档位的 message_delta 不清空已知值', async () => {
    const server = await startServer((_req, res) => {
      sseReply(
        res,
        messageFrames({
          tier: 'priority',
          text: '好',
          deltaUsage: { output_tokens: 4 }
        })
      )
    })
    const seen = collector()
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: context() }),
      { onChunk: () => undefined, onUsage: (u) => usages.push(u), onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ promptTokens: 7, completionTokens: 4 })
  })

  it('官方 MessageDeltaUsage 没有 service_tier：只在 message_delta 里出现的同名值不算真实容量', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        [
          `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } })}\n\n`,
          `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4, service_tier: 'priority' } })}\n\n`,
          `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
        ].join('')
      )
    })
    const seen = collector()
    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: context() }),
      { onChunk: () => undefined, onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: 'auto', actual: null, observed: false }])
  })

  it('有档无 usage：容量照报，用量不补 0', async () => {
    const server = await startServer((_req, res) => {
      sseReply(res, messageFrames({ tier: 'priority', startUsage: { service_tier: 'priority' }, deltaUsage: null }))
    })
    const seen = collector()
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: context() }),
      { onChunk: () => undefined, onUsage: (u) => usages.push(u), onServiceTier: seen.cb }
    )
    expect(usages).toEqual([])
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
  })

  it('有 usage 无档：用量照报，容量保持未知', async () => {
    const server = await startServer((_req, res) => {
      sseReply(res, messageFrames({ text: '好' }))
    })
    const seen = collector()
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: context() }),
      { onChunk: () => undefined, onUsage: (u) => usages.push(u), onServiceTier: seen.cb }
    )
    expect(usages).toHaveLength(1)
    expect(seen.observations).toEqual([{ requested: 'auto', actual: null, observed: false }])
  })

  it('两者皆无：usage 不回 0，容量 observed=false', async () => {
    const server = await startServer((_req, res) => {
      sseReply(res, messageFrames({ startUsage: {}, deltaUsage: null }))
    })
    const seen = collector()
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: context() }),
      { onChunk: () => undefined, onUsage: (u) => usages.push(u), onServiceTier: seen.cb }
    )
    expect(usages).toEqual([])
    expect(seen.observations).toEqual([{ requested: 'auto', actual: null, observed: false }])
  })

  it('分片到达（跨 chunk 边界的 message_start）：真实容量与用量都不丢', async () => {
    const start = JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 9, output_tokens: 0, service_tier: 'priority' } }
    })
    const split = Math.floor(start.length / 2)
    const server = await startServer((_req, res) => {
      sseReplyChunked(res, [
        `data: ${start.slice(0, split)}`,
        `${start.slice(split)}\n\n`,
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
      ])
    })
    const seen = collector()
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      request(server.baseURL, { context: context() }),
      { onChunk: () => undefined, onUsage: (u) => usages.push(u), onServiceTier: seen.cb }
    )
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ promptTokens: 9, completionTokens: 5 })
  })

  it('真实 0 仍是真值：input/output 都为 0 时用量与档位都保留', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(
        res,
        messageJson({ usage: { input_tokens: 0, output_tokens: 0, service_tier: 'priority' } })
      )
    )
    const seen = collector()
    const usages: TokenUsage[] = []
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: context() }),
        settings: settings(server.baseURL, { stream: false })
      },
      { onChunk: () => undefined, onUsage: (u) => usages.push(u), onServiceTier: seen.cb }
    )
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ promptTokens: 0, completionTokens: 0 })
    expect(seen.observations[0]).toEqual({ requested: 'auto', actual: 'priority', observed: true })
  })

  it('纯函数：官方位置解析（非流 usage / message_start.message.usage），别处同名不算', async () => {
    const usage = await usageModule()
    expect(
      usage.serviceTierFromAnthropicMessage({ usage: { input_tokens: 1, output_tokens: 1, service_tier: 'priority' } })
    ).toBe('priority')
    expect(usage.serviceTierFromAnthropicMessage({ usage: { input_tokens: 1, output_tokens: 1 } })).toBeNull()
    expect(usage.serviceTierFromAnthropicMessage({ service_tier: 'priority' })).toBeNull()
    expect(
      usage.serviceTierFromAnthropicEvent({
        type: 'message_start',
        message: { usage: { service_tier: 'standard' } }
      })
    ).toBe('standard')
    expect(
      usage.serviceTierFromAnthropicEvent({
        type: 'message_delta',
        usage: { output_tokens: 4, service_tier: 'priority' }
      })
    ).toBeNull()
    expect(usage.serviceTierFromAnthropicEvent({ type: 'content_block_delta', service_tier: 'priority' })).toBeNull()
    expect(usage.serviceTierFromAnthropicEvent({ type: 'message_start', message: { usage: { service_tier: '  ' } } })).toBeNull()
  })

  it('工具非流式：结果里的 serviceTier 与回调一致，usageComplete 独立不变', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, messageJson({ usage: { input_tokens: 3, output_tokens: 2, service_tier: 'priority' } }))
    )
    const seen = collector()
    const result = await chatWithToolsAnthropic(
      settings(server.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      context(),
      seen.cb
    )
    expect(result.serviceTier).toEqual({ requested: 'auto', actual: 'priority', observed: true })
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(result.usageComplete).toBe(true)
    expect(result.usage).toMatchObject({ promptTokens: 3, completionTokens: 2 })
  })

  it('工具流式：message_start 的容量进结果与回调，缺报时是未知观测', async () => {
    const withTier = await startServer((_req, res) => sseReply(res, messageFrames({ tier: 'priority', text: '好' })))
    const withoutTier = await startServer((_req, res) => sseReply(res, messageFrames({ text: '好' })))
    const first = collector()
    const firstResult = await streamWithToolsAnthropic(
      settings(withTier.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      SHORT,
      context(),
      first.cb
    )
    const second = collector()
    const secondResult = await streamWithToolsAnthropic(
      settings(withoutTier.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      SHORT,
      context(),
      second.cb
    )
    expect(firstResult.serviceTier).toEqual({ requested: 'auto', actual: 'priority', observed: true })
    expect(secondResult.serviceTier).toEqual({ requested: 'auto', actual: null, observed: false })
    expect(first.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(second.observations).toEqual([{ requested: 'auto', actual: null, observed: false }])
  })

  it('工具构造器带 context 时同样只加 service_tier 一个键', async () => {
    const tuned = settings('http://127.0.0.1:1', { maxTokens: 4096, reasoningEffort: 'high' })
    const plain = buildAnthropicToolsBody(tuned, AGENT_MESSAGES, [], true)
    const tiered = buildAnthropicToolsBody(tuned, AGENT_MESSAGES, [], true, context())
    expect(tiered['service_tier']).toBe('auto')
    const { service_tier: _tier, ...rest } = tiered
    expect(rest).toEqual(plain)
  })
})

// ── ③ 失败前已知档位：不丢、不改原终态、不重放 ──────────────────────────

describe('S3-30B ③ 已观测容量在失败路径上不丢失', () => {
  it('普通流：先给容量与部分文本再断流 → Promise 仍失败，已知 capacity 保留，请求数 1', async () => {
    const server = await startServer((_req, res) => {
      sseReplyThenBreak(res, messageFrames({ tier: 'priority', text: '部分', deltaUsage: null, stopReason: null }))
    })
    const seen = collector()
    const chunks: string[] = []
    const error = await rejectionOf(
      new AnthropicProvider().streamChat(request(server.baseURL, { context: context() }), {
        onChunk: (t) => chunks.push(t),
        onServiceTier: seen.cb
      })
    )
    expect(error).not.toBeNull()
    expect(chunks.join('')).toContain('部分')
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(server.requests).toHaveLength(1)
  })

  it('工具流：已知容量后缺终帧 → 原 unknown/missing-terminal 不变，观察仍交出真实值', async () => {
    const server = await startServer((_req, res) => {
      sseReply(res, messageFrames({ tier: 'priority', text: '部分', stopReason: null, messageStop: false }))
    })
    const seen = collector()
    const error = await rejectionOf(
      streamWithToolsAnthropic(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => undefined,
        undefined,
        SHORT,
        context(),
        seen.cb
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).facts?.terminal).toEqual({ state: 'unknown', code: 'missing-terminal' })
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(server.requests).toHaveLength(1)
  })

  it('工具流取消：已知容量后用户停止 → 原失败保留，观察仍交出真实值', async () => {
    const server = await startServer((_req, res) => {
      sseReplyHoldOpen(res, messageFrames({ tier: 'priority', text: '部分', stopReason: null, messageStop: false }))
    })
    const controller = new AbortController()
    const seen = collector()
    const error = await rejectionOf(
      streamWithToolsAnthropic(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => controller.abort(),
        controller.signal,
        SHORT,
        context(),
        seen.cb
      )
    )
    expect(error).not.toBeNull()
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(server.requests).toHaveLength(1)
  })

  it('工具 JSON 截断：先交出真实容量再抛 truncated/token-limit，用量保留、不重放', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(
        res,
        messageJson({
          stop: 'max_tokens',
          usage: { input_tokens: 5, output_tokens: 1, service_tier: 'priority' }
        })
      )
    )
    const seen = collector()
    const error = await rejectionOf(
      chatWithToolsAnthropic(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS, undefined, context(), seen.cb)
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).facts?.terminal).toEqual({ state: 'truncated', code: 'token-limit' })
    expect((error as ProviderError).facts?.usage).toMatchObject({ promptTokens: 5, completionTokens: 1 })
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(server.requests).toHaveLength(1)
  })

  it('工具 JSON 拒绝：standard 容量同样保留，终态仍是 denied/content-filter', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(
        res,
        messageJson({
          stop: 'refusal',
          usage: { input_tokens: 2, output_tokens: 0, service_tier: 'standard' }
        })
      )
    )
    const seen = collector()
    const error = await rejectionOf(
      chatWithToolsAnthropic(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS, undefined, context(), seen.cb)
    )
    expect((error as ProviderError).facts?.terminal).toEqual({ state: 'denied', code: 'content-filter' })
    expect(seen.observations).toEqual([{ requested: 'auto', actual: 'standard', observed: true }])
    expect(server.requests).toHaveLength(1)
  })

  it('HTTP 错误：没有真实容量可观察 → observed=false，且只请求一次', async () => {
    const server = await startServer((_req, res) => jsonReply(res, { error: { message: 'overloaded' } }, 500))
    const seen = collector()
    const error = await rejectionOf(
      new AnthropicProvider().streamChat(request(server.baseURL, { context: context() }), {
        onChunk: () => undefined,
        onServiceTier: seen.cb
      })
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect(seen.observations).toEqual([{ requested: 'auto', actual: null, observed: false }])
    expect(server.requests).toHaveLength(1)
  })

  it('非流普通 HTTP 错误：只请求一次，不重放', async () => {
    const server = await startServer((_req, res) => jsonReply(res, { error: { message: 'bad' } }, 400))
    const error = await rejectionOf(
      new AnthropicProvider().streamChat(
        {
          ...request(server.baseURL, { context: context() }),
          settings: settings(server.baseURL, { stream: false })
        },
        { onChunk: () => undefined }
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect(server.requests).toHaveLength(1)
  })
})

// ── ④ 认证：恰好一个头、auto 精确解析、fail-closed 不重试 ────────────────

describe('S3-30B ④ 认证互斥与 fail-closed', () => {
  it('旧档缺 authentication：保持原 x-api-key 行为，并保留 anthropic-version', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    await new AnthropicProvider().streamChat(
      { ...request(server.baseURL, { context: context() }), settings: settings(server.baseURL, { stream: false }) },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(authHeaderCount(captured.headers)).toBe(1)
    expect(handleOf(captured, 'x-api-key')).toBe(API_KEY)
    expect(handleOf(captured, 'anthropic-version')).toBe(ANTHROPIC_VERSION)
  })

  it('显式 bearer：只有 Authorization（带 Bearer 前缀），没有 x-api-key', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: context() }),
        settings: settings(server.baseURL, { stream: false, authentication: 'bearer' })
      },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(authHeaderCount(captured.headers)).toBe(1)
    expect(handleOf(captured, 'authorization')).toBe(`Bearer ${API_KEY}`)
    expect(captured.headers['x-api-key']).toBeUndefined()
    expect(handleOf(captured, 'anthropic-version')).toBe(ANTHROPIC_VERSION)
  })

  it('显式 x-api-key：只有 x-api-key，没有 Authorization', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    await chatWithToolsAnthropic(
      settings(server.baseURL, { authentication: 'x-api-key' }),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      context()
    )
    const captured = server.requests[0]!
    expect(authHeaderCount(captured.headers)).toBe(1)
    expect(handleOf(captured, 'x-api-key')).toBe(API_KEY)
    expect(captured.headers['authorization']).toBeUndefined()
  })

  it('auto 只按精确匹配的已知 authDefault 解析：Anthropic 官方面 = bearer', async () => {
    const tier = await tierModule()
    const headers = tier.buildAnthropicHeaders(
      settings('https://api.anthropic.com', { authentication: 'auto' }),
      API_KEY
    )
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`)
    expect(Object.hasOwn(headers, 'x-api-key')).toBe(false)
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
  })

  it('auto + 未登记的地址：明确拒绝、网络请求数 0（不猜头、不试两种）', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    const error = await rejectionOf(
      chatWithToolsAnthropic(
        settings(server.baseURL, { authentication: 'auto' }),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        undefined,
        context()
      )
    )
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toMatch(/auto|认证/)
    expect(server.requests).toHaveLength(0)

    const provider = new AnthropicProvider()
    const check = await provider.testConnection(
      request(server.baseURL, { context: context() }, { authentication: 'auto' })
    )
    expect(check.ok).toBe(false)
    const listed = await provider.listModels(
      request(server.baseURL, { context: context() }, { authentication: 'auto' })
    )
    expect(listed.ok).toBe(false)
    expect(server.requests).toHaveLength(0)
  })

  it('显式认证失败（401）：只请求一次，不换认证头重试', async () => {
    const server = await startServer((_req, res) => jsonReply(res, { error: { message: 'invalid key' } }, 401))
    const error = await rejectionOf(
      new AnthropicProvider().streamChat(
        {
          ...request(server.baseURL, { context: context() }),
          settings: settings(server.baseURL, { stream: false, authentication: 'bearer' })
        },
        { onChunk: () => undefined }
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect(server.requests).toHaveLength(1)
    expect(authHeaderCount(server.requests[0]!.headers)).toBe(1)
    expect(server.requests[0]!.headers['x-api-key']).toBeUndefined()
  })

  it('目录与连接检查也恰好一个认证头，并保留协议版本头', async () => {
    const server = await startServer((req, res) =>
      req.method === 'GET' ? jsonReply(res, { data: [{ id: 'claude-x' }] }) : jsonReply(res, {})
    )
    const provider = new AnthropicProvider()
    const req = request(server.baseURL, { context: context() }, { authentication: 'bearer' })
    await provider.testConnection(req)
    await provider.listModels(req)
    expect(server.requests).toHaveLength(2)
    for (const captured of server.requests) {
      expect(authHeaderCount(captured.headers)).toBe(1)
      expect(handleOf(captured, 'authorization')).toBe(`Bearer ${API_KEY}`)
      expect(handleOf(captured, 'anthropic-version')).toBe(ANTHROPIC_VERSION)
    }
  })
})

// ── ⑤ 窄身份：真实 UA、稳定随机键、无旁路 ───────────────────────────────

describe('S3-30B ⑤ 窄身份头', () => {
  it('default：不附加 User-Agent 与会话头', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    await new AnthropicProvider().streamChat(
      { ...request(server.baseURL, { context: context() }), settings: settings(server.baseURL, { stream: false }) },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    // default 不附加任何身份头：Node 传输层自带的 `node` 不算我们发的，只核没有本应用身份
    expect(handleOf(captured, 'user-agent')).not.toMatch(/^jiushililu\//)
    expect(captured.headers['x-opencode-session']).toBeUndefined()
  })

  it('self-ua：真实客户端名 + 组合根版本，不带会话头', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: context() }),
        settings: settings(server.baseURL, { stream: false, requestIdentity: 'self-ua' })
      },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(captured.headers['x-opencode-session']).toBeUndefined()
  })

  it('opencode-v1：同 operation 多次请求稳定，新 operation 隔离', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    const shared = context()
    const provider = new AnthropicProvider()
    const withIdentity = (ctx: ProviderExecutionContext): ProviderRequest => ({
      ...request(server.baseURL, { context: ctx }),
      settings: settings(server.baseURL, { stream: false, requestIdentity: 'opencode-v1' })
    })
    await provider.streamChat(withIdentity(shared), { onChunk: () => undefined })
    await provider.testConnection(withIdentity(shared))
    await provider.listModels(withIdentity(shared))
    const other = context()
    await provider.streamChat(withIdentity(other), { onChunk: () => undefined })

    const sessions = server.requests.map((captured) => handleOf(captured, 'x-opencode-session'))
    expect(sessions).toHaveLength(4)
    expect(sessions[0]).toBe(shared.sessionId)
    expect(sessions[1]).toBe(shared.sessionId)
    expect(sessions[2]).toBe(shared.sessionId)
    expect(sessions[3]).toBe(other.sessionId)
    expect(sessions[3]).not.toBe(shared.sessionId)
    for (const captured of server.requests) expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
  })

  it('身份策略要求信息但缺 context：明确拒绝且 0 请求（聊天 / 检查 / 目录）', async () => {
    const server = await startServer((req, res) =>
      req.method === 'GET' ? jsonReply(res, { data: [] }) : jsonReply(res, messageJson())
    )
    const provider = new AnthropicProvider()
    const error = await rejectionOf(
      provider.streamChat(
        { ...request(server.baseURL), settings: settings(server.baseURL, { stream: false, requestIdentity: 'self-ua' }) },
        { onChunk: () => undefined }
      )
    )
    expect(String((error as Error).message)).toMatch(/运行上下文|身份/)
    const checked = await provider.testConnection(
      request(server.baseURL, {}, { requestIdentity: 'opencode-v1' })
    )
    expect(checked.ok).toBe(false)
    const listed = await provider.listModels(request(server.baseURL, {}, { requestIdentity: 'opencode-v1' }))
    expect(listed.ok).toBe(false)
    expect(server.requests).toHaveLength(0)
  })

  it('隐私 Canary（operationId / 任意 headers 旁路）不进入 body、非授权头与日志', async () => {
    const canary = 'CANARY-E30B-7b31d2'
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(' '))
      })
    }
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    const ctx = forgedContext(NORMAL, { operationId: canary, headers: { 'X-Evil': canary } })
    const smuggled = settings(server.baseURL, {
      stream: false,
      requestIdentity: 'opencode-v1',
      headers: { 'X-Evil': canary }
    } as Partial<ModelSettings>)
    await new AnthropicProvider().streamChat(
      { ...request(server.baseURL, { context: ctx }), settings: smuggled },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(captured.body).not.toContain(canary)
    expect(JSON.stringify(captured.headers)).not.toContain(canary)
    expect(captured.headers['x-evil']).toBeUndefined()
    expect(handleOf(captured, 'x-opencode-session')).toBe(ctx.sessionId)
    expect(logged.join(' ')).not.toContain(canary)
  })

  it('版本值只出现在授权 User-Agent，不进入 body 与认证头', async () => {
    const canaryVersion = '0.13.110-CANARY-9c4a'
    const server = await startServer((_req, res) => jsonReply(res, messageJson()))
    const ctx = forgedContext(NORMAL, { clientVersion: canaryVersion })
    await new AnthropicProvider().streamChat(
      {
        ...request(server.baseURL, { context: ctx }),
        settings: settings(server.baseURL, { stream: false, requestIdentity: 'self-ua' })
      },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${canaryVersion}`)
    expect(captured.body).not.toContain(canaryVersion)
    expect(handleOf(captured, 'x-api-key')).not.toContain(canaryVersion)
    expect(handleOf(captured, 'authorization')).not.toContain(canaryVersion)
  })
})

// ── ⑥ 纯出口：本协议映射与 OpenAI 语义严格分离 ──────────────────────────

describe('S3-30B ⑥ 协议映射纯出口', () => {
  it('anthropicServiceTierForRequest：只把 fast+supported 翻译成 auto', async () => {
    const tier = await tierModule()
    expect(tier.ANTHROPIC_SERVICE_TIER_AUTO).toBe('auto')
    expect(tier.anthropicServiceTierForRequest(context())).toBe('auto')
    expect(tier.anthropicServiceTierForRequest(context(NORMAL))).toBeNull()
    expect(tier.anthropicServiceTierForRequest(context(FAST_UNKNOWN))).toBeNull()
    expect(tier.anthropicServiceTierForRequest(context(FAST_UNSUPPORTED))).toBeNull()
    expect(tier.anthropicServiceTierForRequest(undefined)).toBeNull()
    expect(
      tier.anthropicServiceTierForRequest(forgedContext(FAST_SUPPORTED, { purpose: 'connection-check' }))
    ).toBeNull()
  })

  it('withAnthropicServiceTierField 原地补字段且不动其他键', async () => {
    const tier = await tierModule()
    const body: Record<string, unknown> = { model: 'claude-test', max_tokens: 8, stream: true }
    const same = tier.withAnthropicServiceTierField(body, context())
    expect(same).toBe(body)
    expect(body).toEqual({ model: 'claude-test', max_tokens: 8, stream: true, service_tier: 'auto' })
    const untouched: Record<string, unknown> = { model: 'claude-test' }
    tier.withAnthropicServiceTierField(untouched, context(NORMAL))
    expect(untouched).toEqual({ model: 'claude-test' })
  })

  it('buildAnthropicHeaders：恰好一个认证头 + 协议版本头 + 窄身份头', async () => {
    const tier = await tierModule()
    const headers = tier.buildAnthropicHeaders(
      settings('https://api.anthropic.com', { authentication: 'bearer', requestIdentity: 'opencode-v1' }),
      API_KEY,
      context()
    )
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`)
    expect(Object.hasOwn(headers, 'x-api-key')).toBe(false)
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(headers['User-Agent']).toBe(`jiushililu/${VERSION}`)
    expect(typeof headers['x-opencode-session']).toBe('string')
    expect(headers['Content-Type']).toBe('application/json')
    const listing = tier.buildAnthropicHeaders(settings('https://api.anthropic.com'), API_KEY, undefined, { json: false })
    expect(Object.hasOwn(listing, 'Content-Type')).toBe(false)
    expect(listing['x-api-key']).toBe(API_KEY)
  })
})

// ── ⑦ 目录与检查的最终 URL / 方法 ──────────────────────────────────────

describe('S3-30B ⑦ 目录与连接检查的真实序列化', () => {
  it('目录走 GET {base}/v1/models；检查走 POST {base}/v1/messages 且不带容量字段', async () => {
    const server = await startServer((req, res) =>
      req.method === 'GET' ? jsonReply(res, { data: [{ id: 'claude-x' }] }) : jsonReply(res, {})
    )
    const provider = new AnthropicProvider()
    const req = request(server.baseURL, { context: context() })
    const listed = await provider.listModels(req)
    const checked = await provider.testConnection(req)
    expect(listed).toMatchObject({ ok: true, models: ['claude-x'] })
    expect(checked.ok).toBe(true)
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' })
    expect(server.requests[0]!.headers['content-type']).toBeUndefined()
    expect(server.requests[1]).toMatchObject({ method: 'POST', url: '/v1/messages' })
    const body = bodyJson(server.requests[1]!)
    expect(body['stream']).toBe(false)
    expect(body['max_tokens']).toBe(1)
    expect(Object.hasOwn(body, 'service_tier')).toBe(false)
  })
})
