import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage, ConversationMeta } from '@shared/ipc'
import type { ConversationsBackend } from './conversations-core'

// 会话存储的**分层磁盘后端**（plan10 A 批）
//
// 布局（分层：把"列表要的"与"正文"分开）：
//
//   <root>/conversations.json          ← 只有 meta（列表、白名单只读这一份）
//   <root>/conversations/<id>.json     ← 正文（一条会话一个文件）
//
// 为什么这么分：旧版把**全部会话连同正文**塞进一个文件，于是
//   ① 每次保存要重写全部会话（O(总量)）② 读列表也要先解析全部正文。
// 分开之后：列表只读 meta（O(会话数)），保存只写自己那一份。
//
// ## 三条硬约束（都有测试钉着）
//
// 1. **原子写**：一律"写临时文件 + rename"。读者要么看到旧文件、要么看到新文件，
//    **永远不会看到半截**。⚠️ 换掉 electron-store 时最容易顺手丢掉的就是这条：
//    `checkpoints.ts` 的裸 `writeFileSync` 是另一种赌注（坏一个 manifest 只等于少一条
//    可回滚记录，而且坏文件会被跳过），而**会话正文是用户唯一的原始数据**，赌注不一样。
// 2. **写序：先正文、后索引**。反过来的话，索引里会短暂出现"messageCount 说有 N 条、
//    而正文文件还不存在"的状态 —— 崩在中间就变成"点进去空白"。
// 3. **单个坏文件不拖垮整张表**：某条会话的正文读不出来 → 那条当空处理并留痕，
//    **不许让整个列表加载失败**（旧版 conf 遇到坏 JSON 会直接抛，那是全列表级故障）。
//
// ## 为什么 fs 也是注入的
//
// A 批的验收第一条就是**读盘足迹**："列表不得展开任何正文"是**主进程读盘行为**，
// 渲染层看不见、也不能靠耗时去猜。把 fs 做成可注入的适配器之后，测试可以拿一个
// **记账的** fs 包住真实 fs —— 真文件、真字节，同时能数清"读了几个文件、读了多少字节"。

/** 用到的那几个 fs 能力（收窄成接口，便于测试注入记账版） */
export interface FsAdapter {
  existsSync(path: string): boolean
  mkdirSync(path: string, opts: { recursive: true }): void
  readFileSync(path: string, enc: 'utf8'): string
  writeFileSync(path: string, data: string, enc: 'utf8'): void
  renameSync(from: string, to: string): void
  rmSync(path: string, opts?: { force?: boolean }): void
}

export const nodeFsAdapter: FsAdapter = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, o) => void nodeFs.mkdirSync(p, o),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  writeFileSync: (p, d, e) => nodeFs.writeFileSync(p, d, e),
  renameSync: (a, b) => nodeFs.renameSync(a, b),
  rmSync: (p, o) => nodeFs.rmSync(p, o)
}

/** 磁盘格式版本。老格式（electron-store 整表、正文内嵌）没有这个字段，等价于 1 */
export const CONVERSATIONS_SCHEMA_VERSION = 2

/** 新格式的 meta 文件形状 */
interface MetaFile {
  schemaVersion: number
  conversations: Record<string, ConversationMeta>
}

/** 老格式（v1）：正文内嵌在每条会话里 */
interface LegacyFile {
  conversations?: Record<string, ConversationMeta & { messages?: ChatMessage[] }>
}

export function metaFilePath(root: string): string {
  return join(root, 'conversations.json')
}

export function messagesDir(root: string): string {
  return join(root, 'conversations')
}

export function messagesFilePath(root: string, id: string): string {
  return join(messagesDir(root), `${id}.json`)
}

/** 备份文件名：老格式原地留一版，降级/迁移出问题时用户还能找回 */
export function backupFilePath(root: string, tag: string): string {
  return `${metaFilePath(root)}.bak-${tag}`
}

/** 原子写：临时文件 + rename。tmp 放在同目录（跨盘 rename 会失败） */
function atomicWrite(fs: FsAdapter, path: string, data: string): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, path)
}

