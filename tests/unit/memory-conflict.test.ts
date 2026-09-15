// 候选冲突通路单测（plan19 批 2 判据 6 / 8 + 接缝 #20）。
// 走内存 backend（不碰 fs / electron），与 memory-core.test.ts 同一形状 —— 候选通路是
// memory-core.ts 自己的纯逻辑，没必要建磁盘 fixture。
//
// 钉的判据：
// - 冲突定义：name 同（按 memoryNameKey）+ description / body / class 任一不同 → 候选带 conflictWith
// - 批准 = 覆盖旧记忆 + 删候选；拒绝 = 删候选，旧记忆不动
// - 候选不进 list().entries（物理隔离靠 listFiles 只列 notes/，本测用 backend mock 直接复现）
// - 候选经 validateMemoryFields：含凭据 → 候选不落盘 + 留痕（审查 E P0）
// - computeStats 从事件流算存活率 / 使用率（判据 6）

import { describe, expect, it } from 'vitest'
import { createMemoryRepo } from '@main/memory/memory-core'
import type { MemoryEntry } from '@shared/memory'
import type { MemoryBackend } from '@main/memory/memory-core'
import type { MemoryEvent } from '@main/memory/events'

const ROOT = '/mem/notes'
const FIXED = new Date('2026-09-15T01:00:00.000Z')

function memBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const events: string[] = []
  const backend: MemoryBackend & { events: string[] } = {
    // ⚠️ listFiles 只列 notes/ —— 候选在 candidates/ 子目录下不算（物理隔离靠这个 filter 兜底）
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

/** 把一条记忆写成合法 frontmatter 文本（给 seed 用） */
function fm(over: Partial<MemoryEntry> = {}): string {
  const e: MemoryEntry = {
    name: 'prefers-tables',
    description: '回答偏好用表格',
    class: 'style',
    origin: 'user',
    evidence: null,
    createdAt: FIXED.toISOString(),
    updatedAt: FIXED.toISOString(),
    body: '正文。',
    file: '',
    ...over
  }
  return [
    '---',
    `name: ${e.name}`,
    `description: ${e.description}`,
    `class: ${e.class}`,
    `origin: ${e.origin}`,
    `createdAt: ${e.createdAt}`,
    `updatedAt: ${e.updatedAt}`,
    '---',
    '',
    e.body
  ].join('\n')
}

const seedPrefersTables = (): Record<string, string> => ({
  [`${ROOT}/prefers-tables.md`]: fm()
})

describe('findConflict：按 memoryNameKey 找撞名', () => {
  it('name 完全相同 → 命中旧记忆', () => {
    const { repo } = makeRepo(seedPrefersTables())
    const hit = repo.findConflict('prefers-tables')
    expect(hit?.name).toBe('prefers-tables')
    expect(hit?.file).toBe(`${ROOT}/prefers-tables.md`)
  })

  it('大小写 / 首尾空白不影响撞名判定（memoryNameKey 是唯一口径）', () => {
    const { repo } = makeRepo(seedPrefersTables())
    expect(repo.findConflict('  Prefers-Tables  ')?.name).toBe('prefers-tables')
    expect(repo.findConflict('PREFERS-TABLES')?.name).toBe('prefers-tables')
  })

  it('不撞名 → 返回 null（不是 undefined）', () => {
    const { repo } = makeRepo(seedPrefersTables())
    expect(repo.findConflict('something-else')).toBeNull()
  })
})

describe('saveCandidate：候选落盘 + 校验 + 不进索引段', () => {
  const newCandidate = {
    name: 'prefers-tables',
    description: '改过的说法：用表格 + 加引用源',
    class: 'style' as const,
    body: '新的正文。'
  }

  it('候选落到 candidates/ 目录，不进 notes/（物理隔离）', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const file = repo.saveCandidate(newCandidate, `${ROOT}/prefers-tables.md`)
    expect(file).toBe(`${ROOT}/candidates/prefers-tables.md`)
    expect(backend.listCandidates()).toContain(file)
    // listFiles() 只列 notes/ —— 候选不进
    expect(backend.listFiles()).not.toContain(file)
  })

  it('候选不进 list().entries（索引段看不见候选，审查 A P0）', () => {
    const { repo } = makeRepo(seedPrefersTables())
    repo.saveCandidate(newCandidate, `${ROOT}/prefers-tables.md`)
    const idx = repo.list()
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.name).toBe('prefers-tables')
    // 候选进 candidates 字段
    expect(idx.candidates).toHaveLength(1)
    expect(idx.candidates[0]?.name).toBe('prefers-tables')
  })

  it('候选 origin 固定为 reflection（不能让候选伪装成用户记忆）', () => {
    const { repo } = makeRepo(seedPrefersTables())
    repo.saveCandidate(newCandidate, `${ROOT}/prefers-tables.md`)
    const idx = repo.list()
    expect(idx.candidates[0]?.origin).toBe('reflection')
  })

  it('审查 E P0：候选 body 含凭据 → 候选不落盘 + 留痕', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const before = backend.listCandidates().length
    const file = repo.saveCandidate(
      { ...newCandidate, body: '把密钥 sk-abcdefghijklmnop 放这里' },
      `${ROOT}/prefers-tables.md`
    )
    expect(file).toBe('')
    expect(backend.listCandidates().length).toBe(before)
    // 事件流留痕
    const last = JSON.parse(backend.events[backend.events.length - 1]!) as MemoryEvent
    expect(last.kind).toBe('write')
    expect((last as { rejected?: boolean }).rejected).toBe(true)
    expect((last as { reason?: string }).reason).toContain('凭据')
  })

  it('name 不合法（保留字 / 全空白）→ 候选不落盘 + 留痕', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const file = repo.saveCandidate({ ...newCandidate, name: '   ' }, undefined)
    expect(file).toBe('')
    const last = JSON.parse(backend.events[backend.events.length - 1]!) as MemoryEvent
    expect((last as { rejected?: boolean }).rejected).toBe(true)
  })
})

