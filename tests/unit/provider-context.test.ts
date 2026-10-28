import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { observeServiceTier } from '@shared/request-policy'
import type { AgentChatResult, AgentLoopResult } from '@shared/agent'
import type { ProviderRequest, StreamCallbacks } from '@main/providers/types'
import type { ModelSettings } from '@shared/ipc'

/**
 * S3-30T1 运行态请求上下文与服务档结果合同。
 *
 * 本文件只证明**载体与工厂**的行为：不装配真实 run、不联网、不读真实配置。
 * 新增符号用动态导入，红态才能逐条落点（而不是整文件一个解析错误）。
 */

const PURPOSES = [
  'main-chat',
  'one-shot',
  'subagent',
  'reflection',
  'title',
  'prompt-polish',
  'connection-check',
  'model-catalog'
] as const

const AUXILIARY = ['reflection', 'title', 'prompt-polish', 'connection-check', 'model-catalog'] as const

interface ContextShape {
  clientVersion: string
  purpose: string
  operationId: string
  sessionId: string
  policy: Record<string, unknown>
}

interface ContextFactoryExports {
  createProviderExecutionContext(input: Record<string, unknown>): ContextShape
  isProviderCallPurpose(value: unknown): boolean
  PROVIDER_CALL_PURPOSES: readonly string[]
  AUXILIARY_PROVIDER_CALL_PURPOSES: readonly string[]
}

async function factory(): Promise<ContextFactoryExports> {
  return (await import('@shared/request-policy')) as unknown as ContextFactoryExports
}

const FAST_POLICY = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: 'priority',
  tierSupport: 'supported'
}

const NORMAL_POLICY = {
  mode: 'normal',
  maxLocalReadConcurrency: 1,
  requestedServiceTier: null,
  tierSupport: 'unknown'
}

const VERSION = '0.13.110'

function make(overrides: Record<string, unknown> = {}): Promise<ContextShape> {
  return factory().then((p) =>
    p.createProviderExecutionContext({
      clientVersion: VERSION,
      purpose: 'main-chat',
      policy: { ...FAST_POLICY },
      ...overrides
    })
  )
}

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

/** 提取模块引用（静态 / 裸 / 动态 / require），用于结构守卫与阳性对照。 */
function specifiers(source: string): string[] {
  const patterns = [
    // 与 architecture.test.ts 同口径：import/export 必须位于行首，避免把注释里的示例当成真引用。
    /(?:^|\n)\s*(?:import|export)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g
  ]
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!))
}

/** 截取 interface 花括号正文：用于断言持久类型没有被塞进运行态字段。 */
function interfaceBody(source: string, marker: string): string {
  const start = source.indexOf(marker)
  expect(start, `${marker} 必须存在`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`${marker} 花括号不配平，守卫无法取样`)
}

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com/v1',
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
  inputModalities: ['text']
}

// ── ① 旧调用者兼容：新字段全部可选 ─────────────────────────────────────────

describe('S3-30T1 ① 缺 context / 回调 / 结果字段的旧调用仍兼容', () => {
  it('旧 ProviderRequest 不带 context 仍是合法请求对象', () => {
    const legacy: ProviderRequest = {
      settings,
      apiKey: 'test-key',
      messages: [{ role: 'user', content: '你好' }],
      signal: new AbortController().signal
    }
    expect('context' in legacy).toBe(false)
    expect(legacy.context).toBeUndefined()
    expect(legacy.messages).toHaveLength(1)
  })

  it('旧 StreamCallbacks 只实现 onChunk 仍能工作，onServiceTier 缺省不参与', () => {
    const chunks: string[] = []
    const legacy: StreamCallbacks = { onChunk: (text) => chunks.push(text) }
    legacy.onChunk('增')
    legacy.onChunk('量')
    expect(chunks.join('')).toBe('增量')
    expect(legacy.onServiceTier).toBeUndefined()
  })

  it('旧 AgentChatResult / AgentLoopResult 不填 serviceTier 时字段保持缺失', () => {
    const chat: AgentChatResult = { text: '回答', toolCalls: [], usage: null, usageComplete: true }
    const loop: AgentLoopResult = {
      output: '回答',
      rounds: 1,
      stopReason: 'completed',
      terminal: { state: 'completed' },
      usageComplete: true
    }
    expect('serviceTier' in chat).toBe(false)
    expect('serviceTier' in loop).toBe(false)
    expect(chat.text).toBe('回答')
    expect(loop.stopReason).toBe('completed')
  })
})

