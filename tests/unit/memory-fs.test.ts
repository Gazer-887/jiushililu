// 记忆 fs 后端与装配层单测（plan19 批 1）：路径越界、原子写落盘、手改文件可见、meta 收敛、迁移幂等。
// 用**内存 fs 适配器**（不碰真盘）—— `FsAdapter` 注入就是为这个存在的。

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import type { FsAdapter } from '@main/store/conversations-fs'
import {
  archivedDir,
  createFsMemoryBackend,
  emptyMeta,
  eventsPath,
  memoryDir,
  metaPath,
  migrateMemoryFormat,
  notePathFor,
  notesDir,
  rotateEventsIfNeeded
} from '@main/store/memory-fs'
import { archivedFileName, parseArchivedFileName } from '@shared/memory'
import { MAX_FILE_BYTES } from '@main/log'
import { createMemoryStore } from '@main/store/memory-store'

const ROOT = 'C:/tmp/root'
const norm = (p: string): string => p.replace(/\\/g, '/')

function mapFs(seed: Record<string, string> = {}): FsAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed).map(([k, v]) => [norm(k), v]))
  const dirs = new Set<string>()
  return {
    files,
    existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    mkdirSync: (p) => void dirs.add(norm(p)),
    readFileSync: (p) => {
      const v = files.get(norm(p))
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p, d) => void files.set(norm(p), d),
    renameSync: (a, b) => {
      const v = files.get(norm(a))
      if (v === undefined) throw new Error('ENOENT')
      files.set(norm(b), v)
      files.delete(norm(a))
    },
    rmSync: (p) => void files.delete(norm(p)),
    appendFileSync: (p, d) => {
      const key = norm(p)
      files.set(key, (files.get(key) ?? '') + d)
    },
    sizeBytes: (p) => new TextEncoder().encode(files.get(norm(p)) ?? '').length,
    readdirSync: (p) => {
      const prefix = `${norm(p)}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (!rest.includes('/')) names.add(rest)
      }
      return [...names]
    },
    fsyncFile: () => {},
    fsyncDir: () => {}
  }
}

describe('路径越界：file 来自渲染进程，必须挡在 notes/ 之内', () => {
  it('notes/ 之外：读回 null、删返回 false、写直接抛', () => {
    const fs = mapFs({ 'C:/tmp/root/evil.md': 'x' })
    const backend = createFsMemoryBackend(ROOT, fs)
    expect(backend.read('C:/tmp/root/evil.md')).toBeNull()
    expect(backend.remove('C:/tmp/root/evil.md')).toBe(false)
    expect(() => backend.write('C:/tmp/root/evil.md', 'x')).toThrow()
    expect(fs.files.has('C:/tmp/root/evil.md')).toBe(true)
  })

  it('兄弟目录 notes-evil/ 也挡得住（前缀比对会漏，relative 不会）', () => {
    const fs = mapFs()
    const backend = createFsMemoryBackend(ROOT, fs)
    expect(backend.read(`${notesDir(ROOT)}-evil/a.md`)).toBeNull()
  })
})

describe('落盘与回读', () => {
  it('save 之后文件落在 notes/ 下，list 能读回来', () => {
    const fs = mapFs()
    const store = createMemoryStore(ROOT, fs)
    const r = store.save({
      name: 'prefers-tables',
      description: '回答偏好用表格',
      class: 'style',
      body: '正文。'
    })
    expect(r.ok).toBe(true)
    expect(fs.files.has(norm(notePathFor(ROOT, 'prefers-tables')))).toBe(true)

    const idx = store.list()
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]!.name).toBe('prefers-tables')
    expect(idx.warnings).toEqual([])
  })

  it('用户手改（直接落文件）能被发现 —— 靠列目录，不靠落盘索引', () => {
    const fs = mapFs({
      [notePathFor(ROOT, 'hand-made')]:
        '---\nname: hand-made\ndescription: 手写的\nclass: knowledge\norigin: user\ncreatedAt: 2026-09-15T00:00:00.000Z\nupdatedAt: 2026-09-15T00:00:00.000Z\n---\n\n正文。'
    })
    const store = createMemoryStore(ROOT, fs)
    expect(store.list().entries.map((e) => e.name)).toEqual(['hand-made'])
  })
})

describe('meta.json：默认值、收敛、迁移幂等', () => {
  it('缺文件时给空 meta', () => {
    expect(createFsMemoryBackend(ROOT, mapFs()).readMeta()).toEqual(emptyMeta())
  })

  it('手改坏字段 → 收敛回合法形状（不让应用起不来）', () => {
    const fs = mapFs({
      [metaPath(ROOT)]: JSON.stringify({
        schemaVersion: 99,
        pendingReflection: ['ok', 123, null],
        fullAccessNoticeShownAt: 42
      })
    })
    expect(createFsMemoryBackend(ROOT, fs).readMeta()).toEqual({
      ...emptyMeta(),
      pendingReflection: ['ok']
    })
  })

  it('坏 JSON → 空 meta 并留痕，不抛', () => {
    const fs = mapFs({ [metaPath(ROOT)]: '{ 这不是 json' })
    const warns: string[] = []
    expect(createFsMemoryBackend(ROOT, fs, { onWarn: (m) => warns.push(m) }).readMeta()).toEqual(emptyMeta())
    expect(warns).toHaveLength(1)
  })

  it('迁移幂等：第一次初始化，第二次报"已是新格式"', () => {
    const fs = mapFs()
    expect(migrateMemoryFormat(ROOT, fs).migrated).toBe(true)
    expect(migrateMemoryFormat(ROOT, fs).reason).toBe('已是新格式')
  })

  it('迁移会建出 notes/ 与 memory/', () => {
    const fs = mapFs()
    migrateMemoryFormat(ROOT, fs)
    expect(fs.existsSync(notesDir(ROOT))).toBe(true)
    expect(fs.existsSync(metaPath(ROOT))).toBe(true)
    expect(memoryDir(ROOT).endsWith('memory')).toBe(true)
  })
})

describe('事件流：追加、坏行容忍、轮转', () => {
  it('追加一行一条，readEvents 读得回来', () => {
    const fs = mapFs()
    const backend = createFsMemoryBackend(ROOT, fs)
    backend.appendEvent('{"kind":"flag","at":"2026-09-15T00:00:00.000Z","conversationId":null,"name":"a"}')
    backend.appendEvent('{"kind":"recall","at":"2026-09-15T00:00:01.000Z","conversationId":"c1","name":"a","found":true}')
    const { events, skipped } = backend.readEvents()
    expect(events.map((e) => e.kind)).toEqual(['flag', 'recall'])
    expect(skipped).toBe(0)
  })

  it('坏行与半行被跳过，但**数得出来**（不许静默吞）', () => {
    const fs = mapFs({
      [eventsPath(ROOT)]:
        '{"kind":"flag","at":"2026-09-15T00:00:00.000Z","conversationId":null,"name":"a"}\n{ 半行\n'
    })
    const { events, skipped } = createFsMemoryBackend(ROOT, fs).readEvents()
    expect(events).toHaveLength(1)
    expect(skipped).toBe(1)
  })

  it('超过上限即轮转：当前文件后移为 events.1.jsonl', () => {
    const fs = mapFs({ [eventsPath(ROOT)]: 'x'.repeat(MAX_FILE_BYTES + 1) })
    expect(rotateEventsIfNeeded(ROOT, fs)).toBe(true)
    expect(fs.existsSync(`${memoryDir(ROOT)}/events.1.jsonl`)).toBe(true)
    expect(fs.sizeBytes(eventsPath(ROOT))).toBe(0)
  })

  it('没到上限不轮转', () => {
    const fs = mapFs({ [eventsPath(ROOT)]: 'x'.repeat(10) })
    expect(rotateEventsIfNeeded(ROOT, fs)).toBe(false)
    expect(fs.existsSync(`${memoryDir(ROOT)}/events.1.jsonl`)).toBe(false)
  })

  it('事件写不进去时告警但**不让记忆写入失败**（事件是观测，不是真相源）', () => {
    const fs = mapFs()
    const warns: string[] = []
    const backend = createFsMemoryBackend(ROOT, fs, { onWarn: (m) => warns.push(m) })
    fs.appendFileSync = () => {
      throw new Error('磁盘满了')
    }
    expect(() => backend.appendEvent('{}')).not.toThrow()
    expect(warns).toHaveLength(1)
  })
})

// —— D-106 记忆读盘缓存（真盘 + nodeFsAdapter：生产适配器带 mtimeMsBytes，缓存路径在此生效）——
describe('read() 内容缓存的新鲜度正确性（D-106）', () => {
  function withBackend(fn: (b: ReturnType<typeof createFsMemoryBackend>) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'jsl-memcache-'))
    try {
      fn(createFsMemoryBackend(root, nodeFsAdapter))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('外部手改（mtime/size 变了）→ 读到新内容，不吃缓存', () => {
    withBackend((b) => {
      const file = b.pathFor('cached-entry')
      b.write(file, '---\nname: cached-entry\n---\n\n第一版')
      expect(b.read(file)).toContain('第一版')
      writeFileSync(file, '---\nname: cached-entry\n---\n\n第二版被外部改长了', 'utf8')
      expect(b.read(file)).toContain('第二版被外部改长了')
    })
  })

  it('外部删除 → 读到 null；重新出现 → 读到新档（缓存条目不残留）', () => {
    withBackend((b) => {
      const file = b.pathFor('revive')
      b.write(file, '---\nname: revive\n---\n\n活着')
      expect(b.read(file)).toContain('活着')
      unlinkSync(file)
      expect(b.read(file)).toBeNull()
      writeFileSync(file, '---\nname: revive\n---\n\n复活', 'utf8')
      expect(b.read(file)).toContain('复活')
    })
  })

  it('backend.write 写完立读 → 新值（写后回填，本轮不再读盘）', () => {
    withBackend((b) => {
      const file = b.pathFor('refill')
      b.write(file, '---\nname: refill\n---\n\n旧')
      b.write(file, '---\nname: refill\n---\n\n新新')
      expect(b.read(file)).toContain('新新')
    })
  })

  it('注入式桩（无 mtimeMsBytes）→ 直读回退路径语义不变', () => {
    const fsStub = mapFs()
    const b = createFsMemoryBackend(ROOT, fsStub)
    const file = b.pathFor('stubbed')
    b.write(file, '文本')
    expect(b.read(file)).toBe('文本')
    fsStub.files.set(norm(file), '外部改')
    expect(b.read(file)).toBe('外部改')
  })
})


// ── plan53 片 1：可逆归档（真 backend，只测这一层自己的移动与门禁） ──────────────
describe('归档区：自动遗忘从硬删改成可移动（plan53 片 1）', () => {
  const BODY = '---\nname: n000\n---\n\n旧条目 0'
  function seeded() {
    const fs = mapFs({ [notePathFor(ROOT, 'n000')]: BODY })
    return { fs, backend: createFsMemoryBackend(ROOT, fs) }
  }

  it('archive 是**移动**：notes 里没了，archived/ 里正文逐字一致', () => {
    const { fs, backend } = seeded()
    const from = notePathFor(ROOT, 'n000')
    const to = backend.archive(from)
    expect(to).not.toBeNull()
    expect(norm(to!)).toContain(norm(archivedDir(ROOT)))
    expect(fs.files.has(norm(from))).toBe(false)
    expect(fs.files.get(norm(to!))).toBe(BODY)
  })

  it('归档不进生效集合：listFiles 只列 notes/，listArchived 只列 archived/', () => {
    const { backend } = seeded()
    backend.archive(notePathFor(ROOT, 'n000'))
    expect(backend.listFiles()).toEqual([])
    expect(backend.listArchived()).toHaveLength(1)
  })

  it('只有正式条目进得来：候选与归档区自身都不许再归档', () => {
    const { fs, backend } = seeded()
    const cand = backend.candidatePathFor('x')
    fs.writeFileSync(cand, 'c', 'utf8')
    expect(backend.archive(cand)).toBeNull()
    const a = backend.archive(notePathFor(ROOT, 'n000'))!
    expect(backend.archive(a)).toBeNull()
    expect(fs.files.has(norm(a))).toBe(true) // 被拒的那次不许动原文件
  })

  it('★ 恢复：回到 notes/、归档区清空、正文不变（恢复的是同一条，不是副本）', () => {
    const { fs, backend } = seeded()
    const a = backend.archive(notePathFor(ROOT, 'n000'))!
    const back = backend.restoreFrom(a)
    expect(norm(back!)).toBe(norm(notePathFor(ROOT, 'n000')))
    expect(fs.files.get(norm(notePathFor(ROOT, 'n000')))).toBe(BODY)
    expect(backend.listArchived()).toEqual([])
  })

  it('★ 同名已存在 → 恢复被拒，两边正文都不动（静默覆盖等于抹掉用户新写的那条）', () => {
    const { fs, backend } = seeded()
    const a = backend.archive(notePathFor(ROOT, 'n000'))!
    backend.write(notePathFor(ROOT, 'n000'), '---\nname: n000\n---\n\n重写过的')
    expect(backend.restoreFrom(a)).toBeNull()
    expect(fs.files.get(norm(notePathFor(ROOT, 'n000')))).toContain('重写过的')
    expect(fs.files.get(norm(a))).toBe(BODY) // 归档件留着，用户自己决定怎么合
  })

  it('★ remove 认归档区（K28 清空归档的地基）：假后端曾只认 notes，把这条藏住了', () => {
    const { fs, backend } = seeded()
    const a = backend.archive(notePathFor(ROOT, 'n000'))!
    expect(backend.remove(a)).toBe(true)
    expect(fs.files.has(norm(a))).toBe(false)
    expect(backend.listArchived()).toEqual([])
    expect(backend.remove(a)).toBe(false) // 第二次没有可删的东西，不许谎报成功
  })

  it('恢复的门禁在归档区内：notes/ 路径与兄弟目录 archived-evil/ 一律拒', () => {
    const { fs, backend } = seeded()
    expect(backend.restoreFrom(notePathFor(ROOT, 'n000'))).toBeNull()
    // 兄弟目录里放一个**文件名完全合规**的归档件：只查文件名挡不住它，必须靠目录边界
    const evil = `${archivedDir(ROOT)}-evil/${archivedFileName('n000', new Date('2026-09-20T08:30:12.456Z'))}`
    fs.writeFileSync(evil, BODY, 'utf8')
    expect(backend.restoreFrom(evil)).toBeNull()
    expect(fs.files.has(norm(evil))).toBe(true) // 被拒的那次不许动原文件
  })
})

describe('归档文件名规则（读写两侧唯一口径）', () => {
  it('slug 往返：带连字符的名字不被时刻里的连字符吃掉', () => {
    const at = new Date('2026-09-20T08:30:12.456Z')
    expect(parseArchivedFileName(archivedFileName('prefers-table-files', at))).toEqual({
      slug: 'prefers-table-files',
      archivedAt: at.toISOString()
    })
    // 时刻必须是**能 new Date 的**合法 ISO —— 文件名里那串 `-` 换回去才算还原，否则界面显示 Invalid Date
    expect(new Date(parseArchivedFileName(archivedFileName('n', at))!.archivedAt).getTime()).toBe(at.getTime())
  })

  it('同一 slug 两个时刻 → 两个文件名（按 slug 命名的话，第二次归档就顶掉第一次）', () => {
    const a = archivedFileName('n000', new Date('2026-09-20T08:30:12.456Z'))
    const b = archivedFileName('n000', new Date('2026-09-21T08:30:12.456Z'))
    expect(a).not.toBe(b)
    expect(parseArchivedFileName(a)!.slug).toBe(parseArchivedFileName(b)!.slug)
  })

  it('不合规文件名解析为 null（缺时刻 / 缺分隔 / 目录内混入别的文件）', () => {
    expect(parseArchivedFileName('n000.md')).toBeNull()
    expect(parseArchivedFileName('2026-09-20T08-30-12-456Zn000.md')).toBeNull()
    expect(parseArchivedFileName('readme.md')).toBeNull()
  })
})
