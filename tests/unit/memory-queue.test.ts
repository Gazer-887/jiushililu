// 反思队列单测（plan19 批 2 判据 4 + 接缝 #22 + 审查 C P1）。
// 走真 fs 临时目录 —— enqueueReflection 调 backend.readMeta/writeMeta，
// 这是磁盘层的事；mock backend 就测不到"队列落盘后能否读回"了。
//
// 钉的判据：
// - 写队列 → 重启（重新 createMemoryStore）→ 队列仍在
// - 日上限 20 → 第 21 次 enqueueReflection 返回 false（排队不丢）且队列仍追加
// - reflectionCount 按日期重置（reflectionDate 不同 → 归零）
// - 补跑时校验会话 id 存在 → 坏 id 跳过 + 留痕 + 出队（审查 C P1）
// - runReflection 不 await：装配层负责异步触发，runReflection 本身返回 Promise（不阻塞队列出队逻辑）

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import type { ChatMessage } from '@shared/ipc'
import type { FsAdapter } from '@main/store/conversations-fs'
import { nodeFsAdapter } from '@main/store/conversations-fs'

// 用 stub fs 而不是 node fs —— 让"日期"可控（避免测试在 0 点附近跑就翻车）
function makeStubFs(opts: { now?: () => Date } = {}): FsAdapter {
  const real = nodeFsAdapter
  const now = opts.now ?? (() => new Date('2026-09-15T01:00:00.000Z'))
  // 借真 fs 的所有方法（mkdtempSync 已经建了真目录），只覆盖读 meta 时不影响 ——
  // 这里其实只是占位，让 createMemoryStore 接受"它确实是 FsAdapter"
  return real
}

function makeTmpRoot(opts: { now?: () => Date } = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mem-queue-'))
  return { root, cleanup: () => nodeFsAdapter.rmSync(root, { recursive: true, force: true }) }
}

const msgs: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(2200) }]

describe('队列持久化（判据 4：写队列 → 重启 → 队列仍在）', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    const r = makeTmpRoot()
    root = r.root
    cleanup = r.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('enqueue → 重新 createMemoryStore → 队列仍在', () => {
    const store = createMemoryStore(root)
    expect(store.enqueueReflection('c1')).toBe(true)
    expect(store.enqueueReflection('c2')).toBe(true)

    // "重启"：重建 store（同一 root，meta.json 已落盘）
    const store2 = createMemoryStore(root)
    expect(store2.dequeueReflection()).toBe('c1')
    expect(store2.dequeueReflection()).toBe('c2')
    expect(store2.dequeueReflection()).toBeNull()
  })

  it('enqueue 幂等：同一会话 id 重复入队不重复加', () => {
    const store = createMemoryStore(root)
    expect(store.enqueueReflection('c1')).toBe(true)
    expect(store.enqueueReflection('c1')).toBe(true) // 幂等也算成功
    expect(store.dequeueReflection()).toBe('c1')
    expect(store.dequeueReflection()).toBeNull()
  })
})

describe('日上限（判据 4：队列长度上限 = dailyLimit，默认 20）', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    const r = makeTmpRoot()
    root = r.root
    cleanup = r.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('队列长度达 20 → 第 21 次返回 false；出队腾位 → 又可入队', () => {
    const store = createMemoryStore(root)
    for (let i = 0; i < 20; i++) {
      expect(store.enqueueReflection(`c${i}`)).toBe(true)
    }
    expect(store.enqueueReflection('c20')).toBe(false)
    // 出队腾位（不丢）
    expect(store.dequeueReflection()).toBe('c0')
    // 腾位后又能入队
    expect(store.enqueueReflection('c20')).toBe(true)
  })

  it('自定义队列容量（5）→ 第 6 次返回 false', () => {
    const store = createMemoryStore(root, nodeFsAdapter, { dailyLimit: 5 })
    for (let i = 0; i < 5; i++) {
      expect(store.enqueueReflection(`c${i}`)).toBe(true)
    }
    expect(store.enqueueReflection('c5')).toBe(false)
    expect(store.dequeueReflection()).toBe('c0')
    expect(store.enqueueReflection('c5')).toBe(true)
  })

  it('runReflection 计数达日上限 → 跳过不执行', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const logs: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      dailyLimit: 1,
      onReflectionLog: (msg) => logs.push(msg)
    })
    // dailyLimit=1 → 只能入队 1 条；第 2 条入队失败（队列满）
    store.enqueueReflection('c1')
    expect(store.enqueueReflection('c2')).toBe(false)
    // 跑 c1 → 成功（出队 + 执行 + 计数 = 1）
    await store.runReflection('c1')
    expect(store.backend.readMeta().reflectionCount).toBe(1)
    expect(chat).toHaveBeenCalledTimes(1)
    // 跑 c2 → 被日上限拦（count >= limit），直接跳过
    await store.runReflection('c2')
    expect(store.backend.readMeta().reflectionCount).toBe(1)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('日上限'))).toBe(true)
  })
})

