// 反思日额度定向测试（D-214，2026-10-11 [OpenCode·Leo] 随 M02 日额度批次建）。
// 口径：前置门返回 skipped:true 的反思不消耗日计数；已尝试的零候选、
// 输出不合格（坏格式）与失败仍计数。额度检查先于出队；耗尽不出队。
// 走真 fs 临时目录 —— meta 落盘/重读是磁盘层的事；日期不乱的旧日期由测试写死。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import type { ChatMessage } from '@shared/ipc'

const msgs: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(2200) }]

/** 隔离断言先于删除：根目录判错时抛在 rmSync 之前，防误删真实用户数据 */
function assertIsolatedTmp(root: string, prefix: string): void {
  expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
  expect(basename(root).startsWith(prefix)).toBe(true)
}

describe('D-214 日额度：各尝试结果的计数矩阵', () => {
  let root: string
  let cleanup: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-daily-quota-'))
    cleanup = () => rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => {
    assertIsolatedTmp(root, 'memory-daily-quota-')
    cleanup()
  })

  it('前置门 skipped（正文 < 2048）：不调 chat、不计数、仍出队返回 true', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 100 })
    })
    store.enqueueReflection('c1')
    await expect(store.runReflection('c1')).resolves.toBe(true)
    expect(chat).not.toHaveBeenCalled()
    expect(store.backend.readMeta().reflectionCount).toBe(0)
    expect(store.backend.readMeta().reflectionQueue).toEqual([])
  })

  it('skipped 之后队列继续出队：启动补跑循环不被"未计数"卡住', async () => {
    const seen: string[] = []
    const chat = vi.fn(async () => ({ content: '[]' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: (id) => {
        seen.push(id)
        return true
      },
      getConversationForReflect: (id) => ({ messages: msgs, bodyBytes: id === 'short' ? 100 : 4096 })
    })
    store.enqueueReflection('short')
    store.enqueueReflection('long')
    // 启动循环同款：无参连跑，false 即停
    let rounds = 0
    for (;;) {
      const ran = await store.runReflection()
      if (!ran) break
      if (++rounds > 10) throw new Error('补跑循环没有停')
    }
    expect(seen).toEqual(['short', 'long'])
    expect(store.backend.readMeta().reflectionQueue).toEqual([])
    expect(chat).toHaveBeenCalledTimes(1) // skipped 那次没调模型
    expect(store.backend.readMeta().reflectionCount).toBe(1) // 只有 long 计
  })

  it('completed 只增一次：正常跑完 count 恰好 1，不另造零候选双计数', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 })
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('零候选（completed 路径）计数：模型按要求跑完但没产出', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 })
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('坏格式输出计数：调用真发生过，形状不合格不免费', async () => {
    const chat = vi.fn(async () => ({ content: '这不是 JSON' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 })
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('反思执行器抛错计数：一次失败也是一次额度', async () => {
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: async () => {
        throw new Error('boom')
      },
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: () => {}
    })
    store.enqueueReflection('c1')
    await expect(store.runReflection('c1')).resolves.toBe(true)
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('未尝试分支不计数：会话不存在（既有提前跳过语义不变）', async () => {
    const chat = vi.fn(async () => ({ content: '[]' }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: chat,
      conversationsExists: () => false,
      getConversationForReflect: () => null,
      onReflectionLog: () => {}
    })
    store.enqueueReflection('ghost')
    await expect(store.runReflection('ghost')).resolves.toBe(true)
    expect(chat).not.toHaveBeenCalled()
    expect(store.backend.readMeta().reflectionCount).toBe(0)
  })

  it('耗尽不出队：count 达 dailyLimit → 返回 false 且队列原样保留', async () => {
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      dailyLimit: 1,
      onReflectionLog: () => {}
    })
    store.enqueueReflection('a')
    store.enqueueReflection('b')
    expect(await store.runReflection('a')).toBe(true)
    expect(await store.runReflection('b')).toBe(false) // 额度先于出队判：不动队列
    expect(store.backend.readMeta().reflectionQueue).toEqual(['b'])
    expect(store.backend.readMeta().reflectionCount).toBe(1)
  })

  it('串行连跑在日上限处精确截止：不会多跑一条', async () => {
    const seen: string[] = []
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: (id) => {
        seen.push(id)
        return true
      },
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      dailyLimit: 2,
      onReflectionLog: () => {}
    })
    for (const id of ['a', 'b', 'c']) store.enqueueReflection(id)
    let ran = 0
    for (;;) {
      const r = await store.runReflection()
      if (!r) break
      ran++
      if (ran > 10) throw new Error('串行循环没有停')
    }
    expect(seen).toEqual(['a', 'b'])
    expect(store.backend.readMeta().reflectionQueue).toEqual(['c'])
    expect(store.backend.readMeta().reflectionCount).toBe(2)
  })

  it('跨日重建：昨天计数不挡今天（旧日期先归零再计）', async () => {
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: () => {}
    })
    // 写死一个肯定不同于"今天"的旧日期（避开 0 点附近翻车，同 memory-queue 既有做法）
    const stale = store.backend.readMeta()
    stale.reflectionDate = '2020-01-01'
    stale.reflectionCount = 20
    stale.reflectionQueue = ['c1']
    store.backend.writeMeta(stale)
    await store.runReflection('c1')
    const after = store.backend.readMeta()
    expect(after.reflectionDate).toBe(new Date().toISOString().slice(0, 10))
    expect(after.reflectionCount).toBe(1)
  })

  it('重启保持：跑完计数落盘 → 新建 store 重读不变', async () => {
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      onReflectionLog: () => {}
    })
    store.enqueueReflection('c1')
    await store.runReflection('c1')
    expect(store.backend.readMeta().reflectionCount).toBe(1)
    const restarted = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 })
    })
    expect(restarted.backend.readMeta().reflectionCount).toBe(1)
    expect(restarted.backend.readMeta().reflectionDate).toBe(new Date().toISOString().slice(0, 10))
  })

  it('重启后额度仍生效：昨天满额的计数在新实例同样挡住今天之前（只在本日未跨日时）', async () => {
    const store = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      dailyLimit: 1,
      onReflectionLog: () => {}
    })
    store.enqueueReflection('a')
    await store.runReflection('a')
    // 同一天重建：count=1 达到 dailyLimit=1 —— 新实例同样拒跑（额度是盘上状态）
    const restarted = createMemoryStore(root, nodeFsAdapter, {
      reflectChat: vi.fn(async () => ({ content: '[]' })),
      conversationsExists: () => true,
      getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
      dailyLimit: 1,
      onReflectionLog: () => {}
    })
    restarted.backend.writeMeta({
      ...restarted.backend.readMeta(),
      reflectionQueue: ['b']
    })
    expect(await restarted.runReflection('b')).toBe(false)
    expect(restarted.backend.readMeta().reflectionQueue).toEqual(['b'])
  })
})
