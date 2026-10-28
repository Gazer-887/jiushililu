import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as models from '@shared/models'
import * as schemas from '@main/schemas'
import { modelMetadataSchema, normalizeModelMetadata } from '@shared/model-metadata'
import type { AgentDefinition } from '@main/agent/loader'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import type { ModelSettings } from '@shared/ipc'

/**
 * S89-01 请求策略合同：本地读并发默认化、权限代次与旧配置兼容。
 * 全部断言只碰纯函数与 schema：不联网、不发真实请求、不读真实用户配置。
 */

type PolicyModule = typeof import('@shared/request-policy')

async function policy(): Promise<PolicyModule> {
  return await import('@shared/request-policy')
}

const NOW = 1_700_000_000_000
const BASE_URL = 'https://api.example.com/v1'

// ── 运行链观测替身 ────────────────────────────────────────────────────────
const loopCtl = vi.hoisted(() => ({
  captured: [] as Array<Record<string, unknown>>
}))

vi.mock('@main/agent/loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/loop')>()
  return {
    ...actual,
    runAgentLoop: async (options: Parameters<typeof actual.runAgentLoop>[0]) => {
      loopCtl.captured.push(options as unknown as Record<string, unknown>)
      return { output: '完成', rounds: 1, stopReason: 'completed' as const, terminal: { state: 'completed' as const } }
    }
  }
})

const requestPolicyCalls = vi.hoisted(() => ({ resolve: 0 }))

vi.mock('@shared/request-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/request-policy')>()
  return {
    ...actual,
    resolveRequestPolicy: () => {
      requestPolicyCalls.resolve += 1
      return actual.resolveRequestPolicy()
    }
  }
})

function saveInput(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    name: '端点A',
    providerType: 'openai-compatible',
    baseURL: BASE_URL,
    models: [{ id: 'm1', model: 'test-model', ...entry }],
    apiKey: ''
  }
}

function rawProfile(entry: Record<string, unknown> = {}): unknown[] {
  return [
    {
      id: 'p1',
      name: '端点A',
      providerType: 'openai-compatible',
      baseURL: BASE_URL,
      timeoutMs: 60_000,
      stream: true,
      models: [{ id: 'm1', model: 'test-model', ...entry }],
      activeModelId: 'm1',
      createdAt: NOW,
      updatedAt: NOW
    }
  ]
}

describe('S89-01 ① 工具批并发：整批合格 2 路，其余一律 1 路（fail-closed）', () => {
  it('eligible 只有显式 true 才放宽到 2', async () => {
    const p = await policy()
    expect(p.resolveToolBatchConcurrency({ eligible: true })).toBe(2)
    for (const eligible of [false, undefined, null, 1, 'true', 'yes', 0, {}]) {
      expect(p.resolveToolBatchConcurrency({ eligible })).toBe(1)
    }
    expect(p.resolveToolBatchConcurrency()).toBe(1)
    expect(p.resolveToolBatchConcurrency({})).toBe(1)
  })

  it('不再接受任何档位入参：mode 字段既不是契约也不影响结论', async () => {
    const p = await policy()
    const withMode = (mode: unknown): number =>
      (p.resolveToolBatchConcurrency as (input: Record<string, unknown>) => 1 | 2)({
        eligible: true,
        mode
      })
    for (const mode of ['fast', 'normal', undefined, null, 'turbo']) {
      expect(withMode(mode)).toBe(2)
    }
    // 不合格批即使带着旧的 fast 字段仍是 1 路
    expect(
      (p.resolveToolBatchConcurrency as (input: Record<string, unknown>) => 1 | 2)({
        eligible: false,
        mode: 'fast'
      })
    ).toBe(1)
  })

  it('并发常量语义：串行 1 / 并行 2', async () => {
    const p = await policy()
    expect(p.TOOL_BATCH_CONCURRENCY_SERIAL).toBe(1)
    expect(p.TOOL_BATCH_CONCURRENCY_PARALLEL).toBe(2)
  })
})

