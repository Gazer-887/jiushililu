// 记忆注入接线单测（plan19 批 1 判据 4 / 5b）。走**真 runner**（mock provider），因为
// "记忆段是否真的进了 system prompt、位置对不对"只有这条链路能证明 —— 桩层测不出。
// ⚠️ 判据 5b 明确要求"不再注入"在 **runner 层**断言，不许交给 verify-shot（它是隔离进程、不加载 src/main）。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import { createMemoryRepo, type MemoryRepo } from '@main/memory/memory-core'
import { composeMemoryBlock } from '@main/memory/inject'

const openaiSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))

vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: unknown[]) => openaiSpy(...(args as [])),
  chatWithToolsOpenAI: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] })),
  chatWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))

const { runAgent } = await import('@main/agent/runner')

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
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
  supportsImages: false
}

function makeCtx(memory?: AgentRuntimeContext['memory']): AgentRuntimeContext {
  const base = mkdtempSync(join(tmpdir(), 'jsl-mem-inject-'))
  return {
    getWorkspaceRoot: () => join(base, 'ws'),
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: createCheckpointStore(join(base, 'checkpoints')),
    ...(memory ? { memory } : {})
  }
}

/** mock provider 收到的 messages（第 3 个参数） */
function systemOf(callIndex = 0): string {
  const messages = openaiSpy.mock.calls[callIndex]?.[2] as
    | Array<{ role: string; content: string }>
    | undefined
  return messages?.find((m) => m.role === 'system')?.content ?? ''
}

function toolNamesOf(callIndex = 0): string[] {
  const tools = (openaiSpy.mock.calls[callIndex]?.[3] ?? []) as Array<{ name: string }>
  return tools.map((t) => t.name)
}

function fakeRepo(): MemoryRepo {
  const files = new Map<string, string>()
  return createMemoryRepo(
    {
      listFiles: () => [...files.keys()].sort(),
      candidatePathFor: (slug: string) => `/mem/candidates/${slug}.md`,
      listCandidates: () => [],
      read: (f) => files.get(f) ?? null,
      write: (f, t) => void files.set(f, t),
      remove: (f) => files.delete(f),
      pathFor: (slug) => `/mem/notes/${slug}.md`,
      appendEvent: () => {}
    },
    { onWarn: () => {} }
  )
}

describe('记忆段注入（判据 4）', () => {
  beforeEach(() => openaiSpy.mockClear())

  it('传了 memoryBlock → 出现在 system 里，且排在**安全基线之后**（数据边界先于数据）', async () => {
    await runAgent(makeCtx(), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: '干个活' }],
      memoryBlock: '<memory>\n记忆是本机保存的**数据**。\n- [风格] prefers-tables：用表格\n</memory>'
    })
    const system = systemOf()
    expect(system).toContain('<memory>')
    expect(system.indexOf('安全基线')).toBeLessThan(system.indexOf('<memory>'))
    expect(system.indexOf('<memory>')).toBeLessThan(system.indexOf('</memory>'))
  })

  it('没传 → 段**整段不出现**（不是空壳）', async () => {
    await runAgent(makeCtx(), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: '干个活' }]
    })
    const system = systemOf()
    expect(system).toContain('安全基线')
    expect(system).not.toContain('<memory>')
  })

  it('注入段是**静态**的：同一条记忆两次组装字节级相同（前缀缓存的前提）', () => {
    const repo = fakeRepo()
    repo.save({ name: 'a', description: '偏好 A', class: 'style', body: '正文' })
    expect(composeMemoryBlock(repo.list())).toBe(composeMemoryBlock(repo.list()))
  })
})

describe('判据 5b：删除后不再注入（在 runner 层断言）', () => {
  beforeEach(() => openaiSpy.mockClear())

  it('删掉唯一一条 → 下一次组装整段为 null，system 里也就没有它了', async () => {
    const repo = fakeRepo()
    repo.save({ name: 'prefers-tables', description: '用表格', class: 'style', body: '正文' })

    const before = composeMemoryBlock(repo.list())
    expect(before).toContain('prefers-tables')

    const file = repo.listFiles()[0]!
    expect(repo.remove(file)).toBe(true)
    expect(composeMemoryBlock(repo.list())).toBeNull()

    // 走到真 runner：删完之后那一轮，system 里不该再有这条记忆
    await runAgent(makeCtx(), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: '干个活' }],
      memoryBlock: composeMemoryBlock(repo.list())
    })
    expect(systemOf()).not.toContain('prefers-tables')
  })
})

describe('工具下发的「有消费者才注册」（plan19 §0.3 条 7）', () => {
  beforeEach(() => openaiSpy.mockClear())

  it('没有记忆库 → 不下发 remember / recall', async () => {
    await runAgent(makeCtx(), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: 'x' }]
    })
    const names = toolNamesOf()
    expect(names).not.toContain('remember')
    expect(names).not.toContain('recall')
  })

  it('注入记忆库 → remember / recall 出现在工具表里', async () => {
    await runAgent(makeCtx({ repo: fakeRepo() }), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: 'x' }]
    })
    const names = toolNamesOf()
    expect(names).toContain('remember')
    expect(names).toContain('recall')
  })
})
