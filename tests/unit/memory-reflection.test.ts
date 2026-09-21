// 反思执行器单测（plan19 批 2 判据 2 / 3 + 接缝 #21）。
// mock `ReflectChat`：只测反思执行器自己的判定与解析，不调真模型。
// 走真 createMemoryRepo（mock backend）—— 因为 reflect 调 memory.findConflict，
// 不传真 repo 就要 mock 一堆方法，不如用真 repo 走内存 backend。
//
// 钉的判据：
// - bodyBytes < 2048 → 不调 chat（计数 0）；>= 2048 → 调 chat（计数 1）（判据 3）
// - 产出候选 → list().entries 不含候选（物理隔离）+ approveCandidate 后含它（判据 2）
// - reflect 不直接 saveCandidate（不进 save，只产出候选给装配层）（plan19 #21）
// - stripCodeFence：模型把 JSON 裹 ```json ... ``` 也能解析
// - normalizeCandidate：缺字段 / 不合法 class → 跳过；class 不合法兜底 'default'
// - findConflict 自动填 conflictWith（不依赖装配层）

import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import type { MemoryCandidate } from '@shared/memory'
import { createMemoryRepo } from '@main/memory/memory-core'
import type { MemoryBackend } from '@main/memory/memory-core'
import { createReflectionRunner } from '@main/memory/reflection'

const ROOT = '/mem/notes'
const FIXED = new Date('2026-09-15T01:00:00.000Z')

function memBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const events: string[] = []
  const backend: MemoryBackend & { events: string[] } = {
    listFiles: () => [...files.keys()].filter((f) => f.startsWith(`${ROOT}/`) && !f.startsWith(`${ROOT}/candidates/`)).sort(),
    candidatePathFor: (slug: string) => `${ROOT}/candidates/${slug}.md`,
    listCandidates: () => [...files.keys()].filter((f) => f.startsWith(`${ROOT}/candidates/`)).sort(),
    read: (f: string) => files.get(f) ?? null,
    write: (f: string, t: string) => void files.set(f, t),
    remove: (f: string) => files.delete(f),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line),
    events
  }
  return backend
}

function makeRepo(seed: Record<string, string> = {}) {
  const backend = memBackend(seed)
  const repo = createMemoryRepo(backend, {
    now: () => FIXED,
    onWarn: () => {},
    conversationId: () => 'c1'
  })
  return { repo, backend }
}

const msgs: ChatMessage[] = [
  { role: 'user', content: '讲一下 React 的状态管理' },
  { role: 'assistant', content: 'useState 是 React 的基础 Hook...' }
]

/** 给出"过前置门"的会话大小（>= 2048 字节） */
const BIG_BYTES = 4096
const SMALL_BYTES = 100

describe('前置门：bodyBytes < 2048 → 不调 chat（判据 3）', () => {
  it('小会话 → 返回空候选 + chat 0 次调用', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: SMALL_BYTES, memory: repo })
    expect(out.candidates).toEqual([])
    expect(chat).not.toHaveBeenCalled()
  })

  it('恰好在阈值（2048）→ 调 chat（边界条件不让"= 阈值"被前门挡掉）', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: 2048, memory: repo })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('大会话 → 调 chat 一次', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

describe('产出候选：解析模型输出', () => {
  const oneCand: MemoryCandidate[] = [
    { name: 'prefers-tables', description: '回答偏好用表格', class: 'style', body: '正文。' }
  ]

  it('JSON 数组 → 候选原样带出', async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify(oneCand) }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]?.name).toBe('prefers-tables')
    expect(out.candidates[0]?.class).toBe('style')
  })

  it('stripCodeFence：模型把 JSON 裹在 ```json ... ``` 里也能解析', async () => {
    const chat = vi.fn(async () => ({ content: '```json\n' + JSON.stringify(oneCand) + '\n```' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]?.name).toBe('prefers-tables')
  })

  it('stripCodeFence：围栏头是 ```jsonc 也能剥（不认语言标记）', async () => {
    const chat = vi.fn(async () => ({ content: '```jsonc\n' + JSON.stringify(oneCand) + '\n```' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)
  })

  it('不是数组 → 返回空（不抛）', async () => {
    const chat = vi.fn(async () => ({ content: '{"a": 1}' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toEqual([])
  })

  it('JSON 解析失败 → 返回空（不抛，不假阳性）', async () => {
    const chat = vi.fn(async () => ({ content: '这不是 JSON' }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toEqual([])
  })

  // R17：这一层**不再咽异常**。以前它 catch 成 `{ candidates: [] }`，注释说"留痕由调用方做"，
  // 可异常在这一层就没了 —— 调用方那条「反思执行器抛错」永远进不去，反思失败成了零候选 + 零日志。
  it('chat 抛错 → **原样抛出**（留痕在装配层，前提是异常真到得了那儿）', async () => {
    const chat = vi.fn(async () => {
      throw new Error('network')
    })
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    await expect(
      runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    ).rejects.toThrow('network')
  })

  it('normalizeCandidate：缺 name / description / body 的项跳过（不补全）', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { description: '缺 name', class: 'style', body: 'b' },
        { name: 'x', class: 'style', body: 'b' }, // 缺 description
        { name: 'x', description: 'd', class: 'style' }, // 缺 body
        { name: 'ok', description: 'd', class: 'style', body: '正文。' }
      ])
    }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]?.name).toBe('ok')
  })

  it('normalizeCandidate：class 不合法 → 兜底 default（不丢候选）', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'x', description: 'd', class: 'unknown', body: '正文。' }
      ])
    }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates[0]?.class).toBe('default')
  })

  it('normalizeCandidate：非对象元素跳过', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([null, 'string', 42, { name: 'ok', description: 'd', class: 'style', body: 'b' }])
    }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]?.name).toBe('ok')
  })

  it('normalizeCandidate：evidence 可选；不传时不带 evidence 字段', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'x', description: 'd', class: 'style', body: 'b' },
        { name: 'y', description: 'd', class: 'style', body: 'b', evidence: { conversationId: 'c9', turnIndex: 3 } }
      ])
    }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates[0]?.evidence).toBeUndefined()
    expect(out.candidates[1]?.evidence).toEqual({ conversationId: 'c9', turnIndex: 3 })
  })

  it('normalizeEvidence：conversationId 缺失 → 不带 evidence（不允许半指针）', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'x', description: 'd', class: 'style', body: 'b', evidence: { turnIndex: 3 } }
      ])
    }))
    const { repo } = makeRepo()
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates[0]?.evidence).toBeUndefined()
  })
})

