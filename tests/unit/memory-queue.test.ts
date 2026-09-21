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

// K8 的第二个漏口：反思那条链**不经** `runAgentLoop`，而是把盘上的会话正文直接交给 provider。
// 被「停止生成」留下的空正文助手轮因此原样出境 —— Anthropic 对空 text 块报 400，
// 而 `memory/reflection.ts` 的 catch 只回空候选、本层不留痕 ⇒ 这条会话的记忆沉淀**静默归零**。
describe('反思历史出境前整形（K8 第二漏口）', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTmpRoot()
    root = t.root
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it('reflectChat 收到的消息里不存在空正文的 assistant', async () => {
    const seen: ChatMessage[][] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: async (messages) => {
        seen.push(messages)
        return { content: '[]' }
      },
      conversationsExists: () => true,
      getConversationForReflect: () => ({
        messages: [
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '' },
          { role: 'user', content: '第二问' }
        ],
        bodyBytes: 4096
      })
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(seen).toHaveLength(1)
    for (const m of seen[0] ?? []) {
      if (m.role !== 'assistant') continue
      expect(m.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('整形不许改条数与角色序列（反思靠"谁说了什么"的先后推因果）', async () => {
    const seen: ChatMessage[][] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: async (messages) => {
        seen.push(messages)
        return { content: '[]' }
      },
      conversationsExists: () => true,
      getConversationForReflect: () => ({
        messages: [
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '' },
          { role: 'user', content: '第二问' }
        ],
        bodyBytes: 4096
      })
    })
    store.enqueueReflection('c2')
    await store.runReflection('c2')
    expect((seen[0] ?? []).map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect((seen[0] ?? [])[0]?.content).toBe('第一问')
  })
})

/**
 * R17（由 K8 两轮复查发现）：`memory/reflection.ts` 以前把 `chat` 的异常咽成 `{ candidates: [] }`，
 * 于是装配层那条「反思执行器抛错」分支**永远进不去** —— 净效果是"该沉淀却没沉淀"零留痕。
 * 改语义的另一半必须在这里钉住：**throw 出去不许把队列卡死**（出队发生在调用之前），
 * 且"一次失败的反思也是一次额度"这条既有口径不变。
 */
describe('反思执行器抛错：必须留痕、且不许卡队列（R17）', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTmpRoot()
    root = t.root
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  it('chat 抛错 → 日志里有「反思执行器抛错」，计数照常 +1，且 runReflection 不 reject', async () => {
    const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: async () => {
        throw new Error('400 empty text block')
      },
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: (msg, extra) => logs.push({ msg, extra })
    })
    store.enqueueReflection('c1')
    await expect(store.runReflection('c1')).resolves.toBeUndefined()
    const fail = logs.find((l) => l.msg.includes('反思执行器抛错'))
    expect(fail, '反思失败被咽掉了 —— 这就是 R17：零候选 + 零日志').toBeDefined()
    expect(String(fail?.extra?.error)).toContain('400 empty text block')
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('阳性对照：坏的那一条之后，下一条照常反思（队列没被卡住）', async () => {
    let boom = true
    const ok: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: async () => {
        if (boom) {
          boom = false
          throw new Error('第一次就是坏的')
        }
        ok.push('ran')
        return { content: '[]' }
      },
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: () => {}
    })
    store.enqueueReflection('c1')
    store.enqueueReflection('c2')
    await store.runReflection('c1')
    await store.runReflection('c2')
    expect(ok).toEqual(['ran'])
    expect(store.backend.readMeta().reflectionQueue).toEqual([])
    expect(store.backend.readMeta().reflectionCount).toBe(2)
  })
})
