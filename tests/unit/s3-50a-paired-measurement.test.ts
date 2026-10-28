// S89-01 配对测量：同一任务仅切换默认并行 / 收紧串行，用屏障证明峰值，不用固定毫秒阈值。
// 真实 runAgentLoop + 真实 file tools + 真实 trustedRead.stage/execute；本地假 provider 不发外网。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileTools } from '@main/agent/tools/file-tools'
import { planTrustedReadBatch, runAgentLoop } from '@main/agent/loop'
import { createWorkspaceWriter } from '@main/workspace-write'
import { peekWatchdogLeases, startWatchdog, stopWatchdog } from '@main/watchdog'
import type { AgentChatResult, AgentMessage, AgentTool, StagedToolRead, ToolCall } from '@shared/agent'

const PARALLEL_POLICY = {
  maxLocalReadConcurrency: 2 as const
}
const SERIAL_POLICY = {
  maxLocalReadConcurrency: 1 as const
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时')
    await new Promise((r) => setTimeout(r, 1))
  }
}

const readCall = (id: string, path: string): ToolCall => ({
  id,
  name: 'read_file',
  arguments: JSON.stringify({ path })
})

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'jsl-50a-'))
}

interface Sample {
  pair: number
  mode: 'serial' | 'parallel'
  peak: number
  modelCalls: number
  terminal: string
  toolContents: string[]
  wallMs: number
  providerMs: number
  localMs: number
  readMs: number
}

interface PairResult {
  normal: Sample
  fast: Sample
}

const roots: string[] = []
function writeFile(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text, 'utf8')
}

