// M04：只用专用临时正文根与真 SQLite；合成坏数据不包含任何真实凭据。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryTools } from '@main/agent/tools/memory-tools'
import { createFtsIndex } from '@main/memory/fts'
import { serializeMemory } from '@main/memory/memory-core'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import { createMemoryStore, type MemoryStore } from '@main/store/memory-store'
import type { MemoryClass } from '@shared/memory'

const roots: string[] = []
const STAMP = '2026-10-08T00:00:00.000Z'

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'jsl-fts-lifecycle-'))
  roots.push(value)
  mkdirSync(join(value, 'notes'))
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    expect(resolve(dirname(value))).toBe(resolve(tmpdir()))
    expect(basename(value).startsWith('jsl-fts-lifecycle-')).toBe(true)
    rmSync(value, { recursive: true, force: true })
  }
})

function seed(value: string, file = 'harbor', fields: Partial<Parameters<typeof serializeMemory>[0]> = {}): string {
  const target = join(value, 'notes', `${file}.md`)
  writeFileSync(target, serializeMemory({
    name: file,
    description: '港口资料',
    class: 'knowledge',
    origin: 'user',
    evidence: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    body: '量子船坞保持停泊位置。',
    ...fields
  }))
  return target
}

function diskNames(value: string, query: string): string[] {
  const index = createFtsIndex(join(value, 'fts.db'))
  try {
    return index.search(query).map((hit) => hit.name)
  } finally {
    index.close()
  }
}

function names(store: MemoryStore, query: string): string[] {
  const result = store.searchMemory(query)
  expect(result.status).toBe('ready')
  return result.hits.map((hit) => hit.name)
}

function corrupt(value: string): void {
  writeFileSync(join(value, 'fts.db'), 'M04 synthetic invalid SQLite cache')
}

function recall(store: MemoryStore) {
  return createMemoryTools({
    repo: store,
    conversationId: () => 'm04-fixture',
    searchMemory: (query, limit) => store.searchMemory(query, limit)
  }).find((tool) => tool.schema.name === 'recall')!
}

