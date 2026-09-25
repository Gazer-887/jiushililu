// 记忆的**磁盘后端**（plan19 批 1）：布局、原子写、读盘校验兜底、格式迁移。
// 布局：`<root>/memory/notes/<slug>.md` 一条一文件；`<root>/memory/meta.json` 放版本与队列。
// ⚠️ 完全复用 conversation 那套已验证的地基（`atomicWrite` / `FsAdapter`），不另造：
//    正文是用户攒下来的东西，值得"要么看到新内容、要么看到完整旧内容"。

import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { archivedFileName, parseArchivedFileName } from '@shared/memory'
import { parseEventLine, type MemoryEvent } from '../memory/events'
import { rotateJsonlIfNeeded } from './jsonl'
import type { MemoryBackend } from '../memory/memory-core'
import {
  atomicWrite,
  nodeFsAdapter,
  type FsAdapter,
  type MigrationResult
} from './conversations-fs'

/** 磁盘格式版本。与 `CONVERSATIONS_SCHEMA_VERSION` 各自独立 —— 两条线的迁移节奏不同 */
export const MEMORY_SCHEMA_VERSION = 1

/** meta.json 的形状 */
export interface MemoryMeta {
  schemaVersion: number
  /** 待反思队列（D-040 留的口，**批 2 才消费**；批 1 只负责让它存在） */
  pendingReflection: string[]
  /** 「完全访问档 + 自动记忆」的告知标记（§九 判据 14）：每次从关到开都重新告知一次 */
  fullAccessNoticeShownAt?: string
  /** 批 2：今日已跑反思次数（与 `reflectionDate` 配对，跨日重置） */
  reflectionCount: number
  /** 批 2：当前计数的日期（'YYYY-MM-DD'）。跨日重置时更新 */
  reflectionDate: string
  /** 批 2：待反思会话 id 队列（关窗 / 切换时入队，启动时补跑） */
  reflectionQueue: string[]
}

export function memoryDir(root: string): string {
  return join(root, 'memory')
}

export function notesDir(root: string): string {
  return join(root, 'notes')
}

/** 批 2：候选目录。⚠️ 与 `notes/` **物理隔离** —— `listFiles()` 只列 `notes/`，候选不进索引段（审查 A P0） */
export function candidatesDir(root: string): string {
  return join(root, 'candidates')
}

export function notePathFor(root: string, slug: string): string {
  return join(notesDir(root), `${slug}.md`)
}

/** 候选文件路径：`<root>/candidates/<slug>.md` */
export function candidatePathFor(root: string, slug: string): string {
  return join(candidatesDir(root), `${slug}.md`)
}

/** 归档目录（plan53 片 1）：**与 `notes/` 平级** —— `listFiles()` 只列 notes，归档天然不进注入 */
export function archivedDir(root: string): string {
  return join(memoryDir(root), 'archived')
}

/** 归档路径：命名规则的唯一口径在 `@shared/memory` 的 `archivedFileName`（读写两侧共用） */
export function archivedPathFor(root: string, slug: string, at: Date = new Date()): string {
  return join(archivedDir(root), archivedFileName(slug, at))
}

/**
 * 「拒掉的候选」回收站（plan56 片③）：住在 `memory/rejected/`，与 notes / candidates / archived **四处互斥**。
 * ⚠️ 刻意**不**并入 `insideMemory()` —— 通用的 `read/write/remove` 因此物理上碰不到它：
 *    一条拒掉的提案若能被 `memory:delete` 顺手删掉，就会给一个从未生效过的东西落一笔 `delete`，
 *    存活率被凭空压低（与 B2 同族）。进出只能走下面三个专用口。
 * 文件名沿用归档区那套时间戳编解码（同一份编解码不fork第二份），`archivedAt` 字段在这里读作"拒掉时刻"。
 */
export function rejectedDir(root: string): string {
  return join(memoryDir(root), 'rejected')
}

export function rejectedPathFor(root: string, slug: string, at: Date = new Date()): string {
  return join(rejectedDir(root), archivedFileName(slug, at))
}

export function metaPath(root: string): string {
  return join(memoryDir(root), 'meta.json')
}

export function emptyMeta(): MemoryMeta {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    pendingReflection: [],
    reflectionCount: 0,
    reflectionDate: '',
    reflectionQueue: []
  }
}

export interface MemoryFsOptions {
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
}

