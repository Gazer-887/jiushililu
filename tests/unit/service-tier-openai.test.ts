import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { OpenAICompatibleProvider, buildOpenAIChatBody } from '@main/providers/openai'
import {
  buildToolsBody,
  chatWithToolsOpenAI,
  streamWithToolsOpenAI
} from '@main/providers/openai-agent'
import { ProviderError } from '@main/providers/errors'
import type { ProviderRequest, StreamCallbacks } from '@main/providers/types'
import {
  createProviderExecutionContext,
  type ProviderExecutionContext,
  type RequestPolicySnapshot,
  type ServiceTierObservation
} from '@shared/request-policy'
import type { AgentMessage, ToolSchema } from '@shared/agent'
import type { ChatMessage, ModelSettings } from '@shared/ipc'
import type { TokenUsage } from '@shared/usage'

/**
 * S3-30A：OpenAI 两条链（普通对话 / 带工具）的认证、窄身份与服务档。
 *
 * ⚠️ 断言对象是**真实发出并序列化后的请求**（本地 127.0.0.1 HTTP 服务抓 headers/body/次数），
 * 不是只快照纯 body 函数；请求次数据此计数，用于证明 fail-closed 时 0 次、显式失败不重试。
 * 本文件不联网真实供应商，也不读取任何真实 Key。
 */

const VERSION = '0.13.110'
const API_KEY = 'unit-test-key-not-a-secret'

interface ServiceTierModule {
  CLIENT_NAME: string
  serviceTierForRequest(context?: ProviderExecutionContext): string | null
  resolveProviderAuth(
    settings: { authentication?: string; baseURL: string },
    protocol: 'openai-compatible' | 'anthropic',
    apiKey: string
  ): { header: 'Authorization' | 'x-api-key'; value: string }
  buildIdentityHeaders(
    settings: { requestIdentity?: string },
    context?: ProviderExecutionContext
  ): Record<string, string>
  resolveModelsRequestUrl(baseURL: string, protocol: 'openai-compatible' | 'anthropic'): string
  readServiceTierValue(payload: unknown): string | null
}

/** 新模块用动态导入：实现前各处失败能逐条落点，而不是整文件一个解析错误。 */
async function tierModule(): Promise<ServiceTierModule> {
  return (await import('@main/providers/service-tier')) as unknown as ServiceTierModule
}

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

function context(policy: RequestPolicySnapshot = FAST_SUPPORTED, purpose: 'main-chat' | 'subagent' | 'model-catalog' = 'main-chat'): ProviderExecutionContext {
  return createProviderExecutionContext({
    clientVersion: VERSION,
    purpose,
    policy: { ...policy }
  })
}

/** 恶意/越权上下文：手工构造以验证 provider 不会盲信 policy 自称的能力位。 */
function forgedContext(policy: RequestPolicySnapshot, extra: Record<string, unknown> = {}): ProviderExecutionContext {
  return Object.freeze({
    clientVersion: VERSION,
    purpose: 'main-chat',
    operationId: 'op-forged',
    sessionId: 'sess-forged',
    policy: Object.freeze({ ...policy }),
    ...extra
  }) as unknown as ProviderExecutionContext
}

function settings(baseURL: string, overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    providerType: 'openai-compatible',
    baseURL,
    model: 'test-model',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 1024,
    timeoutMs: 60_000,
    stream: true,
    contextWindow: 131_072,
    reasoningEffort: 'default',
    maxToolRounds: 8,
    inputModalities: ['text'],
    ...overrides
  }
}

const CHAT_MESSAGES: ChatMessage[] = [{ role: 'user', content: '你好' }]
const AGENT_MESSAGES: AgentMessage[] = [{ role: 'user', content: '你好' }]
const TOOLS: ToolSchema[] = []

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

