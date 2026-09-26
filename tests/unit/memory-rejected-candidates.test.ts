// plan56 片③：一键拒绝未成簇候选 —— 敢给批量出口的前提是**反悔得了**。
// 这一组走真 fs 临时目录：本片最要紧的判据（"移走的那份和当初那份逐字节相同"）
// 在内存桩上根本判不出来，只有盘上两次 readFileSync 对得上才算。
//
// ★ 三条歧义按此设计：
//   - "移走"若被写成"删掉再另存一份" ⇒ 逐字节对照会红（判据②）；
//   - 批量若不看名单只认路径 ⇒ 成簇的候选与合并稿会被一起清掉（判据④）；
//   - 回收站若并进 `insideMemory` ⇒ 它能被 `memory:get` / `memory:delete` 伸手进去（判据⑤的另一半）。

import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore, type MemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import { serializeMemory } from '@main/memory/memory-core'
import { MEMORY_LIMITS } from '@shared/memory'

const T0 = '2026-09-25T00:00:00.000Z'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-rejected-'))
})
afterEach(() => {
  nodeFsAdapter.rmSync(root, { recursive: true, force: true })
})

const candDir = (): string => join(root, 'candidates')
const rejectedDir = (): string => join(root, 'memory', 'rejected')
const candFile = (name: string): string => join(candDir(), `${name}.md`)
const makeStore = (): MemoryStore => createMemoryStore(root, nodeFsAdapter, { onWarn: () => {} })

/** 写一条候选，返回文件内容 —— 判据②要拿它跟搬走之后那份逐字节比 */
function writeCandidate(name: string, over: Partial<{ mergeSources: string[]; description: string }> = {}): string {
  nodeFsAdapter.mkdirSync(candDir(), { recursive: true })
  const text = serializeMemory({
    name,
    description: over.description ?? `关于 ${name} 的一条提案`,
    class: 'default',
    origin: 'reflection',
    evidence: null,
    createdAt: T0,
    updatedAt: T0,
    body: `正文 ${name}。`,
    ...(over.mergeSources ? { mergeSources: over.mergeSources } : {})
  })
  nodeFsAdapter.writeFileSync(candFile(name), text)
  return text
}

const listNames = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : []

/** 一份两来源的合并稿 + 它的两条来源 + 一条孤条 —— 片③所有判据的最小现场 */
function seedClusterAndSolo(): { draft: string; srcA: string; srcB: string; solo: string } {
  const srcA = candFile('src-a')
  const srcB = candFile('src-b')
  writeCandidate('src-a')
  writeCandidate('src-b')
  const draft = candFile('merged-draft')
  writeCandidate('merged-draft', { mergeSources: [srcA, srcB] })
  const solo = candFile('solo-one')
  writeCandidate('solo-one')
  return { draft, srcA, srcB, solo }
}

describe('判据① 「未成簇」只判一次，界面拿到的就是主进程允许的', () => {
  it('合并稿与它收走的来源都不算孤条', () => {
    const { solo } = seedClusterAndSolo()
    const store = makeStore()
    expect(store.list().unclustered).toEqual([solo])
    expect(store.list().candidates).toHaveLength(4)
  })

  it('没有合并稿时，全部候选都是未成簇（一键拒绝要能清干净整队）', () => {
    writeCandidate('a')
    writeCandidate('b')
    expect(makeStore().list().unclustered).toEqual([candFile('a'), candFile('b')])
  })
})

