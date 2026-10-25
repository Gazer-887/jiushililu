import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'

it('事件版本随真实落盘保留，重建store不会把旧版本纠正并入当前版本', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-stats-version-'))
  try {
    const first = createMemoryStore(root, nodeFsAdapter, { appVersion: '0.13.104', ftsPath: null })
    expect(first.save({ name: 'a', description: '摘要', body: '正文', class: 'default', origin: 'user' }).ok).toBe(true)
    first.record({ kind: 'correct', conversationId: 'c1', name: 'a' })
    first.record({ kind: 'correct', conversationId: 'c1', name: 'a' })
    const next = createMemoryStore(root, nodeFsAdapter, { appVersion: '0.13.105', ftsPath: null })
    next.record({ kind: 'correct', conversationId: 'c2', name: 'a' })
    const restarted = createMemoryStore(root, nodeFsAdapter, { appVersion: '0.13.106', ftsPath: null })
    expect(restarted.getStats()?.correctionByVersion).toEqual([
      { appVersion: '0.13.104', statsVersion: 1, correctedCount: 1, repeatCorrectedCount: 1, repeatCorrectionRate: 1 },
      { appVersion: '0.13.105', statsVersion: 1, correctedCount: 1, repeatCorrectedCount: 0, repeatCorrectionRate: 0 }
    ])
  } finally {
    // 隔离断言先于删除：根目录判错时抛在 rmSync 之前，防误删真实用户数据（B 批同款纪律）
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('memory-stats-version-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

it('正式合并去向真实落盘：重建 store 后仍能从 delete 事件查到 mergedInto，正文与统计不变（S2-30）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-merge-into-'))
  try {
    const first = createMemoryStore(root, nodeFsAdapter, { appVersion: '0.13.200', ftsPath: null })
    expect(first.save({ name: 'old-note', description: '旧条目', body: '旧正文。', class: 'default', origin: 'user' }).ok).toBe(true)
    expect(first.save({ name: 'new-note', description: '新条目', body: '新正文。', class: 'default', origin: 'user' }).ok).toBe(true)
    const fileOf = (name: string): string => first.list().entries.find((e) => e.name === name)!.file
    expect(first.merge(fileOf('old-note'), fileOf('new-note')).ok).toBe(true)

    // 重建 store：只能从磁盘事件流核实去向，不看内存态
    const restarted = createMemoryStore(root, nodeFsAdapter, { appVersion: '0.13.200', ftsPath: null })
    const { events } = restarted.backend.readEvents()
    const deletes = events.filter((e) => e.kind === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toMatchObject({ name: 'old-note', by: 'user', mergedInto: 'new-note' })
    expect(deletes[0]).not.toHaveProperty('candidate')

    const kept = restarted.list().entries.find((e) => e.name === 'new-note')!
    expect(kept.body).toContain('旧正文。')
    const stats = restarted.getStats()!
    // ⚠️ 口径如实记录：`written` 数的是 write **事件**（2 次 save + merge 对保留条目的那一笔 = 3），
    // `deleted` 只数正式 delete（1），故 alive = 3 - 1 = 2。这是既有口径，S2-30 不改统计语义
    //（只加 mergedInto），此处按真实值断言并在报告里登记为观察项。
    expect(stats.written).toBe(3)
    expect(stats.alive).toBe(2)
    expect(stats.survivalRate).toBeCloseTo(2 / 3, 5)
  } finally {
    // 隔离断言先于删除（同文件既有纪律）：根目录判错时抛在 rmSync 之前
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('memory-merge-into-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