export interface FsMemoryBackend extends MemoryBackend {
  readMeta(): MemoryMeta
  writeMeta(meta: MemoryMeta): void
  /** 读事件流。`skipped` = 跳过的坏行数（半行尾/手改坏行）—— **必须带出，跳过也是留痕** */
  readEvents(): { events: MemoryEvent[]; skipped: number }
}

const EVENTS_NAME = 'events.jsonl'

export function eventsPath(root: string): string {
  return join(memoryDir(root), EVENTS_NAME)
}

/**
 * 事件流轮转（plan26 D-077 起改为薄壳）：逻辑提取到 `store/jsonl.ts` 共用
 * （执行事件流同款策略）—— 上限与份数仍共用 `log.ts` 的常量，行为不变（单测兜底）。
 */
export function rotateEventsIfNeeded(root: string, fs: FsAdapter): boolean {
  return rotateJsonlIfNeeded(eventsPath(root), fs)
}

/** 把 meta.json 收敛成合法形状。老文件缺字段、手改坏字段都不该让应用起不来 */
function sanitizeMeta(raw: unknown): MemoryMeta {
  if (typeof raw !== 'object' || raw === null) return emptyMeta()
  const r = raw as Record<string, unknown>
  const queue = Array.isArray(r['pendingReflection'])
    ? r['pendingReflection'].filter((v): v is string => typeof v === 'string')
    : []
  const shown = typeof r['fullAccessNoticeShownAt'] === 'string' ? r['fullAccessNoticeShownAt'] : undefined
  const reflectionCount =
    typeof r['reflectionCount'] === 'number' && Number.isFinite(r['reflectionCount'])
      ? Math.max(0, Math.floor(r['reflectionCount']))
      : 0
  const reflectionDate = typeof r['reflectionDate'] === 'string' ? r['reflectionDate'] : ''
  const reflectionQueue = Array.isArray(r['reflectionQueue'])
    ? r['reflectionQueue'].filter((v): v is string => typeof v === 'string')
    : []
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    pendingReflection: queue,
    reflectionCount,
    reflectionDate,
    reflectionQueue,
    ...(shown === undefined ? {} : { fullAccessNoticeShownAt: shown })
  }
}

