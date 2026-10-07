// plan63 片 2：FTS 与记忆装配层的接线测试。真盘 tmpdir + nodeFsAdapter + 真 SQLite（ftsPath 注入 tmpdir），
// 索引内容用**第二个连接**打开同一 DB 断言（WAL 读可见）。候选/归档区不进索引也是判据。
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFtsIndex } from '@main/memory/fts'
import { createMemoryTools } from '@main/agent/tools/memory-tools'
import { serializeMemory } from '@main/memory/memory-core'
import { createMemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'

const dirs: string[] = []
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsl-fts-wiring-'))
  dirs.push(root)
  return root
}
// SQLite 连接持句柄 + Windows ⇒ 目录常删不掉（shell-session 同款）；残留进系统 tmp，不判红
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 句柄未释放，留给系统临时目录 */
    }
  }
})

function openIndex(root: string) {
  // root 即 memory 数据根，FTS DB 与 notes/ 同级（store 装配的缺省落点）
  const idx = createFtsIndex(join(root, 'fts.db'))
  return idx
}

describe('FTS 与记忆装配层接线（plan63 片 2）', () => {
  it('save→可检索；remove→摘行；命中顺序取 BM25', () => {
    const root = makeRoot()
    const store = createMemoryStore(root, nodeFsAdapter)
    const saved = store.save({
      name: 'deploys-habit',
      description: '部署偏好',
      class: 'style',
      body: '部署总是先跑测试再打包'
    })
    expect(saved.ok).toBe(true)
    const idx = openIndex(root)
    try {
      expect(idx.search('部署').map((h) => h.file)).toHaveLength(1)
      expect(idx.search('部署')[0].name).toBe('deploys-habit')
    } finally {
      idx.close()
    }
    expect(store.remove(join(notesOf(root), 'deploys-habit.md'), 'user')).toBe(true)
    const after = openIndex(root)
    try {
      expect(after.search('部署')).toEqual([])
    } finally {
      after.close()
    }
  })

  it('冷回填：启动前已存在的 notes 条目，索引建好后可检索', () => {
    const root = makeRoot()
    const notes = join(root, 'notes')
    mkdirSync(notes, { recursive: true })
    const text = serializeMemory({
      name: 'pre-existing',
      description: '启动前就在',
      class: 'knowledge',
      origin: 'reflection',
      evidence: null,
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
      body: '冷启动回填的正文，提到代理端口。'
    })
    writeFileSync(join(notes, 'pre-existing.md'), text)
    const store = createMemoryStore(root, nodeFsAdapter)
    expect(store.get(join(notes, 'pre-existing.md'))).not.toBeNull()
    const idx = openIndex(root)
    try {
      expect(idx.search('代理端口').length).toBe(1)
    } finally {
      idx.close()
    }
  })

  it('候选区不进索引；批准提升为正式条目后才进', () => {
    const root = makeRoot()
    const store = createMemoryStore(root, nodeFsAdapter)
    const cand = store.saveCandidateDetailed({
      name: 'cand-entry',
      description: '候选条目',
      class: 'knowledge',
      origin: 'reflection',
      evidence: null,
      body: '候选正文，提到猫窝位置'
    })
    expect(cand.reason).toBeUndefined()
    const before = openIndex(root)
    try {
      expect(before.search('猫窝')).toEqual([])
    } finally {
      before.close()
    }
    const approved = store.approveCandidate(cand.file)
    expect(approved.ok).toBe(true)
    const after = openIndex(root)
    try {
      expect(after.search('猫窝').length).toBe(1)
    } finally {
      after.close()
    }
  })

  it('ftsPath:null 显式关闭：记忆本体照常，不产生 DB 文件', () => {
    const root = makeRoot()
    const store = createMemoryStore(root, nodeFsAdapter, { ftsPath: null })
    const saved = store.save({
      name: 'no-fts',
      description: '索引关闭时的记忆',
      class: 'knowledge',
      body: '正文'
    })
    expect(saved.ok).toBe(true)
    expect(existsSync(join(root, 'fts.db'))).toBe(false)
  })

  it('searchMemory 集成：BM25 召回生效条目；recall 未命中走兜底；FTS 关闭恒空', async () => {
    const root = makeRoot()
    const store = createMemoryStore(root, nodeFsAdapter)
    const saved = store.save({
      name: 'proxy-port',
      description: '代理端口',
      class: 'knowledge',
      body: '代理端口是 65532'
    })
    expect(saved.ok).toBe(true)
    expect(store.searchMemory('代理').map((h) => h.name)).toEqual(['proxy-port'])

    const tools = createMemoryTools({
      repo: store,
      conversationId: () => 'c1',
      searchMemory: (q, l) => store.searchMemory(q, l)
    })
    const recall = tools.find((t) => t.schema.name === 'recall')!
    // 查询词按空格分（短语 AND 语义）：「代理 端口」两短语都在 proxy-port 里；连写的「代理设置」不命中是设计内
    const out = (await recall.execute({ name: '代理 端口' })) as string
    expect(out).toContain('全文检索找到 1 条相关')
    expect(out).toContain('proxy-port')

    const off = createMemoryStore(root, nodeFsAdapter, { ftsPath: null })
    expect(off.searchMemory('代理')).toEqual([])
  })
})

function notesOf(root: string): string {
  return join(root, 'notes')
}