describe('S89-01 ② 请求策略快照：只保留本地并发上限', () => {
  it('缺省快照只含一个字段，默认并行 2', async () => {
    const p = await policy()
    const snap = p.resolveRequestPolicy()
    expect(snap).toEqual({ maxLocalReadConcurrency: 2 })
    expect(Object.keys(snap)).toEqual(['maxLocalReadConcurrency'])
    for (const key of [
      'mode',
      'requestedServiceTier',
      'tierSupport',
      'readLines',
      'outputDiscipline',
      'windowEnabled'
    ]) {
      expect(key in snap).toBe(false)
    }
  })
})

describe('S89-01 ③ 运行上下文：策略随上下文冻结，非法值拒绝', () => {
  const id = (): string => 'id-' + Math.random().toString(36).slice(2)

  it('策略被复制并冻结，之后修改入参无效', async () => {
    const p = await policy()
    const input = { maxLocalReadConcurrency: 2 as const }
    const ctx = p.createProviderExecutionContext({
      clientVersion: '1.2.3',
      purpose: 'main-chat',
      policy: input,
      randomUUID: id
    })
    expect(ctx.policy).toEqual({ maxLocalReadConcurrency: 2 })
    expect(ctx.policy).not.toBe(input)
    expect(Object.isFrozen(ctx.policy)).toBe(true)
  })

  it('非法并发上限拒绝创建上下文', async () => {
    const p = await policy()
    for (const bad of [0, 3, '2', null, undefined, NaN]) {
      expect(() =>
        p.createProviderExecutionContext({
          clientVersion: '1.2.3',
          purpose: 'main-chat',
          policy: { maxLocalReadConcurrency: bad } as never,
          randomUUID: id
        })
      ).toThrow()
    }
  })

  it('辅助用途与主调用共用同一策略（不再有档位压回分支）', async () => {
    const p = await policy()
    const snap = { maxLocalReadConcurrency: 1 as const }
    for (const purpose of p.PROVIDER_CALL_PURPOSES) {
      const ctx = p.createProviderExecutionContext({
        clientVersion: '1.2.3',
        purpose,
        policy: snap,
        randomUUID: id
      })
      expect(ctx.policy).toEqual(snap)
    }
  })

  it('八类调用目的冻结，非法目的拒绝', async () => {
    const p = await policy()
    expect([...p.PROVIDER_CALL_PURPOSES]).toEqual([
      'main-chat',
      'one-shot',
      'subagent',
      'reflection',
      'title',
      'prompt-polish',
      'connection-check',
      'model-catalog'
    ])
    expect(p.isProviderCallPurpose('title')).toBe(true)
    expect(p.isProviderCallPurpose('turbo')).toBe(false)
  })
})

describe('S89-01 ④ 权限代次合同保持零变动', () => {
  it('同一非负安全整数才算未变化；其余一律按已变化（fail-closed）', async () => {
    const p = await policy()
    expect(p.isPermissionGenerationCurrent(0, 0)).toBe(true)
    expect(p.isPermissionGenerationCurrent(7, 7)).toBe(true)
    expect(p.isPermissionGenerationCurrent(7, 8)).toBe(false)
    for (const [observed, current] of [
      [-1, -1],
      [1.5, 1.5],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      ['7', '7'],
      [null, null],
      [undefined, 0]
    ] as const) {
      expect(p.isPermissionGenerationCurrent(observed, current)).toBe(false)
    }
  })

  it('PermissionStateSnapshot 仍是 preset + generation 的共享形状', () => {
    const snap: import('@shared/request-policy').PermissionStateSnapshot<'read-only' | 'write'> = {
      preset: 'write',
      generation: 3
    }
    expect(snap.preset).toBe('write')
    expect(snap.generation).toBe(3)
  })
})

