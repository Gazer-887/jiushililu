import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent, type AgentRuntimeContext } from '@main/agent/runner'
import { runSubagents } from '@main/agent/scheduler'
import { createCheckpointStore } from '@main/store/checkpoints'
import type { AgentDefinition } from '@main/agent/loader'
import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage } from '@shared/agent'
import type {
  ProviderExecutionContext,
  RequestPolicySnapshot,
  ServiceTierObservation
} from '@shared/request-policy'

/**
 * S3-30T2：运行态上下文在主聊天 / 一次性 / 子代理三条真实装配边界上的承载。
 *
 * ⚠️ 断言对象是**真实 runner / scheduler 路径发出的序列化请求**（本地 127.0.0.1 HTTP 抓
 * headers/body/次数），provider 用已核收的双协议实现，不 mock 协议层。
 * 本文件不联网真实供应商，也不读任何真实配置。
 */

const VERSION = '0.13.110-t2'
const API_KEY = 'unit-test-key-not-a-secret'

const FAST_SUPPORTED: RequestPolicySnapshot = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: 'priority',
  tierSupport: 'supported'
}

function settings(baseURL: string, overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    providerType: 'anthropic',
    baseURL,
    model: 'parent-model',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 1024,
    timeoutMs: 60_000,
    stream: true,
    contextWindow: 100_000,
    reasoningEffort: 'default',
    maxToolRounds: 3,
    inputModalities: ['text'],
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
const tempDirs: string[] = []

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
  while (servers.length > 0) {
    const handle = servers.pop()
    if (handle) await handle.close()
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function jsonReply(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function bodyJson(captured: CapturedRequest): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>
}

/** 认证头计数：恰好一个才算合规（双发互斥头直接失败） */
function authHeaderCount(headers: Record<string, string | string[] | undefined>): number {
  return ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].filter((name) => name in headers).length
}

function handleOf(captured: CapturedRequest, name: string): string {
  const raw = captured.headers[name]
  return Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
}

/**
 * 这一轮是否已带工具结果。⚠️ 必须按**目标协议**判：Anthropic 的出站消息里没有
 * `role:'tool'`，工具结果被合并成 user 消息里的 `tool_result` 块。
 */
function hasToolResult(body: Record<string, unknown>): boolean {
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

// ── 运行夹具 ────────────────────────────────────────────────────────────

function makeRunCtx(): AgentRuntimeContext {
  const base = mkdtempSync(join(tmpdir(), 'jsl-s3-30t2-'))
  tempDirs.push(base)
  const ws = join(base, 'ws')
  mkdirSync(ws, { recursive: true })
  return {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
}

/** 写一个最小可加载的子 Agent 定义；model 故意与父模型不同。 */
function writeAgentDef(ctx: AgentRuntimeContext, name: string, model: string): void {
  mkdirSync(ctx.userAgentsDir, { recursive: true })
  writeFileSync(
    join(ctx.userAgentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} 的职责\nmodel: ${model}\n---\n只做 ${name} 的活。`,
    'utf8'
  )
}

/** Anthropic 整份响应（非流 / JSON 回退同一形状） */
function messageJson(
  options: {
    text?: string
    tier?: string
    stop?: string
    tool?: { id: string; name: string; input: Record<string, unknown> }
  } = {}
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  if (options.text) content.push({ type: 'text', text: options.text })
  if (options.tool) content.push({ type: 'tool_use', ...options.tool })
  const usage: Record<string, unknown> = { input_tokens: 5, output_tokens: 2 }
  if (options.tier) usage['service_tier'] = options.tier
  return {
    content: content.length > 0 ? content : [{ type: 'text', text: '好' }],
    stop_reason: options.stop ?? (options.tool ? 'tool_use' : 'end_turn'),
    usage
  }
}

interface Collector {
  main: ServiceTierObservation[]
  sub: ServiceTierObservation[]
  names: string[]
}

function collector(): {
  state: Collector
  onMain: (o: ServiceTierObservation) => void
  onSub: (o: ServiceTierObservation, name: string) => void
} {
  const state: Collector = { main: [], sub: [], names: [] }
  return {
    state,
    onMain: (observation) => state.main.push(observation),
    onSub: (observation, name) => {
      state.sub.push(observation)
      state.names.push(name)
    }
  }
}

// ── ① 主聊天 / 一次性：上下文只建一次并进入真实序列化 ──────────────────

describe('S3-30T2 ① 主运行上下文进入真实请求', () => {
  it('主聊天：身份头 + 服务档 auto 同时出现在真实序列化里，观察回调拿到真实容量', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson({ text: '好', tier: 'priority' })))
    const seen = collector()
    const result = await runAgent(makeRunCtx(), {
      settings: settings(server.baseURL, { requestIdentity: 'opencode-v1' }),
      apiKey: API_KEY,
      conversationId: 'conv-main',
      history: [{ role: 'user', content: '干活' }],
      clientVersion: VERSION,
      purpose: 'main-chat',
      requestPolicy: FAST_SUPPORTED,
      serviceTierReports: { onMain: seen.onMain, onSubagent: seen.onSub }
    })
    expect(result.output).toContain('好')
    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    expect(bodyJson(captured)['service_tier']).toBe('auto')
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(handleOf(captured, 'x-opencode-session').length).toBeGreaterThan(0)
    expect(seen.state.main).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(seen.state.names).toEqual([])
  })

  it('一次性任务与主聊天各建各的上下文：双会话键不同，且都带身份与服务档', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson({ tier: 'priority' })))
    const ctx = makeRunCtx()
    const run = (conversationId: string, purpose: 'main-chat' | 'one-shot'): Promise<unknown> =>
      runAgent(ctx, {
        settings: settings(server.baseURL, { requestIdentity: 'opencode-v1' }),
        apiKey: API_KEY,
        conversationId,
        history: [{ role: 'user', content: '干活' }],
        clientVersion: VERSION,
        purpose,
        requestPolicy: FAST_SUPPORTED
      })
    await run('conv-a', 'main-chat')
    await run('conv-b', 'one-shot')
    expect(server.requests).toHaveLength(2)
    const sessions = server.requests.map((captured) => handleOf(captured, 'x-opencode-session'))
    expect(sessions[0]).not.toBe(sessions[1])
    for (const captured of server.requests) {
      expect(bodyJson(captured)['service_tier']).toBe('auto')
      expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    }
  })

  it('同一 run 多轮：session 键与策略不随轮次漂移', async () => {
    const server = await startServer((req, res) => {
      const body = bodyJson(req)
      if (!hasToolResult(body)) {
        jsonReply(res, messageJson({ tool: { id: 't1', name: 'list_dir', input: { path: '.' } }, tier: 'priority' }))
        return
      }
      jsonReply(res, messageJson({ text: '完成', tier: 'priority' }))
    })
    const seen = collector()
    await runAgent(makeRunCtx(), {
      settings: settings(server.baseURL, { requestIdentity: 'opencode-v1' }),
      apiKey: API_KEY,
      conversationId: 'conv-rounds',
      history: [{ role: 'user', content: '看看目录' }],
      clientVersion: VERSION,
      requestPolicy: FAST_SUPPORTED,
      serviceTierReports: { onMain: seen.onMain }
    })
    expect(server.requests).toHaveLength(2)
    const sessions = server.requests.map((captured) => handleOf(captured, 'x-opencode-session'))
    expect(sessions[0]).toBe(sessions[1])
    for (const captured of server.requests) expect(bodyJson(captured)['service_tier']).toBe('auto')
    expect(seen.state.main).toHaveLength(2)
  })

  it('运行中改偏好不换上下文：冻结快照与 session 键都不受影响', async () => {
    const mutable: { -readonly [K in keyof RequestPolicySnapshot]: RequestPolicySnapshot[K] } = {
      ...FAST_SUPPORTED
    }
    const server = await startServer((req, res) => {
      const body = bodyJson(req)
      // 第一轮返回后把外部对象改掉：run 起点已复制冻结，本轮不得跟着变
      mutable.mode = 'normal'
      mutable.tierSupport = 'unsupported'
      mutable.requestedServiceTier = null
      if (!hasToolResult(body)) {
        jsonReply(res, messageJson({ tool: { id: 't1', name: 'list_dir', input: { path: '.' } }, tier: 'priority' }))
        return
      }
      jsonReply(res, messageJson({ text: '完成', tier: 'priority' }))
    })
    await runAgent(makeRunCtx(), {
      settings: settings(server.baseURL, { requestIdentity: 'opencode-v1' }),
      apiKey: API_KEY,
      conversationId: 'conv-freeze',
      history: [{ role: 'user', content: '看看目录' }],
      clientVersion: VERSION,
      requestPolicy: mutable,
    })
    expect(server.requests).toHaveLength(2)
    for (const captured of server.requests) expect(bodyJson(captured)['service_tier']).toBe('auto')
    const sessions = server.requests.map((captured) => handleOf(captured, 'x-opencode-session'))
    expect(sessions[0]).toBe(sessions[1])
  })

  it('缺 clientVersion：旧兼容路径（不发身份头、不发服务档），不伪造版本', async () => {
    const server = await startServer((_req, res) => jsonReply(res, messageJson({ tier: 'priority' })))
    await runAgent(makeRunCtx(), {
      settings: settings(server.baseURL),
      apiKey: API_KEY,
      conversationId: 'conv-legacy',
      history: [{ role: 'user', content: '干活' }],
      requestPolicy: FAST_SUPPORTED
    })
    const captured = server.requests[0]!
    expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
    expect(handleOf(captured, 'x-opencode-session')).toBe('')
    expect(handleOf(captured, 'user-agent')).not.toMatch(/^jiushililu\//)
  })
})

// ── ② 失败前已观察事实沿 runner 窄回调交出 ──────────────────────────────

describe('S3-30T2 ② 失败前已观测容量不丢', () => {
  it('流式先给容量与部分正文再断流：run 失败，观察回调仍拿到真实容量，请求数 1', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      res.write(
        `data: ${JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 5, output_tokens: 0, service_tier: 'priority' } }
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '部分' } })}\n\n`
      )
      res.socket?.end()
    })
    const seen = collector()
    let failed: unknown = null
    try {
      await runAgent(makeRunCtx(), {
        settings: settings(server.baseURL),
        apiKey: API_KEY,
        conversationId: 'conv-fail',
        history: [{ role: 'user', content: '干活' }],
        clientVersion: VERSION,
        requestPolicy: FAST_SUPPORTED,
        serviceTierReports: { onMain: seen.onMain }
      })
    } catch (err) {
      failed = err
    }
    expect(failed).not.toBeNull()
    expect(seen.state.main).toEqual([{ requested: 'auto', actual: 'priority', observed: true }])
    expect(server.requests).toHaveLength(1)
  })
})

// ── ③ 辅助摘要：固定普通 + 独立 operation 上下文 ────────────────────────

describe('S3-30T2 ③ runner 内部摘要请求', () => {
  it('摘要请求不带服务档，且与主请求使用不同 operation 键', async () => {
    const server = await startServer((req, res) => {
      const body = bodyJson(req)
      const tools = body['tools']
      if (tools === undefined || (Array.isArray(tools) && tools.length === 0)) {
        jsonReply(res, messageJson({ text: '摘要文本', tier: 'priority' }))
        return
      }
      jsonReply(res, messageJson({ text: '好', tier: 'priority' }))
    })
    const history: AgentMessage[] = []
    for (let i = 0; i < 12; i++) {
      history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条：${'长内容'.repeat(120)}` })
    }
    await runAgent(makeRunCtx(), {
      settings: settings(server.baseURL, { requestIdentity: 'opencode-v1', contextWindow: 1000 }),
      apiKey: API_KEY,
      conversationId: 'conv-summary',
      history,
      clientVersion: VERSION,
      requestPolicy: FAST_SUPPORTED,
      summaryCache: new Map<string, string>()
    })
    expect(server.requests.length).toBeGreaterThanOrEqual(2)
    const summary = server.requests.find((captured) => {
      const tools = bodyJson(captured)['tools']
      return tools === undefined || (Array.isArray(tools) && tools.length === 0)
    })
    const main = server.requests.find((captured) => {
      const tools = bodyJson(captured)['tools']
      return Array.isArray(tools) && tools.length > 0
    })
    expect(summary).toBeTruthy()
    expect(main).toBeTruthy()
    expect(Object.hasOwn(bodyJson(summary!), 'service_tier')).toBe(false)
    expect(bodyJson(main!)['service_tier']).toBe('auto')
    expect(handleOf(summary!, 'x-opencode-session')).not.toBe(handleOf(main!, 'x-opencode-session'))
  })
})

