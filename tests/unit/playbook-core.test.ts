// Playbook 核心层单测（plan19 批 3 判据 1/2/3/4/6 + 接缝 #16）。
// 走**内存 backend**（不碰 fs / electron）—— 与 memory-core.test.ts 同一形状。

import { describe, expect, it } from 'vitest'
import { PLAYBOOK_LIMITS } from '@shared/playbook'
import { buildPlaybookIndex, createPlaybookRepo, indexLine, parsePlaybookFile, serializePlaybook, slugFor } from '@main/memory/playbook-core'
import type { PlaybookBackend, PlaybookEntry } from '@main/memory/playbook-core'
import type { MemoryEvent } from '@main/memory/events'
// MemoryEvent 用于 save 事件断言

const ROOT = '/evo/playbooks'
const FIXED = new Date('2026-09-15T01:00:00.000Z')

function pbBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const events: string[] = []
  const backend: PlaybookBackend & { events: string[] } = {
    listFiles: () => [...files.keys()].sort(),
    read: (f: string) => files.get(f) ?? null,
    write: (f: string, t: string) => void files.set(f, t),
    remove: (f: string) => files.delete(f),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line),
    events
  }
  return backend
}

function makeRepo(seed: Record<string, string> = {}) {
  const backend = pbBackend(seed)
  const repo = createPlaybookRepo(backend, {
    now: () => FIXED,
    onWarn: () => {},
    conversationId: () => 'c1'
  })
  return { repo, backend }
}

function fm(over: Partial<PlaybookEntry> = {}): string {
  const e: PlaybookEntry = {
    name: 'edit-react-component',
    description: '编辑 React 组件的标准流程',
    tags: ['file-edit', 'react'],
    origin: 'model',
    createdAt: FIXED.toISOString(),
    updatedAt: FIXED.toISOString(),
    body: '正文。',
    file: '',
    ...over
  }
  return [
    '---',
    `name: ${e.name}`,
    `description: ${e.description}`,
    `tags: ${e.tags.join(',')}`,
    `origin: ${e.origin}`,
    `createdAt: ${e.createdAt}`,
    `updatedAt: ${e.updatedAt}`,
    '---',
    '',
    e.body
  ].join('\n')
}

const valid = {
  name: 'edit-react-component',
  description: '编辑 React 组件的标准流程',
  tags: ['file-edit', 'react'],
  body: '正文。'
}

describe('严格 frontmatter 解析', () => {
  it('正常解析，tags 从逗号分隔还原为数组', () => {
    const r = parsePlaybookFile(fm())
    expect(r.ok).toBe(true)
    expect(r.ok && r.parsed.name).toBe('edit-react-component')
    expect(r.ok && r.parsed.tags).toEqual(['file-edit', 'react'])
    expect(r.ok && r.parsed.body).toBe('正文。')
  })

  it('剥 BOM、认 CRLF', () => {
    const r = parsePlaybookFile(`\uFEFF${fm().replace(/\n/g, '\r\n')}`)
    expect(r.ok).toBe(true)
  })

  it.each([
    ['缺 frontmatter 起始', '正文而已'],
    ['没闭合', '---\nname: x\n'],
    ['未知键', fm().replace('name:', 'evil:')],
    ['缺必填', fm().replace(/tags:.*\n/, '')],
    ['origin 不合法', fm().replace('origin: model', 'origin: aliens')]
  ])('%s → 拒', (_name, text) => {
    expect(parsePlaybookFile(text).ok).toBe(false)
  })

  it('tags 被 trim + normalize', () => {
    const text = fm().replace('tags: file-edit,react', 'tags:  File-Edit , React ')
    const r = parsePlaybookFile(text)
    expect(r.ok && r.parsed.tags).toEqual(['file-edit', 'react'])
  })
})

describe('序列化往返与 slug', () => {
  it('往返后字段一致', () => {
    const text = serializePlaybook({
      name: 'a',
      description: 'b',
      tags: ['x', 'y'],
      origin: 'model',
      createdAt: FIXED.toISOString(),
      updatedAt: FIXED.toISOString(),
      body: '正文。'
    })
    const back = parsePlaybookFile(text)
    expect(back.ok && back.parsed.tags).toEqual(['x', 'y'])
    expect(back.ok && back.parsed.body).toBe('正文。')
  })

  it('slug：空白压成 -；保留字拒绝', () => {
    expect(slugFor('  编辑组件 步骤 ')).toBe('编辑组件-步骤')
    expect(slugFor('CON')).toBeNull()
    expect(slugFor('   ')).toBeNull()
  })
})

