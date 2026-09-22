// 记忆去重单测（plan33 · 问题四）：相似度判定纯函数 + save 写入闸门 + merge 合并方向。
// 与 memory-core.test.ts 同一形状：内存 backend，不碰 fs。

import { describe, expect, it } from 'vitest'
import { createMemoryRepo } from '@main/memory/memory-core'
import { createArchiveMock } from '../helpers/memory-archive-mock'
import {
  findDuplicatePairs,
  findSimilarEntry,
  similarityScore
} from '@main/memory/similarity'

const ROOT = '/mem/notes'
const ARCH = '/mem/archived'

function memBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const events: string[] = []
  const arch = createArchiveMock({ files, notesRoot: ROOT, archRoot: ARCH })
  return {
    files,
    events,
    listFiles: () => [...files.keys()].sort(),
    candidatePathFor: (slug: string) => `${ROOT}/candidates/${slug}.md`,
    listCandidates: () => [],
    write: (f: string, t: string) => void files.set(f, t),
    remove: (f: string) => files.delete(f),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line),
    ...arch.backend
  }
}

let tick = 0
function makeRepo(seed: Record<string, string> = {}) {
  const backend = memBackend(seed)
  const base = new Date('2026-09-16T01:00:00.000Z').getTime()
  const repo = createMemoryRepo(backend, {
    now: () => new Date(base + tick++ * 60_000),
    onWarn: () => {},
    conversationId: () => 'c1'
  })
  return { repo, backend }
}

describe('相似度判定（similarity.ts 纯函数）', () => {
  it('全同 → 1；无关 → 低分', () => {
    expect(similarityScore('用户喜欢深色主题', '用户喜欢深色主题')).toBe(1)
    expect(similarityScore('用户喜欢深色主题', '项目使用 pnpm 管理依赖')).toBeLessThan(0.3)
  })

  it('口径边界（有意为之）：同义改写 bigram 分不清同义反义（深色/浅色主题 0.56 > 同义改写 0.17），阈值 0.7 宁可漏放', () => {
    // 反义对不得过线 —— 错杀"偏好相反"的两条比漏掉同义更伤信任
    expect(similarityScore('用户偏好深色主题', '用户偏好浅色主题')).toBeLessThan(
      0.7
    )
  })

  it('findSimilarEntry：描述包含 → 命中；近乎相同 → 命中；无关 → null', () => {
    const existing = [
      { name: 'a', description: '回答偏好用表格', file: 'a.md' },
      { name: 'b', description: '项目用 pnpm', file: 'b.md' }
    ]
    // 包含：target 是既有描述的子串
    expect(findSimilarEntry({ name: 'a2', description: '偏好用表格' }, existing)?.file).toBe('a.md')
    // 近乎相同：仅差一两个字
    expect(findSimilarEntry({ name: 'a3', description: '回答偏好用表格!!' }, existing)?.file).toBe('a.md')
    expect(findSimilarEntry({ name: 'c', description: '完全不相干的内容' }, existing)).toBeNull()
  })

  it('findDuplicatePairs：全库两两配对，只收过线对', () => {
    const entries = [
      { name: 'a', description: '用户偏好深色主题', file: 'a.md' },
      { name: 'b', description: '用户偏好深色主题', file: 'b.md' },
      { name: 'c', description: '终端用 pwsh', file: 'c.md' }
    ]
    const pairs = findDuplicatePairs(entries)
    expect(pairs).toHaveLength(1)
    expect([pairs[0]!.a.file, pairs[0]!.b.file].sort()).toEqual(['a.md', 'b.md'])
  })
})

describe('save 写入闸门（plan33）', () => {
  it('近乎同文换名 → 拒绝 + 带回 similar 指针 + 事件流留痕', async () => {
    const { repo, backend } = makeRepo()
    const first = repo.save({
      name: 'dark-theme-preference',
      description: '用户偏好深色主题',
      class: 'default',
      body: '界面用深色。',
      origin: 'model'
    })
    expect(first.ok).toBe(true)

    // 名字不同（撞名闸拦不住），描述近乎相同 —— 同义堆积的典型形态
    const second = repo.save({
      name: 'dark-mode-choice',
      description: '用户偏好深色主题',
      class: 'default',
      body: '另一条。',
      origin: 'model'
    })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.similar?.name).toBe('dark-theme-preference')
      expect(second.similar?.file).toBe(`${ROOT}/dark-theme-preference.md`)
      expect(second.reason).toContain('高度相似')
    }
    // 事件流要能回答"试过写什么、为什么没成"
    const events = backend.events.join('\n')
    expect(events).toContain('"rejected":true')
  })

  it('force=true 仍要另存 → 放行', () => {
    const { repo } = makeRepo()
    repo.save({ name: 'a-entry', description: '用户偏好深色主题', class: 'default', body: 'x', origin: 'user' })
    const res = repo.save({
      name: 'b-entry',
      description: '用户喜欢深色主题',
      class: 'default',
      body: 'y',
      origin: 'user',
      force: true
    })
    expect(res.ok).toBe(true)
  })

  it('编辑既有条目（带 file）不受闸门拦截', () => {
    const { repo } = makeRepo()
    const first = repo.save({ name: 'a-entry', description: '用户偏好深色主题', class: 'default', body: '旧文', origin: 'user' })
    expect(first.ok).toBe(true)
    const edit = repo.save({
      name: 'a-entry',
      description: '用户偏好深色主题（已补充）',
      class: 'default',
      body: '新文',
      origin: 'user',
      file: first.ok ? first.file : ''
    })
    expect(edit.ok).toBe(true)
  })

  it('list() 带出结构化 duplicates 配对', () => {
    const { repo } = makeRepo()
    repo.save({ name: 'a-entry', description: '用户偏好深色主题', class: 'default', body: 'x', origin: 'user', force: true })
    repo.save({ name: 'b-entry', description: '用户偏好深色主题', class: 'default', body: 'y', origin: 'user', force: true })
    const index = repo.list()
    expect(index.duplicates).toHaveLength(1)
    expect(index.duplicates[0]!.names.sort()).toEqual(['a-entry', 'b-entry'])
  })
})

describe('merge 合并（plan33）', () => {
  it('按 createdAt 重判方向：旧文并入新条，旧条删除，事件留痕', () => {
    const { repo, backend } = makeRepo()
    const older = repo.save({ name: 'old-entry', description: '旧描述', class: 'default', body: '旧正文', origin: 'user', force: true })
    const newer = repo.save({ name: 'new-entry', description: '新描述', class: 'default', body: '新正文', origin: 'user', force: true })
    expect(older.ok && newer.ok).toBe(true)
    if (!(older.ok && newer.ok)) return

    // 故意把参数顺序传反 —— 方向必须由 repo 内部按 createdAt 纠正
    const res = repo.merge(newer.file, older.file)
    expect(res.ok).toBe(true)

    const index = repo.list()
    expect(index.entries.map((e) => e.name).sort()).toEqual(['new-entry'])
    const kept = index.entries.find((e) => e.name === 'new-entry')!
    expect(kept.body).toContain('新正文')
    expect(kept.body).toContain('合并自「old-entry」')
    expect(kept.body).toContain('旧正文')

    const events = backend.events.join('\n')
    expect(events).toContain('"kind":"delete"')
  })

  it('一边不存在 → ok:false + 人话', () => {
    const { repo } = makeRepo()
    const res = repo.merge('/mem/notes/ghost.md', '/mem/notes/ghost2.md')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('不存在')
  })
})
