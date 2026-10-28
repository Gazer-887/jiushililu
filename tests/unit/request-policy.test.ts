import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as models from '@shared/models'
import * as tokenTier from '@shared/token-tier'
import * as schemas from '@main/schemas'
import type { ModelSettings } from '@shared/ipc'
import type { AgentDefinition } from '@main/agent/loader'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'

/**
 * S3-20A 模型默认兼容：FAST 纯合同 + 模型默认持久化 + 与省 token 四档正交。
 *
 * 全部断言只碰纯函数与 schema：不联网、不发真实请求、不读真实用户配置。
 * 新增模块用动态导入，红态才能逐条落点（而不是整文件一个解析错误）。
 */

type PolicyModule = typeof import('@shared/request-policy')

async function policy(): Promise<PolicyModule> {
  return await import('@shared/request-policy')
}

const fixture = vi.hoisted(() => ({ root: '' }))

// S3-20D2 入口装配观测替身：IPC handler 表 + runAgent 调用记录。
// 默认 'real' 原样委托真实实现（S3-20D1 及此前全部用例零影响），D2 用例切 'fake' 后
// 由测试脚本自行决定 runAgent 何时返回 / 抛错 / 等待，用来观察"run 起点读了什么"。
const d2Ctl = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  calls: [] as Array<Record<string, unknown>>,
  mode: 'real' as 'real' | 'fake',
  impl: null as null | ((args: Record<string, unknown>) => Promise<unknown>)
}))

// 落盘跳用**真实 electron-store 后端 conf + 临时目录**（同 auto-memory-settings 范式），
// 不读真实用户配置。
// S3-20D2 起补 ipcMain 捕获（真 IPC handler 注册）与 app.getPath（组合根取 userData）；
// safeStorage 换成可往返的内存实现 —— 只为让入口的 hasApiKey / getDecryptedApiKey
// 走真实 store 路径，不引入真实系统加密。
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (!fixture.root) throw new Error('必须先指定隔离数据根')
      return fixture.root
    }
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<unknown>) => {
      d2Ctl.handlers.set(channel, fn)
    }
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  clipboard: {},
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
        super({ cwd: fixture.root, configName: options.name, projectName: 's3-20a-models', projectVersion: '0.0.0' })
      }
    }
  }
})

// ── S3-20D1 观测替身 ─────────────────────────────────────────────────────────
// 目标测试要看见"run 级策略快照"在主循环与子代理之间**是否为同一个引用**，故在
// loop 边界做一层可控转发：默认原样委托给真实实现（既有路径零影响），需要观测时
// 切到 fake 分支，由测试脚本自行取走 options 并模拟派发。
const loopCtl = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'fake',
  captured: [] as Array<Record<string, unknown>>,
  fakeHook: null as null | ((options: Record<string, unknown>) => void),
  jobs: [] as Array<{ agent: string; task: string }>
}))

const requestPolicyCalls = vi.hoisted(() => ({ resolve: 0 }))

vi.mock('@shared/request-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/request-policy')>()
  return {
    ...actual,
    resolveRequestPolicy: (...args: Parameters<typeof actual.resolveRequestPolicy>) => {
      requestPolicyCalls.resolve += 1
      return actual.resolveRequestPolicy(...args)
    }
  }
})

vi.mock('@main/agent/loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/loop')>()
  return {
    ...actual,
    runAgentLoop: async (options: Parameters<typeof actual.runAgentLoop>[0]) => {
      loopCtl.captured.push(options as unknown as Record<string, unknown>)
      if (loopCtl.mode === 'real') return actual.runAgentLoop(options)
      loopCtl.fakeHook?.(options as unknown as Record<string, unknown>)
      const tools = (options.tools ?? []) as Array<{
        schema: { name: string }
        execute: (args: Record<string, unknown>) => Promise<unknown>
      }>
      const spawn = tools.find((t) => t.schema.name === 'spawn_agents')
      if (spawn) await spawn.execute({ jobs: loopCtl.jobs })
      return { output: '完成', rounds: 1, stopReason: 'completed' as const, terminal: { state: 'completed' as const } }
    }
  }
})

// S3-20D2：入口装配观测点。默认委托真实 runAgent（D1 用例不受影响）；
// D2 用例切 fake 后只记录 args，由测试决定返回值/异常/阻塞。
vi.mock('@main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/runner')>()
  return {
    ...actual,
    runAgent: async (
      ctx: Parameters<typeof actual.runAgent>[0],
      args: Parameters<typeof actual.runAgent>[1]
    ) => {
      d2Ctl.calls.push(args as unknown as Record<string, unknown>)
      if (d2Ctl.mode === 'real') return await actual.runAgent(ctx, args)
      if (!d2Ctl.impl) throw new Error('D2 fake runAgent 未设置实现')
      return await d2Ctl.impl(args as unknown as Record<string, unknown>)
    }
  }
})

const providerSpies = vi.hoisted(() => ({ openai: vi.fn(), anthropic: vi.fn() }))

vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: unknown[]) => providerSpies.openai(...args),
  chatWithToolsOpenAI: vi.fn()
}))

vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: (...args: unknown[]) => providerSpies.anthropic(...args),
  chatWithToolsAnthropic: vi.fn()
}))

/**
 * 提取模块引用（静态 import/export-from、裸 import、动态 import、require）。
 * 抽成函数是为了给正交守卫配**阳性对照**：守卫本身必须能认出违规写法，不能恒真。
 */
function moduleSpecifiers(source: string): string[] {  const patterns = [
    /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g
  ]
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]))
}

const NOW = 1_700_000_000_000
const BASE_URL = 'https://api.example.com/v1'

/** modelSaveSchema 的最小合法载荷（单条目） */
function saveInput(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    name: '端点A',
    providerType: 'openai-compatible',
    baseURL: BASE_URL,
    models: [{ id: 'm1', model: 'test-model', ...entry }],
    apiKey: ''
  }
}

/** normalizeProfiles 的新形状夹具（单端点单条目） */
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

function profileWith(entry: models.ModelEntry): models.ModelProfile {
  return models.createProfile({
    id: 'p1',
    providerType: 'openai-compatible',
    baseURL: BASE_URL,
    models: [entry],
    now: NOW
  })
}

describe('S3-20A ① 枚举与默认', () => {
  it('三个枚举的运行时集合与默认值冻结', async () => {
    const p = await policy()
    expect([...p.SPEED_MODES]).toEqual(['normal', 'fast'])
    expect([...p.SPEED_OVERRIDES]).toEqual(['inherit', 'normal', 'fast'])
    expect([...p.TIER_SUPPORTS]).toEqual(['supported', 'unsupported', 'unknown'])
    expect(p.DEFAULT_SPEED_MODE).toBe('normal')
    expect(p.DEFAULT_SPEED_OVERRIDE).toBe('inherit')
    expect(p.DEFAULT_TIER_SUPPORT).toBe('unknown')
  })

  it('类型守卫只认合法值，不把相似值当合法', async () => {
    const p = await policy()
    expect(p.isSpeedMode('normal')).toBe(true)
    expect(p.isSpeedMode('fast')).toBe(true)
    expect(p.isSpeedMode('FAST')).toBe(false)
    expect(p.isSpeedMode('')).toBe(false)
    expect(p.isSpeedMode(undefined)).toBe(false)
    expect(p.isSpeedOverride('inherit')).toBe(true)
    expect(p.isSpeedOverride('normal')).toBe(true)
    expect(p.isSpeedOverride('fast')).toBe(true)
    expect(p.isSpeedOverride('auto')).toBe(false)
    expect(p.isTierSupport('supported')).toBe(true)
    expect(p.isTierSupport('unsupported')).toBe(true)
    expect(p.isTierSupport('unknown')).toBe(true)
    expect(p.isTierSupport('yes')).toBe(false)
  })
})