// ── ② 八类 purpose 与输入边界 ─────────────────────────────────────────────

describe('S3-30T1 ② 八类 purpose 冻结，非法目的与坏版本明确拒绝', () => {
  it('八类目的常量与冻结清单逐字一致', async () => {
    const p = await factory()
    expect([...p.PROVIDER_CALL_PURPOSES]).toEqual([...PURPOSES])
    expect([...p.AUXILIARY_PROVIDER_CALL_PURPOSES]).toEqual([...AUXILIARY])
    for (const purpose of PURPOSES) expect(p.isProviderCallPurpose(purpose)).toBe(true)
  })

  it('八种目的都能创建上下文，且 purpose 原样保留', async () => {
    for (const purpose of PURPOSES) {
      const ctx = await make({ purpose })
      expect(ctx.purpose).toBe(purpose)
      expect(Object.isFrozen(ctx)).toBe(true)
    }
  })

  it('非法目的一律拒绝（不做 trim、不做大小写归一）', async () => {
    const bad = [
      undefined,
      null,
      '',
      'main',
      'MAIN-CHAT',
      'main chat',
      'reflection ',
      ' model-catalog',
      1,
      true,
      {},
      []
    ]
    for (const purpose of bad) {
      await expect(make({ purpose })).rejects.toThrow(TypeError)
    }
  })

  it('版本缺失、非字符串、空白、换行与控制字符一律拒绝', async () => {
    const bad = [undefined, null, '', '   ', '\t', 1, true, {}, '1.0\n2.0', '1.0\r', '\n', '1.0\u0000']
    for (const clientVersion of bad) {
      await expect(make({ clientVersion })).rejects.toThrow(TypeError)
    }
  })

  it('版本两端空白被裁剪，内部空格保留（真实版本值不被改写）', async () => {
    expect((await make({ clientVersion: ' 1.2.3 ' })).clientVersion).toBe('1.2.3')
    expect((await make({ clientVersion: '1.2.3 beta' })).clientVersion).toBe('1.2.3 beta')
  })

  it('policy 结构损坏时拒绝，不把脏值带进运行态', async () => {
    for (const policy of [undefined, null, {}, { ...FAST_POLICY, mode: 'turbo' }, { ...FAST_POLICY, tierSupport: 'yes' }, { ...FAST_POLICY, maxLocalReadConcurrency: 3 }]) {
      await expect(make({ policy })).rejects.toThrow(TypeError)
    }
  })
})

// ── ③ 随机运行键 ─────────────────────────────────────────────────────────