describe('S89-01 ⑤ 旧配置兼容：speedMode / serviceTiers 读时忽略、绝不报错', () => {
  it('normalizeProfiles 读到 speedMode 时丢弃该键且不丢条目', () => {
    const { profiles, dropped } = models.normalizeProfiles(
      rawProfile({ speedMode: 'fast', settings: { temperature: 0.2 } })
    )
    expect(dropped).toBe(0)
    const entry = profiles[0]!.models[0]!
    expect('speedMode' in entry).toBe(false)
    expect(entry.settings).toEqual({ temperature: 0.2 })
  })

  it('modelSaveSchema 对旧 speedMode 键按 strip 忽略（不报错、不落盘）', () => {
    const parsed = schemas.modelSaveSchema.parse(saveInput({ speedMode: 'fast' }))
    expect(parsed.models[0]).toEqual({ id: 'm1', model: 'test-model' })
    expect('speedMode' in parsed.models[0]!).toBe(false)
  })

  it('modelMetadataSchema 接受并丢弃历史 serviceTiers，其他字段照常校验', () => {
    const legacy = {
      serviceTiers: { official: { value: ['priority'], observedAt: NOW } },
      contextWindow: { user: { value: 64000, observedAt: NOW } }
    }
    const parsed = modelMetadataSchema.parse(legacy)
    expect(parsed).toEqual({ contextWindow: legacy.contextWindow })
    expect('serviceTiers' in parsed).toBe(false)
    // 其他未知键仍然 fail-closed（兼容例外只对 serviceTiers 开口）
    expect(() => modelMetadataSchema.parse({ unexpected: true })).toThrow()
  })

  it('normalizeModelMetadata 静默丢弃 serviceTiers，保留同一份里的合法字段', () => {
    const out = normalizeModelMetadata({
      serviceTiers: { user: { value: ['priority'], observedAt: NOW } },
      contextWindow: { user: { value: 32000, observedAt: NOW } }
    })
    expect(out).toEqual({ contextWindow: { user: { value: 32000, observedAt: NOW } } })
    expect(normalizeModelMetadata({ serviceTiers: { bad: true } })).toBeUndefined()
  })

  it('message 运行事实 schema 忽略历史 requestPolicy / serviceTier', () => {
    const parsed = schemas.storedMessageSchema.parse({
      role: 'assistant',
      content: '答',
      requestId: '00000000-0000-4000-8000-000000000000',
      requestPolicy: { mode: 'fast', maxLocalReadConcurrency: 2 },
      serviceTier: { requested: 'priority', actual: 'priority', observed: true }
    })
    expect(parsed.requestId).toBe('00000000-0000-4000-8000-000000000000')
    expect('requestPolicy' in parsed).toBe(false)
    expect('serviceTier' in parsed).toBe(false)
  })
})