describe('冲突自动填 conflictWith（反思调 memory.findConflict，不自己实现撞名）', () => {
  const seedPrefers = (): Record<string, string> => ({
    [`${ROOT}/prefers-tables.md`]: [
      '---',
      'name: prefers-tables',
      'description: 回答偏好用表格',
      'class: style',
      'origin: user',
      `createdAt: ${FIXED.toISOString()}`,
      `updatedAt: ${FIXED.toISOString()}`,
      '---',
      '',
      '正文。'
    ].join('\n')
  })

  it('候选 name 与已存在记忆撞名 → conflictWith = 旧记忆 file', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        // description 与旧记忆不同 → 这是冲突（不是完全相同）
        { name: 'prefers-tables', description: '改过的说法', class: 'style', body: '新正文。' }
      ])
    }))
    const { repo } = makeRepo(seedPrefers())
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]?.conflictWith).toBe(`${ROOT}/prefers-tables.md`)
  })

  it('候选 name 大小写不同但 memoryNameKey 同 → 仍判冲突', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'PREFERS-TABLES', description: '大小写变体', class: 'style', body: '正文。' }
      ])
    }))
    const { repo } = makeRepo(seedPrefers())
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates[0]?.conflictWith).toBe(`${ROOT}/prefers-tables.md`)
  })

  it('候选 name 不撞名 → conflictWith 为 undefined', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'brand-new', description: '全新的', class: 'knowledge', body: '正文。' }
      ])
    }))
    const { repo } = makeRepo(seedPrefers())
    const runner = createReflectionRunner({ chat })
    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates[0]?.conflictWith).toBeUndefined()
  })
})

describe('反思产出候选不直接 save（plan19 #21）', () => {
  it('reflect 后 notes/ 目录仍空（候选未落盘 —— 落盘交装配层 saveCandidate）', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'brand-new', description: 'd', class: 'style', body: 'b' }
      ])
    }))
    const { repo, backend } = makeRepo()
    const runner = createReflectionRunner({ chat })
    await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(backend.listFiles()).toHaveLength(0)
    expect(backend.listCandidates()).toHaveLength(0)
  })
})

describe('判据 2：反思产出候选 → list().entries 不含 → 批准后含它', () => {
  it('完整链路：reflect → 装配层 saveCandidate → 候选在 candidates 不在 entries → approve → 在 entries', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'brand-new', description: '全新的', class: 'knowledge', body: '正文。' }
      ])
    }))
    const { repo, backend } = makeRepo()
    const runner = createReflectionRunner({ chat })

    const out = await runner.reflect({ id: 'c1', messages: msgs, bodyBytes: BIG_BYTES, memory: repo })
    expect(out.candidates).toHaveLength(1)

    // 装配层调 saveCandidate（不在反思执行器内）
    const file = repo.saveCandidate(out.candidates[0]!)
    expect(file).toBe(`${ROOT}/candidates/brand-new.md`)

    // 候选在 candidates，不在 entries
    const idx1 = repo.list()
    expect(idx1.entries).toHaveLength(0)
    expect(idx1.candidates).toHaveLength(1)
    expect(idx1.candidates[0]?.origin).toBe('reflection')

    // 批准：origin 变 'user'（plan19 判据 2 注意点：全新候选批准后 = 用户行为）
    const repo2 = createMemoryRepo(backend, {
      now: () => new Date('2026-09-15T01:01:00.000Z'),
      onWarn: () => {},
      conversationId: () => 'c1'
    })
    const r = repo2.approveCandidate(file)
    expect(r.ok).toBe(true)

    const idx2 = repo.list()
    expect(idx2.entries).toHaveLength(1)
    expect(idx2.entries[0]?.name).toBe('brand-new')
    expect(idx2.entries[0]?.origin).toBe('user')
    expect(idx2.candidates).toHaveLength(0)
  })
})