// ── ④ 父派两子：真实 runner + scheduler + 双协议函数 ────────────────────

describe('S3-30T2 ④ 子任务上下文与模型能力', () => {
  it('父子三键互异、子模型覆盖按实际模型解析、子观察不覆盖主请求展示值', async () => {
    const perModel = new Map<string, number>()
    const server = await startServer((req, res) => {
      const body = bodyJson(req)
      const model = String(body['model'])
      const round = (perModel.get(model) ?? 0) + 1
      perModel.set(model, round)
      const sawToolResult = hasToolResult(body)
      if (model === 'child-alpha') {
        if (!sawToolResult) {
          jsonReply(res, messageJson({ tool: { id: 'a1', name: 'list_dir', input: { path: '.' } }, tier: 'priority' }))
          return
        }
        jsonReply(res, messageJson({ text: 'alpha 完成', tier: 'priority' }))
        return
      }
      if (model === 'child-beta') {
        jsonReply(res, messageJson({ text: 'beta 完成', tier: 'standard' }))
        return
      }
      if (!sawToolResult) {
        jsonReply(
          res,
          messageJson({
            tier: 'priority',
            tool: {
              id: 'spawn-1',
              name: 'spawn_agents',
              input: {
                jobs: [
                  { agent: 'alpha', task: '做 alpha 的活' },
                  { agent: 'beta', task: '做 beta 的活' }
                ]
              }
            }
          })
        )
        return
      }
      jsonReply(res, messageJson({ text: '都完成了', tier: 'priority' }))
    })
    const ctx = makeRunCtx()
    writeAgentDef(ctx, 'alpha', 'child-alpha')
    writeAgentDef(ctx, 'beta', 'child-beta')
    const seen = collector()
    const result = await runAgent(ctx, {
      settings: settings(server.baseURL, { requestIdentity: 'opencode-v1', maxToolRounds: 4 }),
      apiKey: API_KEY,
      conversationId: 'conv-spawn',
      history: [{ role: 'user', content: '派两个活' }],
      clientVersion: VERSION,
      requestPolicy: FAST_SUPPORTED,
      tierSupportForModel: (model) => (model === 'child-alpha' ? 'supported' : undefined),
      serviceTierReports: { onMain: seen.onMain, onSubagent: seen.onSub }
    })
    expect(result.output).toBeTruthy()

    const pick = (model: string): CapturedRequest[] =>
      server.requests.filter((captured) => bodyJson(captured)['model'] === model)
    const parent = pick('parent-model')
    const alpha = pick('child-alpha')
    const beta = pick('child-beta')
    expect(parent).toHaveLength(2)
    expect(alpha).toHaveLength(2)
    expect(beta).toHaveLength(1)

    const sessionOf = (list: CapturedRequest[]): string[] => list.map((c) => handleOf(c, 'x-opencode-session'))
    const [parentKey] = sessionOf(parent)
    const [alphaKey] = sessionOf(alpha)
    const [betaKey] = sessionOf(beta)
    expect(new Set([parentKey, alphaKey, betaKey]).size).toBe(3)
    expect(new Set(sessionOf(parent)).size).toBe(1)
    expect(new Set(sessionOf(alpha)).size).toBe(1)

    // 父 FAST + 父模型 supported → 父发 auto
    for (const captured of parent) expect(bodyJson(captured)['service_tier']).toBe('auto')
    // 子 alpha 在快照里 supported → 继承 FAST 意图，仍发 auto
    for (const captured of alpha) expect(bodyJson(captured)['service_tier']).toBe('auto')
    // 子 beta 未声明 → 不把父模型的 supported 当作子模型证据，一律不发
    for (const captured of beta) expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)

    // 子请求的观察只进子域，绝不污染主请求展示值
    // beta 没请求容量档 → requested=null，但服务端真实回了 standard，照样如实观测
    expect(seen.state.sub).toContainEqual({ requested: null, actual: 'standard', observed: true })
    expect(seen.state.sub).toContainEqual({ requested: 'auto', actual: 'priority', observed: true })
    expect(seen.state.names).toContain('beta')
    expect(seen.state.names).toContain('alpha')
    // 主请求域只见父自己的真实值：子代理的 standard 绝不写进主展示通道
    expect(seen.state.main.length).toBeGreaterThan(0)
    for (const observation of seen.state.main) {
      expect(observation.actual).toBe('priority')
      expect(observation.requested).toBe('auto')
    }
    expect(seen.state.main).not.toContainEqual({ requested: null, actual: 'standard', observed: true })
  })
})

