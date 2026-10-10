// 同一数据根与同名条目同时落盘，验证列表、重建与删除不会跨库。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import { createPlaybookStore } from '@main/store/playbook-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'

it.each(['memory', 'playbook'])('真fs重建后删除%s不损伤另一库', (side) => {
  const root = mkdtempSync(join(tmpdir(), 'jsl-isolation-'))
  const memoryAt = () => createMemoryStore(root, nodeFsAdapter, { ftsPath: null })
  try {
    const memory = memoryAt(), playbook = createPlaybookStore(root)
    const m = memory.save({ name: 'same-name', description: '语义记忆', class: 'default', origin: 'user', body: '记忆正文独立' })
    const p = playbook.save({ name: 'same-name', description: '经验手册', tags: ['debug'], body: '手册正文独立' })
    expect(m.ok).toBe(true); expect(p.ok).toBe(true)
    if (!m.ok || !p.ok || !('file' in m)) throw new Error('隔离夹具未落入生效库')
    expect(m.file).not.toBe(p.file)
    const assertLists = (mem = memoryAt(), pb = createPlaybookStore(root)) => {
      expect(mem.listFiles()).toEqual([m.file])
      expect(pb.listFiles()).toEqual([p.file])
      expect(mem.list().entries.map((e) => [e.file, e.body])).toEqual([[m.file, '记忆正文独立']])
      expect(pb.list().entries.map((e) => [e.file, e.body])).toEqual([[p.file, '手册正文独立']])
    }
    assertLists(memory, playbook)
    assertLists()
    const survivor = side === 'memory' ? p.file : m.file
    const before = readFileSync(survivor)
    expect(side === 'memory' ? memoryAt().remove(m.file) : createPlaybookStore(root).remove(p.file)).toBe(true)
    expect(existsSync(survivor)).toBe(true)
    expect(readFileSync(survivor)).toEqual(before)
    expect(memoryAt().listFiles()).toEqual(side === 'memory' ? [] : [m.file])
    expect(createPlaybookStore(root).listFiles()).toEqual(side === 'playbook' ? [] : [p.file])
  } finally {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-isolation-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
