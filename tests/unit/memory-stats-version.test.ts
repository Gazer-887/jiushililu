import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    rmSync(root, { recursive: true, force: true })
  }
})