describe('S3-30T1 ③ 运行键随机、对象内稳定、跨上下文隔离', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  it('同一上下文连续读取键不变，operation 与 session 是两个不同的值', async () => {
    const ctx = await make()
    expect(ctx.operationId).toBe(ctx.operationId)
    expect(ctx.sessionId).toBe(ctx.sessionId)
    expect(ctx.operationId).not.toBe(ctx.sessionId)
  })

  it('默认随机源产出 UUID v4，且不含传入版本或合成 Canary', async () => {
    const canary = 'CANARY-E30T1-7f4c1d9a'
    const ctx = await make({ clientVersion: canary })
    expect(ctx.clientVersion).toBe(canary)
    expect(ctx.operationId).toMatch(UUID_V4)
    expect(ctx.sessionId).toMatch(UUID_V4)
    for (const key of [ctx.operationId, ctx.sessionId]) {
      expect(key).not.toContain(canary)
      expect(key.toLowerCase()).not.toContain('canary')
    }
  })

  it('两次创建、父与子、兄弟上下文之间的键全部互不相同', async () => {
    const parent = await make({ purpose: 'main-chat' })
    const childA = await make({ purpose: 'subagent', policy: { ...parent.policy } })
    const childB = await make({ purpose: 'subagent', policy: { ...parent.policy } })
    const other = await make({ purpose: 'one-shot' })
    const keys = [parent, childA, childB, other].flatMap((ctx) => [ctx.operationId, ctx.sessionId])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('上下文只含合同五字段，不夹带会话 ID、路径、用户或任意请求头入口', async () => {
    const ctx = await make()
    expect(Object.keys(ctx).sort()).toEqual(['clientVersion', 'operationId', 'policy', 'purpose', 'sessionId'])
    for (const forbidden of ['conversationId', 'path', 'user', 'headers', 'runId', 'model', 'apiKey']) {
      expect(forbidden in ctx).toBe(false)
    }
  })

  it('注入随机源只用于测试：两次取值都被使用，且值原样落位', async () => {
    const values = ['op-test-1', 'session-test-1']
    let calls = 0
    const ctx = await make({
      randomUUID: () => {
        const value = values[calls]
        calls += 1
        if (value === undefined) throw new Error('随机源调用次数超出预期')
        return value
      }
    })
    expect(calls).toBe(2)
    expect(ctx.operationId).toBe('op-test-1')
    expect(ctx.sessionId).toBe('session-test-1')
  })

  it('注入源返回空值、换行控制字符或两次相同值时必须拒绝', async () => {
    await expect(make({ randomUUID: () => '' })).rejects.toThrow(TypeError)
    await expect(make({ randomUUID: () => 'a\r\nb' })).rejects.toThrow(TypeError)
    await expect(make({ randomUUID: () => 'same' })).rejects.toThrow(TypeError)
  })
})

// ── ④ 冻结、复制与五类辅助固定 normal ─────────────────────────────────────

describe('S3-30T1 ④ 顶层与 policy 冻结，辅助目的固定 normal', () => {
  it('顶层与 policy 均冻结，严格模式写入抛 TypeError 且值不变', async () => {
    const ctx = await make()
    const mutableCtx = ctx as unknown as { clientVersion: string }
    const mutablePolicy = ctx.policy as unknown as { mode: string }
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.policy)).toBe(true)
    expect(() => {
      mutableCtx.clientVersion = '9.9.9'
    }).toThrow(TypeError)
    expect(() => {
      mutablePolicy.mode = 'normal'
    }).toThrow(TypeError)
    expect(ctx.clientVersion).toBe(VERSION)
    expect(ctx.policy.mode).toBe('fast')
  })

  it('创建后修改输入 policy，不影响已创建上下文', async () => {
    const input: Record<string, unknown> = { ...FAST_POLICY }
    const ctx = await make({ policy: input })
    input.mode = 'normal'
    input.requestedServiceTier = null
    input.maxLocalReadConcurrency = 1
    expect(ctx.policy).toEqual(FAST_POLICY)
  })

  it('五类辅助目的即使传 FAST 也固定 normal，且不请求非默认服务档', async () => {
    for (const purpose of AUXILIARY) {
      const ctx = await make({ purpose, policy: { ...FAST_POLICY } })
      expect(ctx.policy).toEqual({
        mode: 'normal',
        maxLocalReadConcurrency: 1,
        requestedServiceTier: null,
        tierSupport: 'supported'
      })
    }
  })

  it('主聊与一次性任务保留显式快照（fast + supported 仍为 priority）', async () => {
    for (const purpose of ['main-chat', 'one-shot']) {
      const ctx = await make({ purpose, policy: { ...FAST_POLICY } })
      expect(ctx.policy).toEqual(FAST_POLICY)
      expect(ctx.policy.requestedServiceTier).toBe('priority')
    }
  })

  it('子代理传入父 policy 内容不变，得到独立冻结副本', async () => {
    const parent = await make({ purpose: 'main-chat', policy: { ...FAST_POLICY } })
    const child = await make({ purpose: 'subagent', policy: { ...parent.policy } })
    expect(child.policy).toEqual(parent.policy)
    expect(child.policy).not.toBe(parent.policy)
    expect(Object.isFrozen(child.policy)).toBe(true)
  })

  it('策略只含合同四字段，不夹带省 token 档位或持久模型设置', async () => {
    const ctx = await make()
    expect(Object.keys(ctx.policy).sort()).toEqual([
      'maxLocalReadConcurrency',
      'mode',
      'requestedServiceTier',
      'tierSupport'
    ])
    for (const key of ['readLines', 'outputDiscipline', 'reasoningEffortOverride', 'settings', 'model']) {
      expect(key in ctx.policy).toBe(false)
    }
  })
})