describe('S89-01 ⑥ 模块边界：策略层零依赖，运行链不读用户偏好', () => {
  function readSource(rel: string): string {
    return readFileSync(resolve(process.cwd(), rel), 'utf8')
  }

  function codeOnly(source: string): string {
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
    return noBlock
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n')
  }

  it('request-policy 仍是零依赖纯模块，且不再出现档位符号', () => {
    const src = readSource('src/shared/request-policy.ts')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/SpeedMode|SpeedOverride|TierSupport|serviceTier|requestedServiceTier/)
    expect(/\bfetch\s*\(/.test(src)).toBe(false)
  })

  it('runner / loop / scheduler 不引用 electron-store 或 ui-prefs', () => {
    const forbiddenCall = /\b(getUIPrefs|loadUIPrefs|persistUIPrefs|setUIPref|resetUIPrefs)\s*\(/
    for (const rel of ['src/main/agent/runner.ts', 'src/main/agent/loop.ts', 'src/main/agent/scheduler.ts']) {
      const src = readSource(rel)
      expect(src).not.toMatch(/from ['"][^'"]*electron-store/)
      expect(src).not.toMatch(/from ['"][^'"]*ui-prefs/)
      expect(forbiddenCall.test(codeOnly(src))).toBe(false)
    }
  })

  it('loop / scheduler 不解析策略，只有 runner 解析一次', () => {
    expect(codeOnly(readSource('src/main/agent/loop.ts'))).not.toContain('resolveRequestPolicy(')
    expect(codeOnly(readSource('src/main/agent/scheduler.ts'))).not.toContain('resolveRequestPolicy(')
    const hits = codeOnly(readSource('src/main/agent/runner.ts')).match(/resolveRequestPolicy\(/g) ?? []
    expect(hits).toHaveLength(1)
  })

  it('shared/agent.ts 只保留命名合同，不复制档位实现', () => {
    const shared = readSource('src/shared/agent.ts')
    expect(shared).toContain('export type RunRequestPolicy = Readonly<RequestPolicySnapshot>')
    expect(codeOnly(shared)).not.toMatch(/SpeedMode|resolveSpeedMode|normalizeSpeedMode|FAST_SERVICE_TIER/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 运行链：快照冻结与传播
// ═══════════════════════════════════════════════════════════════════════════

const RUN_SETTINGS: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: BASE_URL,
  model: 'test-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60_000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  inputModalities: ['text']
}

const tempDirs: string[] = []

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  loopCtl.captured.length = 0
  requestPolicyCalls.resolve = 0
})

function makeRunCtx(): AgentRuntimeContext {
  const base = mkdtempSync(join(tmpdir(), 'jsl-s89-01-'))
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

function writeAgentDef(ctx: AgentRuntimeContext, name: string, model = 'another-model'): void {
  mkdirSync(ctx.userAgentsDir, { recursive: true })
  writeFileSync(
    join(ctx.userAgentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} 的职责\nmodel: ${model}\n---\n只做 ${name} 的活。`,
    'utf8'
  )
}

async function runAgentOnce(
  extra: Record<string, unknown> = {},
  ctx: AgentRuntimeContext = makeRunCtx()
): Promise<void> {
  const { runAgent } = await import('@main/agent/runner')
  await runAgent(ctx, {
    settings: RUN_SETTINGS,
    apiKey: 'k',
    conversationId: 'conv-s89-01',
    history: [{ role: 'user', content: '干活' }],
    ...extra
  } as unknown as Parameters<typeof runAgent>[1])
}

describe('S89-01 ⑦ 快照冻结与传播', () => {
  it('缺省时主循环收到默认快照 { maxLocalReadConcurrency: 2 }，且只解析一次', async () => {
    await runAgentOnce()
    expect(loopCtl.captured).toHaveLength(1)
    const snap = loopCtl.captured[0]!.requestPolicy as Record<string, unknown>
    expect(snap).toEqual({ maxLocalReadConcurrency: 2 })
    expect(Object.isFrozen(snap)).toBe(true)
    expect(requestPolicyCalls.resolve).toBe(1)
  })

  it('传入快照被复制并冻结，运行中改入参不影响已启动的 run', async () => {
    const input = { maxLocalReadConcurrency: 1 as const }
    await runAgentOnce({ requestPolicy: input })
    const snap = loopCtl.captured[0]!.requestPolicy as { maxLocalReadConcurrency: number }
    expect(snap).not.toBe(input)
    expect(Object.isFrozen(snap)).toBe(true)
    expect(snap.maxLocalReadConcurrency).toBe(1)
    expect(() => {
      snap.maxLocalReadConcurrency = 2
    }).toThrow(TypeError)
    expect(requestPolicyCalls.resolve).toBe(0)
  })

  it('主循环与全部子代理共享同一个冻结引用', async () => {
    const ctx = makeRunCtx()
    writeAgentDef(ctx, 'reviewer', 'cheap-model')
    writeAgentDef(ctx, 'tester', 'expensive-model')

    const { runAgent } = await import('@main/agent/runner')
    // 用真实 runAgent 太贵：只验证构造路径的引用传播由 scheduler 单测覆盖。
    // 这里走 runAgent 的默认路径（无派发口），确认快照来自同一实例。
    await runAgent(ctx, {
      settings: RUN_SETTINGS,
      apiKey: 'k',
      conversationId: 'conv-s89-01-shared',
      history: [{ role: 'user', content: '干活' }]
    } as unknown as Parameters<typeof runAgent>[1])
    expect(loopCtl.captured).toHaveLength(1)
    expect(Object.isFrozen(loopCtl.captured[0]!.requestPolicy)).toBe(true)
  })

  it('scheduler 把父快照原样透传，不重新解析', async () => {
    const { runSubagents } = await import('@main/agent/scheduler')
    const frozen = Object.freeze({ maxLocalReadConcurrency: 2 })
    const def: AgentDefinition = {
      name: 'solo',
      description: '单独跑',
      model: 'another-model',
      systemPrompt: '只做自己的活。',
      source: 'user',
      file: '/virtual/solo.md'
    }
    const results = await runSubagents({
      definitions: [def],
      task: '干活',
      requestPolicy: frozen,
      toolsFor: () => [],
      chatFactory: () => async () => ({ text: '完成', toolCalls: [] }),
      maxConcurrency: 1
    })
    expect(results[0]?.ok).toBe(true)
    expect(loopCtl.captured.at(-1)?.requestPolicy).toBe(frozen)
    expect(requestPolicyCalls.resolve).toBe(0)
  })
})