describe('S3-20A ② 缺值 / 旧值 / 非法值回落 normal', () => {
  it('缺值、null、旧值、非法值、非字符串一律回落 normal', async () => {
    const p = await policy()
    for (const bad of [undefined, null, '', 'turbo', 'FAST', 'auto', 1, true, {}, []]) {
      expect(p.normalizeSpeedMode(bad)).toBe('normal')
    }
    expect(p.normalizeSpeedMode('fast')).toBe('fast')
  })

  it('非法覆盖值回 inherit（不冒充显式覆盖），合法值原样保留', async () => {
    const p = await policy()
    for (const bad of [undefined, null, '', 'turbo', 1, {}, []]) {
      expect(p.normalizeSpeedOverride(bad)).toBe('inherit')
    }
    expect(p.normalizeSpeedOverride('inherit')).toBe('inherit')
    expect(p.normalizeSpeedOverride('normal')).toBe('normal')
    expect(p.normalizeSpeedOverride('fast')).toBe('fast')
  })

  it('tierSupport 缺值/非法值一律 unknown（fail-closed：不声明支持就不请求）', async () => {
    const p = await policy()
    for (const bad of [undefined, null, '', 'yes', 1, {}, []]) {
      expect(p.normalizeTierSupport(bad)).toBe('unknown')
    }
    expect(p.normalizeTierSupport('supported')).toBe('supported')
    expect(p.normalizeTierSupport('unsupported')).toBe('unsupported')
  })
})

describe('S3-20A ③ 会话覆盖：inherit 用模型默认，显式值直接覆盖', () => {
  it('inherit 取模型默认（缺省覆盖也等价 inherit）', async () => {
    const p = await policy()
    expect(p.resolveSpeedMode('fast', 'inherit')).toBe('fast')
    expect(p.resolveSpeedMode('fast', undefined)).toBe('fast')
    expect(p.resolveSpeedMode('normal', 'inherit')).toBe('normal')
    expect(p.resolveSpeedMode(undefined, 'inherit')).toBe('normal')
  })

  it('normal / fast 显式覆盖模型默认', async () => {
    const p = await policy()
    expect(p.resolveSpeedMode('fast', 'normal')).toBe('normal')
    expect(p.resolveSpeedMode('normal', 'fast')).toBe('fast')
    expect(p.resolveSpeedMode(undefined, 'fast')).toBe('fast')
  })

  it('非法覆盖值不会把模型默认顶掉（回落 inherit）', async () => {
    const p = await policy()
    expect(p.resolveSpeedMode('fast', 'turbo')).toBe('fast')
    expect(p.resolveSpeedMode('normal', 'turbo')).toBe('normal')
  })
})

describe('S3-20A ④ 本地读并发：normal=1，fast=2', () => {
  it('两档并发与快照同源', async () => {
    const p = await policy()
    expect(p.localReadConcurrency('normal')).toBe(1)
    expect(p.localReadConcurrency('fast')).toBe(2)
    expect(p.resolveRequestPolicy({ modelDefault: 'normal' }).maxLocalReadConcurrency).toBe(1)
    expect(p.resolveRequestPolicy({ modelDefault: 'fast' }).maxLocalReadConcurrency).toBe(2)
    expect(p.resolveRequestPolicy({ modelDefault: 'fast', sessionOverride: 'normal' }).maxLocalReadConcurrency).toBe(1)
    expect(p.resolveRequestPolicy({ modelDefault: 'normal', sessionOverride: 'fast' }).maxLocalReadConcurrency).toBe(2)
  })
})

describe('S3-20A ⑤ service-tier 意图：只有 fast+supported 才非空', () => {
  it('fast + supported 产生非空档位名，且与常量一致', async () => {
    const p = await policy()
    const snap = p.resolveRequestPolicy({ modelDefault: 'fast', tierSupport: 'supported' })
    expect(snap.mode).toBe('fast')
    expect(snap.tierSupport).toBe('supported')
    expect(snap.requestedServiceTier).toBe(p.FAST_SERVICE_TIER)
    expect(typeof snap.requestedServiceTier).toBe('string')
    expect((snap.requestedServiceTier ?? '').length).toBeGreaterThan(0)
  })

  it('unsupported / unknown / 缺值保持 requestedServiceTier=null', async () => {
    const p = await policy()
    for (const tierSupport of ['unsupported', 'unknown', undefined, 'yes', null]) {
      const snap = p.resolveRequestPolicy({ modelDefault: 'fast', tierSupport })
      expect(snap.requestedServiceTier).toBeNull()
      expect(snap.tierSupport).toBe(tierSupport === 'unsupported' ? 'unsupported' : 'unknown')
    }
  })

  it('normal 即使声明 supported 也不请求非默认服务档', async () => {
    const p = await policy()
    const snap = p.resolveRequestPolicy({ modelDefault: 'normal', tierSupport: 'supported' })
    expect(snap.mode).toBe('normal')
    expect(snap.requestedServiceTier).toBeNull()
  })

  it('快照只含合同四字段，不夹带省 token 参数', async () => {
    const p = await policy()
    const snap = p.resolveRequestPolicy({ modelDefault: 'fast', tierSupport: 'supported' })
    expect(Object.keys(snap).sort()).toEqual(
      ['maxLocalReadConcurrency', 'mode', 'requestedServiceTier', 'tierSupport'].sort()
    )
    for (const key of ['readLines', 'outputDiscipline', 'maxTokens', 'keepRatioMax', 'windowEnabled']) {
      expect(key in snap).toBe(false)
    }
  })
})

describe('S3-20A ⑥ 服务档观测：actual/observed 不回填成功', () => {
  it('没有 actual 就没有观测，绝不用 requested 冒充 actual', async () => {
    const p = await policy()
    expect(p.observeServiceTier('priority', null)).toEqual({ requested: 'priority', actual: null, observed: false })
    expect(p.observeServiceTier('priority', undefined)).toEqual({
      requested: 'priority',
      actual: null,
      observed: false
    })
    expect(p.observeServiceTier('priority', '')).toEqual({ requested: 'priority', actual: null, observed: false })
    expect(p.observeServiceTier('priority', '   ')).toEqual({
      requested: 'priority',
      actual: null,
      observed: false
    })
  })

  it('真实回值才算观测；服务端降级是真实观测，不因与 request 不同而丢弃', async () => {
    const p = await policy()
    expect(p.observeServiceTier('priority', 'priority')).toEqual({
      requested: 'priority',
      actual: 'priority',
      observed: true
    })
    expect(p.observeServiceTier('priority', 'default')).toEqual({
      requested: 'priority',
      actual: 'default',
      observed: true
    })
    expect(p.observeServiceTier(null, 'default')).toEqual({ requested: null, actual: 'default', observed: true })
  })
})

