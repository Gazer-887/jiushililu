// plan55 片③（K29）：候选区的治理三道闸 —— 候选互检 / 同名不覆盖 / 条数上限。
// 09-25 实测积压 71 条、40+ 条落在 8 个同义簇，成因就是这三处全空。
// 走真 repo + 内存 backend（与 `memory-core.test.ts` 同一形状），不 mock 存储层。

import { describe, expect, it } from 'vitest'
import { MEMORY_LIMITS, type MemorySaveResult } from '@shared/memory'
import { createMemoryRepo, serializeMemory, type MemoryBackend } from '@main/memory/memory-core'
import { createArchiveMock } from '../helpers/memory-archive-mock'

const ROOT = '/mem/notes'
const CAND = `${ROOT}/candidates`
const ARCH = '/mem/archived'
const FIXED = new Date('2026-09-15T01:00:00.000Z')

function memBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const events: string[] = []
  const arch = createArchiveMock({ files, notesRoot: ROOT, archRoot: ARCH })
  const backend: MemoryBackend & { events: string[]; files: Map<string, string> } = {
    listFiles: () =>
      [...files.keys()].filter((f) => f.startsWith(`${ROOT}/`) && !f.startsWith(`${CAND}/`)).sort(),
    candidatePathFor: (slug: string) => `${CAND}/${slug}.md`,
    listCandidates: () => [...files.keys()].filter((f) => f.startsWith(`${CAND}/`)).sort(),
    write: (f: string, t: string) => void files.set(f, t),
    read: (f: string) => files.get(f) ?? null,
    remove: (f: string) => files.delete(f),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line),
    ...arch.backend,
    events
  }
  return backend
}

function makeRepo(seed: Record<string, string> = {}) {
  const backend = memBackend(seed)
  const repo = createMemoryRepo(backend, {
    now: () => FIXED,
    onWarn: () => {},
    conversationId: () => 'c1',
    modelWritesNeedApproval: () => true
  })
  return { repo, backend }
}

const noteText = (name: string, desc: string): string =>
  serializeMemory({
    name,
    description: desc,
    class: 'default',
    origin: 'user',
    evidence: null,
    createdAt: FIXED.toISOString(),
    updatedAt: FIXED.toISOString(),
    body: '正文。'
  })

const proposal = (name: string, description: string) => ({
  name,
  description,
  class: 'default' as const,
  body: '提案正文。',
  origin: 'model' as const
})

const reasonOf = (r: MemorySaveResult): string => (r.ok === false ? r.reason : '')

describe('候选互检：模型不许把同一件事提第二遍', () => {
  it('与**待批候选**高度相似 ⇒ 拒，且不再落一条新的', () => {
    const { repo, backend } = makeRepo()
    const first = repo.save(proposal('verbatim-raw-output', '用户要求子代理逐字回贴原始 stdout'))
    expect(first.ok).toBe(true)
    const second = repo.save(
      proposal('verbatim-raw-stdout', '用户要求子代理逐字回贴原始 stdout 输出')
    )
    expect(second.ok).toBe(false)
    expect(reasonOf(second)).toContain('待批准提案')
    expect(backend.listCandidates()).toHaveLength(1)
  })

  // ⚠️ 夹具是"近乎相同"的一对 —— 这道闸的尺子是字面 bigram（`MEMORY_SIMILAR_THRESHOLD` 0.7），
  // **换一套措辞它就漏**（实测：'一次交付不要回头确认' vs '一次做完不必回头确认' 未过线）。
  // 漏的那一半归片④ 的模型预筛，不许假装这道闸管语义。
  it('拒因要具体到"哪一条"，不许回一句"没写进去"（模型据此才知道要停）', () => {
    const { repo } = makeRepo()
    repo.save(proposal('one-shot-delivery', '一次交付不要回头确认，跑完再汇报'))
    const r = repo.save(proposal('one-shot-delivery-v2', '一次交付不要回头确认，跑完之后再汇报'))
    expect(r.ok).toBe(false)
    expect(reasonOf(r)).toContain('one-shot-delivery')
  })

  it('用户手动写**不**被候选拦：候选尚未生效，不该挡住显式写入', () => {
    const { repo } = makeRepo()
    repo.save(proposal('quiet-mode', '长任务期间免打扰'))
    const r = repo.save({
      name: 'quiet-mode-2',
      description: '长任务期间不要打断',
      class: 'default',
      body: '用户自己写的版本。',
      origin: 'user'
    })
    expect(r.ok).toBe(true)
  })
})

describe('同名撞 slug：后写的顶掉前一条 = 静默丢提案', () => {
  it('第二条同名提案被拒，第一条原文还在', () => {
    const { repo, backend } = makeRepo()
    expect(repo.save(proposal('dupe', '第一条描述')).ok).toBe(true)
    const before = backend.read(`${CAND}/dupe.md`)
    const second = repo.save(proposal('dupe', '第二条描述试图顶掉它'))
    expect(second.ok).toBe(false)
    expect(reasonOf(second)).toContain('同名提案')
    expect(backend.read(`${CAND}/dupe.md`)).toBe(before)
  })
})

describe('候选条数上限：满了报数，不静默丢、也不折进归档', () => {
  const fill = (n: number): Record<string, string> => {
    const seed: Record<string, string> = {}
    for (let i = 0; i < n; i++) {
      seed[`${CAND}/c${i}.md`] = noteText(`c${i}`, `第 ${i} 条待批准提案的摘要说明`)
    }
    return seed
  }

  it('达到上限 ⇒ 新提案被拒，理由报出当前条数与上限', () => {
    const { repo, backend } = makeRepo(fill(MEMORY_LIMITS.maxCandidates))
    const r = repo.save(proposal('one-more', '再多一条提案'))
    expect(r.ok).toBe(false)
    expect(reasonOf(r)).toContain(String(MEMORY_LIMITS.maxCandidates))
    expect(backend.listCandidates()).toHaveLength(MEMORY_LIMITS.maxCandidates)
  })

  it('被拒时**已有候选一条不丢**（上限不是清理的借口）', () => {
    const seed = fill(MEMORY_LIMITS.maxCandidates)
    const { repo, backend } = makeRepo(seed)
    const before = [...backend.listCandidates()].sort()
    repo.save(proposal('one-more', '再多一条提案'))
    expect([...backend.listCandidates()].sort()).toEqual(before)
  })

  it('差一条到上限时仍可入（边界不许提前拒）', () => {
    const { repo } = makeRepo(fill(MEMORY_LIMITS.maxCandidates - 1))
    expect(repo.save(proposal('last-one', '最后一条提案')).ok).toBe(true)
  })
})