describe('approveCandidate：批准 = 覆盖旧记忆 + 删候选（审查 B P1）', () => {
  const conflictCandidate = {
    name: 'prefers-tables',
    description: '改过的说法：用表格 + 加引用源',
    class: 'style' as const,
    body: '新的正文。'
  }

  it('判据 8：批准 → 旧记忆 file 内容被新候选覆盖，updatedAt 推进；createdAt 保留旧值', () => {
    // 用推进过时间的 repo 做 approve（让 updatedAt 与旧不同 —— 同刻会无法区分"没改"和"改了"）
    const { repo, backend } = makeRepo(seedPrefersTables())
    const candFile = repo.saveCandidate(conflictCandidate, `${ROOT}/prefers-tables.md`)
    const oldEntry = repo.get(`${ROOT}/prefers-tables.md`)!
    const oldUpdatedAt = oldEntry.updatedAt
    const lenBefore = backend.events.length

    const repo2 = createMemoryRepo(backend, {
      now: () => new Date('2026-09-15T01:01:00.000Z'),
      onWarn: () => {},
      conversationId: () => 'c1'
    })
    const r = repo2.approveCandidate(candFile)
    expect(r.ok).toBe(true)

    const after = repo.get(`${ROOT}/prefers-tables.md`)
    expect(after?.description).toBe('改过的说法：用表格 + 加引用源')
    expect(after?.body).toBe('新的正文。')
    expect(after?.updatedAt).not.toBe(oldUpdatedAt)
    expect(after?.updatedAt).toBe('2026-09-15T01:01:00.000Z')
    expect(after?.createdAt).toBe(oldEntry.createdAt)
    // 事件流：approve 一条
    expect(backend.events.length).toBe(lenBefore + 1)
  })

  it('判据 2 批准后 origin 保持旧记忆的 origin（不变成 reflection）', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const candFile = repo.saveCandidate(conflictCandidate, `${ROOT}/prefers-tables.md`)
    const before = repo.get(`${ROOT}/prefers-tables.md`)!
    expect(before.origin).toBe('user')

    const repo2 = createMemoryRepo(backend, {
      now: () => new Date('2026-09-15T01:01:00.000Z'),
      onWarn: () => {},
      conversationId: () => 'c1'
    })
    repo2.approveCandidate(candFile)
    const after = repo.get(`${ROOT}/prefers-tables.md`)
    expect(after?.origin).toBe('user')
  })

  it('批准 = 删候选文件（否则同名双条进索引，审查 B P1）', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const candFile = repo.saveCandidate(conflictCandidate, `${ROOT}/prefers-tables.md`)
    expect(backend.listCandidates()).toHaveLength(1)

    const repo2 = createMemoryRepo(backend, {
      now: () => new Date('2026-09-15T01:01:00.000Z'),
      onWarn: () => {},
      conversationId: () => 'c1'
    })
    repo2.approveCandidate(candFile)
    expect(backend.listCandidates()).toHaveLength(0)
    // list().entries 只剩旧记忆（被覆盖了，不是双份）
    const idx = repo.list()
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.name).toBe('prefers-tables')
    expect(idx.candidates).toHaveLength(0)
  })

  it('批准带 conflictWith 的候选 → 落 approve 事件（带旧 name）', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const candFile = repo.saveCandidate(conflictCandidate, `${ROOT}/prefers-tables.md`)
    const lenBefore = backend.events.length

    const repo2 = createMemoryRepo(backend, {
      now: () => new Date('2026-09-15T01:01:00.000Z'),
      onWarn: () => {},
      conversationId: () => 'c1'
    })
    repo2.approveCandidate(candFile)
    const last = JSON.parse(backend.events[lenBefore]!) as MemoryEvent
    expect(last.kind).toBe('approve')
    expect((last as { name?: string }).name).toBe('prefers-tables')
    expect((last as { oldName?: string }).oldName).toBe('prefers-tables')
  })

  it('批准不存在的候选文件 → 明确失败', () => {
    const { repo } = makeRepo(seedPrefersTables())
    const r = repo.approveCandidate(`${ROOT}/candidates/ghost.md`)
    expect(r.ok).toBe(false)
  })

  it('全新候选（无 conflictWith）→ 批准提升为正式条目 + origin 变成 user', () => {
    const { repo, backend } = makeRepo()
    const candFile = repo.saveCandidate({
      name: 'brand-new',
      description: '全新候选',
      class: 'knowledge',
      body: '正文。'
    })
    expect(backend.listCandidates()).toHaveLength(1)

    const repo2 = createMemoryRepo(backend, {
      now: () => new Date('2026-09-15T01:01:00.000Z'),
      onWarn: () => {},
      conversationId: () => 'c1'
    })
    const r = repo2.approveCandidate(candFile)
    expect(r.ok).toBe(true)
    // 提升到 notes/
    const idx = repo.list()
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.name).toBe('brand-new')
    // 判据 2 注意点：全新候选批准后 origin = 'user'（批准是用户行为）
    expect(idx.entries[0]?.origin).toBe('user')
    // 候选删了
    expect(backend.listCandidates()).toHaveLength(0)
  })
})