describe('S3-20A ⑦ 旧档案：缺字段保持缺失，有效值为 normal', () => {
  it('缺 speedMode 的档案读盘后字段仍缺失（不强行补写），有效值 normal', async () => {
    const p = await policy()
    const { profiles, dropped } = models.normalizeProfiles(rawProfile())
    expect(dropped).toBe(0)
    const entry = profiles[0].models[0]
    expect('speedMode' in entry).toBe(false)
    expect(p.normalizeSpeedMode(entry.speedMode)).toBe('normal')
    expect(p.resolveSpeedMode(entry.speedMode, 'inherit')).toBe('normal')
  })

  it('更老的扁平形状升级后同样不带 speedMode，有效值 normal', async () => {
    const p = await policy()
    const flat = [
      {
        id: 'p-legacy',
        providerType: 'openai-compatible',
        baseURL: BASE_URL,
        model: 'legacy-model',
        createdAt: NOW
      }
    ]
    const { profiles } = models.normalizeProfiles(flat)
    expect(profiles).toHaveLength(1)
    const entry = profiles[0].models[0]
    expect('speedMode' in entry).toBe(false)
    expect(p.normalizeSpeedMode(entry.speedMode)).toBe('normal')
  })

  it('非法 speedMode 读盘丢弃（条目本身保留），有效值 normal', async () => {
    const p = await policy()
    for (const bad of ['turbo', 'FAST', 1, null, {}]) {
      const { profiles, dropped } = models.normalizeProfiles(rawProfile({ speedMode: bad }))
      expect(dropped).toBe(0)
      expect(profiles).toHaveLength(1)
      expect('speedMode' in profiles[0].models[0]).toBe(false)
      expect(p.normalizeSpeedMode(profiles[0].models[0].speedMode)).toBe('normal')
    }
  })
})

describe('S3-20A ⑧ 合法 speedMode：保存 / 读盘 / 补丁 / 目录复制不丢', () => {
  it('modelSaveSchema 接受并保留合法 speedMode', async () => {
    for (const speedMode of ['normal', 'fast']) {
      const parsed = schemas.modelSaveSchema.parse(saveInput({ speedMode }))
      expect(parsed.models[0].speedMode).toBe(speedMode)
    }
  })

  it('modelSaveSchema 拒绝非法 / 空 speedMode（不静默剥离）', async () => {
    for (const bad of ['turbo', 'FAST', '', null, 1, true]) {
      expect(schemas.modelSaveSchema.safeParse(saveInput({ speedMode: bad })).success).toBe(false)
    }
  })

  it('normalizeProfiles 读盘保留合法 speedMode', async () => {
    for (const speedMode of ['normal', 'fast']) {
      const { profiles, dropped } = models.normalizeProfiles(rawProfile({ speedMode }))
      expect(dropped).toBe(0)
      expect(profiles[0].models[0].speedMode).toBe(speedMode)
    }
  })

  it('makeEntry 复制目录条目时保留 speedMode；运行时脏值不写入', async () => {
    const source = models.makeEntry({
      id: 'm1',
      model: 'test-model',
      settings: { temperature: 0.2 },
      speedMode: 'fast'
    })
    const copy = models.makeEntry({
      id: 'm2',
      model: source.model,
      settings: source.settings,
      speedMode: source.speedMode
    })
    expect(copy.speedMode).toBe('fast')
    expect(copy.settings).toEqual({ temperature: 0.2 })
    const bad = models.makeEntry({ id: 'm3', model: 'x', speedMode: 'turbo' as never })
    expect('speedMode' in bad).toBe(false)
  })

  it('单字段 settings 补丁不丢 speedMode / metadata，且不改原条目', async () => {
    const entry = models.makeEntry({
      id: 'm1',
      model: 'test-model',
      speedMode: 'fast',
      settings: { temperature: 0.2 },
      metadata: { contextWindow: { user: { value: 64000, observedAt: NOW } } }
    })
    const next = models.applyEntrySettingsPatch(entry, { contextWindow: 131072 })
    expect(next.speedMode).toBe('fast')
    expect(next.metadata).toEqual(entry.metadata)
    expect(next.settings).toEqual({ temperature: 0.2, contextWindow: 131072 })
    // 纯函数：原条目一字节不动（补丁语义只产生新对象）
    expect(entry.settings).toEqual({ temperature: 0.2 })
    expect(entry.speedMode).toBe('fast')
  })

  it('K51 能力探测写盘（applyDetectionToEntries）不丢 speedMode', async () => {
    const entry = models.makeEntry({ id: 'm1', model: 'test-model', speedMode: 'fast' })
    const next = models.applyDetectionToEntries([entry], { 'test-model': { imageInput: true } }, NOW)
    expect(next[0].speedMode).toBe('fast')
    expect(next[0].detectedModalities).toEqual(['text', 'image'])
  })

  it('settingsOf 不把 speedMode 混进模型设置（speedMode 是条目字段）', async () => {
    const entry = models.makeEntry({ id: 'm1', model: 'test-model', speedMode: 'fast' })
    const settings = models.settingsOf(profileWith(entry), entry)
    expect('speedMode' in settings).toBe(false)
    expect(settings.model).toBe('test-model')
  })

  it('mergeEntrySettings 只合并 settings 白名单，不产生 speedMode 键', async () => {
    const merged = models.mergeEntrySettings({ temperature: 0.2 }, { contextWindow: 32000 })
    expect(merged).toEqual({ temperature: 0.2, contextWindow: 32000 })
    expect('speedMode' in merged).toBe(false)
  })
})

describe('S3-20A ⑨ 与省 token 四档完全正交', () => {
  const TIERS = ['rich', 'ultimate', 'balanced', 'light'] as const
  const READ_LINES = { rich: 2000, ultimate: 800, balanced: 200, light: 100 } as const
  const DISCIPLINE = { rich: 0, ultimate: 0, balanced: 1, light: 2 } as const

  it('四档行为保持原样：readLines / outputDiscipline / reasoningEffortOverride', async () => {
    const p = await policy()
    const snapshot = p.resolveRequestPolicy({ modelDefault: 'fast', tierSupport: 'supported' })
    expect(snapshot.mode).toBe('fast')
    for (const tier of TIERS) {
      const before = tokenTier.resolvePolicy(tier)
      expect(before.tier).toBe(tier)
      expect(before.readLines).toBe(READ_LINES[tier])
      expect(before.outputDiscipline).toBe(DISCIPLINE[tier])
      expect(before.reasoningEffortOverride).toBe(tier === 'light' ? 'low' : null)
      // 纯函数：算完请求策略后再取一次，取值逐字段不变
      expect(tokenTier.resolvePolicy(tier)).toEqual(before)
    }
    // 四档仍是四条不同行为，没有被压成一条
    expect(new Set(TIERS.map((t) => tokenTier.resolvePolicy(t).readLines)).size).toBe(4)
  })

  it('normal / fast 下 settingsOf 逐字段一致（reasoning、contextWindow、maxTokens 不受影响）', async () => {
    const base = {
      temperature: 0.2,
      maxTokens: 2048,
      contextWindow: 64000,
      reasoningEffort: 'high',
      reasoning: { kind: 'effort' as const, levels: ['low', 'high'] }
    }
    const normal = models.makeEntry({ id: 'm1', model: 'test-model', speedMode: 'normal', settings: base })
    const fast = models.makeEntry({ id: 'm2', model: 'test-model', speedMode: 'fast', settings: base })
    const normalSettings = models.settingsOf(profileWith(normal), normal)
    const fastSettings = models.settingsOf(profileWith(fast), fast)
    expect(fastSettings).toEqual(normalSettings)
    expect(fastSettings.reasoning).toEqual(base.reasoning)
    expect(fastSettings.contextWindow).toBe(64000)
    expect(fastSettings.maxTokens).toBe(2048)
    expect(fastSettings.reasoningEffort).toBe('high')
  })

  it('模块引用扫描器有阳性对照：四种引用写法都能识别（守卫不是恒真）', () => {
    const sample = [
      "import { resolvePolicy } from './token-tier'",
      "import './token-tier'",
      "const m = await import('./token-tier')",
      "const r = require('./token-tier')"
    ].join('\n')
    expect(moduleSpecifiers(sample).filter((s) => s.includes('token-tier'))).toHaveLength(4)
  })

  it('request-policy 是零依赖纯模块：不引用 token-tier，也不碰网络 / Electron', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/shared/request-policy.ts'), 'utf8')
    // 零依赖是"完全正交"的结构性保证：静态、裸、动态、require 任一写法都会在这里露头
    expect(moduleSpecifiers(source)).toEqual([])
    // 省 token 的旋钮名一律不得出现在本文件（防未来偷偷读取别人的档位）
    expect(source).not.toMatch(/readLines|outputDiscipline|reasoningEffortOverride|keepRatioMax/)
    expect(/\bfetch\s*\(/.test(source)).toBe(false)
    expect(/\bXMLHttpRequest\b/.test(source)).toBe(false)
  })

  it('token-tier 源码不认识 speedMode / request-policy（正交是双向的）', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/shared/token-tier.ts'), 'utf8')
    expect(moduleSpecifiers(source).filter((s) => s.includes('request-policy'))).toEqual([])
    expect(source).not.toMatch(/speedMode|request-policy/)
  })
})

