import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'

it('校准采集区分拒写、门前跳过/调用命中、预算截断，落盘重读不丢读数', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-calibration-'))
  try {
    const chat = vi.fn(async () => ({ content: JSON.stringify([{ name: 'from-reflection', description: '反思摘要', class: 'default', body: '反思正文' }]) }))
    const store = createMemoryStore(root, nodeFsAdapter, {
      ftsPath: null, dailyLimit: 2, appVersion: '0.13.104', reflectChat: chat,
      getConversationForReflect: (id) => ({ messages: [{ role: 'user', content: '文本' }], bodyBytes: id === 'short' ? 100 : 3000 })
    })
    expect(store.save({ name: 'bad', description: 'x'.repeat(121), body: '正文', class: 'default', origin: 'user' }).ok).toBe(false)
    const index = store.list()
    store.beginTurn({ ...index, total: 10, omitted: 4 })
    store.enqueueReflection('short')
    await store.runReflection('short')
    expect(store.backend.readMeta().reflectionCount).toBe(1) // 保留既有额度契约；采样另外区分未调用
    store.enqueueReflection('long')
    await store.runReflection('long')
    expect(chat).toHaveBeenCalledTimes(1)
    const restarted = createMemoryStore(root, nodeFsAdapter, { ftsPath: null })
    const c = restarted.getStats()?.calibration
    expect(c?.rejectedWrites).toBe(1)
    expect(c?.rejectionReasons.some((x) => x.reason.includes('description') && x.count === 1)).toBe(true)
    expect(c?.reflection).toEqual({ attempted: 1, skipped: 1, failed: 0, hits: 1, hitRate: 1 })
    expect(c?.injection).toMatchObject({ samples: 1, totalEntries: 10, omittedEntries: 4, truncatedSamples: 1, truncationRate: 0.4 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('队列积压天数跨重建恢复；旧队列无入队坐标时明确计未知，不能补造年龄', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-calibration-queue-'))
  try {
    let now = new Date('2026-10-01T00:00:00Z')
    const opts = { ftsPath: null, now: () => now }
    const first = createMemoryStore(root, nodeFsAdapter, opts)
    first.enqueueReflection('known')
    const meta = first.backend.readMeta()
    meta.reflectionQueue.push('legacy')
    first.backend.writeMeta(meta)
    now = new Date('2026-10-03T00:00:00Z')
    const next = createMemoryStore(root, nodeFsAdapter, opts)
    next.enqueueReflection('new')
    const sample = next.getStats()?.calibration?.queueSamples.at(-1)
    expect(sample).toMatchObject({ depth: 3, waitDays: [2, 0], unknownAges: 1 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