function readJson<T>(fs: FsAdapter, path: string): T | null {
  try {
    if (!fs.existsSync(path)) return null
    // **先剥 BOM**：`JSON.parse` 遇到开头的 U+FEFF 会直接抛，而文件明明在 ——
    // 表现为"所有会话一下子都不见了"，且极难查（打开文件看内容是好的）。
    // 旧库（conf）写的是无 BOM，但用户手改过、或别的编辑器存过一次就会带上。
    // 这行是**换库时最容易顺手丢掉**的那类兜底：原库默默替我们挡住了。
    const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** 会话 id 的兜底校验：`<id>.json` 的 id 来自渲染进程，不许带路径分隔符往外跳 */
function safeId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !/[\\/]/.test(id) && !id.includes('..')
}

export interface FsBackendOptions {
  /** 读不出来时的留痕回调（单个坏文件不该静默） */
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
}

export function createFsConversationsBackend(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  opts: FsBackendOptions = {}
): ConversationsBackend {
  const warn = opts.onWarn ?? (() => {})

  function readMetaFile(): Record<string, ConversationMeta> {
    const raw = readJson<MetaFile | LegacyFile>(fs, metaFilePath(root))
    if (!raw) return {}
    const list = (raw as MetaFile).conversations ?? {}
    const out: Record<string, ConversationMeta> = {}
    for (const [id, entry] of Object.entries(list)) {
      if (!entry) continue
      // **兼容未迁移的老文件**：老格式里正文内嵌在 entry.messages 上。
      // 这里把它剥掉、并用它的长度当 messageCount 兜底 —— 于是"迁移没成功"
      // 也不会让应用起不来（降级而不是硬失败）。
      const legacy = entry as ConversationMeta & { messages?: ChatMessage[] }
      const { messages, ...meta } = legacy
      out[id] = {
        ...meta,
        messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : (messages?.length ?? 0)
      }
    }
    return out
  }

  function writeMetaFile(all: Record<string, ConversationMeta>): void {
    const payload: MetaFile = { schemaVersion: CONVERSATIONS_SCHEMA_VERSION, conversations: all }
    atomicWrite(fs, metaFilePath(root), JSON.stringify(payload, null, 2))
  }

  return {
    readMeta: readMetaFile,

    putMeta(id, meta) {
      const all = readMetaFile()
      all[id] = meta
      writeMetaFile(all)
    },

    removeMeta(id) {
      const all = readMetaFile()
      if (!(id in all)) return
      delete all[id]
      writeMetaFile(all)
    },

    readMessages(id) {
      if (!safeId(id)) return []
      const list = readJson<ChatMessage[]>(fs, messagesFilePath(root, id))
      if (!Array.isArray(list)) {
        // 文件在但读不出来 → 当空处理并留痕（**不抛**，否则一条坏会话会拖垮整张表）
        if (fs.existsSync(messagesFilePath(root, id))) {
          warn('会话正文读不出来，已按空内容处理', { id })
        }
        return []
      }
      return list
    },

    writeMessages(id, messages) {
      if (!safeId(id)) throw new Error(`会话 id 不合法：${id}`)
      atomicWrite(fs, messagesFilePath(root, id), JSON.stringify(messages, null, 2))
    },

    removeMessages(id) {
      if (!safeId(id)) return
      fs.rmSync(messagesFilePath(root, id), { force: true })
    }
  }
}

// ── 格式迁移：v1（整表 + 正文内嵌）→ v2（meta 表 + 正文分文件）────────────
//
// ⚠️ 这是 A 批**唯一动用户数据**的一步，按 plan10 §2.4 的止损规矩办：
//   **写齐 → 校验 → 才覆盖索引**，且**先把老文件原样备份一份**。
//   任何一步失败就**不覆盖索引**、原样保留老文件，让应用以"降级模式"继续跑
//   （readMetaFile 能容忍老格式）—— 半迁移是最糟的状态，但"能跑"比"跑不起来"强得多。

export interface MigrationResult {
  migrated: boolean
  /** 迁移前有几条会话带正文（`migrated=false` 时为 0 —— 没搬就是没搬） */
  moved: number
  /** 跳过的原因（migrated=false 时） */
  reason?: string
  backupPath?: string
}

export function migrateConversationsFormat(
  root: string,
  fs: FsAdapter = nodeFsAdapter,
  tag = 'v1',
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
): MigrationResult {
  const warn = onWarn ?? (() => {})
  const path = metaFilePath(root)

  if (!fs.existsSync(path)) return { migrated: false, moved: 0, reason: '没有会话文件' }

  const raw = readJson<MetaFile | LegacyFile>(fs, path)
  if (raw === null) return { migrated: false, moved: 0, reason: '会话文件读不出来（已保留原样）' }

  const version = (raw as MetaFile).schemaVersion
  if (typeof version === 'number' && version >= CONVERSATIONS_SCHEMA_VERSION) {
    return { migrated: false, moved: 0, reason: '已是新格式' }
  }

  const list = (raw as LegacyFile).conversations ?? {}
  const metas: Record<string, ConversationMeta> = {}
  let moved = 0

  try {
    for (const [id, entry] of Object.entries(list)) {
      if (!entry) continue
      const legacy = entry as ConversationMeta & { messages?: ChatMessage[] }
      const { messages, ...meta } = legacy
      const kept = Array.isArray(messages) ? messages : []

      if (kept.length > 0) {
        if (!safeId(id)) throw new Error(`会话 id 不合法：${id}`)
        atomicWrite(fs, messagesFilePath(root, id), JSON.stringify(kept, null, 2))
        // **校验**：写完读回来数一遍。宁可慢一点，也不要"以为写成功了"。
        const back = readJson<ChatMessage[]>(fs, messagesFilePath(root, id))
        if (!Array.isArray(back) || back.length !== kept.length) {
          throw new Error(`正文写回校验不过：${id}（期望 ${kept.length} 条）`)
        }
        moved += 1
      }
      metas[id] = { ...meta, messageCount: kept.length }
    }

    // 校验报告必须**非零**才算过（本项目红线：两个空输出 diff 会判一致）
    if (moved === 0 && Object.keys(list).length > 0) {
      warn('迁移：没有任何会话带正文，按"无需迁移"处理', { conversations: Object.keys(list).length })
    }

    // 到这里正文都写齐并校验过了，才备份 + 覆盖索引
    const backupPath = backupFilePath(root, tag)
    fs.writeFileSync(backupPath, fs.readFileSync(path, 'utf8'), 'utf8')
    atomicWrite(fs, path, JSON.stringify({ schemaVersion: CONVERSATIONS_SCHEMA_VERSION, conversations: metas }, null, 2))
    return { migrated: true, moved, backupPath }
  } catch (err) {
    // 失败：**不覆盖索引**，老文件原样留着（应用会以降级模式继续跑）
    warn('会话格式迁移失败，已保留老文件（应用以降级模式运行）', {
      error: err instanceof Error ? err.message : String(err)
    })
    return { migrated: false, moved: 0, reason: err instanceof Error ? err.message : String(err) }
  }
}