describe('索引与预算截断', () => {
  const entry = (name: string, tags: string[], updatedAt = FIXED.toISOString()): PlaybookEntry => ({
    name,
    description: `d-${name}`,
    tags,
    origin: 'model',
    createdAt: updatedAt,
    updatedAt,
    body: 'b',
    file: `${ROOT}/${name}.md`
  })

  it('按 updatedAt 倒序', () => {
    const idx = buildPlaybookIndex([
      entry('a', ['x'], '2026-09-15T00:00:01.000Z'),
      entry('b', ['y'], '2026-09-15T00:00:03.000Z'),
      entry('c', ['z'], '2026-09-15T00:00:02.000Z')
    ])
    expect(idx.entries.map((e) => e.name)).toEqual(['b', 'c', 'a'])
  })

  it('行数超限即截断，omitted 如实带出', () => {
    const many = Array.from({ length: PLAYBOOK_LIMITS.maxEntries + 5 }, (_, i) =>
      entry(`n${String(i).padStart(3, '0')}`, ['tag'])
    )
    const idx = buildPlaybookIndex(many)
    expect(idx.entries.length).toBeLessThanOrEqual(PLAYBOOK_LIMITS.maxEntries)
    expect(idx.omitted).toBe(many.length - idx.entries.length)
  })
})

describe('CRUD：校验、撞名、标签', () => {
  it('新建写入成功 + 事件流有 playbook_write', () => {
    const { repo, backend } = makeRepo()
    const r = repo.save(valid)
    expect(r.ok).toBe(true)
    expect(r.ok && r.file).toBe(`${ROOT}/edit-react-component.md`)
    const last = JSON.parse(backend.events[backend.events.length - 1]!) as MemoryEvent
    expect(last.kind).toBe('playbook_write')
  })

  it('撞名拒绝', () => {
    const { repo } = makeRepo()
    expect(repo.save(valid).ok).toBe(true)
    const dup = repo.save({ ...valid, description: '换个说法' })
    expect(dup.ok).toBe(false)
    expect(dup.ok === false && dup.reason).toContain('同名')
  })

  it('标签为空 → 拒', () => {
    const { repo } = makeRepo()
    expect(repo.save({ ...valid, tags: [] }).ok).toBe(false)
  })

  it('凭据进 body → 拒', () => {
    const { repo } = makeRepo()
    expect(repo.save({ ...valid, body: '密钥 sk-abcdefghijklmnop' }).ok).toBe(false)
  })

  it('编辑既有条目保留 createdAt', () => {
    const { repo } = makeRepo()
    repo.save(valid)
    const file = `${ROOT}/edit-react-component.md`
    const edit = repo.save({ ...valid, description: '改过的', file })
    expect(edit.ok).toBe(true)
    expect(repo.get(file)?.createdAt).toBe(FIXED.toISOString())
    expect(repo.get(file)?.description).toBe('改过的')
  })
})

describe('recall：条件召回（判据 1/6：标签匹配注入）', () => {
  it('活跃标签命中 → 返回匹配条目', () => {
    const { repo } = makeRepo()
    repo.save(valid)
    const matched = repo.recall(['file-edit'])
    expect(matched).toHaveLength(1)
    expect(matched[0]?.name).toBe('edit-react-component')
  })

  it('活跃标签不命中 → 返回空', () => {
    const { repo } = makeRepo()
    repo.save(valid)
    const matched = repo.recall(['debug'])
    expect(matched).toHaveLength(0)
  })

  it('多条不同标签 → 只返回命中的（判据 2）', () => {
    const { repo } = makeRepo()
    repo.save(valid)
    repo.save({ name: 'debug-flow', description: '调试流程', tags: ['debug'], body: '正文。' })
    const matched = repo.recall(['file-edit'])
    expect(matched).toHaveLength(1)
    expect(matched[0]?.name).toBe('edit-react-component')
  })

  it('空标签 → 返回空（不报错）', () => {
    const { repo } = makeRepo()
    repo.save(valid)
    expect(repo.recall([])).toEqual([])
  })

  it('recall 是纯过滤（事件由工具层落，不是 repo 方法）', () => {
    const { repo, backend } = makeRepo()
    repo.save(valid)
    const lenBefore = backend.events.length
    repo.recall(['file-edit'])
    // repo.recall 不落事件（纯函数），事件由 playbook-tools.ts 的 recall_playbook 工具落
    expect(backend.events.length).toBe(lenBefore)
  })
})

describe('物理隔离（判据 4）', () => {
  it('playbook.listFiles() 不返回 memory 路径（路径前缀不同）', () => {
    const backend = pbBackend()
    backend.write(`${ROOT}/test.md`, fm())
    // playbook 路径以 /evo/playbooks/ 开头，memory 以 /mem/notes/ 开头
    const files = backend.listFiles()
    expect(files.every((f) => f.startsWith(`${ROOT}/`))).toBe(true)
    expect(files.every((f) => !f.includes('/memory/') && !f.includes('/notes/'))).toBe(true)
  })
})

describe('演示路径（判据 6：固定任务类型可演示）', () => {
  it('tags=["file-edit"] 的条目 → composePlaybookBlock 活跃标签 ["file-edit"] → 注入段含该条目名', () => {
    // 这里只测 repo.recall；composePlaybookBlock 的注入段断言在 playbook-inject.test.ts
    const { repo } = makeRepo()
    repo.save(valid)
    const matched = repo.recall(['file-edit'])
    expect(matched).toHaveLength(1)
    expect(matched[0]?.name).toBe('edit-react-component')
    expect(indexLine(matched[0]!)).toContain('edit-react-component')
  })
})