describe('S3-20A ⑩ 真实落盘跳：旧保存 / 单字段 patch / 整表保存与重读', () => {
  type DiskEntry = {
    speedMode?: string
    settings?: Record<string, unknown>
    metadata?: { contextWindow?: { user?: { value?: unknown } } }
  }
  type DiskProfile = { id: string; models: DiskEntry[] }

  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'jsl-s3-20a-'))
    vi.resetModules()
  })
  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true })
    fixture.root = ''
  })

  /** 直接读 models.json：证明字段真的落在盘上，而不是只活在内存/返回值里 */
  function diskProfiles(): DiskProfile[] {
    const path = join(fixture.root, 'models.json')
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).profiles as DiskProfile[]) : []
  }

  async function savedFastEntry(): Promise<{ id: string }> {
    const store = await import('@main/store/models')
    return store.saveEndpoint({
      name: '端点A',
      providerType: 'openai-compatible',
      baseURL: BASE_URL,
      models: [{ id: 'm1', model: 'test-model', speedMode: 'fast' }],
      apiKey: ''
    })
  }

  it('saveEndpoint 落盘合法 speedMode，模块重载后读盘仍在', async () => {
    const saved = await savedFastEntry()
    expect(saved.id).toBeTruthy()
    expect(diskProfiles()[0].models[0].speedMode).toBe('fast')
    // 模拟重启：清模块缓存后从同一份 models.json 重新读
    vi.resetModules()
    const store = await import('@main/store/models')
    expect(store.listProfiles().profiles[0].models[0].speedMode).toBe('fast')
  })

  it('saveSettings 旧入口白名单重建后仍保留 speedMode（删掉 store 那一行即红）', async () => {
    const store = await import('@main/store/models')
    await savedFastEntry()
    store.saveSettings({
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
      maxToolRounds: 200,
      inputModalities: ['text'],
      apiKey: ''
    })
    expect(diskProfiles()[0].models[0].speedMode).toBe('fast')
  })

  it('patchEntrySettings 只改 settings：speedMode 与顶层 metadata 原样保留', async () => {
    const store = await import('@main/store/models')
    const saved = store.saveEndpoint({
      name: '端点A',
      providerType: 'openai-compatible',
      baseURL: BASE_URL,
      models: [
        {
          id: 'm1',
          model: 'test-model',
          speedMode: 'fast',
          metadata: { contextWindow: { user: { value: 64000, observedAt: NOW } } }
        }
      ],
      apiKey: ''
    })
    store.patchEntrySettings(saved.id, 'm1', { contextWindow: 131072 })
    const entry = diskProfiles()[0].models[0]
    expect(entry.speedMode).toBe('fast')
    expect(entry.settings?.contextWindow).toBe(131072)
    expect(entry.metadata?.contextWindow?.user?.value).toBe(64000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S3-20D1：run 级请求策略快照冻结与运行链传播
// ═══════════════════════════════════════════════════════════════════════════

const D1_POLICY = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: 'priority',
  tierSupport: 'supported'
} as const

const D1_SETTINGS: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com/v1',
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
}

const d1TempDirs: string[] = []

afterEach(() => {
  for (const d of d1TempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeRunCtx(): AgentRuntimeContext {
  const base = mkdtempSync(join(tmpdir(), 'jsl-s3-20d1-'))
  d1TempDirs.push(base)
  const ws = join(base, 'ws')
  mkdirSync(ws, { recursive: true })
  return {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
}

/** 写一个最小可加载的子 Agent 定义（frontmatter + 正文）。`model` 故意与父 run 不同。 */
function writeAgentDef(ctx: AgentRuntimeContext, name: string, model = 'another-model'): AgentDefinition {
  mkdirSync(ctx.userAgentsDir, { recursive: true })
  const file = join(ctx.userAgentsDir, `${name}.md`)
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} 的职责\nmodel: ${model}\n---\n只做 ${name} 的活。`, 'utf8')
  return {
    name,
    description: `${name} 的职责`,
    model,
    systemPrompt: `只做 ${name} 的活。`,
    source: 'user',
    file
  }
}

async function runAgentOnce(
  extra: Record<string, unknown> = {},
  ctx: AgentRuntimeContext = makeRunCtx()
): Promise<Awaited<ReturnType<typeof import('@main/agent/runner').runAgent>>> {
  const { runAgent } = await import('@main/agent/runner')
  return await runAgent(ctx, {
    settings: D1_SETTINGS,
    apiKey: 'k',
    conversationId: 'conv-s3-20d1',
    history: [{ role: 'user', content: '干活' }],
    ...extra
  } as unknown as Parameters<typeof runAgent>[1])
}

function resetD1Spies(mode: 'real' | 'fake'): void {
  loopCtl.mode = mode
  loopCtl.captured.length = 0
  loopCtl.fakeHook = null
  loopCtl.jobs = []
  requestPolicyCalls.resolve = 0
}

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

/**
 * 只留代码行：剥掉块注释与**整行**注释。
 * 必须剥的理由：runner 的既有注释里就写着"不得 import electron-store"，
 * 直接全文匹配会把说明句误判成违规（假红）；而代码里的真实调用仍会留下。
 */
function codeOnly(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

describe('S3-20D1 ① 传入快照：主循环收到同一份内容', () => {
  beforeEach(() => resetD1Spies('fake'))

  it('调用方传入 requestPolicy 后，主循环 options 里拿到四字段原样内容', async () => {
    const input = { ...D1_POLICY }
    await runAgentOnce({ requestPolicy: input })

    expect(loopCtl.captured).toHaveLength(1)
    expect(loopCtl.captured[0]!.requestPolicy).toEqual(D1_POLICY)
    // 传入即复制：不是把调用方的对象原样递进去
    expect(loopCtl.captured[0]!.requestPolicy).not.toBe(input)
    expect(Object.isFrozen(loopCtl.captured[0]!.requestPolicy)).toBe(true)
  })
})

describe('S3-20D1 ② 主循环与子代理共享同一个冻结对象', () => {
  beforeEach(() => resetD1Spies('fake'))

  it('同一 run 的主循环与全部子代理收到同一个冻结引用（不按子代理模型另算）', async () => {
    const ctx = makeRunCtx()
    writeAgentDef(ctx, 'reviewer', 'cheap-model')
    writeAgentDef(ctx, 'tester', 'expensive-model')
    loopCtl.jobs = [
      { agent: 'reviewer', task: '复核实现' },
      { agent: 'tester', task: '跑测试' }
    ]

    await runAgentOnce({ requestPolicy: { ...D1_POLICY } }, ctx)

    // 1 个主循环 + 2 个子代理循环
    expect(loopCtl.captured).toHaveLength(3)
    const mainPolicy = loopCtl.captured[0]!.requestPolicy
    expect(mainPolicy).toEqual(D1_POLICY)
    expect(Object.isFrozen(mainPolicy)).toBe(true)
    for (const options of loopCtl.captured.slice(1)) {
      expect(options.requestPolicy).toBe(mainPolicy)
    }
    // 子代理的模型偏好各不相同，但策略一次都没被重新解析
    expect(requestPolicyCalls.resolve).toBe(0)
  })
})

describe('S3-20D1 ③ 快照与调用方对象解耦', () => {
  beforeEach(() => resetD1Spies('fake'))

  it('运行中与调用后修改输入对象，快照值都不变', async () => {
    const input: Record<string, unknown> = { ...D1_POLICY }
    let modeSeenInsideRun: unknown
    loopCtl.fakeHook = (options) => {
      // 模拟"运行中改设置"：若实现没复制，这一改会直接落到快照上
      input.mode = 'normal'
      input.maxLocalReadConcurrency = 1
      input.requestedServiceTier = null
      modeSeenInsideRun = (options.requestPolicy as Record<string, unknown>).mode
    }

    await runAgentOnce({ requestPolicy: input })

    const frozen = loopCtl.captured[0]!.requestPolicy as Record<string, unknown>
    expect(modeSeenInsideRun).toBe('fast')
    expect(frozen).toEqual(D1_POLICY)
    // 再改一次（调用已结束）同样无效
    input.mode = 'normal'
    expect(frozen.mode).toBe('fast')
  })
})

describe('S3-20D1 ④ 冻结快照不可写', () => {
  beforeEach(() => resetD1Spies('fake'))

  it('严格模式下写入冻结快照抛 TypeError，且原值不变', async () => {
    await runAgentOnce({ requestPolicy: { ...D1_POLICY } })
    const frozen = loopCtl.captured[0]!.requestPolicy as { mode: string }

    expect(Object.isFrozen(frozen)).toBe(true)
    expect(() => {
      frozen.mode = 'normal'
    }).toThrow(TypeError)
    expect(frozen.mode).toBe('fast')
  })
})

describe('S3-20D1 ⑤ 缺省策略：normal 保守默认，且只解析一次', () => {
  beforeEach(() => resetD1Spies('fake'))

  it('未传策略时主循环收到 normal 保守默认的冻结快照', async () => {
    await runAgentOnce()

    const policy = loopCtl.captured[0]!.requestPolicy as Record<string, unknown>
    expect(policy).toEqual({
      mode: 'normal',
      maxLocalReadConcurrency: 1,
      requestedServiceTier: null,
      tierSupport: 'unknown'
    })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(requestPolicyCalls.resolve).toBe(1)
  })
})

describe('S3-20D1 ⑥ runAgent 在检查点建立后、模型调用前取得策略', () => {
  beforeEach(() => resetD1Spies('fake'))

  it('先 begin 检查点，再读取调用方快照', async () => {
    const ctx = makeRunCtx()
    const order: string[] = []
    const begin = ctx.checkpoints.begin.bind(ctx.checkpoints)
    ctx.checkpoints.begin = (workspace, agent, conversationId) => {
      order.push('begin')
      return begin(workspace, agent, conversationId)
    }
    const input = {
      get mode() {
        order.push('policy')
        return 'fast' as const
      },
      maxLocalReadConcurrency: 2 as const,
      requestedServiceTier: 'priority',
      tierSupport: 'supported' as const
    }

    await runAgentOnce({ requestPolicy: input }, ctx)

    expect(order).toEqual(['begin', 'policy'])
  })
})

describe('S3-20D1 ⑦ 同一 run 的模型调用与工具轮不重新解析', () => {
  beforeEach(() => {
    resetD1Spies('real')
    providerSpies.openai.mockReset()
    providerSpies.anthropic.mockReset()
  })

  it('传入策略时整轮（两次模型调用 + 一次工具）解析次数为 0，且不下发服务档字段', async () => {
    const ctx = makeRunCtx()
    writeFileSync(join(ctx.getWorkspaceRoot(), 'a.txt'), '内容', 'utf8')
    providerSpies.openai.mockResolvedValueOnce({
      text: '先读文件',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }]
    })
    providerSpies.openai.mockResolvedValueOnce({ text: '完成', toolCalls: [] })

    const res = await runAgentOnce({ requestPolicy: { ...D1_POLICY } }, ctx)

    expect(providerSpies.openai).toHaveBeenCalledTimes(2)
    expect(requestPolicyCalls.resolve).toBe(0)
    expect(res.terminal).toEqual({ state: 'completed' })
    // 用量与终态不被策略影响：厂商没报 usage 就仍是 null（不是 0）
    expect(res.usage).toBeNull()
    // 不发送任何供应商服务档字段：模型设置与工具 schema 两处都不出现
    for (const call of providerSpies.openai.mock.calls) {
      const modelArg = call[0] as Record<string, unknown>
      for (const key of ['service_tier', 'serviceTier', 'requestedServiceTier', 'speedMode', 'mode']) {
        expect(key in modelArg).toBe(false)
      }
      expect(JSON.stringify(call[3] ?? [])).not.toMatch(/service_tier|requestedServiceTier|speedMode/)
    }
  })

  it('未传策略时整轮只解析一次（不是每轮模型调用各算一次）', async () => {
    const ctx = makeRunCtx()
    writeFileSync(join(ctx.getWorkspaceRoot(), 'a.txt'), '内容', 'utf8')
    providerSpies.openai.mockResolvedValueOnce({
      text: '先读文件',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }]
    })
    providerSpies.openai.mockResolvedValueOnce({ text: '完成', toolCalls: [] })

    await runAgentOnce({}, ctx)

    expect(providerSpies.openai).toHaveBeenCalledTimes(2)
    expect(requestPolicyCalls.resolve).toBe(1)
  })
})

describe('S3-20D1 ⑧ 运行链不读 UI 偏好、不各层重解析', () => {
  const CHAIN = ['src/main/agent/runner.ts', 'src/main/agent/loop.ts', 'src/main/agent/scheduler.ts']

  it('扫描器阳性对照：注释里的名字不算违规，代码里的调用一定被认出', () => {
    expect(codeOnly('// getUIPrefs()\nconst a = 1').includes('getUIPrefs')).toBe(false)
    expect(codeOnly('/* electron-store */\nconst a = 1').includes('electron-store')).toBe(false)
    expect(codeOnly('const b = getUIPrefs()').includes('getUIPrefs')).toBe(true)
  })

  it('runner / loop / scheduler 不引用 electron-store 或 ui-prefs，也不读用户偏好', () => {
    const forbiddenCall = /\b(getUIPrefs|loadUIPrefs|persistUIPrefs|setUIPref|resetUIPrefs)\s*\(/
    for (const rel of CHAIN) {
      const src = readSource(rel)
      const specifiers = moduleSpecifiers(src)
      expect(specifiers.some((s) => s === 'electron-store' || s.includes('ui-prefs'))).toBe(false)
      expect(forbiddenCall.test(codeOnly(src))).toBe(false)
    }
  })

  it('只有 runner 解析一次策略；loop / scheduler 的代码里不出现解析调用', () => {
    expect(codeOnly(readSource('src/main/agent/loop.ts'))).not.toContain('resolveRequestPolicy(')
    expect(codeOnly(readSource('src/main/agent/scheduler.ts'))).not.toContain('resolveRequestPolicy(')
    const runnerHits = codeOnly(readSource('src/main/agent/runner.ts')).match(/resolveRequestPolicy\(/g) ?? []
    expect(runnerHits).toHaveLength(1)
  })

  it('三处 options 都带 run 级不可变策略字段，且共享同一命名合同', () => {
    for (const rel of CHAIN) {
      const hits = readSource(rel).match(/requestPolicy\?: RunRequestPolicy/g) ?? []
      expect(hits).toHaveLength(1)
    }
    const shared = readSource('src/shared/agent.ts')
    expect(shared).toContain('export type RunRequestPolicy = Readonly<RequestPolicySnapshot>')
    expect(shared).toContain("from './request-policy'")
    // 不复制枚举与解析逻辑：共享类型层不得出现第二套速度档实现
    expect(codeOnly(shared)).not.toMatch(
      /\b(SPEED_MODES|SPEED_OVERRIDES|normalizeSpeedMode|resolveSpeedMode|resolveRequestPolicy)\b/
    )
  })
})

describe('S3-20D1 ⑨ 与省 token 四档保持完全独立', () => {
  it('token-tier 源码不认识请求策略，TokenPolicy 里没有速度字段', async () => {
    const src = readSource('src/shared/token-tier.ts')
    expect(src).not.toMatch(/requestPolicy|RequestPolicySnapshot|maxLocalReadConcurrency|requestedServiceTier|speedMode/i)

    const policy = tokenTier.resolvePolicy('balanced')
    for (const key of ['mode', 'maxLocalReadConcurrency', 'requestedServiceTier', 'tierSupport']) {
      expect(key in policy).toBe(false)
    }
  })

  it('请求策略快照也不夹带任何 token 档位参数', async () => {
    const snap = (await policy()).resolveRequestPolicy({ modelDefault: 'fast', tierSupport: 'supported' })
    for (const key of [
      'tier',
      'readLines',
      'outputDiscipline',
      'maxTokens',
      'keepRatioMax',
      'windowEnabled',
      'reasoningEffortOverride'
    ]) {
      expect(key in snap).toBe(false)
    }
    // 四档行为在策略存在时逐字段不变（固定值，不是自我比较）
    const tiers = ['rich', 'ultimate', 'balanced', 'light'] as const
    expect(tiers.map((t) => tokenTier.resolvePolicy(t).readLines)).toEqual([2000, 800, 200, 100])
    expect(tiers.map((t) => tokenTier.resolvePolicy(t).outputDiscipline)).toEqual([0, 0, 1, 2])
    expect(tokenTier.resolvePolicy('light').reasoningEffortOverride).toBe('low')
    expect(tokenTier.resolvePolicy('rich').windowEnabled).toBe(false)
  })
})

describe('S3-20D1 ⑩ 现有串行工具路径行为不变', () => {
  beforeEach(() => resetD1Spies('real'))

  it('同一轮两个工具仍按序串行执行，快照原样进入循环', async () => {
    const events: string[] = []
    const makeTool = (name: string) => ({
      schema: { name, description: name, parameters: {} },
      async execute(): Promise<string> {
        events.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, 5))
        events.push(`${name}:end`)
        return `${name} ok`
      }
    })
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        text: '一次两个',
        toolCalls: [
          { id: 't1', name: 'tool_a', arguments: '{}' },
          { id: 't2', name: 'tool_b', arguments: '{}' }
        ]
      })
      .mockResolvedValueOnce({ text: '完成', toolCalls: [] })
    const frozen = Object.freeze({ ...D1_POLICY })

    const { runAgentLoop } = await import('@main/agent/loop')
    const res = await runAgentLoop({
      systemPrompt: 's',
      history: [{ role: 'user', content: 'x' }],
      tools: [makeTool('tool_a'), makeTool('tool_b')],
      chat,
      requestPolicy: frozen
    })

    expect(events).toEqual(['tool_a:start', 'tool_a:end', 'tool_b:start', 'tool_b:end'])
    expect(res.output).toBe('完成')
    expect(loopCtl.captured.at(-1)?.requestPolicy).toBe(frozen)
  })
})

describe('S3-20D1 ⑪ 子代理失败 / 取消路径仍保留父快照', () => {
  beforeEach(() => resetD1Spies('real'))

  const def: AgentDefinition = {
    name: 'boom',
    description: '会失败的子代理',
    model: 'another-model',
    systemPrompt: '只负责失败。',
    source: 'user',
    file: '/virtual/boom.md'
  }

  it('模型通道抛错后，子代理循环收到的仍是父 run 的冻结对象', async () => {
    const { runSubagents } = await import('@main/agent/scheduler')
    const frozen = Object.freeze({ ...D1_POLICY })

    const results = await runSubagents({
      definitions: [def],
      task: '干活',
      requestPolicy: frozen,
      toolsFor: () => [],
      chatFactory: () => async () => {
        throw new Error('模型通道炸了')
      },
      maxConcurrency: 1
    })

    expect(results[0]?.ok).toBe(false)
    expect(loopCtl.captured.at(-1)?.requestPolicy).toBe(frozen)
    expect(requestPolicyCalls.resolve).toBe(0)
  })

  it('取消路径同样不重新解析，父快照保持不变', async () => {
    const { runSubagents } = await import('@main/agent/scheduler')
    const frozen = Object.freeze({ ...D1_POLICY })
    const controller = new AbortController()

    await expect(
      runSubagents({
        definitions: [def],
        task: '干活',
        requestPolicy: frozen,
        signal: controller.signal,
        toolsFor: () => [],
        chatFactory: () => async () => {
          controller.abort()
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        },
        maxConcurrency: 1
      })
    ).rejects.toBeTruthy()

    expect(loopCtl.captured.at(-1)?.requestPolicy).toBe(frozen)
    expect(requestPolicyCalls.resolve).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S3-20D2：入口侧策略装配（主聊天与一次性任务共用同一条构造路径）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 本阶段服务档支持状态没有可靠字段来源 ⇒ 一律 unknown。
 * 因此即使 speedMode=fast，requestedServiceTier 也必须是 null（不得猜 supported）。
 */
const D2_NORMAL = {
  mode: 'normal',
  maxLocalReadConcurrency: 1,
  requestedServiceTier: null,
  tierSupport: 'unknown'
} as const

const D2_FAST = {
  mode: 'fast',
  maxLocalReadConcurrency: 2,
  requestedServiceTier: null,
  tierSupport: 'unknown'
} as const

const D2_KEYS = ['maxLocalReadConcurrency', 'mode', 'requestedServiceTier', 'tierSupport']

let d2Sequence = 0

function d2Ok(): Record<string, unknown> {
  return {
    ok: true,
    output: '完成',
    rounds: 1,
    stopReason: 'completed',
    agent: '内核默认',
    changedFiles: 0,
    usage: null,
    usageComplete: true,
    terminal: { state: 'completed' }
  }
}

function d2Event(id: number = ++d2Sequence) {
  return {
    sender: {
      id,
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
      send: () => {}
    }
  }
}

interface D2Harness {
  models: typeof import('@main/store/models')
  uiPrefs: typeof import('@main/store/ui-prefs')
  IPC: typeof import('@shared/ipc').IPC
}

/** 真 IPC 注册：只把 Electron 与网络出口换成替身，内部装配全部走真实实现。 */
async function setupD2(): Promise<D2Harness> {
  const { registerIpcHandlers } = await import('@main/ipc')
  const { createAgentContext } = await import('@main/agent/runner')
  const { createMemoryStore } = await import('@main/store/memory-store')
  const { createPlaybookStore } = await import('@main/store/playbook-store')
  const memory = createMemoryStore(join(fixture.root, `d2-memory-${++d2Sequence}`), undefined, {
    ftsPath: null,
    modelWritesNeedApproval: () => false
  })
  const agent = createAgentContext({
    getWorkspaceRoot: () => fixture.root,
    builtinAgentsDir: join(fixture.root, 'builtin'),
    userAgentsDir: join(fixture.root, 'agents'),
    checkpointDir: join(fixture.root, 'checkpoints'),
    memory: { repo: memory, enabled: () => true }
  })
  d2Ctl.handlers.clear()
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
    execEventSink: { append: () => {} },
    network: {} as never
  })
  return {
    models: await import('@main/store/models'),
    uiPrefs: await import('@main/store/ui-prefs'),
    IPC: (await import('@shared/ipc')).IPC
  }
}

/** 真实落盘：把模型默认档写进当前端点条目（非法值也照写，由读盘路径负责丢弃）。 */
async function seedModel(speedMode?: string): Promise<{ id: string }> {
  const models = await import('@main/store/models')
  const settings = await import('@main/store/settings')
  const entry = {
    id: 'm1',
    model: 'test-model',
    ...(speedMode !== undefined ? { speedMode } : {})
  } as unknown as models.ModelEntry
  const profile = models.saveEndpoint({
    name: '端点A',
    providerType: 'openai-compatible',
    baseURL: BASE_URL,
    models: [entry],
    apiKey: ''
  })
  // 入口的 hasApiKey / getDecryptedApiKey 走真实 store + 内存 safeStorage，只差这一把 Key
  settings.setProfileKey(profile.id, 'd2-test-key')
  return { id: profile.id }
}

/** 模拟"运行中切换模型"：整份端点更新，只改默认速度档。 */
async function replaceModel(id: string, speedMode: string): Promise<void> {
  const models = await import('@main/store/models')
  models.saveEndpoint({
    id,
    name: '端点A',
    providerType: 'openai-compatible',
    baseURL: BASE_URL,
    models: [{ id: 'm1', model: 'test-model', speedMode } as unknown as models.ModelEntry],
    apiKey: ''
  })
}

async function setOverrides(map: Record<string, string>): Promise<void> {
  const ui = await import('@main/store/ui-prefs')
  ui.setUIPref({
    conversationSpeedOverrides: map as unknown as Record<string, 'inherit' | 'normal' | 'fast'>
  })
}

async function runChat(conversationId: string): Promise<Record<string, unknown>> {
  const { IPC } = await import('@shared/ipc')
  await d2Ctl.handlers.get(IPC.chatSend)!(d2Event(), {
    conversationId,
    messages: [{ role: 'user', content: '干活' }]
  })
  return d2Ctl.calls.at(-1)!
}

async function runOneOff(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { IPC } = await import('@shared/ipc')
  await d2Ctl.handlers.get(IPC.agentRun)!(d2Event(), input)
  return d2Ctl.calls.at(-1)!
}

function snapshotOf(call: Record<string, unknown>): Record<string, unknown> {
  expect(call.requestPolicy, 'runAgent 必须显式收到入口解析的快照').toBeTypeOf('object')
  return call.requestPolicy as Record<string, unknown>
}

function resetD2(): void {
  fixture.root = mkdtempSync(join(tmpdir(), 'jsl-s3-20d2-'))
  vi.resetModules()
  d2Ctl.handlers.clear()
  d2Ctl.calls.length = 0
  d2Ctl.mode = 'fake'
  d2Ctl.impl = async () => d2Ok()
  requestPolicyCalls.resolve = 0
}

function cleanupD2(): void {
  d2Ctl.mode = 'real'
  d2Ctl.impl = null
  d2Ctl.handlers.clear()
  d2Ctl.calls.length = 0
  rmSync(fixture.root, { recursive: true, force: true })
  fixture.root = ''
}

describe('S3-20D2 ① 模型默认 + 会话覆盖 → 入口快照', () => {
  beforeEach(resetD2)
  afterEach(cleanupD2)

  it('模型 normal + 会话 inherit → normal', async () => {
    const { IPC } = await setupD2()
    await seedModel('normal')
    await setOverrides({ 'd2-normal': 'inherit' })

    expect(IPC.chatSend).toBeTypeOf('string')
    expect(snapshotOf(await runChat('d2-normal'))).toEqual(D2_NORMAL)
  })

  it('模型 fast + 会话 inherit → fast（服务档仍 unknown，不请求非默认档）', async () => {
    await setupD2()
    await seedModel('fast')
    await setOverrides({ 'd2-fast': 'inherit' })

    expect(snapshotOf(await runChat('d2-fast'))).toEqual(D2_FAST)
  })

  it('模型 fast + 会话 normal → normal（会话覆盖压过模型默认）', async () => {
    await setupD2()
    await seedModel('fast')
    await setOverrides({ 'd2-override-normal': 'normal' })

    expect(snapshotOf(await runChat('d2-override-normal'))).toEqual(D2_NORMAL)
  })

  it('模型 normal + 会话 fast → fast', async () => {
    await setupD2()
    await seedModel('normal')
    await setOverrides({ 'd2-override-fast': 'fast' })

    expect(snapshotOf(await runChat('d2-override-fast'))).toEqual(D2_FAST)
  })
})

describe('S3-20D2 ② 会话隔离与非法值回落', () => {
  beforeEach(resetD2)
  afterEach(cleanupD2)

  it('两会话覆盖互不影响，未覆盖会话回到模型默认', async () => {
    await setupD2()
    await seedModel('normal')
    await setOverrides({ 'd2-a': 'fast', 'd2-b': 'normal' })

    expect(snapshotOf(await runChat('d2-a'))).toEqual(D2_FAST)
    expect(snapshotOf(await runChat('d2-b'))).toEqual(D2_NORMAL)
    expect(snapshotOf(await runChat('d2-c'))).toEqual(D2_NORMAL)
  })

  it('非法模型档与非法覆盖都安全回落 normal，不抛错也不冒充 fast', async () => {
    const { models } = await setupD2()
    await seedModel('turbo')
    await setOverrides({ 'd2-bad': 'warp' })

    // 读盘路径先丢弃非法档位（条目保留），入口再解析成保守默认
    expect(models.getActiveEntry()?.entry.speedMode).toBeUndefined()
    expect(snapshotOf(await runChat('d2-bad'))).toEqual(D2_NORMAL)
  })
})

describe('S3-20D2 ③ 一次性任务：没有真实会话 id 不读任意覆盖', () => {
  beforeEach(resetD2)
  afterEach(cleanupD2)

  it('占位 owner（agent-task）的覆盖不得被一次性任务借用', async () => {
    await setupD2()
    await seedModel('fast')
    // 故意给占位 owner 与一个真实会话都写 normal：只有真实 id 才允许命中
    await setOverrides({ 'agent-task': 'normal', 'd2-real': 'normal' })

    expect(snapshotOf(await runOneOff({ task: '干活' }))).toEqual(D2_FAST)
    expect(snapshotOf(await runOneOff({ task: '干活', conversationId: 'd2-real' }))).toEqual(D2_NORMAL)
  })
})

describe('S3-20D2 ④ run 起点定格：运行中改设置只影响下一次 run', () => {
  beforeEach(resetD2)
  afterEach(cleanupD2)

  it('run 启动后改模型与覆盖，已启动调用的快照不变；下一次 run 才读新值', async () => {
    await setupD2()
    const { id } = await seedModel('normal')
    await setOverrides({ 'd2-live': 'inherit' })

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const startedAt = new Promise<void>((resolve) => {
      started = resolve
    })
    d2Ctl.impl = async () => {
      started()
      await gate
      return d2Ok()
    }

    const running = runChat('d2-live')
    await startedAt
    const captured = snapshotOf(d2Ctl.calls[0]!)
    expect(captured).toEqual(D2_NORMAL)

    // 运行中切换模型默认与会话覆盖 —— 本轮快照必须一个字节都不变
    await replaceModel(id, 'fast')
    await setOverrides({ 'd2-live': 'fast' })
    expect(captured).toEqual(D2_NORMAL)
    expect(requestPolicyCalls.resolve).toBe(1)

    release()
    await running

    // 下一次 run 才读到新值
    expect(snapshotOf(await runChat('d2-live'))).toEqual(D2_FAST)
    expect(requestPolicyCalls.resolve).toBe(2)
  })
})

describe('S3-20D2 ⑤ 两个入口都真实传给 runAgent', () => {
  beforeEach(resetD2)
  afterEach(cleanupD2)

  it('主聊天与一次性任务都显式带 requestPolicy，且不写进历史消息', async () => {
    await setupD2()
    await seedModel('fast')

    const chatCall = await runChat('d2-pass-chat')
    const taskCall = await runOneOff({ task: '干活' })

    for (const call of [chatCall, taskCall]) {
      expect(Object.keys(snapshotOf(call)).sort()).toEqual(D2_KEYS)
      // 策略只走 run 级参数：不混进会话历史 / 工具参数
      expect(JSON.stringify(call.history)).not.toMatch(/requestPolicy|maxLocalReadConcurrency|requestedServiceTier/)
    }
    expect(snapshotOf(chatCall)).toEqual(D2_FAST)
    expect(snapshotOf(taskCall)).toEqual(D2_FAST)
  })

  it('失败与取消路径都只用同一个快照：不重试、不补发、不重复解析', async () => {
    await setupD2()
    await seedModel('fast')

    d2Ctl.impl = async () => {
      throw new Error('上游炸了')
    }
    await runChat('d2-fail')
    expect(d2Ctl.calls).toHaveLength(1)
    expect(requestPolicyCalls.resolve).toBe(1)
    expect(snapshotOf(d2Ctl.calls[0]!)).toEqual(D2_FAST)

    d2Ctl.impl = (args) =>
      new Promise((_resolve, reject) => {
        const signal = args.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('已停止', 'AbortError')), {
          once: true
        })
      })
    const running = runChat('d2-cancel')
    await vi.waitFor(() => expect(d2Ctl.calls).toHaveLength(2))
    const stop = d2Ctl.handlers.get((await import('@shared/ipc')).IPC.chatAbort)!
    await stop({}, 'd2-cancel')
    await running

    expect(d2Ctl.calls).toHaveLength(2)
    expect(requestPolicyCalls.resolve).toBe(2)
    expect(snapshotOf(d2Ctl.calls[1]!)).toEqual(D2_FAST)
  })

  it('轮数截断同样只解析一次，不补发、不重算', async () => {
    await setupD2()
    await seedModel('fast')
    d2Ctl.impl = async () => ({ ...d2Ok(), stopReason: 'max-rounds' })

    expect((await runChat('d2-truncated')).requestPolicy).toEqual(D2_FAST)
    expect(d2Ctl.calls).toHaveLength(1)
    expect(requestPolicyCalls.resolve).toBe(1)
  })
})

describe('S3-20D2 ⑥ 重启不自动启动 run', () => {
  beforeEach(resetD2)
  afterEach(cleanupD2)

  it('注册入口不触发任何 run，也不解析策略', async () => {
    const { IPC } = await setupD2()
    // 再注册一次 = 模拟进程重启后的组合根装配
    await setupD2()

    expect(d2Ctl.calls).toHaveLength(0)
    expect(requestPolicyCalls.resolve).toBe(0)
    expect(d2Ctl.handlers.get(IPC.chatSend)).toBeTypeOf('function')
    expect(d2Ctl.handlers.get(IPC.agentRun)).toBeTypeOf('function')
  })
})

describe('S3-20D2 ⑦ 源码守卫：入口只读一次、不在循环内重复取值', () => {
  function entryHelperBody(code: string): string {
    const marker = 'function entryRequestPolicy('
    const start = code.indexOf(marker)
    expect(start, '入口策略构造器必须存在且唯一').toBeGreaterThanOrEqual(0)
    const open = code.indexOf('{', start)
    let depth = 0
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1
      else if (code[i] === '}') {
        depth -= 1
        if (depth === 0) return code.slice(start, i + 1)
      }
    }
    throw new Error('构造器花括号不配平，源码守卫无法取样')
  }

  it('唯一构造器内部：模型默认一次、覆盖表一次、解析一次，无循环', () => {
    const body = entryHelperBody(codeOnly(readSource('src/main/ipc.ts')))
    expect(body.match(/getActiveEntry\(/g) ?? []).toHaveLength(1)
    expect(body.match(/getUIPrefs\(/g) ?? []).toHaveLength(1)
    expect(body.match(/resolveRequestPolicy\(/g) ?? []).toHaveLength(1)
    expect(body).not.toMatch(/\b(for|while|do)\s*\(|\.map\(|\.forEach\(|\.reduce\(/)
    // 与省 token 四档完全正交
    expect(body).not.toMatch(/token-tier|resolvePolicy|getTokenTier|TokenPolicy|tokenSaverTier/)
  })

  it('两个 run 起点各自显式传入同一构造器的结果，且策略不进消息/事件', () => {
    const code = codeOnly(readSource('src/main/ipc.ts'))
    expect(code.match(/runAgent\(deps\.agent,/g) ?? []).toHaveLength(2)
    expect(code.match(/requestPolicy: entryRequestPolicy\(/g) ?? []).toHaveLength(2)
    // 解析出口全文件只有一处
    expect(code.match(/resolveRequestPolicy\(/g) ?? []).toHaveLength(1)
    // 小写 requestPolicy 字段只出现在两处 run 起点（构造器名是 entryRequestPolicy，不算）
    expect(code.match(/\brequestPolicy\b/g) ?? []).toHaveLength(2)
  })
})