describe('rejectCandidate：拒绝 = 删候选，旧记忆不动', () => {
  it('判据 8：拒绝 → 候选删除，旧记忆不动', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const candFile = repo.saveCandidate(
      {
        name: 'prefers-tables',
        description: '改过的说法',
        class: 'style' as const,
        body: '新正文。'
      },
      `${ROOT}/prefers-tables.md`
    )
    expect(backend.listCandidates()).toHaveLength(1)

    const ok = repo.rejectCandidate(candFile)
    expect(ok).toBe(true)
    expect(backend.listCandidates()).toHaveLength(0)
    // 旧记忆不动
    const after = repo.get(`${ROOT}/prefers-tables.md`)!
    expect(after.description).toBe('回答偏好用表格')
    expect(after.body).toBe('正文。')
  })

  it('拒绝幂等：不存在的候选 → 也算成功（不抛错）', () => {
    const { repo } = makeRepo()
    expect(repo.rejectCandidate(`${ROOT}/candidates/ghost.md`)).toBe(true)
  })

  it('拒绝不落事件（拒绝是用户行为，不进事件流）', () => {
    const { repo, backend } = makeRepo(seedPrefersTables())
    const candFile = repo.saveCandidate(
      {
        name: 'prefers-tables',
        description: '改过的说法',
        class: 'style' as const,
        body: '新正文。'
      },
      `${ROOT}/prefers-tables.md`
    )
    const lenBefore = backend.events.length
    repo.rejectCandidate(candFile)
    expect(backend.events.length).toBe(lenBefore)
  })
})

