// L1 场景回归测试的**装置**（plan25 S2 · D-074/D-075/D-076）。
// 与 tests/unit 的分工：**单测测函数，场景测故事** —— 每个场景是一段用户故事，
// 跨模块走真实链路（remember 工具 / 通路 B / 反思器 / 审批 / 遗忘 / recall），
// 断言**端态**（落盘文件与注入块的最终形态），不断言中间函数怎么被调用（D-076）。
// 走内存 backend：每个场景从干净状态开始（Anthropic：不共享状态，避免关联性失败）。
// CI 零模型：反思的 chat 用桩（返回场景写死的 JSON）—— L1 是回归测试，不是 eval；
// plan19 承诺的「真模型 eval」由 L2（scripts/run-evals.mjs）兑现。

import type { MemoryStats, MemoryClass, MemoryIndex } from '@shared/memory'
import { parseArchivedFileName } from '@shared/memory'
import type { MemoryEvent } from '@main/memory/events'
import { parseEventLine } from '@main/memory/events'
import { createMemoryRepo, serializeMemory } from '@main/memory/memory-core'
import { createReflectionRunner } from '@main/memory/reflection'
import { createMemoryTools } from '@main/agent/tools/memory-tools'
import { composeMemoryBlock } from '@main/memory/inject'
import { createArchiveMock } from '../helpers/memory-archive-mock'

const ROOT = '/mem/notes'
const ARCH = '/mem/archived'
const FIXED = new Date('2026-09-15T01:00:00.000Z')

/** 场景 seed 的一条初始记忆（serializeMemory 的便捷封装 —— 与落盘格式同源） */
export function seedEntry(opts: {
  name: string
  cls: MemoryClass
  body: string
  origin?: 'user' | 'model' | 'reflection'
  updatedAt?: string
  description?: string
}): Record<string, string> {
  const ts = opts.updatedAt ?? '2026-09-14T00:00:00.000Z'
  return {
    [`${ROOT}/${opts.name}.md`]: serializeMemory({
      name: opts.name,
      description: opts.description ?? `${opts.name} 的摘要`,
      class: opts.cls,
      origin: opts.origin ?? 'user',
      evidence: null,
      createdAt: ts,
      updatedAt: ts,
      body: opts.body
    })
  }
}

// ── 场景描述 ──────────────────────────────────────────────────────────────

export type Level = 'simple' | 'medium' | 'complex'

/** 反思桩 chat 返回的一条候选（就是模型会输出的 JSON 元素） */
export interface ReflectCandidate {
  name: string
  description: string
  class: string
  body: string
}

/** 一步动作。⚠️ 只描述"发生了什么"，不描述"怎么调"——装配在 harness 里 */
export type Step =
  | {
      act: 'remember'
      name: string
      description: string
      cls: Exclude<MemoryClass, 'profile'>
      body: string
      /** 用户原话（纠正链的因果链判定用） */
      lastUser?: string
    }
  | {
      act: 'capture'
      name: string
      description: string
      cls: Exclude<MemoryClass, 'profile'>
      body: string
      turnIndex?: number
    }
  | { act: 'reflect'; candidates: ReflectCandidate[] }
  | { act: 'approveAll' }
  | { act: 'reject'; name: string }
  | { act: 'recall'; name: string }
  | { act: 'flag'; name: string }

/** 端态断言的取景器。全部只读——断言的是**故事讲完后的世界** */
export interface World {
  /** 注入索引视图（每次调用现取） */
  view: () => MemoryIndex
  /** 注入块（composeMemoryBlock 的产出） */
  block: () => string | null
  /** 事件流统计 */
  stats: () => MemoryStats
  /** 事件原始行（name 按序）——少数场景要数事件 */
  events: () => string[]
  /** notes/ 里某 slug 的文件全文（端态落盘检查用） */
  fileText: (slug: string) => string | null
  /** 归档区（plan53 片 1）：遗忘不再硬删，端态要能证明"正文还在、还能回来" */
  archived: () => Array<{ slug: string; text: string | null }>
  /** 载入警告（手改防线场景用） */
  warnings: () => string[]
}

export interface Scenario {
  id: string
  desc: string
  level: Level
  /** 初始盘面（slug → 文件全文）；缺省 = 空库 */
  seed?: Record<string, string>
  steps: Step[]
  expect: (w: World) => void
}

// ── 世界构造与动作执行 ─────────────────────────────────────────────────────

function makeBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const candidates = new Map<string, string>()
  const events: string[] = []
  const arch = createArchiveMock({
    files,
    notesRoot: ROOT,
    archRoot: ARCH,
    fallback: (f) => candidates.get(f) ?? null
  })
  const backend = {
    events,
    listFiles: () => [...files.keys()].sort(),
    candidatePathFor: (slug: string) => `${ROOT}/candidates/${slug}.md`,
    listCandidates: () => [...candidates.keys()].sort(),
    write: (f: string, t: string) => {
      if (f.startsWith(`${ROOT}/candidates/`)) candidates.set(f, t)
      else files.set(f, t)
    },
    remove: (f: string) => (f.startsWith(`${ROOT}/candidates/`) ? candidates.delete(f) : files.delete(f)),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line),
    ...arch.backend
  }
  return backend
}

/** 跑一个场景：逐步执行动作，返回端态取景器 */
export async function runScenario(scenario: Scenario): Promise<World> {
  const backend = makeBackend(scenario.seed ?? {})
  const warnings: string[] = []
  const repo = createMemoryRepo(backend, {
    now: () => FIXED,
    onWarn: (m) => warnings.push(m),
    conversationId: () => 'conv-1'
  })

  const tools = createMemoryTools({
    repo,
    conversationId: () => 'conv-1',
    turnIndex: () => 1,
    lastUserMessage: () => currentLastUser,
    confirm: async () => false // 场景不点确认桥——确认档行为在单测层已钉
  })
  const rememberTool = tools.find((t) => t.schema.name === 'remember')!

  const reflect = createReflectionRunner({
    chat: async () => ({ content: '' }) // 每步 reflect 时重造
  })

  let currentLastUser = ''
  for (const step of scenario.steps) {
    switch (step.act) {
      case 'remember': {
        currentLastUser = step.lastUser ?? ''
        await rememberTool.execute({
          name: step.name,
          description: step.description,
          class: step.cls,
          body: step.body
        })
        currentLastUser = ''
        break
      }
      case 'capture': {
        // 通路 B：选中即记，origin=user + 精确证据，与 MemoryCapture.tsx 同参
        repo.save({
          name: step.name,
          description: step.description,
          class: step.cls,
          body: step.body,
          origin: 'user',
          evidence: { conversationId: 'conv-1', turnIndex: step.turnIndex ?? 1 }
        })
        break
      }
      case 'reflect': {
        // 真反思执行器 + 桩 chat（返回场景写死的 JSON）→ 候选落盘
        const runner = createReflectionRunner({
          chat: async () => ({ content: JSON.stringify(step.candidates) })
        })
        const { candidates: produced } = await runner.reflect({
          id: 'conv-1',
          messages: [{ role: 'user' as const, content: '（会话正文，桩下不参与判定）' }],
          bodyBytes: 4096, // 过前置门（MIN_BODY_BYTES=2048）
          memory: repo
        })
        for (const c of produced) {
          const conflict = repo.findConflict(c.name)
          repo.saveCandidate(c, conflict?.file)
        }
        break
      }
      case 'approveAll': {
        for (const c of repo.list().candidates) void repo.approveCandidate(c.file)
        break
      }
      case 'reject': {
        const hit = repo.list().candidates.find((c) => c.name === step.name)
        if (hit) repo.rejectCandidate(hit.file)
        break
      }
      case 'recall': {
        const index = repo.list()
        const hit = index.entries.find((e) => e.name === step.name)
        repo.record({ kind: 'recall', conversationId: 'conv-1', name: step.name, found: Boolean(hit) })
        break
      }
      case 'flag': {
        repo.record({ kind: 'flag', conversationId: 'conv-1', name: step.name })
        break
      }
    }
  }

  // ── 端态取景器 ──
  return {
    view: () => repo.list(),
    block: () => composeMemoryBlock(repo.list()),
    stats: () => repo.computeStats(parseEvents(backend.events)),
    events: () => [...backend.events],
    fileText: (slug) => backend.read(`${ROOT}/${slug}.md`),
    archived: () =>
      backend
        .listArchived()
        .map((f) => ({ slug: parseArchivedFileName(f.slice(f.lastIndexOf('/') + 1))?.slug ?? '', text: backend.read(f) }))
        .sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    archived: () =>
      backend.listArchived().map((f) => ({
        slug: parseArchivedFileName(f.split('/').pop() ?? '')?.slug ?? '',
        text: backend.read(f)
      })),
    warnings: () => [...warnings]
  }
}

/** 事件行 → 事件对象（computeStats 的输入口径） */
function parseEvents(lines: string[]): MemoryEvent[] {
  return lines
    .map((l) => parseEventLine(l))
    .filter((e): e is MemoryEvent => e !== null)
}
