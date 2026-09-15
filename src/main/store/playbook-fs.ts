// Playbook 的**磁盘后端**（plan19 批 3）：布局、原子写、读盘校验兜底、格式迁移。
// 布局：`<root>/evolution/playbooks/<slug>.md` 一条一文件；`<root>/evolution/events.jsonl` 事件流；
//       `<root>/evolution/meta.json` 放版本。
// ⚠️ 与 `memory/` **物理隔离**（plan19 §4.1：分开的理由是预算语义不同 —— 语义记忆无条件注入、
//    Playbook 条件召回）。故本文件**不 import memory-fs**，只复用 `conversations-fs` 的原子写地基
//    与 `log.ts` 的轮转常量（轮转策略是一件事，两处各拍一套数迟早分叉）。

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { MAX_ARCHIVES, MAX_FILE_BYTES } from '../log'
import { parseEventLine, type MemoryEvent } from '../memory/events'
import type { PlaybookBackend } from '../memory/playbook-core'
import {
  atomicWrite,
  nodeFsAdapter,
  type FsAdapter,
  type MigrationResult
} from './conversations-fs'

/** 磁盘格式版本。与 `MEMORY_SCHEMA_VERSION` 各自独立 —— 两条线迁移节奏不同 */
export const PLAYBOOK_SCHEMA_VERSION = 1

/** meta.json 的形状 */
export interface PlaybookMeta {
  schemaVersion: number
}

export function evolutionDir(root: string): string {
  return join(root, 'evolution')
}

export function playbooksDir(root: string): string {
  return join(evolutionDir(root), 'playbooks')
}

export function playbookPathFor(root: string, slug: string): string {
  return join(playbooksDir(root), `${slug}.md`)
}

export function playbookMetaPath(root: string): string {
  return join(evolutionDir(root), 'meta.json')
}

/** ⚠️ 事件文件独立于 memory 的 `events.jsonl`（物理隔离，批 3 不做跨系统统计） */
export function playbookEventsPath(root: string): string {
  return join(evolutionDir(root), 'events.jsonl')
}

export function emptyPlaybookMeta(): PlaybookMeta {
  return { schemaVersion: PLAYBOOK_SCHEMA_VERSION }
}

export interface PlaybookFsOptions {
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
}

export interface FsPlaybookBackend extends PlaybookBackend {
  readMeta(): PlaybookMeta
  writeMeta(meta: PlaybookMeta): void
  /** 读事件流。`skipped` = 跳过的坏行数（半行尾/手改坏行）—— 必须带出，跳过也是留痕 */
  readEvents(): { events: MemoryEvent[]; skipped: number }
}

function playbookArchivePath(root: string, index: number): string {
  return join(evolutionDir(root), `events.${index}.jsonl`)
}

/** 事件流轮转：与 memory 同策略、同常量（`log.ts`），只是目录不同 */
export function rotatePlaybookEventsIfNeeded(root: string, fs: FsAdapter): boolean {
  const current = playbookEventsPath(root)
  if (fs.sizeBytes(current) < MAX_FILE_BYTES) return false
  const oldest = playbookArchivePath(root, MAX_ARCHIVES)
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
  for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
    const from = playbookArchivePath(root, i)
    if (fs.existsSync(from)) fs.renameSync(from, playbookArchivePath(root, i + 1))
  }
  fs.renameSync(current, playbookArchivePath(root, 1))
  return true
}