export function createFsMemoryBackend(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  opts: MemoryFsOptions = {}
): FsMemoryBackend {
  const warn = opts.onWarn ?? (() => {})
  const notes = notesDir(root)
  const candidates = candidatesDir(root)
  const archived = archivedDir(root)
  const rejected = rejectedDir(root)
  /** D-106：read() 的内容缓存。新鲜度键 (mtimeMs, size)，见 `read` 内注释；容量=记忆文件数，不设上限 */
  const readCache = new Map<string, { m: number; s: number; text: string }>()

  /**
   * `file` 来自渲染进程 —— 必须挡在 `notes/` 之内。
   * 用 `relative` 而不是前缀比对：前缀比对会被 `notes-evil/` 这类兄弟目录绕过。
   */
  function insideNotes(file: string): boolean {
    const rel = relative(resolve(notes), resolve(file))
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /**
   * 批 2：候选目录的边界检查。与 `insideNotes` 同口径 —— `relative` 而非前缀。
   * ⚠️ 候选路径**只由主进程内部生成**（slug 来自校验过的 name），但 approve/reject 的 file 经渲染进程回传，
   *    仍要做边界检查 —— 否则"删候选"接口会被传任意路径。
   */
  function insideCandidates(file: string): boolean {
    const rel = relative(resolve(candidates), resolve(file))
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }

  function insideArchived(file: string): boolean {
    const rel = relative(resolve(archived), resolve(file))
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /** plan56 片③：回收站自己的边界。⚠️ 刻意**不**并进 `insideMemory()` —— 见 `rejectedDir` 注释 */
  function insideRejected(file: string): boolean {
    const rel = relative(resolve(rejected), resolve(file))
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /** read/write/remove 接受 `notes/`、`candidates/`、`archived/` 三处（批 2 候选流通 + 片 1 归档流通） */
  function insideMemory(file: string): boolean {
    return insideNotes(file) || insideCandidates(file) || insideArchived(file)
  }

  return {
    listFiles() {
      if (!fs.existsSync(notes)) return []
      try {
        return fs
          .readdirSync(notes)
          .filter((n) => n.endsWith('.md'))
          .map((n) => join(notes, n))
      } catch (err) {
        // ⚠️ 不静默返回空：那会让"读不到目录"看起来像"一条记忆都没有"（凭据与授权词会跟着漏过巡检）
        warn('记忆目录列不出来，本次按"无条目"处理', {
          error: err instanceof Error ? err.message : String(err)
        })
        return []
      }
    },

    read(file) {
      if (!insideMemory(file)) return null
      try {
        // D-106：满载 100 条 × 每轮注入 = 逐文件同步读是判据 10 的大头（Defender 环境实测 ~0.5ms/次）。
        // 新鲜度键 (mtimeMs, size) 由 stat 一次给出——stat 命中即免"读盘+重复解析"。
        // 适配器不提供 mtimeMsBytes（如注入式测试桩）时自动回退直读，语义不变。
        if (fs.mtimeMsBytes) {
          const key = fs.mtimeMsBytes(file)
          if (key === null) {
            readCache.delete(file)
            return null
          }
          const hit = readCache.get(file)
          if (hit && hit.m === key.mtimeMs && hit.s === key.size) return hit.text
          const text = fs.readFileSync(file, 'utf8')
          readCache.set(file, { m: key.mtimeMs, s: key.size, text })
          return text
        }
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      } catch {
        readCache.delete(file)
        return null
      }
    },

    write(file, text) {
      if (!insideMemory(file)) throw new Error(`记忆文件越界：${file}`)
      // 候选目录可能还没建（首次写候选时）—— 不建就写不进去
      if (insideCandidates(file)) {
        fs.mkdirSync(candidates, { recursive: true })
      }
      atomicWrite(fs, file, text)
      // 写后回填（stat 取真实新键）：本轮"写完即读"不再走第二次读盘
      const key = fs.mtimeMsBytes ? fs.mtimeMsBytes(file) : null
      if (key) readCache.set(file, { m: key.mtimeMs, s: key.size, text })
      else readCache.delete(file)
    },

    remove(file) {
      if (!insideMemory(file)) return false
      if (!fs.existsSync(file)) return false
      fs.rmSync(file, { force: true })
      readCache.delete(file)
      return true
    },

    // ── plan53 片 1：可逆归档。**自动遗忘走这里，用户手删仍走 `remove`** ──
    archive(file) {
      if (!insideNotes(file)) return null // 只归档正式条目；候选/归档区不许再归档
      if (!fs.existsSync(file)) return null
      const slug = basename(file, '.md')
      const to = archivedPathFor(root, slug)
      fs.mkdirSync(archived, { recursive: true })
      fs.writeFileSync(to, fs.readFileSync(file, 'utf8'), 'utf8')
      fs.rmSync(file, { force: true })
      readCache.delete(file)
      readCache.delete(to)
      return to
    },

    listArchived() {
      if (!fs.existsSync(archived)) return []
      try {
        return fs.readdirSync(archived).filter((n) => n.endsWith('.md')).map((n) => join(archived, n))
      } catch (err) {
        // 与 listFiles 同口径：列不出来不许静默当"没有归档"
        warn('归档区列不出来，本次按"无归档"处理', { error: err instanceof Error ? err.message : String(err) })
        return []
      }
    },

    restoreFrom(archivedFile) {
      const parsed = parseArchivedFileName(basename(archivedFile))
      if (!parsed || !insideArchived(archivedFile)) return null
      if (!fs.existsSync(archivedFile)) return null
      const to = notePathFor(root, parsed.slug)
      if (fs.existsSync(to)) return null // 同名已存在 ⇒ 交回调用方给理由，这里绝不覆盖
      fs.mkdirSync(notes, { recursive: true })
      fs.writeFileSync(to, fs.readFileSync(archivedFile, 'utf8'), 'utf8')
      fs.rmSync(archivedFile, { force: true })
      readCache.delete(archivedFile)
      readCache.delete(to)
      return to
    },

    // ── plan56 片③：拒掉的候选进回收站（可逆）。四处互斥、且不走 `insideMemory`，见 `rejectedDir` 注释 ──
    reject(file) {
      // 只收候选：notes 里的是生效条目（那边叫归档），拿"拒绝"去动它是串区
      if (!insideCandidates(file)) return null
      if (!fs.existsSync(file)) return null
      const slug = basename(file, '.md')
      const to = rejectedPathFor(root, slug)
      fs.mkdirSync(rejected, { recursive: true })
      // 读什么写什么。这里"顺手重新序列化"一次，恢复回去的就不是用户拒掉的那一份（判据②）
      fs.writeFileSync(to, fs.readFileSync(file, 'utf8'), 'utf8')
      fs.rmSync(file, { force: true })
      readCache.delete(file)
      return to
    },

    listRejected() {
      if (!fs.existsSync(rejected)) return []
      try {
        return fs.readdirSync(rejected).filter((n) => n.endsWith('.md')).map((n) => join(rejected, n))
      } catch (err) {
        warn('回收站列不出来，本次按"没有拒掉的候选"处理', {
          error: err instanceof Error ? err.message : String(err)
        })
        return []
      }
    },

    readRejected(rejectedFile) {
      // 只认回收站这一处：`read()` 的 `insideMemory` 不含它，通用口子伸不进来
      if (!insideRejected(rejectedFile)) return null
      try {
        return fs.existsSync(rejectedFile) ? fs.readFileSync(rejectedFile, 'utf8') : null
      } catch {
        return null
      }
    },

    restoreRejectedFrom(rejectedFile) {
      const parsed = parseArchivedFileName(basename(rejectedFile))
      if (!parsed || !insideRejected(rejectedFile)) return null
      if (!fs.existsSync(rejectedFile)) return null
      const to = candidatePathFor(root, parsed.slug)
      if (fs.existsSync(to)) return null // 同名已在待批队列 ⇒ 绝不覆盖
      fs.mkdirSync(candidates, { recursive: true })
      fs.writeFileSync(to, fs.readFileSync(rejectedFile, 'utf8'), 'utf8')
      fs.rmSync(rejectedFile, { force: true })
      readCache.delete(to)
      return to
    },

    removeRejected(rejectedFile) {
      if (!insideRejected(rejectedFile)) return false
      if (!fs.existsSync(rejectedFile)) return false
      fs.rmSync(rejectedFile, { force: true })
      return true
    },

    pathFor(slug) {
      return notePathFor(root, slug)
    },

    candidatePathFor(slug) {
      return candidatePathFor(root, slug)
    },

    listCandidates() {
      const dir = candidatesDir(root)
      if (!fs.existsSync(dir)) return []
      try {
        return fs
          .readdirSync(dir)
          .filter((n) => n.endsWith('.md'))
          .map((n) => join(dir, n))
      } catch {
        // 候选目录读不到不影响正式条目 —— 返回空即可（正式条目才是真相源）
        return []
      }
    },

    /**
     * 追加一行事件。⚠️ **追加型、不是原子写**：半行尾部可容忍（读时跳过坏行）。
     * 写不进去**不让记忆写入失败**（事件是观测，不是真相源），但绝不静默 —— 一次性告警。
     */
    appendEvent(line: string) {
      const path = eventsPath(root)
      try {
        fs.mkdirSync(dirname(path), { recursive: true })
        rotateEventsIfNeeded(root, fs)
        fs.appendFileSync(path, `${line}\n`, 'utf8')
      } catch (err) {
        warn('记忆事件写不进去，本条事件已丢（记忆本身不受影响）', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },

    readEvents() {
      const path = eventsPath(root)
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
      const path = metaPath(root)
      try {
        if (!fs.existsSync(path)) return emptyMeta()
        return sanitizeMeta(JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
      } catch {
        warn('meta.json 读不出来，已按空处理（待反思队列会重建）', {})
        return emptyMeta()
      }
    },

    writeMeta(meta) {
      atomicWrite(fs, metaPath(root), JSON.stringify(meta, null, 2))
    }
  }
}

/**
 * 格式迁移。当前只有 v1，故**只做两件事**：目录不在就建、meta.json 缺或版本低就写一份。
 * ⚠️ 幂等（每次启动都跑）；失败**不抛** —— 记忆坏了不该让应用起不来（降级而不是硬失败）。
 */
export function migrateMemoryFormat(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
): MigrationResult {
  const warn = onWarn ?? (() => {})
  try {
    fs.mkdirSync(notesDir(root), { recursive: true })
    // 批 2：候选目录也建（幂等；首次写候选时 write 还会兜底建一次，但启动时就建能让"首次反思"少一次 I/O）
    fs.mkdirSync(candidatesDir(root), { recursive: true })
    const path = metaPath(root)
    if (!fs.existsSync(path)) {
      fs.mkdirSync(dirname(path), { recursive: true })
      atomicWrite(fs, path, JSON.stringify(emptyMeta(), null, 2))
      return { migrated: true, moved: 0, reason: '初始化记忆目录' }
    }
    const meta = sanitizeMeta(JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
    atomicWrite(fs, path, JSON.stringify(meta, null, 2))
    return { migrated: false, moved: 0, reason: '已是新格式' }
  } catch (err) {
    warn('记忆目录初始化失败，本批功能以降级模式运行', {
      error: err instanceof Error ? err.message : String(err)
    })
    return { migrated: false, moved: 0, reason: err instanceof Error ? err.message : String(err) }
  }
}