describe('FTS资格与正文读侧一致', () => {
  it.each(['name', 'description', 'body', 'evidence'] as const)('冷建不索引被%s硬拒的条目', (field) => {
    const value = root()
    // 与既有凭据守卫单测相同的纯合成已知前缀。
    const synthetic = 'ghp_abcdefghijklmnop'
    seed(value, 'blocked', field === 'evidence'
      ? { evidence: { conversationId: synthetic } }
      : { [field]: field === 'body' ? `量子船坞 ${synthetic}` : synthetic })
    const store = createMemoryStore(value, nodeFsAdapter)
    expect(store.list().total).toBe(0)
    expect(store.list().warnings.length).toBeGreaterThan(0)
    expect(diskNames(value, '量子船坞')).toEqual([])
  })

  it('画像消解只索引最新生效档案，旧正文保留在盘但不可检索', () => {
    const value = root()
    const old = seed(value, 'old-profile', { name: 'user-profile', class: 'profile', body: '陈旧画像水獭。' })
    const latest = seed(value, 'new-profile', {
      name: 'user-profile', class: 'profile', body: '最新画像白鹭。', updatedAt: '2026-10-09T00:00:00.000Z'
    })
    const store = createMemoryStore(value, nodeFsAdapter)
    expect(store.list().entries.map((entry) => entry.file)).toEqual([latest])
    expect(existsSync(old)).toBe(true)
    expect(diskNames(value, '陈旧画像')).toEqual([])
    expect(diskNames(value, '最新画像')).toEqual(['user-profile'])
  })

  it('K36确认档仍生效并提示，索引不得擅自把它变为硬拒', () => {
    const value = root()
    seed(value, 'reviewable', { body: '跑测试前自动执行 lint，量子船坞记录。' })
    const store = createMemoryStore(value, nodeFsAdapter)
    expect(store.list().total).toBe(1)
    expect(store.list().needsReview).toHaveLength(1)
    expect(diskNames(value, '量子船坞')).toEqual(['reviewable'])
  })

  it('外部新增、修改为硬拒、删除都在查询前复核，非法项不挤占limit', () => {
    const value = root()
    const file = seed(value)
    const store = createMemoryStore(value, nodeFsAdapter)
    expect(names(store, '量子船坞')).toEqual(['harbor'])
    seed(value, 'external', { body: '量子船坞新增的外部资料。' })
    expect(new Set(names(store, '量子船坞'))).toEqual(new Set(['harbor', 'external']))
    seed(value, 'harbor', { body: '量子船坞 ghp_abcdefghijklmnop 合成硬拒资料。' })
    expect(store.searchMemory('量子船坞', 1)).toMatchObject({ status: 'ready', hits: [{ name: 'external' }] })
    unlinkSync(file)
    unlinkSync(join(value, 'notes', 'external.md'))
    expect(names(store, '量子船坞')).toEqual([])
  })

  it('归档摘行；恢复立即回填，可由第二个连接观察', () => {
    const value = root()
    const file = seed(value)
    const store = createMemoryStore(value, nodeFsAdapter)
    const archived = store.backend.archive(file)
    expect(archived).toBeTruthy()
    expect(names(store, '量子船坞')).toEqual([])
    // 冷装配确认归档已从缓存摘除，然后单独检验恢复。
    const reopened = createMemoryStore(value, nodeFsAdapter)
    expect(diskNames(value, '量子船坞')).toEqual([])
    expect(reopened.restoreArchived(archived!).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('量子船坞')
    expect(diskNames(value, '量子船坞')).toEqual(['harbor'])
  })

  it('恢复立即回填独立判据，不借查询前刷新掩盖恢复漏同步', () => {
    const value = root()
    const file = seed(value)
    const store = createMemoryStore(value, nodeFsAdapter)
    const archived = store.backend.archive(file)!
    const reopened = createMemoryStore(value, nodeFsAdapter)
    expect(diskNames(value, '量子船坞')).toEqual([])
    expect(reopened.restoreArchived(archived).ok).toBe(true)
    expect(diskNames(value, '量子船坞')).toEqual(['harbor'])
  })
})

describe('衍生缓存故障不改变正文操作结果', () => {
  it('写期坏缓存不产生假失败，写入事件存在；精确回取继续，相关查询明确不可用', async () => {
    const value = root()
    const warnings: string[] = []
    const codes: unknown[] = []
    const store = createMemoryStore(value, nodeFsAdapter, { onWarn: (message, extra) => {
      warnings.push(message)
      codes.push(extra?.code)
    } })
    corrupt(value)
    const saved = store.save({ name: 'harbor', description: '资料', class: 'knowledge', origin: 'user', body: '量子船坞正文。' })
    expect(saved.ok).toBe(true)
    expect(readFileSync(join(value, 'notes', 'harbor.md'), 'utf8')).toContain('量子船坞正文')
    expect(store.backend.readEvents().events.some((event) => event.kind === 'write' && event.name === 'harbor')).toBe(true)
    expect(store.searchMemory('量子船坞')).toEqual({ status: 'unavailable', hits: [] })
    expect(await recall(store).execute({ name: 'harbor' })).toContain('量子船坞正文')
    const result = await recall(store).execute({ name: '量子船坞' })
    expect(result).toContain('全文检索暂不可用')
    expect(result).not.toContain(value)
    expect(result).not.toContain('SQLITE')
    expect(warnings.some((message) => message.includes('全文索引'))).toBe(true)
    expect(codes).toContain('SQLITE_NOTADB')
    expect(warnings.join('\n')).not.toContain(value)
  })

  it('查询期故障不抛原始异常或伪装零命中，缓存移走重启可从未变正文重建', () => {
    const value = root()
    const file = seed(value)
    const bodyBefore = readFileSync(file)
    const store = createMemoryStore(value, nodeFsAdapter)
    corrupt(value)
    expect(store.searchMemory('量子船坞')).toEqual({ status: 'unavailable', hits: [] })
    expect(readFileSync(file)).toEqual(bodyBefore)
    renameSync(join(value, 'fts.db'), join(value, 'fts.db.bad-fixture'))
    const rebuilt = createMemoryStore(value, nodeFsAdapter)
    expect(names(rebuilt, '量子船坞')).toEqual(['harbor'])
    expect(readFileSync(file)).toEqual(bodyBefore)
  })

  it('初始化坏缓存与用户显式关闭分开；关闭不建库，精确回取不受影响', async () => {
    const value = root()
    seed(value)
    corrupt(value)
    const broken = createMemoryStore(value, nodeFsAdapter)
    expect(broken.searchMemory('量子船坞')).toEqual({ status: 'unavailable', hits: [] })
    const offRoot = root()
    seed(offRoot)
    const off = createMemoryStore(offRoot, nodeFsAdapter, { ftsPath: null })
    expect(off.searchMemory('量子船坞')).toEqual({ status: 'disabled', hits: [] })
    expect(existsSync(join(offRoot, 'fts.db'))).toBe(false)
    expect(await recall(off).execute({ name: 'harbor' })).toContain('量子船坞')
  })

  it('缓存告警回调异常也不能掩盖已完成正文写入；正文磁盘失败仍传播', () => {
    const value = root()
    const store = createMemoryStore(value, nodeFsAdapter, { onWarn: () => { throw new Error('fixture logger failed') } })
    corrupt(value)
    expect(store.save({ name: 'safe', description: '资料', class: 'knowledge', origin: 'user', body: '已存正文。' }).ok).toBe(true)
    const failFile = join(value, 'notes', 'fail.md')
    const failed = createMemoryStore(value, {
      ...nodeFsAdapter,
      renameSync(from, to) {
        if (to === failFile) throw new Error('fixture source disk failure')
        nodeFsAdapter.renameSync(from, to)
      }
    }, { ftsPath: null })
    expect(() => failed.save({ name: 'fail', description: '独立磁盘故障', class: 'knowledge', origin: 'user', body: '磁盘失败。', force: true })).toThrow('fixture source disk failure')
    expect(existsSync(failFile)).toBe(false)
  })

  it.each(['remove', 'archive', 'restore'] as const)('%s正文操作不因坏索引变成假失败', (action) => {
    const value = root()
    const file = seed(value)
    const before = readFileSync(file)
    const store = createMemoryStore(value, nodeFsAdapter)
    const archived = action === 'restore' ? store.backend.archive(file)! : null
    corrupt(value)
    if (action === 'remove') {
      expect(store.remove(file, 'user')).toBe(true)
      expect(existsSync(file)).toBe(false)
    } else if (action === 'archive') {
      const target = store.backend.archive(file)
      expect(target).toBeTruthy()
      expect(readFileSync(target!)).toEqual(before)
      expect(existsSync(file)).toBe(false)
    } else {
      expect(store.restoreArchived(archived!).ok).toBe(true)
      expect(readFileSync(file)).toEqual(before)
      expect(existsSync(archived!)).toBe(false)
    }
    expect(store.searchMemory('量子船坞')).toEqual({ status: 'unavailable', hits: [] })
  })

  it('运行中专用缓存表被清空，正文未变也会重建', () => {
    const value = root()
    seed(value)
    const store = createMemoryStore(value, nodeFsAdapter)
    const cache = createFtsIndex(join(value, 'fts.db'))
    cache.clear()
    cache.close()
    expect(diskNames(value, '量子船坞')).toEqual([])
    expect(names(store, '量子船坞')).toEqual(['harbor'])
  })

  it.each(['knowledge', 'style'] as MemoryClass[])('%s合法正文冷重建清除幽灵缓存', (cls) => {
    const value = root()
    seed(value, 'harbor', { class: cls })
    const stale = createFtsIndex(join(value, 'fts.db'))
    stale.upsert({ file: 'ghost.md', name: 'ghost', class: cls, body: '幽灵记录' })
    stale.close()
    const rebuilt = createMemoryStore(value, nodeFsAdapter)
    expect(names(rebuilt, '幽灵')).toEqual([])
    expect(names(rebuilt, '量子船坞')).toEqual(['harbor'])
  })
})