export function createFsPlaybookBackend(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  opts: PlaybookFsOptions = {}
): FsPlaybookBackend {
  const warn = opts.onWarn ?? (() => {})
  const dir = playbooksDir(root)

  /**
   * `file` 来自渲染进程（界面删除）—— 必须挡在 `playbooks/` 之内。
   * 用 `relative` 而不是前缀比对：前缀比对会被 `playbooks-evil/` 这类兄弟目录绕过。
   */
  function insidePlaybooks(file: string): boolean {
    const rel = relative(resolve(dir), resolve(file))
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }

  return {
    listFiles() {
      if (!fs.existsSync(dir)) return []
      try {
        return fs
          .readdirSync(dir)
          .filter((n) => n.endsWith('.md'))
          .map((n) => join(dir, n))
      } catch (err) {
        // ⚠️ 不静默返回空：那会让"读不到目录"看起来像"一条 Playbook 都没有"
        warn('Playbook 目录列不出来，本次按"无条目"处理', {
          error: err instanceof Error ? err.message : String(err)
        })
        return []
      }
    },

    read(file) {
      if (!insidePlaybooks(file)) return null
      try {
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      } catch {
        return null
      }
    },

    write(file, text) {
      if (!insidePlaybooks(file)) throw new Error(`Playbook 文件越界：${file}`)
      // 目录可能还没建（首次写入时）—— 不建就写不进去
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      atomicWrite(fs, file, text)
    },

    remove(file) {
      if (!insidePlaybooks(file)) return false
      if (!fs.existsSync(file)) return false
      fs.rmSync(file, { force: true })
      return true
    },

    pathFor(slug) {
      return playbookPathFor(root, slug)
    },

    /**
     * 追加一行事件。⚠️ **追加型、不是原子写**：半行尾部可容忍（读时跳过坏行）。
     * 写不进去**不让 Playbook 写入失败**（事件是观测，不是真相源），但绝不静默 —— 一次性告警。
     */
    appendEvent(line: string) {
      const path = playbookEventsPath(root)
      try {
        fs.mkdirSync(dirname(path), { recursive: true })
        rotatePlaybookEventsIfNeeded(root, fs)
        fs.appendFileSync(path, `${line}\n`, 'utf8')
      } catch (err) {
        warn('Playbook 事件写不进去，本条事件已丢（Playbook 本身不受影响）', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },

    readEvents() {
      const path = playbookEventsPath(root)
      if (!fs.existsSync(path)) return { events: [], skipped: 0 }
      let text: string
      try {
        text = fs.readFileSync(path, 'utf8')
      } catch {
        return { events: [], skipped: 0 }
      }
      const events: MemoryEvent[] = []
      let skipped = 0
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        const parsed = parseEventLine(line)
        if (parsed === null) skipped += 1
        else events.push(parsed)
      }
      return { events, skipped }
    },

    readMeta() {
      const path = playbookMetaPath(root)
      try {
        if (!fs.existsSync(path)) return emptyPlaybookMeta()
        const raw = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
        return {
          schemaVersion:
            typeof raw['schemaVersion'] === 'number' ? raw['schemaVersion'] : PLAYBOOK_SCHEMA_VERSION
        }
      } catch {
        warn('Playbook meta.json 读不出来，已按空处理', {})
        return emptyPlaybookMeta()
      }
    },

    writeMeta(meta) {
      atomicWrite(fs, playbookMetaPath(root), JSON.stringify(meta, null, 2))
    }
  }
}

/**
 * 格式迁移。当前只有 v1，故只做两件事：目录不在就建、meta.json 缺或版本低就写一份。
 * ⚠️ 幂等（每次启动都跑）；失败**不抛** —— Playbook 坏了不该让应用起不来（降级而不是硬失败）。
 */
export function migratePlaybookFormat(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
): MigrationResult {
  const warn = onWarn ?? (() => {})
  try {
    fs.mkdirSync(playbooksDir(root), { recursive: true })
    const path = playbookMetaPath(root)
    if (!fs.existsSync(path)) {
      fs.mkdirSync(dirname(path), { recursive: true })
      atomicWrite(fs, path, JSON.stringify(emptyPlaybookMeta(), null, 2))
      return { migrated: true, moved: 0, reason: '初始化 Playbook 目录' }
    }
    atomicWrite(fs, path, JSON.stringify(emptyPlaybookMeta(), null, 2))
    return { migrated: false, moved: 0, reason: '已是新格式' }
  } catch (err) {
    warn('Playbook 目录初始化失败，本批功能以降级模式运行', {
      error: err instanceof Error ? err.message : String(err)
    })
    return { migrated: false, moved: 0, reason: err instanceof Error ? err.message : String(err) }
  }
}
