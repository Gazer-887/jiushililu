import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryTools } from '@main/agent/tools/memory-tools'
import { serializeMemory } from '@main/memory/memory-core'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import { createMemoryStore, type MemoryStore } from '@main/store/memory-store'
import { MEMORY_LIMITS } from '@shared/memory'

const roots: string[] = []
const TARGET = 'hidden-detail'
const BODY = '量子船坞校准的完整正文，需要先检查停泊位置。'

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'jsl-recall-budget-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    expect(resolve(dirname(path))).toBe(resolve(tmpdir()))
    expect(basename(path).startsWith('jsl-recall-budget-')).toBe(true)
    rmSync(path, { recursive: true, force: true })
  }
})

function seededStore(fts = true): MemoryStore {
  const path = root()
  mkdirSync(join(path, 'notes'), { recursive: true })
  for (let i = 0; i < MEMORY_LIMITS.maxEntries; i += 1) {
    const name = i === 0 ? TARGET : `regular-${i}`
    const stamp = new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString()
    writeFileSync(
      join(path, 'notes', `${name}.md`),
      serializeMemory({
        name,
        description: `条目${i}`.padEnd(MEMORY_LIMITS.maxDescriptionChars, '字'),
        class: 'knowledge',
        origin: 'user',
        evidence: null,
        createdAt: stamp,
        updatedAt: stamp,
        body: i === 0 ? BODY : `常规正文${i}`
      })
    )
  }
  return createMemoryStore(path, nodeFsAdapter, fts ? {} : { ftsPath: null })
}

function recallFor(store: MemoryStore) {
  return createMemoryTools({
    repo: store,
    conversationId: () => 'recall-budget-test',
    searchMemory: (query, limit) => store.searchMemory(query, limit)
  }).find((tool) => tool.schema.name === 'recall')!
}

describe('预算限制注入索引，正文回取仍覆盖生效集合', () => {
  it('FTS建议预算外名称后，按明确名称可取完整正文', async () => {
    const store = seededStore()
    const index = store.list()
    expect(index.omitted).toBeGreaterThan(0)
    expect(index.entries.some((entry) => entry.name === TARGET)).toBe(false)
    expect(store.searchMemory('量子船坞').hits.map((entry) => entry.name)).toEqual([TARGET])

    const recall = recallFor(store)
    const suggested = await recall.execute({ name: '量子船坞' })
    expect(suggested).toContain('全文检索找到 1 条相关')
    expect(suggested).toContain(TARGET)
    expect(await recall.execute({ name: TARGET })).toContain(BODY)
    expect(
      store.backend.readEvents().events.filter((event) => event.kind === 'recall')
    ).toMatchObject([
      { name: '量子船坞', found: false },
      { name: TARGET, found: true }
    ])

    const differentCase = await recall.execute({ name: TARGET.toUpperCase() })
    expect(differentCase).toContain('没有名为')
    expect(differentCase).not.toContain(BODY)
  })

  it('FTS关闭时，预算外生效条目仍可按名称回取', async () => {
    const store = seededStore(false)
    expect(store.list().entries.some((entry) => entry.name === TARGET)).toBe(false)
    expect(store.searchMemory('量子船坞').hits).toEqual([])
    expect(await recallFor(store).execute({ name: TARGET })).toContain(BODY)
  })

  it('未批候选与拒绝后的正文都不能按名称回取', async () => {
    const store = createMemoryStore(root(), nodeFsAdapter)
    const candidate = store.saveCandidateDetailed({
      name: 'pending-only',
      description: '蓝鲸条目',
      class: 'knowledge',
      origin: 'reflection',
      evidence: null,
      body: '蓝鲸候选正文只保存在候选区。'
    })
    expect(candidate.file).toBeTruthy()
    expect(store.list().candidates.some((entry) => entry.name === 'pending-only')).toBe(true)
    const recall = recallFor(store)
    expect(await recall.execute({ name: 'pending-only' })).not.toContain('蓝鲸候选正文')
    expect(store.rejectUnclustered([candidate.file])).toEqual({
      rejected: [candidate.file],
      skipped: []
    })
    expect(store.backend.listRejected()).toHaveLength(1)
    expect(await recall.execute({ name: 'pending-only' })).not.toContain('蓝鲸候选正文')
  })

  it('条目被容量归档后，正文仍在归档区但不可召回', async () => {
    const store = seededStore()
    const saved = store.save({
      name: 'new-arrival',
      description: '新增条目触发容量归档',
      class: 'knowledge',
      origin: 'user',
      body: '全新正文。',
      force: true
    })
    expect(saved.ok).toBe(true)
    const archived = store.backend.listArchived()
    expect(archived).toHaveLength(1)
    expect(readFileSync(archived[0]!, 'utf8')).toContain(BODY)
    expect(store.searchMemory('量子船坞').hits).toEqual([])
    expect(await recallFor(store).execute({ name: TARGET })).not.toContain(BODY)
  })
})