async function runOne(
  mode: 'serial' | 'parallel',
  pair: number,
  root: string,
  calls: ToolCall[],
  barrier: 'parallel' | 'serial' = mode === 'parallel' ? 'parallel' : 'serial'
): Promise<{ sample: Sample; result: { stopReason: string } }> {
  const tools: AgentTool[] = createFileTools(createWorkspaceWriter(root, { trash: async () => {} }))
  const read = tools[0]!
  const cap = read.trustedRead!
  const gates: Array<Deferred<void>> = []
  const started: string[] = []
  let active = 0
  let peak = 0
  let readMs = 0
  let providerMs = 0
  let chatCalls = 0
  let seen: AgentMessage[] = []

  const hold = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const gate = deferred<void>()
    gates.push(gate)
    started.push(label)
    active += 1
    peak = Math.max(peak, active)
    await gate.promise
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      active -= 1
      readMs += performance.now() - t0
    }
  }

  const originalExecute = read.execute.bind(read)
  const originalStage = cap.stage.bind(cap)
  vi.spyOn(read, 'execute').mockImplementation((args) => hold('execute', () => originalExecute(args)))
  vi.spyOn(cap, 'stage').mockImplementation((args, signal, canStart) =>
    hold('stage', () => originalStage(args, signal, canStart))
  )

  const startedAt = performance.now()
  const loop = runAgentLoop({
    systemPrompt: '',
    history: [],
    tools,
    maxRounds: 3,
    requestPolicy: mode === 'parallel' ? PARALLEL_POLICY : SERIAL_POLICY,
    chat: async (messages): Promise<AgentChatResult> => {
      chatCalls += 1
      const t0 = performance.now()
      try {
        // 供应商耗时与本地文件耗时分开计；两种模式同一个假延迟。
        await new Promise((r) => setTimeout(r, 2))
        if (chatCalls === 1) return { text: null, toolCalls: calls }
        seen = messages
        return { text: 'done', toolCalls: [] }
      } finally {
        providerMs += performance.now() - t0
      }
    }
  })

  // 屏障：串行逐项释放，默认并行合格批同时释放两项；释放前先记录峰值。
  if (barrier === 'serial') {
    await waitUntil(() => started.length === 1)
    expect(peak, '串行策略启动第一项时峰值应为 1').toBe(1)
    expect(gates[0], '串行策略第一项应持有闸门').toBeTruthy()
    gates[0]!.resolve()
    await waitUntil(() => started.length === 2)
    gates[1]!.resolve()
  } else {
    await waitUntil(() => started.length === 2)
    expect(peak, '默认并行合格批应同时启动两项，峰值 2').toBe(2)
    gates[0]!.resolve()
    gates[1]!.resolve()
  }

  const result = await loop
  const wallMs = performance.now() - startedAt
  const toolContents = seen
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content ?? ''))
  return {
    sample: {
      pair,
      mode,
      peak,
      modelCalls: chatCalls,
      terminal: result.stopReason,
      toolContents,
      wallMs,
      providerMs,
      localMs: Math.max(0, wallMs - providerMs),
      readMs
    },
    result
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

beforeEach(() => {
  startWatchdog({ intervalMs: 1000, thresholdMs: 1000, heartbeatMs: 0 })
})
afterEach(() => {
  stopWatchdog()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('S89-01 50 对默认并行测量（屏障证据）', () => {
  it('默认并行峰值 2 / 收紧串行峰值 1；结果、读版本、终态、模型调用次数相同', async () => {
    const pairs: PairResult[] = []
    for (let i = 0; i < 50; i += 1) {
      const root = tempRoot()
      roots.push(root)
      writeFile(root, 'a.txt', `alpha-${i}`)
      writeFile(root, 'b.txt', `beta-${i}`)
      const calls = [readCall('a', 'a.txt'), readCall('b', 'b.txt')]
      const normal = await runOne('serial', i, root, calls)
      const fast = await runOne('parallel', i, root, calls)
      expect(normal.sample.peak, `第 ${i + 1} 对串行峰值`).toBe(1)
      expect(fast.sample.peak, `第 ${i + 1} 对默认并行峰值`).toBe(2)
      expect(fast.sample.modelCalls, `第 ${i + 1} 对模型调用次数`).toBe(normal.sample.modelCalls)
      expect(fast.sample.terminal, `第 ${i + 1} 对终态`).toBe(normal.sample.terminal)
      expect(fast.sample.toolContents, `第 ${i + 1} 对读取结果/版本`).toEqual(normal.sample.toolContents)
      pairs.push({ normal: normal.sample, fast: fast.sample })
    }

    const all = pairs.flatMap((p) => [p.normal, p.fast])
    const summary = {
      schema: 's3r4-e350a/paired-measure@1',
      pairs: pairs.length,
      samples: all.length,
      environment: {
        platform: process.platform,
        node: process.version,
        vitest: true,
        source: 'runAgentLoop + createFileTools + trustedRead'
      },
      normal: {
        peak: [...new Set(pairs.map((p) => p.normal.peak))],
        wallMedianMs: median(pairs.map((p) => p.normal.wallMs)),
        wallP95Ms: percentile(pairs.map((p) => p.normal.wallMs), 95),
        localMedianMs: median(pairs.map((p) => p.normal.localMs)),
        localP95Ms: percentile(pairs.map((p) => p.normal.localMs), 95),
        providerMedianMs: median(pairs.map((p) => p.normal.providerMs)),
        providerP95Ms: percentile(pairs.map((p) => p.normal.providerMs), 95),
        readMedianMs: median(pairs.map((p) => p.normal.readMs)),
        readP95Ms: percentile(pairs.map((p) => p.normal.readMs), 95)
      },
      fast: {
        peak: [...new Set(pairs.map((p) => p.fast.peak))],
        wallMedianMs: median(pairs.map((p) => p.fast.wallMs)),
        wallP95Ms: percentile(pairs.map((p) => p.fast.wallMs), 95),
        localMedianMs: median(pairs.map((p) => p.fast.localMs)),
        localP95Ms: percentile(pairs.map((p) => p.fast.localMs), 95),
        providerMedianMs: median(pairs.map((p) => p.fast.providerMs)),
        providerP95Ms: percentile(pairs.map((p) => p.fast.providerMs), 95),
        readMedianMs: median(pairs.map((p) => p.fast.readMs)),
        readP95Ms: percentile(pairs.map((p) => p.fast.readMs), 95)
      },
      invariant: {
        modelCallsEqual: pairs.every((p) => p.normal.modelCalls === p.fast.modelCalls),
        terminalEqual: pairs.every((p) => p.normal.terminal === p.fast.terminal),
        toolContentsEqual: pairs.every(
          (p) => JSON.stringify(p.normal.toolContents) === JSON.stringify(p.fast.toolContents)
        )
      },
      pairsRaw: pairs
    }

    const out = process.env.S3_50A_OUT
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(summary, null, 1) + '\n', 'utf8')
    }
    expect(summary.pairs).toBe(50)
    expect(summary.invariant.modelCallsEqual).toBe(true)
    expect(summary.invariant.terminalEqual).toBe(true)
    expect(summary.invariant.toolContentsEqual).toBe(true)
    expect(peekWatchdogLeases()).toHaveLength(0)
  }, 60_000)
})

describe('S89-01 不合格批仍串行', () => {
  it('同文件、大小写/junction 别名、混合工具、MCP 冒名一律 plan=null', async () => {
    const root = tempRoot()
    roots.push(root)
    writeFile(root, 'a.txt', 'alpha')
    writeFile(root, 'Case.txt', 'case')
    mkdirSync(join(root, 'sub'))
    writeFile(root, 'sub/f.txt', 'junction')
    const { mkdirSync: mk } = await import('node:fs')
    mk(join(root, 'sub'), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    try {
      symlinkSync(join(root, 'sub'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      /* 已存在则复用 */
    }
    const tools = createFileTools(createWorkspaceWriter(root, { trash: async () => {} }))
    const map = new Map(tools.map((t) => [t.schema.name, t]))
    const fake: AgentTool = {
      schema: { name: 'read_file', description: '', parameters: {} },
      execute: async () => 'fake',
      trustedRead: {
        canonicalKey: async (args) => `fake:${String(args['path'])}`,
        stage: async () => ({ text: 'fake', ok: true, receipt: null, key: null }),
        commit: () => 'fake',
        discard: () => {}
      }
    }
    const cases: Array<{ name: string; calls: ToolCall[]; map?: Map<string, AgentTool> }> = [
      { name: 'same-file', calls: [readCall('s1', 'a.txt'), readCall('s2', 'a.txt')] },
      { name: 'case-alias', calls: [readCall('c1', 'Case.txt'), readCall('c2', 'case.txt')] },
      { name: 'junction-alias', calls: [readCall('j1', 'sub/f.txt'), readCall('j2', 'link/f.txt')] },
      {
        name: 'mixed-tools',
        calls: [
          readCall('m1', 'a.txt'),
          { id: 'm2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'x' }) }
        ]
      },
      { name: 'mcp-impersonation', calls: [readCall('f1', 'a.txt'), readCall('f2', 'b.txt')], map: new Map([['read_file', fake]]) }
    ]
    const results: Array<{ name: string; plan: unknown }> = []
    for (const item of cases) {
      const plan = await planTrustedReadBatch(item.calls, item.map ?? map)
      expect(plan, `${item.name} 不得进入批路径`).toBeNull()
      // 记录**实际返回值**（null 或真实结构），不手写 null，证据才能自证。
      results.push({ name: item.name, plan: plan === null ? null : JSON.parse(JSON.stringify(plan)) })
    }
    const out = process.env.S3_50A_INELIGIBLE_OUT
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify({ schema: 's3r4-e350a/ineligible@1', cases: results }, null, 1) + '\n', 'utf8')
    }
    expect(results).toHaveLength(5)
  }, 20_000)

  it('同文件批按真实 loop 回退串行：峰值 1、模型调用次数不变', async () => {
    const root = tempRoot()
    roots.push(root)
    writeFile(root, 'a.txt', 'alpha')
    const { sample } = await runOne(
      'parallel',
      0,
      root,
      [readCall('s1', 'a.txt'), readCall('s2', 'a.txt')],
      'serial'
    )
    expect(sample.peak, '不合格批必须回退串行').toBe(1)
    expect(sample.modelCalls).toBe(2)
    expect(sample.terminal).toBe('completed')
    const out = process.env.S3_50A_INELIGIBLE_OUT
    if (out) {
      const payload = existsSync(out)
        ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>)
        : { schema: 's3r4-e350a/ineligible@1', cases: [] }
      payload['serialFallback'] = {
        case: 'same-file',
        peak: sample.peak,
        modelCalls: sample.modelCalls,
        terminal: sample.terminal,
        toolContents: sample.toolContents
      }
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(payload, null, 1) + '\n', 'utf8')
    }
  }, 20_000)
})