function jsonReply(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function sseReply(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(frames.join(''))
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

/** 聊天非流式的最小成功响应 */
function chatJson(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
    ...extra
  }
}

/** 聊天流式：一帧正文 + 一帧 usage（可注入 service_tier） */
function chatFrames(extra: { tierFrame?: Record<string, unknown>; usageFrame?: Record<string, unknown> | null } = {}): string[] {
  const frames = ['data: {"choices":[{"delta":{"content":"好"}}]}\n\n']
  if (extra.tierFrame) frames.push(`data: ${JSON.stringify(extra.tierFrame)}\n\n`)
  if (extra.usageFrame !== null) {
    frames.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        ...(extra.usageFrame ?? {})
      })}\n\n`
    )
  }
  frames.push('data: [DONE]\n\n')
  return frames
}

function authHeaderCount(headers: Record<string, string | string[] | undefined>): number {
  return ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].filter((name) => name in headers).length
}

function bodyJson(captured: CapturedRequest): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  vi.restoreAllMocks()
})

// ── ① 旧调用者：缺 context 时请求逐字节不变 ─────────────────────────────

describe('S3-30A ① 普通模式与缺 context 的旧档不附加服务档字段', () => {
  it('buildOpenAIChatBody / buildToolsBody 不传 context 时没有 service_tier 键', () => {
    for (const stream of [true, false]) {
      expect(Object.hasOwn(buildOpenAIChatBody(settings('https://api.example.com/v1'), CHAT_MESSAGES, stream), 'service_tier')).toBe(false)
      expect(Object.hasOwn(buildToolsBody(settings('https://api.example.com/v1'), AGENT_MESSAGES, TOOLS, stream), 'service_tier')).toBe(false)
    }
  })

  it('四条真实请求链：缺 context 时不发 service_tier，且恰好一个认证头', async () => {
    const server = await startServer((_req, res, index) => {
      if (index === 0) jsonReply(res, chatJson('非流式回复'))
      else if (index === 1) sseReply(res, chatFrames())
      else if (index === 2) jsonReply(res, chatJson('工具非流式'))
      else sseReply(res, chatFrames())
    })

    const chatProvider = new OpenAICompatibleProvider()
    // 1) 普通对话非流式
    await chatProvider.streamChat(request(server.baseURL, {}, { stream: false }), { onChunk: () => undefined })
    // 2) 普通对话流式
    await chatProvider.streamChat(request(server.baseURL), { onChunk: () => undefined })
    // 3) 带工具非流式
    await chatWithToolsOpenAI(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS)
    // 4) 带工具流式
    await streamWithToolsOpenAI(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS, () => undefined)

    expect(server.requests).toHaveLength(4)
    for (const captured of server.requests) {
      expect(captured.body).not.toContain('service_tier')
      expect(authHeaderCount(captured.headers)).toBe(1)
      expect(captured.headers['authorization']).toBe(`Bearer ${API_KEY}`)
    }
  })

  it('普通模式（normal）有 context 也不发 service_tier', () => {
    const ctx = context(NORMAL)
    expect(Object.hasOwn(buildOpenAIChatBody(settings('https://api.example.com/v1'), CHAT_MESSAGES, true, ctx), 'service_tier')).toBe(false)
    expect(Object.hasOwn(buildToolsBody(settings('https://api.example.com/v1'), AGENT_MESSAGES, TOOLS, true, ctx), 'service_tier')).toBe(false)
  })
})

// ── ② 服务档请求门控：fast × supported 才发 ───────────────────────────────

describe('S3-30A ② 只有 fast + supported 才发送非默认 service_tier', () => {
  it('fast + supported：四条链都发送 priority', async () => {
    const server = await startServer((_req, res, index) => {
      if (index === 0) jsonReply(res, chatJson('n'))
      else if (index === 1) sseReply(res, chatFrames())
      else if (index === 2) jsonReply(res, chatJson('t'))
      else sseReply(res, chatFrames())
    })
    const ctx = context(FAST_SUPPORTED)
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: ctx }, { stream: false }),
      { onChunk: () => undefined }
    )
    await new OpenAICompatibleProvider().streamChat(request(server.baseURL, { context: ctx }), { onChunk: () => undefined })
    await chatWithToolsOpenAI(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS, undefined, ctx)
    await streamWithToolsOpenAI(settings(server.baseURL), API_KEY, AGENT_MESSAGES, TOOLS, () => undefined, undefined, undefined, undefined, ctx)

    expect(server.requests).toHaveLength(4)
    for (const captured of server.requests) expect(bodyJson(captured)['service_tier']).toBe('priority')
  })

  it('fast + unknown / fast + unsupported：不发 service_tier', () => {
    for (const policy of [FAST_UNKNOWN, FAST_UNSUPPORTED]) {
      const ctx = context(policy)
      const chat = buildOpenAIChatBody(settings('https://api.example.com/v1'), CHAT_MESSAGES, true, ctx)
      const tools = buildToolsBody(settings('https://api.example.com/v1'), AGENT_MESSAGES, TOOLS, true, ctx)
      expect(Object.hasOwn(chat, 'service_tier')).toBe(false)
      expect(Object.hasOwn(tools, 'service_tier')).toBe(false)
    }
  })

  it('不盲信 requestedServiceTier：能力位 unknown 或模式 normal 时，自称 priority 也不发', () => {
    const hostile1 = forgedContext({ ...FAST_UNKNOWN, requestedServiceTier: 'priority' })
    const hostile2 = forgedContext({ ...NORMAL, requestedServiceTier: 'priority' })
    for (const ctx of [hostile1, hostile2]) {
      expect(Object.hasOwn(buildOpenAIChatBody(settings('https://api.example.com/v1'), CHAT_MESSAGES, true, ctx), 'service_tier')).toBe(false)
    }
  })

  it('辅助 purpose 即使传入 FAST 也固定 normal：不偷发收费档', () => {
    const ctx = context(FAST_SUPPORTED, 'model-catalog')
    expect(ctx.policy.mode).toBe('normal')
    expect(ctx.policy.requestedServiceTier).toBeNull()
    expect(Object.hasOwn(buildOpenAIChatBody(settings('https://api.example.com/v1'), CHAT_MESSAGES, true, ctx), 'service_tier')).toBe(false)
  })

  it('testConnection 与 listModels 永不发服务档，即使收到伪 fast 上下文', async () => {
    const server = await startServer((_req, res, index) => {
      if (index === 0) jsonReply(res, chatJson('ok'))
      else jsonReply(res, { data: [{ id: 'm1' }] })
    })
    const forged = forgedContext(FAST_SUPPORTED)
    await new OpenAICompatibleProvider().testConnection(
      request(server.baseURL, { context: forged }, { stream: false })
    )
    const listed = await new OpenAICompatibleProvider().listModels(
      request(server.baseURL, { context: forged }, { stream: false })
    )
    expect(listed.ok).toBe(true)
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]!.body).not.toContain('service_tier')
    expect(server.requests[1]!.method).toBe('GET')
    expect(server.requests[1]!.body).toBe('')
  })

  it('附加 service_tier 不改变模型、推理、输入/输出预算与 stream', () => {
    const base = settings('https://api.example.com/v1', { reasoningEffort: 'high', maxTokens: 4321, temperature: 0.3 })
    const plain = buildOpenAIChatBody(base, CHAT_MESSAGES, true)
    const tiered = buildOpenAIChatBody(base, CHAT_MESSAGES, true, context())
    const { service_tier: tier, ...rest } = tiered
    expect(tier).toBe('priority')
    expect(rest).toEqual(plain)
  })
})

// ── ③ 响应观测：actual 只来自真实回值 ─────────────────────────────────────

describe('S3-30A ③ 普通对话的真实服务档观测', () => {
  it('非流式：服务端回 default 时保留 default，observed=true', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('hi', { service_tier: 'default' })))
    const seen: ServiceTierObservation[] = []
    const cb: StreamCallbacks = { onChunk: () => undefined, onServiceTier: (o) => seen.push(o) }
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }, { stream: false }),
      cb
    )
    expect(seen).toEqual([{ requested: 'priority', actual: 'default', observed: true }])
  })

  it('非流式：缺报时 actual=null / observed=false，不因 200、usage 或终态推断', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('hi')))
    const seen: ServiceTierObservation[] = []
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }, { stream: false }),
      { onChunk: () => undefined, onServiceTier: (o) => seen.push(o) }
    )
    expect(seen).toEqual([{ requested: 'priority', actual: null, observed: false }])
  })

  it('流式：档位帧与流尾 usage 帧独立，两处都能收', async () => {
    const server = await startServer((_req, res) =>
      sseReply(res, chatFrames({ tierFrame: { service_tier: 'priority' } }))
    )
    const seen: ServiceTierObservation[] = []
    let usageTotal: number | null = null
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }),
      {
        onChunk: () => undefined,
        onUsage: (u) => (usageTotal = u.promptTokens + u.completionTokens),
        onServiceTier: (o) => seen.push(o)
      }
    )
    expect(seen).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
    expect(usageTotal).toBe(5)
  })

  it('流式：有 usage 无档位 → observed=false；有档位无 usage → 档位照报、不补 0', async () => {
    const noTier = await startServer((_req, res) => sseReply(res, chatFrames()))
    const seenA: ServiceTierObservation[] = []
    await new OpenAICompatibleProvider().streamChat(
      request(noTier.baseURL, { context: context() }),
      { onChunk: () => undefined, onServiceTier: (o) => seenA.push(o) }
    )
    expect(seenA).toEqual([{ requested: 'priority', actual: null, observed: false }])

    const noUsage = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"service_tier":"priority","choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const seenB: ServiceTierObservation[] = []
    const usages: number[] = []
    await new OpenAICompatibleProvider().streamChat(
      request(noUsage.baseURL, { context: context() }),
      {
        onChunk: () => undefined,
        onUsage: () => usages.push(1),
        onServiceTier: (o) => seenB.push(o)
      }
    )
    expect(seenB).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
    expect(usages).toEqual([])
  })

  it('流式：usage 全为 0 是真实值，照常回报；档位缺报仍 independent', async () => {
    const server = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const seen: ServiceTierObservation[] = []
    let promptTokens: number | null = null
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }),
      {
        onChunk: () => undefined,
        onUsage: (u) => (promptTokens = u.promptTokens),
        onServiceTier: (o) => seen.push(o)
      }
    )
    expect(promptTokens).toBe(0)
    expect(seen).toEqual([{ requested: 'priority', actual: null, observed: false }])
  })

  it('流式：usage 只报一半时不当完整用量，也不影响档位独立观测', async () => {
    const server = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3}}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const seen: ServiceTierObservation[] = []
    const usages: number[] = []
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }),
      {
        onChunk: () => undefined,
        onUsage: () => usages.push(1),
        onServiceTier: (o) => seen.push(o)
      }
    )
    expect(usages).toEqual([])
    expect(seen).toEqual([{ requested: 'priority', actual: null, observed: false }])
  })

  it('普通模式 + 服务端回 priority：requested=null 但 actual 仍是真实值', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('hi', { service_tier: 'priority' })))
    const seen: ServiceTierObservation[] = []
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context(NORMAL) }, { stream: false }),
      { onChunk: () => undefined, onServiceTier: (o) => seen.push(o) }
    )
    expect(seen).toEqual([{ requested: null, actual: 'priority', observed: true }])
  })
})

// ── ④ 带工具链的结果字段 ──────────────────────────────────────────────────

describe('S3-30A ④ 带工具链的 serviceTier 结果字段', () => {
  it('非流式：真实 service_tier 进结果；缺报时给未知观测', async () => {
    let index = 0
    const server = await startServer((_req, res) => {
      index += 1
      jsonReply(res, chatJson('工具回复', index === 1 ? { service_tier: 'priority' } : {}))
    })
    const observed = await chatWithToolsOpenAI(
      settings(server.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      context()
    )
    expect(observed.serviceTier).toEqual({ requested: 'priority', actual: 'priority', observed: true })
    expect(observed.usageComplete).toBe(true)

    const missing = await chatWithToolsOpenAI(
      settings(server.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      context()
    )
    expect(missing.serviceTier).toEqual({ requested: 'priority', actual: null, observed: false })
  })

  it('带工具：部分 usage 不算完整、0 用量仍是真值，二者都不影响档位观测', async () => {
    let index = 0
    const server = await startServer((_req, res) => {
      index += 1
      if (index === 1) {
        jsonReply(res, {
          choices: [{ message: { content: '部分用量' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3 },
          service_tier: 'default'
        })
        return
      }
      sseReply(res, [
        'data: {"choices":[{"delta":{"content":"零用量"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    })
    const partial = await chatWithToolsOpenAI(
      settings(server.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      context()
    )
    expect(partial.usageComplete).toBe(false)
    expect('usage' in partial).toBe(false)
    expect(partial.serviceTier).toEqual({ requested: 'priority', actual: 'default', observed: true })

    const zero = await streamWithToolsOpenAI(
      settings(server.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      undefined,
      undefined,
      context()
    )
    expect(zero.usage).toMatchObject({ promptTokens: 0, completionTokens: 0 })
    expect(zero.usageComplete).toBe(true)
    expect(zero.serviceTier).toEqual({ requested: 'priority', actual: null, observed: false })
  })

  it('流式：档位帧真实回值进结果；缺报保持未知；旧调用者（无 context 无回值）不新增键', async () => {
    const withTier = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"service_tier":"default","choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const hit = await streamWithToolsOpenAI(
      settings(withTier.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      undefined,
      undefined,
      context()
    )
    expect(hit.serviceTier).toEqual({ requested: 'priority', actual: 'default', observed: true })

    const noTier = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const missed = await streamWithToolsOpenAI(
      settings(noTier.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      undefined,
      undefined,
      context()
    )
    expect(missed.serviceTier).toEqual({ requested: 'priority', actual: null, observed: false })

    const legacy = await streamWithToolsOpenAI(
      settings(noTier.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined
    )
    expect('serviceTier' in legacy).toBe(false)
  })
})

// ── ⑤ 窄身份：真实 UA + 稳定随机会话头 ────────────────────────────────────

describe('S3-30A ⑤ 窄身份只输出真实 UA 与 x-opencode-session', () => {
  it('default / 缺字段：不发 UA、不发 x-opencode-session（旧行为）', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok', { service_tier: 'default' })))
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }, { stream: false }),
      { onChunk: () => undefined }
    )
    const headers = server.requests[0]!.headers
    // 运行栈（undici）自带 `user-agent: node`：default 的判据是"没有附加本应用身份"
    expect(String(headers['user-agent'] ?? '')).not.toMatch(/^jiushililu\//)
    expect(headers['x-opencode-session']).toBeUndefined()
  })

  it('self-ua：真实客户端名 + 组合根版本；不发会话头', async () => {
    const module = await tierModule()
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    const ctx = context()
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: ctx }, { stream: false, requestIdentity: 'self-ua' }),
      { onChunk: () => undefined }
    )
    const headers = server.requests[0]!.headers
    expect(headers['user-agent']).toBe(`${module.CLIENT_NAME}/${VERSION}`)
    expect(String(headers['user-agent']).toLowerCase()).not.toContain('opencode')
    expect(headers['x-opencode-session']).toBeUndefined()
  })

  it('opencode-v1：额外发 context.sessionId；同上下文稳定、不同上下文隔离', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    const first = context()
    const second = context()
    for (const ctx of [first, first, second]) {
      await new OpenAICompatibleProvider().streamChat(
        request(server.baseURL, { context: ctx }, { stream: false, requestIdentity: 'opencode-v1' }),
        { onChunk: () => undefined }
      )
    }
    const sessions = server.requests.map((captured) => captured.headers['x-opencode-session'])
    expect(sessions[0]).toBe(first.sessionId)
    expect(sessions[1]).toBe(first.sessionId)
    expect(sessions[2]).toBe(second.sessionId)
    expect(sessions[0]).not.toBe(sessions[2])
    for (const captured of server.requests) {
      expect(String(captured.headers['user-agent'])).toMatch(/^jiushililu\//)
    }
  })

  it('需要身份但缺 context：明确拒绝且 0 请求，不伪造版本或随机键', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    for (const requestIdentity of ['self-ua', 'opencode-v1']) {
      await expect(
        new OpenAICompatibleProvider().streamChat(
          request(server.baseURL, {}, { stream: false, requestIdentity }),
          { onChunk: () => undefined }
        )
      ).rejects.toThrow(/身份|上下文|版本/)
    }
    expect(server.requests).toHaveLength(0)
  })

  it('手造上下文含 CRLF 控制字符：拒绝且 0 请求（不允许拼出可注入 header）', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    const evilVersion = Object.freeze({
      clientVersion: '1.0\r\nX-Evil: 1',
      purpose: 'main-chat',
      operationId: 'op-1',
      sessionId: 'sess-1',
      policy: Object.freeze({ ...NORMAL })
    }) as unknown as ProviderExecutionContext
    const evilSession = Object.freeze({
      clientVersion: VERSION,
      purpose: 'main-chat',
      operationId: 'op-1',
      sessionId: 'sess\r\nX-Evil: 2',
      policy: Object.freeze({ ...NORMAL })
    }) as unknown as ProviderExecutionContext
    await expect(
      new OpenAICompatibleProvider().streamChat(
        request(server.baseURL, { context: evilVersion }, { stream: false, requestIdentity: 'self-ua' }),
        { onChunk: () => undefined }
      )
    ).rejects.toThrow()
    await expect(
      new OpenAICompatibleProvider().streamChat(
        request(server.baseURL, { context: evilSession }, { stream: false, requestIdentity: 'opencode-v1' }),
        { onChunk: () => undefined }
      )
    ).rejects.toThrow()
    expect(server.requests).toHaveLength(0)
  })

  it('隐私 Canary（operationId / 任意 headers 旁路）不进入 body、非授权头与日志', async () => {
    const canary = 'CANARY-E30A-2f91c7'
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(' '))
      })
    }
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    const ctx = forgedContext(NORMAL, { operationId: canary, headers: { 'X-Evil': canary } })
    const smuggled = settings(server.baseURL, {
      requestIdentity: 'opencode-v1',
      headers: { 'X-Evil': canary }
    } as Partial<ModelSettings>)
    await new OpenAICompatibleProvider().streamChat(
      { ...request(server.baseURL, { context: ctx }), settings: smuggled },
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(captured.body).not.toContain(canary)
    expect(JSON.stringify(captured.headers)).not.toContain(canary)
    expect(captured.headers['x-evil']).toBeUndefined()
    expect(logged.join(' ')).not.toContain(canary)
  })

  it('版本值只出现在授权 User-Agent，不进入 body 与认证头', async () => {
    const canaryVersion = '0.13.110-CANARY-4d2e'
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    const ctx = Object.freeze({
      clientVersion: canaryVersion,
      purpose: 'main-chat',
      operationId: 'op-1',
      sessionId: 'sess-1',
      policy: Object.freeze({ ...NORMAL })
    }) as unknown as ProviderExecutionContext
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: ctx }, { stream: false, requestIdentity: 'self-ua' }),
      { onChunk: () => undefined }
    )
    const captured = server.requests[0]!
    expect(captured.headers['user-agent']).toBe(`jiushililu/${canaryVersion}`)
    expect(captured.body).not.toContain(canaryVersion)
    expect(String(captured.headers['authorization'])).not.toContain(canaryVersion)
  })
})

// ── ⑥ 认证：互斥头、auto 精确解析、fail-closed 与不重试 ───────────────────

describe('S3-30A ⑥ 认证只发一种头，auto 精确解析且 fail-closed', () => {
  it('旧档缺 authentication：openai-compatible 保持 bearer 旧行为', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }, { stream: false }),
      { onChunk: () => undefined }
    )
    expect(authHeaderCount(server.requests[0]!.headers)).toBe(1)
    expect(server.requests[0]!.headers['authorization']).toBe(`Bearer ${API_KEY}`)
  })

  it('显式 bearer：仅 Authorization；显式 x-api-key 在 openai-compatible 上明确拒绝且 0 请求', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }, { stream: false, authentication: 'bearer' }),
      { onChunk: () => undefined }
    )
    expect(authHeaderCount(server.requests[0]!.headers)).toBe(1)
    expect(server.requests[0]!.headers['authorization']).toBe(`Bearer ${API_KEY}`)

    const before = server.requests.length
    await expect(
      new OpenAICompatibleProvider().streamChat(
        request(server.baseURL, { context: context() }, { stream: false, authentication: 'x-api-key' }),
        { onChunk: () => undefined }
      )
    ).rejects.toThrow(/x-api-key|不兼容/)
    expect(server.requests).toHaveLength(before)
  })

  it('auto：只按精确匹配预设的已知 authDefault 解析；unknown 与自定义地址 fail-closed 0 请求', async () => {
    const module = await tierModule()
    // 精确匹配 MiniMax（普通与订阅同 base、同 bearer）→ 已知缺省
    expect(module.resolveProviderAuth({ authentication: 'auto', baseURL: 'https://api.minimax.cn/v1' }, 'openai-compatible', API_KEY)).toEqual({
      header: 'Authorization',
      value: API_KEY
    })
    // OpenAI 官方面 authDefault=unknown → 拒绝
    expect(() => module.resolveProviderAuth({ authentication: 'auto', baseURL: 'https://api.openai.com/v1' }, 'openai-compatible', API_KEY)).toThrow(/unknown|认证/)
    // 自定义/本地地址不在预设表 → 无法精确辨认 → 拒绝
    expect(() => module.resolveProviderAuth({ authentication: 'auto', baseURL: 'http://127.0.0.1:9/v1' }, 'openai-compatible', API_KEY)).toThrow(/预设|认证/)

    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    await expect(
      new OpenAICompatibleProvider().streamChat(
        request(server.baseURL, { context: context() }, { stream: false, authentication: 'auto' }),
        { onChunk: () => undefined }
      )
    ).rejects.toThrow(/预设|认证|auto/)
    expect(server.requests).toHaveLength(0)
  })

  it('testConnection / listModels 对 unknown auto 也是 0 请求并给明确失败', async () => {
    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    const provider = new OpenAICompatibleProvider()
    const tested = await provider.testConnection(
      request(server.baseURL, {}, { stream: false, authentication: 'auto' })
    )
    const listed = await provider.listModels(request(server.baseURL, {}, { stream: false, authentication: 'auto' }))
    expect(tested.ok).toBe(false)
    expect(tested.message).toMatch(/预设|认证|auto/)
    expect(listed.ok).toBe(false)
    expect(listed.message).toMatch(/预设|认证|auto/)
    expect(server.requests).toHaveLength(0)
  })

  it('显式认证失败只发一次请求，不自动换认证重试', async () => {
    const server = await startServer((_req, res) => jsonReply(res, { error: { message: 'bad key' } }, 401))
    await expect(
      new OpenAICompatibleProvider().streamChat(
        request(server.baseURL, { context: context() }, { stream: false, authentication: 'bearer' }),
        { onChunk: () => undefined }
      )
    ).rejects.toThrow()
    expect(server.requests).toHaveLength(1)
    expect(authHeaderCount(server.requests[0]!.headers)).toBe(1)
  })

  it('Key 不进入请求体；协议面纯函数：Anthropic 旧档 x-api-key，显式 bearer 只换头不双发', async () => {
    const module = await tierModule()
    expect(module.resolveProviderAuth({ baseURL: 'https://api.anthropic.com' }, 'anthropic', API_KEY)).toEqual({
      header: 'x-api-key',
      value: API_KEY
    })
    expect(module.resolveProviderAuth({ authentication: 'bearer', baseURL: 'https://api.anthropic.com' }, 'anthropic', API_KEY)).toEqual({
      header: 'Authorization',
      value: API_KEY
    })
    expect(module.resolveProviderAuth({ authentication: 'x-api-key', baseURL: 'https://api.anthropic.com' }, 'anthropic', API_KEY)).toEqual({
      header: 'x-api-key',
      value: API_KEY
    })

    const server = await startServer((_req, res) => jsonReply(res, chatJson('ok')))
    await new OpenAICompatibleProvider().streamChat(
      request(server.baseURL, { context: context() }, { stream: false, authentication: 'bearer' }),
      { onChunk: () => undefined }
    )
    expect(server.requests[0]!.body).not.toContain(API_KEY)
  })
})

// ── ⑦ 目录与检查：身份同规则 + URL 不回归 ────────────────────────────────

describe('S3-30A ⑦ listModels / testConnection 身份与最终 URL', () => {
  it('OpenCode Go 目录最终路径 = /inference/go/v1/models（不发送真实厂商请求）', async () => {
    const module = await tierModule()
    expect(module.resolveModelsRequestUrl('https://opencode.ai/inference/go/openai/v1', 'openai-compatible')).toBe(
      'https://opencode.ai/inference/go/v1/models'
    )
    expect(module.resolveModelsRequestUrl('https://opencode.ai/inference/go/anthropic', 'anthropic')).toBe(
      'https://opencode.ai/inference/go/v1/models'
    )
  })

  it('普通 /v1 与 Gemini /v1beta/openai 的目录路径不回归', async () => {
    const module = await tierModule()
    const plain = await startServer((_req, res) => jsonReply(res, { data: [{ id: 'm1' }] }))
    const provider = new OpenAICompatibleProvider()
    const v1 = await provider.listModels(request(`${plain.baseURL}/v1`, {}, { stream: false }))
    expect(v1.ok).toBe(true)
    expect(plain.requests[0]!.url).toBe('/v1/models')

    const gemini = await startServer((_req, res) => jsonReply(res, { data: [{ id: 'm2' }] }))
    const compat = await provider.listModels(request(`${gemini.baseURL}/v1beta/openai`, {}, { stream: false }))
    expect(compat.ok).toBe(true)
    expect(gemini.requests[0]!.url).toBe('/v1beta/openai/models')
    expect(module.resolveModelsRequestUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'openai-compatible')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models'
    )
  })

  it('testConnection 与 listModels 同走身份规则（self-ua / opencode-v1）', async () => {
    const server = await startServer((_req, res, index) => {
      if (index === 0) jsonReply(res, chatJson('ok'))
      else jsonReply(res, { data: [{ id: 'm1' }] })
    })
    const provider = new OpenAICompatibleProvider()
    const ctx = context(FAST_SUPPORTED, 'connection-check')
    await provider.testConnection(
      request(server.baseURL, { context: ctx }, { stream: false, requestIdentity: 'opencode-v1' })
    )
    const catalogCtx = context(FAST_SUPPORTED, 'model-catalog')
    await provider.listModels(
      request(server.baseURL, { context: catalogCtx }, { stream: false, requestIdentity: 'self-ua' })
    )
    expect(server.requests[0]!.headers['user-agent']).toBe(`jiushililu/${VERSION}`)
    expect(server.requests[0]!.headers['x-opencode-session']).toBe(ctx.sessionId)
    expect(server.requests[1]!.headers['user-agent']).toBe(`jiushililu/${VERSION}`)
    expect(server.requests[1]!.headers['x-opencode-session']).toBeUndefined()
    for (const captured of server.requests) expect(captured.body).not.toContain('service_tier')
  })
})

// ── ⑧ 纯函数哨兵：不猜值、不伪造 ──────────────────────────────────────────

describe('S3-30A ⑧ 服务档纯函数边界', () => {
  it('serviceTierForRequest 只认 fast + supported + 非默认值', async () => {
    const module = await tierModule()
    expect(module.serviceTierForRequest(context(FAST_SUPPORTED))).toBe('priority')
    expect(module.serviceTierForRequest(context(FAST_UNKNOWN))).toBeNull()
    expect(module.serviceTierForRequest(context(FAST_UNSUPPORTED))).toBeNull()
    expect(module.serviceTierForRequest(context(NORMAL))).toBeNull()
    expect(module.serviceTierForRequest(undefined)).toBeNull()
    expect(module.serviceTierForRequest(forgedContext({ ...FAST_SUPPORTED, requestedServiceTier: 'default' }))).toBeNull()
    expect(module.serviceTierForRequest(forgedContext({ ...FAST_SUPPORTED, requestedServiceTier: 'auto' }))).toBeNull()
    // 伪造 context 也不能让辅助 purpose 绕过"固定普通"
    for (const purpose of ['reflection', 'title', 'prompt-polish', 'connection-check', 'model-catalog']) {
      expect(module.serviceTierForRequest(forgedContext(FAST_SUPPORTED, { purpose }))).toBeNull()
    }
  })

  it('readServiceTierValue 只认非空字符串，其他一律 null', async () => {
    const module = await tierModule()
    expect(module.readServiceTierValue({ service_tier: 'default' })).toBe('default')
    expect(module.readServiceTierValue({ service_tier: 'priority' })).toBe('priority')
    expect(module.readServiceTierValue({ service_tier: '' })).toBeNull()
    expect(module.readServiceTierValue({ service_tier: '   ' })).toBeNull()
    expect(module.readServiceTierValue({ service_tier: 1 })).toBeNull()
    expect(module.readServiceTierValue({})).toBeNull()
    expect(module.readServiceTierValue(null)).toBeNull()
  })
})

// ── ⑨ S3-30A-R1：失败前已知档位的无损观察 ─────────────────────────────────

/**
 * 这些用例全部使用**真实本地 HTTP/SSE**：服务端先回出档位帧，再断流 / 取消 / 缺终帧 / 抛原失败。
 * 断言三件事同时成立：① Promise 的原失败语义不变（终态/usage 不动）② 请求数仍为 1（不重发）
 * ③ 单请求观察出口拿到同一请求的真实档位。缺档位时只允许 actual=null / observed=false。
 */
describe('S3-30A-R1 ⑨ 失败前已知档位的无损观察', () => {
  it('普通流：档位与部分正文/usage 后真实断流，Promise 仍失败，已知 actual 可取得且请求数 1', async () => {
    const server = await startServer((_req, res) =>
      sseReplyThenBreak(res, [
        'data: {"service_tier":"priority","choices":[{"delta":{"content":"半"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"截"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
      ])
    )
    const chunks: string[] = []
    const seen: ServiceTierObservation[] = []
    let usage: TokenUsage | null = null
    const error = await rejectionOf(
      new OpenAICompatibleProvider().streamChat(request(server.baseURL, { context: context() }), {
        onChunk: (text) => chunks.push(text),
        onUsage: (value) => (usage = value),
        onServiceTier: (observation) => seen.push(observation)
      })
    )
    expect(error).not.toBeNull()
    expect(server.requests).toHaveLength(1)
    expect(chunks.join('')).toBe('半截')
    expect(usage).toMatchObject({ promptTokens: 3, completionTokens: 2 })
    expect(seen).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
  })

  it('普通流：断流前未见到档位 → 仍诚实回报 observed=false，不从 200/usage 推断', async () => {
    const server = await startServer((_req, res) =>
      sseReplyThenBreak(res, [
        'data: {"choices":[{"delta":{"content":"断"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
      ])
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      new OpenAICompatibleProvider().streamChat(request(server.baseURL, { context: context() }), {
        onChunk: () => undefined,
        onServiceTier: (observation) => seen.push(observation)
      })
    )
    expect(error).not.toBeNull()
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: null, observed: false }])
  })

  it('工具流：档位后缺终帧 → 原 unknown/missing-terminal 与 usage 保留，观察出口交出真实档位', async () => {
    const server = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"service_tier":"default","choices":[{"delta":{"content":"半"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'
      ])
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      streamWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => undefined,
        undefined,
        undefined,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    const facts = (error as ProviderError).facts
    expect(facts?.terminal).toEqual({ state: 'unknown', code: 'missing-terminal' })
    expect(facts?.usage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
    expect(facts?.usageComplete).toBe(true)
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: 'default', observed: true }])
  })

  it('工具流：档位后真实断流 → Promise 仍失败，观察出口交出真实档位且不重发', async () => {
    const server = await startServer((_req, res) =>
      sseReplyThenBreak(res, [
        'data: {"service_tier":"priority","choices":[{"delta":{"content":"半"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"截"}}]}\n\n'
      ])
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      streamWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => undefined,
        undefined,
        undefined,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).not.toBeNull()
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
  })

  it('工具流：收到档位后取消 → 已知 actual 不丢，Promise 保持失败且请求数 1', async () => {
    const server = await startServer((_req, res) =>
      sseReplyHoldOpen(res, [
        'data: {"service_tier":"priority","choices":[{"delta":{"content":"半"}}]}\n\n'
      ])
    )
    const controller = new AbortController()
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      streamWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => controller.abort(),
        controller.signal,
        undefined,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).not.toBeNull()
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
  })

  it('工具 JSON：length 带档位与真实 0 usage → truncated 失败原样，观察保存实际值且不重放', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, {
        choices: [{ message: { content: '截断正文' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        service_tier: 'default'
      })
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      chatWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    const facts = (error as ProviderError).facts
    expect(facts?.terminal).toEqual({ state: 'truncated', code: 'token-limit' })
    expect(facts?.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: null,
      reasoningTokens: null
    })
    expect(facts?.usageComplete).toBe(true)
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: 'default', observed: true }])
  })

  it('工具 JSON：content_filter 带档位与 usage → denied 失败原样，观察保存实际值', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, {
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        service_tier: 'priority'
      })
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      chatWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    const facts = (error as ProviderError).facts
    expect(facts?.terminal).toEqual({ state: 'denied', code: 'content-filter' })
    expect(facts?.usage).toMatchObject({ promptTokens: 3, completionTokens: 2 })
    expect(facts?.usageComplete).toBe(true)
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
  })

  it('工具流端点回退 JSON：length 失败仍交出档位，收尾不得补发 observed=false 覆盖', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, {
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
        service_tier: 'priority'
      })
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      streamWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => undefined,
        undefined,
        undefined,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).facts?.terminal).toEqual({
      state: 'truncated',
      code: 'token-limit'
    })
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
  })

  it('无实际档位：工具流成功与工具 JSON 成功都只回报 observed=false，不从 requested/usage/200 回填', async () => {
    const streamed = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"choices":[{"delta":{"content":"无档"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const streamSeen: ServiceTierObservation[] = []
    const streamedResult = await streamWithToolsOpenAI(
      settings(streamed.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      () => undefined,
      undefined,
      undefined,
      undefined,
      context(),
      (observation) => streamSeen.push(observation)
    )
    expect(streamedResult.serviceTier).toEqual({
      requested: 'priority',
      actual: null,
      observed: false
    })
    expect(streamSeen).toEqual([{ requested: 'priority', actual: null, observed: false }])

    const json = await startServer((_req, res) => jsonReply(res, chatJson('无档')))
    const jsonSeen: ServiceTierObservation[] = []
    const jsonResult = await chatWithToolsOpenAI(
      settings(json.baseURL),
      API_KEY,
      AGENT_MESSAGES,
      TOOLS,
      undefined,
      context(),
      (observation) => jsonSeen.push(observation)
    )
    expect(jsonResult.serviceTier).toEqual({
      requested: 'priority',
      actual: null,
      observed: false
    })
    expect(jsonSeen).toEqual([{ requested: 'priority', actual: null, observed: false }])
  })

  it('工具 JSON 失败但无档位 → 仍 observed=false，原 truncated 终态不变', async () => {
    const server = await startServer((_req, res) =>
      jsonReply(res, {
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 2, completion_tokens: 0 }
      })
    )
    const seen: ServiceTierObservation[] = []
    const error = await rejectionOf(
      chatWithToolsOpenAI(
        settings(server.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        undefined,
        context(),
        (observation) => seen.push(observation)
      )
    )
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).facts?.terminal).toEqual({
      state: 'truncated',
      code: 'token-limit'
    })
    expect(server.requests).toHaveLength(1)
    expect(seen).toEqual([{ requested: 'priority', actual: null, observed: false }])
  })

  it('并发四请求（普通/工具 × 成功/失败）各持观察出口，不串档位', async () => {
    const plainOk = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"service_tier":"default","choices":[{"delta":{"content":"成"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const plainBreak = await startServer((_req, res) =>
      sseReplyThenBreak(res, [
        'data: {"service_tier":"priority","choices":[{"delta":{"content":"断"}}]}\n\n'
      ])
    )
    const toolOk = await startServer((_req, res) =>
      sseReply(res, [
        'data: {"service_tier":"priority","choices":[{"delta":{"content":"成"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const toolFail = await startServer((_req, res) =>
      jsonReply(res, {
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
        service_tier: 'default'
      })
    )
    const seenPlainOk: ServiceTierObservation[] = []
    const seenPlainBreak: ServiceTierObservation[] = []
    const seenToolOk: ServiceTierObservation[] = []
    const seenToolFail: ServiceTierObservation[] = []
    const results = await Promise.allSettled([
      new OpenAICompatibleProvider().streamChat(request(plainOk.baseURL, { context: context() }), {
        onChunk: () => undefined,
        onServiceTier: (observation) => seenPlainOk.push(observation)
      }),
      new OpenAICompatibleProvider().streamChat(
        request(plainBreak.baseURL, { context: context() }),
        {
          onChunk: () => undefined,
          onServiceTier: (observation) => seenPlainBreak.push(observation)
        }
      ),
      streamWithToolsOpenAI(
        settings(toolOk.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        () => undefined,
        undefined,
        undefined,
        undefined,
        context(),
        (observation) => seenToolOk.push(observation)
      ),
      chatWithToolsOpenAI(
        settings(toolFail.baseURL),
        API_KEY,
        AGENT_MESSAGES,
        TOOLS,
        undefined,
        context(),
        (observation) => seenToolFail.push(observation)
      )
    ])
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'rejected'
    ])
    expect(seenPlainOk).toEqual([{ requested: 'priority', actual: 'default', observed: true }])
    expect(seenPlainBreak).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
    expect(seenToolOk).toEqual([{ requested: 'priority', actual: 'priority', observed: true }])
    expect(seenToolFail).toEqual([{ requested: 'priority', actual: 'default', observed: true }])
    for (const server of [plainOk, plainBreak, toolOk, toolFail]) {
      expect(server.requests).toHaveLength(1)
    }
  })
})