// ── ⑤ 服务档结果兄弟字段：观测与用量/终态相互独立 ────────────────────────

describe('S3-30T1 ⑤ serviceTier 观测独立于用量、终态与正文', () => {
  it('requested=priority 但 actual 缺失时保持 null / observed=false，不回填', () => {
    const missing = observeServiceTier('priority', undefined)
    expect(missing).toEqual({ requested: 'priority', actual: null, observed: false })
    const chat: AgentChatResult = { text: '正文', toolCalls: [], serviceTier: missing, usageComplete: true }
    expect(chat.serviceTier).toEqual({ requested: 'priority', actual: null, observed: false })
    expect(chat.usageComplete).toBe(true)
    expect(chat.text).toBe('正文')
  })

  it('actual=priority / default 都是真实观测，服务端降级不被丢弃', () => {
    const priority = observeServiceTier('priority', 'priority')
    const downgraded = observeServiceTier('priority', 'default')
    expect(priority).toEqual({ requested: 'priority', actual: 'priority', observed: true })
    expect(downgraded).toEqual({ requested: 'priority', actual: 'default', observed: true })
    expect(downgraded.actual).not.toBe(downgraded.requested)
  })

  it('usageComplete 的 true / false / 缺失与档位观测互不影响', () => {
    const observed = observeServiceTier('priority', 'priority')
    const chatTrue: AgentChatResult = { text: null, toolCalls: [], serviceTier: observed, usageComplete: true }
    const chatFalse: AgentChatResult = { text: null, toolCalls: [], serviceTier: observed, usageComplete: false }
    const chatMissing: AgentChatResult = { text: null, toolCalls: [], serviceTier: observed }
    expect(chatTrue.serviceTier?.observed).toBe(true)
    expect(chatFalse.serviceTier?.observed).toBe(true)
    expect(chatMissing.serviceTier?.observed).toBe(true)
    expect(chatTrue.usageComplete).toBe(true)
    expect(chatFalse.usageComplete).toBe(false)
    expect('usageComplete' in chatMissing).toBe(false)
  })

  it('终态完成与用量齐全都不推断服务档：缺字段仍保持缺失', () => {
    const loop: AgentLoopResult = {
      output: '完成',
      rounds: 2,
      stopReason: 'completed',
      terminal: { state: 'completed' },
      // T1-N2 补正：AgentLoopResult 没有 `usage` 字段（用量载体是 AgentRunResult），
      // 旧夹具多挂一个未声明属性只是被 Vitest 转译放过，不能当作类型证明。
      usageComplete: true
    }
    expect('serviceTier' in loop).toBe(false)
    expect(loop.serviceTier).toBeUndefined()
  })

  it('AgentLoopResult 同样承载观测；失败终态也不改变 actual=null / observed=false', () => {
    const missing = observeServiceTier('priority', null)
    const loop: AgentLoopResult = {
      output: '',
      rounds: 1,
      stopReason: 'max-rounds',
      terminal: { state: 'failed', code: 'upstream-error' },
      usageComplete: false,
      serviceTier: missing
    }
    expect(loop.serviceTier).toEqual({ requested: 'priority', actual: null, observed: false })
    expect(loop.terminal?.state).toBe('failed')
    expect(loop.usageComplete).toBe(false)
  })

  it('结果类型声明处真的把 serviceTier 作为可选兄弟字段（两处）', () => {
    const source = readSource('src/shared/agent.ts')
    expect(source.match(/serviceTier\?: ServiceTierObservation/g) ?? []).toHaveLength(2)
  })
})