describe('判据② 移走的是那一份原文，逐字节相同', () => {
  it('candidates/ 少一条、rejected/ 多一条，内容一模一样', () => {
    const text = writeCandidate('solo-one')
    const store = makeStore()
    const file = candFile('solo-one')

    const res = store.rejectUnclustered(store.list().unclustered)

    expect(res).toEqual({ rejected: [file], skipped: [] })
    expect(existsSync(file)).toBe(false)
    const moved = listNames(rejectedDir())
    expect(moved).toHaveLength(1)
    expect(readFileSync(join(rejectedDir(), moved[0]), 'utf8')).toBe(text)
    // 列表读数同步跟上：待批少一条、回收站多一条
    const after = store.list()
    expect(after.candidates.map((c) => c.name)).toEqual([])
    expect(after.rejected.map((r) => r.name)).toEqual(['solo-one'])
  })

  it('回收站那份带得出"拒掉时刻"（界面按它排序、显示日期）', () => {
    writeCandidate('solo-one')
    const store = makeStore()
    store.rejectUnclustered(store.list().unclustered)
    const r = store.list().rejected[0]
    expect(r?.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(new Date(r!.rejectedAt).getTime()).not.toBeNaN()
  })
})

describe('判据④ 一键这一刀不碰成簇的候选与合并稿', () => {
  it('把四个路径全传进去 ⇒ 只走孤条，其余原地不动且带回理由', () => {
    const { draft, srcA, srcB, solo } = seedClusterAndSolo()
    const store = makeStore()

    const res = store.rejectUnclustered([draft, srcA, srcB, solo])

    expect(res.rejected).toEqual([solo])
    expect(res.skipped.map((x) => x.file).sort()).toEqual([draft, srcA, srcB].sort())
    expect(res.skipped[0]!.reason).toContain('未成簇')
    expect(listNames(candDir()).sort()).toEqual(['merged-draft.md', 'src-a.md', 'src-b.md'])
  })

  it('区外路径（生效条目 / 乱写的绝对路径）一律不动', () => {
    writeCandidate('solo-one')
    nodeFsAdapter.mkdirSync(join(root, 'notes'), { recursive: true })
    const noteFile = join(root, 'notes', 'live.md')
    nodeFsAdapter.writeFileSync(noteFile, 'x')
    const store = makeStore()

    const res = store.rejectUnclustered([noteFile, join(root, '..', 'elsewhere.md')])

    expect(res.rejected).toEqual([])
    expect(res.skipped).toHaveLength(2)
    expect(existsSync(noteFile)).toBe(true)
    expect(listNames(candDir())).toEqual(['solo-one.md'])
  })
})

describe('判据③ 放回待批队列后照常能批准', () => {
  it('恢复 ⇒ 回到 candidates/、队列里能批准生效', () => {
    writeCandidate('solo-one')
    const store = makeStore()
    store.rejectUnclustered(store.list().unclustered)
    const moved = join(rejectedDir(), listNames(rejectedDir())[0])

    expect(store.restoreRejected(moved)).toEqual({ ok: true })
    expect(existsSync(candFile('solo-one'))).toBe(true)
    expect(listNames(rejectedDir())).toEqual([])

    const approved = makeStore().approveCandidate(candFile('solo-one'))
    expect(approved.ok).toBe(true)
    expect(makeStore().list().entries.map((e) => e.name)).toEqual(['solo-one'])
  })

  it('同名提案已在队列里 ⇒ 拒绝恢复且不覆盖', () => {
    const text = writeCandidate('solo-one')
    const store = makeStore()
    store.rejectUnclustered(store.list().unclustered)
    const moved = join(rejectedDir(), listNames(rejectedDir())[0])
    writeCandidate('solo-one') // 队列里又出现一条同名的
    const before = readFileSync(moved, 'utf8')

    const res = store.restoreRejected(moved)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('solo-one')
    expect(readFileSync(moved, 'utf8')).toBe(before)
    expect(readFileSync(candFile('solo-one'), 'utf8')).toBe(text)
  })

  it('回收站外的路径想"恢复"进来 ⇒ 拒（不搬 notes / candidates 里的活文件）', () => {
    writeCandidate('solo-one')
    expect(makeStore().restoreRejected(candFile('solo-one')).ok).toBe(false)
    expect(existsSync(candFile('solo-one'))).toBe(true)
  })
})

describe('判据⑤ 回收站不进注入、不占上限，也别的口都伸不进来', () => {
  it('既不进 `listFiles()` 也不进 `list().entries`', () => {
    writeNote('live-note')
    writeCandidate('solo-one')
    const store = makeStore()
    store.rejectUnclustered(store.list().unclustered)
    const after = makeStore()

    // 分隔符按平台走：CI 在 Linux 上 `listFiles()` 发的是正斜杠，只拆 `\\` 会让整条路径留下（判据照旧，只是不再假设分隔符）
    expect(after.listFiles().map((f) => f.split(/[\\/]/).pop())).toEqual(['live-note.md'])
    expect(after.list().entries).toHaveLength(1)
    expect(after.list().rejected).toHaveLength(1)
  })

  it('清空队列后名额还回来：拒满上限再恢复写入通路', () => {
    for (let i = 0; i < MEMORY_LIMITS.maxCandidates; i++) writeCandidate(`c-${i}`)
    const store = makeStore()
    expect(store.list().candidates).toHaveLength(MEMORY_LIMITS.maxCandidates)
    const res = store.rejectUnclustered(store.list().unclustered)
    expect(res.rejected).toHaveLength(MEMORY_LIMITS.maxCandidates)
    expect(store.list().rejected).toHaveLength(MEMORY_LIMITS.maxCandidates)

    // 拒掉的件仍按文件数占名额的话，这里就会被上限挡死（R-A3 同族）。
    // 契约：`saveCandidateDetailed` 成功带 `file`、失败带 `reason`（它没有 `ok` 字段）
    const saved = store.saveCandidateDetailed({
      name: 'next-one',
      description: '上限之后写进来的下一条',
      class: 'default',
      body: '正文。'
    })
    expect(saved.file).toBeDefined()
    expect(saved.reason).toBeUndefined()
    expect(store.list().candidates.map((c) => c.name)).toEqual(['next-one'])
  })

  it('通用的读 / 删伸不进回收站（`memory:get`、`memory:delete` 走的就是这两个口）', () => {
    writeCandidate('solo-one')
    const store = makeStore()
    store.rejectUnclustered(store.list().unclustered)
    const moved = join(rejectedDir(), listNames(rejectedDir())[0])

    expect(store.get(moved)).toBeNull()
    expect(store.remove(moved, 'user')).toBe(false)
    expect(existsSync(moved)).toBe(true)
  })

  it('清空 ⇒ 件数对得上、盘上真没了；重复清空返回 0', () => {
    writeCandidate('a')
    writeCandidate('b')
    const store = makeStore()
    store.rejectUnclustered(store.list().unclustered)
    expect(store.list().rejected).toHaveLength(2)

    expect(store.clearRejected()).toBe(2)
    expect(listNames(rejectedDir())).toEqual([])
    expect(store.clearRejected()).toBe(0)
  })
})

describe('口径：拒绝全程不进事件流（与单条拒绝同一句话）', () => {
  it('移走 / 放回 / 清空 ⇒ 一条事件都不落，存活率不动', () => {
    writeCandidate('a')
    const store = makeStore()
    const before = store.backend.readEvents().events.length
    const statsBefore = store.computeStats(store.backend.readEvents().events)

    store.rejectUnclustered(store.list().unclustered)
    const moved = join(rejectedDir(), listNames(rejectedDir())[0])
    store.restoreRejected(moved)
    store.rejectUnclustered(store.list().unclustered)
    store.clearRejected()

    const events = store.backend.readEvents().events
    expect(events).toHaveLength(before)
    expect(store.computeStats(events)).toEqual(statsBefore)
  })
})

function writeNote(name: string): void {
  nodeFsAdapter.mkdirSync(join(root, 'notes'), { recursive: true })
  nodeFsAdapter.writeFileSync(
    join(root, 'notes', `${name}.md`),
    serializeMemory({
      name,
      description: `一条生效的经验 ${name}`,
      class: 'default',
      origin: 'user',
      evidence: null,
      createdAt: T0,
      updatedAt: T0,
      body: '正文。'
    })
  )
}
