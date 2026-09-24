// plan55 片④-a：预筛的**装配层**判据 —— `prescreen.ts` 那 16 条只证明纯函数会算，
// 这一组证明"有人接了它"：候选真的落盘、来源真的没被提前删、批准时来源真的逐条收掉。
// K15 的教训就写在这旁边：接口声明了、界面格子也建好了、装配那一跳没人接，一道闸都不会红。

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import { serializeMemory } from '@main/memory/memory-core'

let root = ''
let cleanup: (() => void) | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-prescreen-'))
  cleanup = () => nodeFsAdapter.rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  cleanup?.()
})

function candidatesRoot(): string {
  return join(root, 'candidates')
}

function writeCandidate(name: string, cls: string, desc: string): string {
  const file = join(candidatesRoot(), `${name}.md`)
  nodeFsAdapter.mkdirSync(candidatesRoot(), { recursive: true })
  nodeFsAdapter.writeFileSync(
    file,
    serializeMemory({
      name,
      description: desc,
      class: cls as 'default',
      origin: 'model',
      evidence: null,
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z',
      body: '提案正文。'
    })
  )
  return file.split(tmpdir()).join('')
}

function candFile(name: string): string {
  return join(candidatesRoot(), `${name}.md`)
}

const chatReturning = (payload: unknown) =>
  vi.fn(async () => ({
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 }
  }))

const cluster = (sources: string[], over: Record<string, unknown> = {}) => ({
  sources,
  name: 'verbatim-output',
  description: '要求逐字回贴原始 stdout',
  class: 'default',
  body: '用户要求逐字回贴原始 stdout，并严格禁止任务书之外的探测或命令。',
  ...over
})

function storeWith(chat: unknown) {
  return createMemoryStore(root, nodeFsAdapter, {
    reflectChat: chat as never,
    onWarn: () => {},
    onReflectionLog: () => {}
  })
}

describe('runPrescreen 真的接上了（不是只有纯函数会算）', () => {
  it('两条同义候选 ⇒ 落一份合并稿，且**来源候选一条不删**', async () => {
    writeCandidate('verbatim-raw-output', 'default', '要求逐字回贴 stdout')
    writeCandidate('verbatim-raw-stdout', 'default', '要求逐字回贴 stdout 输出')
    const chat = chatReturning([cluster(['c1', 'c2'])])
    const store = storeWith(chat)

    const report = await store.runPrescreen()
    expect(report.ok).toBe(true)
    expect(report.merged).toBe(1)

    const names = readdirSync(candidatesRoot()).sort()
    expect(names).toContain('verbatim-output.md')
    // 来源必须还在 —— 用户批准合并稿之前动它们 = 静默丢
    expect(names).toContain('verbatim-raw-output.md')
    expect(names).toContain('verbatim-raw-stdout.md')

    const merged = store.list().candidates.find((c) => c.name === 'verbatim-output')
    expect(merged?.mergeSources).toHaveLength(2)
  })

  it('单条簇不写合并稿（没被归并的东西再抄一份只会让队列更长）', async () => {
    writeCandidate('solo', 'default', '一条孤零零的提案')
    const chat = chatReturning([cluster(['c1'], { name: 'solo-merged' })])
    const report = await storeWith(chat).runPrescreen()
    expect(report.clusters).toBe(1)
    expect(report.merged).toBe(0)
  })

  it('合并稿名字撞来源 ⇒ 避让，不许报"已存在同名提案"把合并稿挡在门外', async () => {
    writeCandidate('a', 'default', '要求逐字回贴 stdout')
    writeCandidate('b', 'default', '要求逐字回贴 stdout 输出')
    // 模型把合并稿起名叫 `a` —— 正是它的一条来源
    const chat = chatReturning([cluster(['c1', 'c2'], { name: 'a' })])
    const report = await storeWith(chat).runPrescreen()
    expect(report.merged).toBe(1)
    const names = readdirSync(candidatesRoot())
    expect(names).toContain('a-merged-2.md')
    expect(names).toContain('a.md') // 来源没被顶掉
  })

  it('批准合并稿 ⇒ 新条目进 notes，来源逐条消失且各记一笔 delete(mergedInto)', async () => {
    writeCandidate('a', 'default', '要求逐字回贴 stdout')
    writeCandidate('b', 'default', '要求逐字回贴 stdout 输出')
    const chat = chatReturning([cluster(['c1', 'c2'])])
    const store = storeWith(chat)
    await store.runPrescreen()
    const merged = store.list().candidates.find((c) => c.name === 'verbatim-output')!

    const res = store.approveCandidate(merged.file)
    expect(res.ok).toBe(true)

    const leftNames = store.list().candidates.map((c) => c.name)
    expect(leftNames).not.toContain('verbatim-output')
    expect(leftNames).not.toContain('a')
    expect(leftNames).not.toContain('b')
    expect(store.list().entries.map((e) => e.name)).toContain('verbatim-output')

    const { events } = store.backend.readEvents()
    const deletes = events.filter((e) => e.kind === 'delete')
    expect(deletes.map((e) => e.name).sort()).toEqual(['a', 'b'])
    expect(deletes.every((e) => e.mergedInto === 'verbatim-output')).toBe(true)
    // ⚠️ 记的是 delete 不是 archive —— 这些从未生效，没有"可恢复"可言
    expect(events.some((e) => e.kind === 'archive')).toBe(false)
  })

  it('模型答非所问 ⇒ 一条不写、一条不丢、如实报原因', async () => {
    writeCandidate('a', 'default', '一条提案')
    const chat = chatReturning('我看看这几条……')
    const report = await storeWith(chat).runPrescreen()
    expect(report.ok).toBe(true)
    expect(report.merged).toBe(0)
    expect(report.rejected.length).toBeGreaterThan(0)
    expect(storeWith(chat) && readdirSync(candidatesRoot())).toEqual(['a.md'])
  })

  it('没注入模型通道 ⇒ 明确报"无法预筛"，不静默返回空成功', async () => {
    writeCandidate('a', 'default', '一条提案')
    const store = createMemoryStore(root, nodeFsAdapter, { onWarn: () => {}, onReflectionLog: () => {} })
    const report = await store.runPrescreen()
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('模型通道')
  })

  it('用量透传：厂商报了就有数，**没报就是 null**（不许替它编 0，同 K15）', async () => {
    writeCandidate('a', 'default', '一条提案')
    writeCandidate('b', 'default', '另一条提案')
    const chat = vi.fn(async () => ({
      content: JSON.stringify([cluster(['c1', 'c2'])])
    }))
    const report = await storeWith(chat).runPrescreen()
    expect(report.usage).toBeNull()
  })
})