// ── ⑥ 结构守卫：无 electron / 无 Node 导入 / 不落持久层 / 无 headers 入口 ──

describe('S3-30T1 ⑥ 结构守卫', () => {
  const NODE_BUILTINS = new Set([
    'fs',
    'path',
    'crypto',
    'os',
    'child_process',
    'http',
    'https',
    'net',
    'tls',
    'url',
    'util',
    'events',
    'stream'
  ])

  it('扫描器阳性对照：四种引用写法都能识别（守卫不是恒真）', () => {
    const sample = [
      "import { a } from 'electron'",
      "import 'node:fs'",
      "const m = await import('./x')",
      "const r = require('path')"
    ].join('\n')
    expect(specifiers(sample)).toEqual(['electron', 'node:fs', './x', 'path'])
  })

  it('providers 目录全部源文件不导入 electron / electron-store', () => {
    const dir = resolve(process.cwd(), 'src/main/providers')
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const banned = specifiers(readSource(`src/main/providers/${name}`)).filter(
        (spec) => spec === 'electron' || spec === 'electron-store' || spec.startsWith('electron/')
      )
      expect(banned, `${name} 不得依赖 electron`).toEqual([])
    }
  })

  it('request-policy 保持零模块引用（浏览器可消费，无 Node 导入）', () => {
    const source = readSource('src/shared/request-policy.ts')
    expect(specifiers(source)).toEqual([])
    expect(/\bfetch\s*\(/.test(source)).toBe(false)
    expect(/\bXMLHttpRequest\b/.test(source)).toBe(false)
  })

  it('shared/agent 不导入 Node 内置模块或 electron', () => {
    const specs = specifiers(readSource('src/shared/agent.ts'))
    for (const spec of specs) {
      const bare = spec.replace(/^node:/, '').split('/')[0]!
      expect(spec.startsWith('node:'), spec).toBe(false)
      expect(NODE_BUILTINS.has(bare), spec).toBe(false)
      expect(spec === 'electron' || spec === 'electron-store', spec).toBe(false)
    }
  })

  it('providers/types 只以类型方式引用运行态上下文与观测，不增加运行时依赖', () => {
    const source = readSource('src/main/providers/types.ts')
    expect(source).toMatch(/import type \{[^}]*ProviderExecutionContext[^}]*\} from '@shared\/request-policy'/)
    expect(source).toMatch(/context\?: ProviderExecutionContext/)
    expect(source).toMatch(/onServiceTier\?: \(observation: ServiceTierObservation\) => void/)
    expect(/\bheaders\b/.test(source)).toBe(false)
  })

  it('运行态上下文不进入持久 ModelSettings，也不被持久层引用', () => {
    const modelSettings = interfaceBody(readSource('src/shared/ipc.ts'), 'export interface ModelSettings {')
    expect(modelSettings).not.toMatch(/\bcontext\b|operationId|sessionId|operationKey|sessionKey|ProviderExecutionContext/)
    for (const rel of ['src/shared/ipc.ts', 'src/main/schemas.ts', 'src/main/store/models.ts']) {
      expect(readSource(rel)).not.toContain('ProviderExecutionContext')
    }
  })

  it('request-policy 上下文合同不定义任意请求头入口', () => {
    const source = readSource('src/shared/request-policy.ts')
    expect(/\bheaders\b/.test(source)).toBe(false)
    expect(source).not.toMatch(/authorization|x-api-key|user-agent/i)
  })
})