// ── ⑤ scheduler 作业边界：每个作业只建一次上下文 ───────────────────────

describe('S3-30T2 ⑤ scheduler 的作业上下文边界', () => {
  function def(name: string, model?: string): AgentDefinition {
    return {
      name,
      description: `${name} 的职责`,
      systemPrompt: `只做 ${name} 的活。`,
      source: 'user',
      ...(model ? { model } : {})
    } as AgentDefinition
  }

  function fakeContext(tag: string): ProviderExecutionContext {
    return Object.freeze({
      clientVersion: VERSION,
      purpose: 'subagent',
      operationId: `op-${tag}`,
      sessionId: `sess-${tag}`,
      policy: Object.freeze({ ...FAST_SUPPORTED })
    }) as unknown as ProviderExecutionContext
  }

  it('每个作业调用一次 contextFactory，并把同一份上下文交给该作业的模型通道', async () => {
    const made: string[] = []
    const received: Array<{ name: string; context: ProviderExecutionContext | undefined }> = []
    const results = await runSubagents({
      definitions: [def('alpha', 'child-alpha'), def('beta', 'child-beta')],
      task: '做活',
      toolsFor: () => [],
      contextFactory: (d) => {
        made.push(d.name)
        return fakeContext(d.name)
      },
      chatFactory: (d, _tools, context) => {
        received.push({ name: d.name, context })
        return async (): Promise<AgentChatResult> => ({
          text: `${d.name} 完成`,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: null, reasoningTokens: null },
          usageComplete: true
        })
      }
    })
    expect(made.sort()).toEqual(['alpha', 'beta'])
    expect(received).toHaveLength(2)
    for (const entry of received) {
      expect(entry.context?.sessionId).toBe(`sess-${entry.name}`)
    }
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('不给 contextFactory：chatFactory 收到 undefined（旧调用者兼容）', async () => {
    const received: Array<ProviderExecutionContext | undefined> = []
    await runSubagents({
      definitions: [def('solo')],
      task: '做活',
      toolsFor: () => [],
      chatFactory: (_d, _tools, context) => {
        received.push(context)
        return async (): Promise<AgentChatResult> => ({ text: '完成', toolCalls: [], usageComplete: false })
      }
    })
    expect(received).toEqual([undefined])
  })
})

// ── ⑥ 纯派生函数：能力位按实际模型解析 ──────────────────────────────────

describe('S3-30T2 ⑥ 模型能力派生', () => {
  it('未覆盖模型沿用父快照；覆盖后按快照解析，缺失一律 unknown', async () => {
    // 新出口用动态导入：实现前逐条落点，而不是整文件一个解析错误
    const { resolveModelTierSupport } = (await import('@main/agent/runner')) as unknown as {
      resolveModelTierSupport(input: {
        requestModel: string
        baseModel: string
        baseTierSupport: string
        tierSupportForModel?: (model: string) => string | undefined
      }): string
    }
    const lookup = (model: string): 'supported' | 'unsupported' | undefined =>
      model === 'child-supported' ? 'supported' : model === 'child-unsupported' ? 'unsupported' : undefined
    expect(
      resolveModelTierSupport({
        requestModel: 'parent-model',
        baseModel: 'parent-model',
        baseTierSupport: 'supported',
        tierSupportForModel: lookup
      })
    ).toBe('supported')
    expect(
      resolveModelTierSupport({
        requestModel: 'child-supported',
        baseModel: 'parent-model',
        baseTierSupport: 'supported',
        tierSupportForModel: lookup
      })
    ).toBe('supported')
    expect(
      resolveModelTierSupport({
        requestModel: 'child-unknown',
        baseModel: 'parent-model',
        baseTierSupport: 'supported',
        tierSupportForModel: lookup
      })
    ).toBe('unknown')
    expect(
      resolveModelTierSupport({
        requestModel: 'child-unsupported',
        baseModel: 'parent-model',
        baseTierSupport: 'supported',
        tierSupportForModel: lookup
      })
    ).toBe('unsupported')
    expect(
      resolveModelTierSupport({
        requestModel: 'child-unknown',
        baseModel: 'parent-model',
        baseTierSupport: 'supported'
      })
    ).toBe('unknown')
  })
})

// ── ⑦ S3-30F0 目录拉取的身份/认证入参桥 ────────────────────────────────

describe('S3-30F0 目录拉取桥：只接两项既有持久策略', () => {
  const base = {
    providerType: 'anthropic' as const,
    baseURL: 'https://api.anthropic.com',
    apiKey: 'unit-test-key-not-a-secret'
  }

  it('三种身份 × 三种认证逐一过 schema 并原值保留', async () => {
    const { modelFetchAvailableSchema } = await import('@main/schemas')
    const identities = ['default', 'self-ua', 'opencode-v1'] as const
    const auths = ['auto', 'bearer', 'x-api-key'] as const
    for (const requestIdentity of identities) {
      for (const authentication of auths) {
        const parsed = modelFetchAvailableSchema.safeParse({ ...base, requestIdentity, authentication })
        expect(parsed.success).toBe(true)
        if (parsed.success) {
          expect(parsed.data.requestIdentity).toBe(requestIdentity)
          expect(parsed.data.authentication).toBe(authentication)
        }
      }
    }
  })

  it('坏枚举被拒（不静默降级成旧行为）', async () => {
    const { modelFetchAvailableSchema } = await import('@main/schemas')
    expect(
      modelFetchAvailableSchema.safeParse({ ...base, requestIdentity: 'fake-ua' }).success
    ).toBe(false)
    expect(
      modelFetchAvailableSchema.safeParse({ ...base, authentication: 'basic' }).success
    ).toBe(false)
    expect(
      modelFetchAvailableSchema.safeParse({ ...base, authentication: 'Bearer' }).success
    ).toBe(false)
  })

  it('旧形状合法且不补任何新默认值', async () => {
    const { modelFetchAvailableSchema } = await import('@main/schemas')
    const parsed = modelFetchAvailableSchema.safeParse({ ...base })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(Object.hasOwn(parsed.data, 'requestIdentity')).toBe(false)
      expect(Object.hasOwn(parsed.data, 'authentication')).toBe(false)
    }
  })

  it('运行态键（sessionId / operationId / headers）不是本桥字段，未知键被剥掉', async () => {
    const { modelFetchAvailableSchema } = await import('@main/schemas')
    const parsed = modelFetchAvailableSchema.safeParse({
      ...base,
      sessionId: 'sess-leak',
      operationId: 'op-leak',
      headers: { 'X-Evil': 'CANARY' }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const data = parsed.data as Record<string, unknown>
      expect(Object.hasOwn(data, 'sessionId')).toBe(false)
      expect(Object.hasOwn(data, 'operationId')).toBe(false)
      expect(Object.hasOwn(data, 'headers')).toBe(false)
      expect(JSON.stringify(data)).not.toContain('CANARY')
      expect(JSON.stringify(data)).not.toContain('sess-leak')
    }
  })

  it('类型层同样不开放运行态键（FetchAvailableInput 源码守卫）', () => {
    const source = readFileSync('src/shared/models.ts', 'utf8')
    const at = source.indexOf('export interface FetchAvailableInput')
    expect(at).toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf('}', at) + 1)
    expect(body).toContain('requestIdentity?: RequestIdentityMode')
    expect(body).toContain('authentication?: AuthenticationChoice')
    for (const forbidden of ['sessionId', 'operationId', 'runId', 'headers']) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('模型目录按钮的调用点传当前草稿值，且全文件只有这一处拉取调用（无自动拉取）', () => {
    const source = readFileSync('src/renderer/src/views/SettingsView.tsx', 'utf8')
    // 只在用户点「获取可用模型」时调用：打开页面/切模板都不自动拉
    expect(source.match(/fetchAvailableModels\(/g)?.length ?? 0).toBe(1)
    const at = source.indexOf('onFetch={async () => {')
    expect(at).toBeGreaterThan(-1)
    const block = source.slice(at, at + 2200)
    expect(block).toContain('presetSelection.requestIdentity')
    expect(block).toContain('m.settings?.requestIdentity')
    expect(block).toContain('authTouched && draftAuth ? draftAuth : draftStoredAuth')
    expect(block).toContain('requestIdentity: identityForFetch')
    expect(block).toContain('authentication: authForFetch')
    // 渲染端不得把运行 context / 伪版本 / 任意头送进主进程（按**代码形状**判，不误伤注释里的说明词）
    for (const forbidden of ['sessionId:', 'operationId:', 'clientVersion:', 'headers:']) {
      expect(block).not.toContain(forbidden)
    }
    // 切模板的处理函数里不许顺手拉取
    const presetAt = source.indexOf('const handlePresetSelect')
    expect(presetAt).toBeGreaterThan(-1)
    expect(source.slice(presetAt, presetAt + 1200)).not.toContain('fetchAvailableModels')
  })
})

// ── ⑧ S3-30F 组合根版本、能力声明与八类消费者 ──────────────────────────

describe('S3-30F 服务档声明映射（user > official > catalog）', () => {
  interface MetadataModule {
    tierSupportFromServiceTiers(protocol: 'openai-compatible' | 'anthropic', metadata: unknown): string
  }
  const load = async (): Promise<MetadataModule> =>
    (await import('@shared/models')) as unknown as MetadataModule
  const NOW = 1_700_000_000_000
  const obs = (value: string[]): unknown => ({ value, observedAt: NOW })

  it('缺 metadata / 缺声明 / 空列表 → unknown', async () => {
    const { tierSupportFromServiceTiers } = await load()
    expect(tierSupportFromServiceTiers('openai-compatible', undefined)).toBe('unknown')
    expect(tierSupportFromServiceTiers('openai-compatible', {})).toBe('unknown')
    expect(tierSupportFromServiceTiers('openai-compatible', { serviceTiers: obs([]) })).toBe('unknown')
  })

  it('各协议只认自己的快速档值（不跨协议共用）', async () => {
    const { tierSupportFromServiceTiers } = await load()
    expect(
      tierSupportFromServiceTiers('openai-compatible', { serviceTiers: { official: obs(['priority']) } })
    ).toBe('supported')
    expect(
      tierSupportFromServiceTiers('openai-compatible', { serviceTiers: { official: obs(['fast']) } })
    ).toBe('supported')
    expect(tierSupportFromServiceTiers('anthropic', { serviceTiers: { official: obs(['auto']) } })).toBe(
      'supported'
    )
    expect(
      tierSupportFromServiceTiers('anthropic', { serviceTiers: { official: obs(['priority']) } })
    ).toBe('supported')
    expect(tierSupportFromServiceTiers('anthropic', { serviceTiers: { official: obs(['fast']) } })).toBe(
      'unknown'
    )
    expect(
      tierSupportFromServiceTiers('openai-compatible', { serviceTiers: { official: obs(['auto']) } })
    ).toBe('unknown')
  })

  it('标准档声明 → unsupported；混入读不懂的值 → unknown（不猜）', async () => {
    const { tierSupportFromServiceTiers } = await load()
    expect(
      tierSupportFromServiceTiers('openai-compatible', { serviceTiers: { official: obs(['standard']) } })
    ).toBe('unsupported')
    expect(
      tierSupportFromServiceTiers('anthropic', { serviceTiers: { official: obs(['standard_only']) } })
    ).toBe('unsupported')
    expect(
      tierSupportFromServiceTiers('openai-compatible', {
        serviceTiers: { official: obs(['standard', 'mystery-tier']) }
      })
    ).toBe('unknown')
  })

  it('user 覆盖优先于 official/catalog；清除 user 后回落到 official', async () => {
    const { tierSupportFromServiceTiers } = await load()
    const withUser = {
      serviceTiers: { user: obs(['standard']), official: obs(['priority']), catalog: obs(['priority']) }
    }
    expect(tierSupportFromServiceTiers('openai-compatible', withUser)).toBe('unsupported')
    const cleared = { serviceTiers: { official: obs(['priority']), catalog: obs(['priority']) } }
    expect(tierSupportFromServiceTiers('openai-compatible', cleared)).toBe('supported')
    const officialBeatsCatalog = {
      serviceTiers: { official: obs(['standard']), catalog: obs(['priority']) }
    }
    expect(tierSupportFromServiceTiers('openai-compatible', officialBeatsCatalog)).toBe('unsupported')
    const catalogOnly = { serviceTiers: { catalog: obs(['priority']) } }
    expect(tierSupportFromServiceTiers('openai-compatible', catalogOnly)).toBe('supported')
  })
})

describe('S3-30F 辅助请求固定普通 + 独立 operation 键（真实工厂）', () => {
  const FAST_POLICY = {
    mode: 'fast',
    maxLocalReadConcurrency: 2,
    requestedServiceTier: 'priority',
    tierSupport: 'supported'
  } as const

  it('五类辅助 purpose 一律被工厂压回 normal，即使伪造 fast 策略', async () => {
    const { createProviderExecutionContext } = await import('@shared/request-policy')
    for (const purpose of ['reflection', 'title', 'prompt-polish', 'connection-check', 'model-catalog'] as const) {
      const context = createProviderExecutionContext({
        clientVersion: '9.9.9',
        purpose,
        policy: { ...FAST_POLICY }
      })
      expect(context.policy.mode).toBe('normal')
      expect(context.policy.requestedServiceTier).toBeNull()
    }
  })

  it('同一逻辑 operation 内键稳定；不同 operation 互不相同', async () => {
    const { createProviderExecutionContext } = await import('@shared/request-policy')
    const policy = { ...FAST_POLICY }
    const first = createProviderExecutionContext({ clientVersion: '9.9.9', purpose: 'reflection', policy })
    const second = createProviderExecutionContext({ clientVersion: '9.9.9', purpose: 'reflection', policy })
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.operationId).not.toBe(second.operationId)
  })
})

describe('S3-30F 目录与连接检查的真实序列化（本地 HTTP）', () => {
  it('目录拉取：草稿身份/认证真实出站，固定普通档不带 service_tier', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'GET') {
        jsonReply(res, { data: [{ id: 'claude-x' }] })
        return
      }
      jsonReply(res, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    })
    const { createProviderExecutionContext, resolveRequestPolicy } = await import('@shared/request-policy')
    const { AnthropicProvider } = await import('@main/providers/anthropic')
    const context = createProviderExecutionContext({
      clientVersion: VERSION,
      purpose: 'model-catalog',
      policy: resolveRequestPolicy()
    })
    const catalogSettings: ModelSettings = {
      ...settings(server.baseURL),
      requestIdentity: 'opencode-v1',
      authentication: 'bearer'
    }
    const listed = await new AnthropicProvider().listModels({
      settings: catalogSettings,
      apiKey: API_KEY,
      messages: [],
      signal: new AbortController().signal,
      context
    })
    expect(listed.ok).toBe(true)
    const captured = server.requests[0]!
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe('/v1/models')
    expect(handleOf(captured, 'authorization')).toBe(`Bearer ${API_KEY}`)
    expect(captured.headers['x-api-key']).toBeUndefined()
    expect(handleOf(captured, 'x-opencode-session')).toBe(context.sessionId)
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(captured.body).toBe('')
  })

  it('连接检查：草稿与已存档案两条路都用实际身份/认证，不带 service_tier', async () => {
    const server = await startServer((_req, res) => jsonReply(res, {}))
    const { createProviderExecutionContext, resolveRequestPolicy } = await import('@shared/request-policy')
    const { AnthropicProvider } = await import('@main/providers/anthropic')
    const makeContext = (): ProviderExecutionContext =>
      createProviderExecutionContext({
        clientVersion: VERSION,
        purpose: 'connection-check',
        policy: resolveRequestPolicy()
      })
    const draft: ModelSettings = {
      ...settings(server.baseURL),
      requestIdentity: 'self-ua',
      authentication: 'x-api-key'
    }
    const provider = new AnthropicProvider()
    const first = await provider.testConnection({
      settings: draft,
      apiKey: API_KEY,
      messages: [],
      signal: new AbortController().signal,
      context: makeContext()
    })
    const second = await provider.testConnection({
      settings: { ...draft, requestIdentity: 'default' },
      apiKey: API_KEY,
      messages: [],
      signal: new AbortController().signal,
      context: makeContext()
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(server.requests).toHaveLength(2)
    for (const captured of server.requests) {
      expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
      expect(captured.headers['x-opencode-session']).toBeUndefined()
    }
    expect(handleOf(server.requests[0]!, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(handleOf(server.requests[0]!, 'x-api-key')).toBe(API_KEY)
    expect(handleOf(server.requests[1]!, 'user-agent')).not.toMatch(/^jiushililu\//)
  })
})

describe('S3-30F 八类消费者接线矩阵（真实调用点 + 源码守卫）', () => {
  const ipcSource = readFileSync('src/main/ipc.ts', 'utf8')
  const indexSource = readFileSync('src/main/index.ts', 'utf8')
  const storeSource = readFileSync('src/main/store/models.ts', 'utf8')
  const runnerSource = readFileSync('src/main/agent/runner.ts', 'utf8')

  it('主聊天 / 一次性 / 子代理：run 冻结策略且 purpose 正确', () => {
    expect(ipcSource).toContain("purpose: 'main-chat'")
    expect(ipcSource).toContain("purpose: 'one-shot'")
    expect(runnerSource).toContain("purpose: 'subagent'")
    expect(ipcSource.match(/runStartSnapshot\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(ipcSource).toContain('getActiveRunBinding()')
  })

  it('五类辅助用途各自出现在真实调用点', () => {
    expect(indexSource).toContain("purpose: 'reflection'")
    expect(indexSource).toContain("purpose: 'title'")
    expect(ipcSource).toContain("'prompt-polish'")
    expect(ipcSource.match(/'connection-check'/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(ipcSource).toContain("'model-catalog'")
  })

  it('真实版本只从组合根 app.getVersion() 注入，providers/store 不读 package', () => {
    expect(indexSource).toContain('clientVersion: app.getVersion()')
    expect(ipcSource).toContain('deps.clientVersion')
    expect(storeSource).not.toContain('getVersion')
    expect(storeSource).not.toContain('package.json')
  })

  it('目录拉取消费 F0 桥的两项策略，并保留原 Key 回退链', () => {
    expect(storeSource).toContain('input.requestIdentity')
    expect(storeSource).toContain('input.authentication')
    expect(storeSource).toContain('resolveFetchApiKey(input, savedKey)')
    expect(storeSource).toContain('getProfileKey(input.id)')
    // 目录拉取**函数体内**不得改读"当前激活端点的 Key"（那会回退到别的端点）
    const catalogAt = storeSource.indexOf('export async function fetchAvailableModels')
    expect(catalogAt).toBeGreaterThan(-1)
    const catalogBody = storeSource.slice(catalogAt, catalogAt + 3000)
    expect(catalogBody).not.toContain('getDecryptedApiKey')
  })

  it('能力位来自 metadata 单真源，不再固定 unknown', () => {
    expect(ipcSource).not.toContain("tierSupport: 'unknown'")
    expect(ipcSource).toContain('getActiveRunBinding()')
    expect(ipcSource).toContain('tierSupportForModel')
    expect(storeSource).toContain('tierSupportFromServiceTiers(')
  })
})

// ── ⑨ S3-30F-R1 真实 IPC 运行证明（只 mock 平台边界）────────────────────

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
      getVersion: () => '0.13.110-ipc-mock',
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
        throw new Error('net.fetch 不在本测试范围（provider 走真实 Node fetch）')
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
    readonly path = '/tmp/jsl-ipc-mock-store.json'
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

interface IpcEvent {
  channel: string
  payload: unknown
}

interface IpcHarness {
  call(channel: string, raw?: unknown): Promise<unknown>
  events: IpcEvent[]
}

/** 装配真实 ipc 层：只替换平台边界与会话/记忆等外部服务，provider/HTTP/settings/store 全是真的。 */
async function bootIpc(clientVersion: string | undefined = VERSION): Promise<IpcHarness> {
  const { registerIpcHandlers } = await import('@main/ipc')
  const ctx = makeRunCtx()
  const userDataDir = mkdtempSync(join(tmpdir(), 'jsl-ipc-ud-'))
  tempDirs.push(userDataDir)
  const events: IpcEvent[] = []
  const stubs = {
    agent: ctx,
    userDataDir,
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
    ...(clientVersion === undefined ? {} : { clientVersion })
  }
  registerIpcHandlers(stubs as unknown as Parameters<typeof registerIpcHandlers>[0])
  return {
    events,
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

function fullSettings(baseURL: string, overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    providerType: 'anthropic',
    baseURL,
    model: 'parent-model',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 1024,
    timeoutMs: 60_000,
    stream: true,
    contextWindow: 100_000,
    reasoningEffort: 'default',
    maxToolRounds: 3,
    inputModalities: ['text'],
    ...overrides
  }
}

describe('S3-30F-R1 真实 IPC → 本地 HTTP（目录拉取）', () => {
  it('modelsFetchAvailable 真实执行：GET /v1/models、恰一个认证头、身份、无 service_tier', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'GET') {
        jsonReply(res, { data: [{ id: 'claude-x' }] })
        return
      }
      jsonReply(res, {})
    })
    const harness = await bootIpc()
    const { IPC } = await import('@shared/ipc')
    const result = (await harness.call(IPC.modelsFetchAvailable, {
      providerType: 'anthropic',
      baseURL: server.baseURL,
      apiKey: API_KEY,
      requestIdentity: 'opencode-v1',
      authentication: 'bearer'
    })) as { ok: boolean; models: string[] }
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['claude-x'])
    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe('/v1/models')
    expect(authHeaderCount(captured.headers)).toBe(1)
    expect(handleOf(captured, 'authorization')).toBe(`Bearer ${API_KEY}`)
    expect(captured.headers['x-api-key']).toBeUndefined()
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(handleOf(captured, 'x-opencode-session').length).toBeGreaterThan(0)
    expect(captured.body).toBe('')
  })

  it('真实 Key 回退：草稿不带 Key、带已存端点 id → 用该端点密文（不越端点）', async () => {
    const server = await startServer((_req, res) => jsonReply(res, { data: [{ id: 'm-x' }] }))
    const harness = await bootIpc()
    const { IPC } = await import('@shared/ipc')
    const store = await import('@main/store/models')
    const saved = store.saveEndpoint({
      name: 'ipc-seed',
      providerType: 'anthropic',
      baseURL: server.baseURL,
      timeoutMs: 60_000,
      stream: true,
      apiKey: 'sk-saved-ipc',
      models: [{ id: 'm-x', model: 'parent-model' }]
    })
    const result = (await harness.call(IPC.modelsFetchAvailable, {
      id: saved.id,
      providerType: 'anthropic',
      baseURL: server.baseURL
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(server.requests).toHaveLength(1)
    expect(handleOf(server.requests[0]!, 'x-api-key')).toBe('sk-saved-ipc')
  })

  it('未知 auto：0 请求且明确失败；显式认证 401：恰好 1 请求、不换头', async () => {
    const server = await startServer((_req, res) => jsonReply(res, { error: { message: 'nope' } }, 401))
    const harness = await bootIpc()
    const { IPC } = await import('@shared/ipc')
    const auto = (await harness.call(IPC.modelsFetchAvailable, {
      providerType: 'anthropic',
      baseURL: server.baseURL,
      apiKey: API_KEY,
      authentication: 'auto'
    })) as { ok: boolean; message: string }
    expect(auto.ok).toBe(false)
    expect(auto.message).toMatch(/auto|认证/)
    expect(server.requests).toHaveLength(0)

    const explicit = (await harness.call(IPC.modelsFetchAvailable, {
      providerType: 'anthropic',
      baseURL: server.baseURL,
      apiKey: API_KEY,
      authentication: 'bearer'
    })) as { ok: boolean }
    expect(explicit.ok).toBe(false)
    expect(server.requests).toHaveLength(1)
    expect(authHeaderCount(server.requests[0]!.headers)).toBe(1)
    expect(server.requests[0]!.headers['x-api-key']).toBeUndefined()
  })
})

describe('S3-30F-R1 真实 IPC → 本地 HTTP（连接检查）', () => {
  it('settingsTest 真实执行：POST /v1/messages、草稿身份/认证、无 service_tier', async () => {
    const server = await startServer((_req, res) => jsonReply(res, {}))
    const harness = await bootIpc()
    const { IPC } = await import('@shared/ipc')
    const result = (await harness.call(IPC.settingsTest, {
      ...fullSettings(server.baseURL),
      apiKey: API_KEY,
      requestIdentity: 'opencode-v1',
      authentication: 'x-api-key'
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe('/v1/messages')
    expect(authHeaderCount(captured.headers)).toBe(1)
    expect(handleOf(captured, 'x-api-key')).toBe(API_KEY)
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(handleOf(captured, 'x-opencode-session').length).toBeGreaterThan(0)
    expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
    expect(bodyJson(captured)['stream']).toBe(false)
    expect(bodyJson(captured)['max_tokens']).toBe(1)
  })

  it('modelsTest 真实执行：已存档案的实际身份/认证进真实请求', async () => {
    const server = await startServer((_req, res) => jsonReply(res, {}))
    const harness = await bootIpc()
    const { IPC } = await import('@shared/ipc')
    const store = await import('@main/store/models')
    const saved = store.saveEndpoint({
      name: 'ipc-check',
      providerType: 'anthropic',
      baseURL: server.baseURL,
      timeoutMs: 60_000,
      stream: true,
      apiKey: 'sk-check-ipc',
      models: [
        {
          id: 'm-check',
          model: 'parent-model',
          settings: { requestIdentity: 'self-ua', authentication: 'bearer' }
        }
      ]
    })
    const result = (await harness.call(IPC.modelsTest, saved.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    expect(captured.url).toBe('/v1/messages')
    expect(authHeaderCount(captured.headers)).toBe(1)
    expect(handleOf(captured, 'authorization')).toBe('Bearer sk-check-ipc')
    expect(handleOf(captured, 'user-agent')).toBe(`jiushililu/${VERSION}`)
    expect(Object.hasOwn(bodyJson(captured), 'service_tier')).toBe(false)
  })
})

describe('S3-30F-R1 run 起点 Key 绑定（结构顺序守卫）', () => {
  const ipcSource = readFileSync('src/main/ipc.ts', 'utf8')

  function blockAfter(marker: string, length: number): string {
    const at = ipcSource.indexOf(marker)
    expect(at, `找不到调用点：${marker}`).toBeGreaterThan(-1)
    return ipcSource.slice(at, at + length)
  }

  it('chatSend / agentRun 的 Key 只从 run 快照的 profileId 解出，不再重读当前 active profile', () => {
    for (const marker of ['ipcMain.handle(IPC.chatSend', 'ipcMain.handle(IPC.agentRun']) {
      const block = blockAfter(marker, 9000)
      // 主路径必须从快照的 profileId 解 Key（缺快照才回落旧路径）
      expect(block).toContain('runSnapshot ? getProfileKey(runSnapshot.profileId) : getDecryptedApiKey()')
      // 旧的"直接按当前 active 取 Key"形状不许回来
      expect(block).not.toContain('const apiKey = getDecryptedApiKey()')
      expect(block).not.toContain('hasApiKey()')
    }
    // 快照本身必须携带 Key 引用
    const snapshot = blockAfter('interface RunStartSnapshot', 700)
    expect(snapshot).toContain('profileId: string')
    expect(ipcSource).toContain('profileId: profile.id')
  })
})

describe('S3-30F-R1 run 起点 Key 引用同源（A→B 切换反例）', () => {
  it('A 发起的 run 跨轮不被 B 串 Key；下一 run 才使用 B', async () => {
    // 第一轮的响应先压住：保证"A→B 切换"确实发生在两轮之间（不靠时序巧合）
    let releaseFirstRound: (() => void) | null = null
    const firstRoundGate = new Promise<void>((resolve) => {
      releaseFirstRound = resolve
    })
    const serverA = await startServer((req, res) => {
      const body = bodyJson(req)
      if (!hasToolResult(body)) {
        void firstRoundGate.then(() =>
          jsonReply(res, messageJson({ tool: { id: 't1', name: 'list_dir', input: { path: '.' } } }))
        )
        return
      }
      jsonReply(res, messageJson({ text: 'A 完成' }))
    })
    const serverB = await startServer((_req, res) => {
      jsonReply(res, messageJson({ text: 'B 完成' }))
    })
    const harness = await bootIpc()
    const { IPC } = await import('@shared/ipc')
    const store = await import('@main/store/models')
    const profileA = store.saveEndpoint({
      name: 'ipc-A',
      providerType: 'anthropic',
      baseURL: serverA.baseURL,
      timeoutMs: 60_000,
      stream: true,
      apiKey: 'sk-A',
      models: [
        { id: 'm-a', model: 'model-A', settings: { authentication: 'bearer', requestIdentity: 'self-ua' } }
      ]
    })
    const profileB = store.saveEndpoint({
      name: 'ipc-B',
      providerType: 'anthropic',
      baseURL: serverB.baseURL,
      timeoutMs: 60_000,
      stream: true,
      apiKey: 'sk-B',
      models: [
        { id: 'm-b', model: 'model-B', settings: { authentication: 'bearer', requestIdentity: 'self-ua' } }
      ]
    })
    store.setActiveProfile(profileA.id)
    // 第一轮请求一落地就切换当前端点：本 run 后续轮次仍必须用 A 的 Key/模型
    const originalA = serverA.requests
    const chatPayload = {
      conversationId: 'conv-ipc-ab',
      messages: [{ role: 'user', content: '看看目录' }]
    }
    const pending = harness.call(IPC.chatSend, chatPayload)
    // 等第一轮请求到达（响应仍被压住）→ 切 A→B → 放行第一轮
    for (let i = 0; i < 400 && originalA.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(originalA.length).toBe(1)
    store.setActiveProfile(profileB.id)
    releaseFirstRound?.()
    await pending
    expect(originalA.length).toBe(2)
    for (const captured of originalA) {
      expect(handleOf(captured, 'authorization')).toBe('Bearer sk-A')
      expect(bodyJson(captured)['model']).toBe('model-A')
    }
    expect(serverB.requests).toHaveLength(0)

    // 下一 run 才使用 B
    await harness.call(IPC.chatSend, { ...chatPayload, conversationId: 'conv-ipc-b' })
    expect(serverB.requests).toHaveLength(1)
    expect(handleOf(serverB.requests[0]!, 'authorization')).toBe('Bearer sk-B')
    expect(bodyJson(serverB.requests[0]!)['model']).toBe('model-B')
  })
})