describe('按日期重置（reflectionCount 跨日归零）', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    const r = makeTmpRoot()
    root = r.root
    cleanup = r.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('enqueue：meta 里 reflectionDate 是"昨天" → 调用时归零后再 +1', () => {
    const store = createMemoryStore(root)
    // 把 meta 写成"昨天已经跑了 10 次"
    const meta = store.backend.readMeta()
    meta.reflectionDate = '2020-01-01' // 跟"今天"肯定不同
    meta.reflectionCount = 10
    store.backend.writeMeta(meta)

    // 调 enqueue：先重置 count，再判上限
    expect(store.enqueueReflection('c1')).toBe(true)
    const after = store.backend.readMeta()
    expect(after.reflectionDate).toBe(new Date().toISOString().slice(0, 10))
    expect(after.reflectionCount).toBe(0) // 还没跑反思，enqueue 不 +1
  })

  it('runReflection：跨日 → 归零后再 +1（昨天跑 10 次，今天跑 1 次 = 1）', async () => {
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 })
    })
    // 直接往 meta 写"昨天已跑 10 次 + c1 在队列里"（跳过 enqueue 的日期重置逻辑）
    const stale = store.backend.readMeta()
    stale.reflectionDate = '2020-01-01'
    stale.reflectionCount = 10
    stale.reflectionQueue = ['c1']
    store.backend.writeMeta(stale)

    // runReflection 先重置日期（跨日 → count 归零），再跑 c1（计数 = 1）
    await store.runReflection('c1')
    const after = store.backend.readMeta()
    expect(after.reflectionDate).toBe(new Date().toISOString().slice(0, 10))
    expect(after.reflectionCount).toBe(1)
  })
})

describe('runReflection：先校验会话 id 存在（审查 C P1）', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    const r = makeTmpRoot()
    root = r.root
    cleanup = r.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('会话不存在 → 跳过 + 留痕（onReflectionLog 收到）+ 不调 chat', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const logs: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => false,
      getConversationForReflect: () => null,
      onReflectionLog: (msg) => logs.push(msg)
    })
    store.enqueueReflection('does-not-exist')
    await store.runReflection('does-not-exist')
    expect(chat).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('不存在'))).toBe(true)
  })

  it('会话存在但正文读不出来 → 跳过 + 留痕', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const logs: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => null,
      onReflectionLog: (msg) => logs.push(msg)
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(chat).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('读不出来'))).toBe(true)
  })

  it('会话存在 + 正文够长 → 调 chat + 落候选 + 计数 +1', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify([
        { name: 'brand-new', description: 'd', class: 'style', body: 'b' }
      ])
    }))
    const logs: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: (msg) => logs.push(msg)
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(chat).toHaveBeenCalledTimes(1)
    const idx = store.list()
    expect(idx.candidates).toHaveLength(1)
    expect(idx.candidates[0]?.name).toBe('brand-new')
    expect(store.backend.readMeta().reflectionCount).toBe(1)
    expect(logs.some((l) => l.includes('反思完成'))).toBe(true)
  })

  it('会话存在 + 正文过前置门（< 2048）→ 不调 chat，但计数仍 +1（一次失败的反思也是一次额度）', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 100 })
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(chat).not.toHaveBeenCalled()
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('未注入 reflectChat → 跳过 + 留痕', async () => {
    const logs: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: (msg) => logs.push(msg)
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(logs.some((l) => l.includes('未注入'))).toBe(true)
  })

  it('getStats：事件流空 → null；非空 → 返回 { survivalRate, usageRate }', () => {
    const store = createMemoryStore(root)
    expect(store.getStats()).toBeNull()

    // 写一条记忆（落 write 事件）
    store.save({ name: 'a', description: 'd', class: 'style', body: '正文。' })
    const s = store.getStats()
    expect(s).not.toBeNull()
    expect(s?.written).toBe(1)
    expect(s?.alive).toBe(1)
    expect(s?.survivalRate).toBe(1)
    // 没人 recall → 使用率 0（alive 非 0 时为数值，不是 null —— shared/memory.ts 契约）
    expect(s?.usageRate).toBe(0)
  })
})