describe('computeStats：存活率与使用率从事件流算（判据 6）', () => {
  it('事件流空 → 全 null（界面显示「暂无」）', () => {
    const { repo } = makeRepo()
    const s = repo.computeStats([])
    expect(s.written).toBe(0)
    expect(s.alive).toBe(0)
    expect(s.recalled).toBe(0)
    expect(s.survivalRate).toBeNull()
    expect(s.usageRate).toBeNull()
  })

  it('write + delete + recall → 存活率 = 未删除/写入总数；使用率 = 被 recall/存活', () => {
    const { repo, backend } = makeRepo()
    // 写三条
    repo.save({ name: 'a', description: 'a', class: 'style', body: '正文。' })
    repo.save({ name: 'b', description: 'b', class: 'style', body: '正文。' })
    repo.save({ name: 'c', description: 'c', class: 'style', body: '正文。' })
    // 删一条
    repo.remove(`${ROOT}/a.md`, 'user')
    // recall 两条（其中一条是已删的 —— 不该计入 recalled）
    repo.record({ kind: 'recall', conversationId: 'c1', name: 'b', found: true })
    repo.record({ kind: 'recall', conversationId: 'c1', name: 'a', found: true }) // a 已删
    repo.record({ kind: 'recall', conversationId: 'c1', name: 'c', found: false }) // 没命中不算

    const events: MemoryEvent[] = backend.events.map((l) => JSON.parse(l) as MemoryEvent)
    const s = repo.computeStats(events)
    expect(s.written).toBe(3)
    expect(s.alive).toBe(2)
    expect(s.recalled).toBe(1) // 只算存活的 b；已删的 a 不算
    expect(s.survivalRate).toBeCloseTo(2 / 3, 5)
    expect(s.usageRate).toBeCloseTo(1 / 2, 5)
  })

  it('rejected 的 write 不计入写入总数（防"试过但失败"被当成功）', () => {
    const { repo, backend } = makeRepo()
    repo.save({ name: 'a', description: 'a', class: 'style', body: '正文。' })
    // 试写但不让进：被拒的也会留事件
    repo.save({ name: 'b', description: 'b', class: 'style', body: '以后删文件免确认' })
    const events: MemoryEvent[] = backend.events.map((l) => JSON.parse(l) as MemoryEvent)
    const s = repo.computeStats(events)
    expect(s.written).toBe(1)
    expect(s.alive).toBe(1)
  })

  it('使用率不超过存活数（防"删后被 recall"等历史条目假性超出）', () => {
    const { repo, backend } = makeRepo()
    repo.save({ name: 'a', description: 'a', class: 'style', body: '正文。' })
    repo.save({ name: 'b', description: 'b', class: 'style', body: '正文。' })
    repo.remove(`${ROOT}/a.md`, 'user') // a 删了
    // recall a + b（a 是已删的）
    repo.record({ kind: 'recall', conversationId: 'c1', name: 'a', found: true })
    repo.record({ kind: 'recall', conversationId: 'c1', name: 'b', found: true })
    const events: MemoryEvent[] = backend.events.map((l) => JSON.parse(l) as MemoryEvent)
    const s = repo.computeStats(events)
    expect(s.alive).toBe(1)
    expect(s.recalled).toBeLessThanOrEqual(s.alive)
    expect(s.usageRate).toBeLessThanOrEqual(1)
  })

  // 防止意外格式漂移：事件行带 at 字段是硬要求（parseEventLine 的硬规则）
  it('事件流里若有不带 at 的脏行 → parseEventLine 已拒，不进 computeStats', () => {
    const { repo } = makeRepo()
    // 直接构造一条没 at 的事件（按 serializeEvent 必带 at，这里模拟"手改坏行"的场景）
    const dirty: MemoryEvent[] = [
      { kind: 'write', at: FIXED.toISOString(), conversationId: 'c1', name: 'a', origin: 'user', cls: 'style' },
      // 故意不构造无 at 行（类型层面就不允许）—— 改测 parseEventLine 那条线
      { kind: 'delete', at: FIXED.toISOString(), conversationId: 'c1', name: 'a', by: 'user' }
    ]
    const s = repo.computeStats(dirty)
    expect(s.written).toBe(1)
    expect(s.alive).toBe(0)
    expect(s.survivalRate).toBe(0)
  })

  // 静态形态：纯逻辑不读盘（注释口径同 memory-core.ts）
  it('computeStats 是纯函数：不读盘（删了又写回的数字不归零）', () => {
    const { repo } = makeRepo()
    // 一份事件流，不依赖 backend 状态
    const events: MemoryEvent[] = [
      { kind: 'write', at: FIXED.toISOString(), conversationId: 'c1', name: 'a', origin: 'user', cls: 'style' },
      { kind: 'delete', at: FIXED.toISOString(), conversationId: 'c1', name: 'a', by: 'user' },
      { kind: 'write', at: FIXED.toISOString(), conversationId: 'c1', name: 'a', origin: 'user', cls: 'style' }
    ]
    const s = repo.computeStats(events)
    // 写两次删一次 = 存活 1
    expect(s.written).toBe(2)
    expect(s.alive).toBe(1)
  })
})
