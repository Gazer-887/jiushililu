// 记忆 fs 后端与装配层单测（plan19 批 1）：路径越界、原子写落盘、手改文件可见、meta 收敛、迁移幂等。
// 用**内存 fs 适配器**（不碰真盘）—— `FsAdapter` 注入就是为这个存在的。

import { describe, expect, it } from 'vitest'
import type { FsAdapter } from '@main/store/conversations-fs'
import {
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
