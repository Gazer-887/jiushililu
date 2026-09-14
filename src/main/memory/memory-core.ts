// 记忆的**纯逻辑**（plan19 批 1）：严格 frontmatter 解析、条目序列化、文件名派生、索引与预算截断、
// 以及 CRUD 的完整行为。⚠️ 不 import electron / fs —— 存储接缝由 `MemoryBackend` 注入，本文件可单测。
// 分层照项目惯例：领域逻辑住这里，布局与原子写住 `store/memory-fs.ts`，装配住 `store/memory-store.ts`。

import {
  MEMORY_CLASSES,
  MEMORY_LIMITS,
  MEMORY_ORIGINS,
  memoryNameKey,
  utf8Bytes,
  validateMemoryFields,
  type MemoryClass,
  type MemoryEntry,
  type MemoryEvidence,
  type MemoryGuardVerdict,
  type MemoryIndex,
  type MemoryOrigin,
  type MemorySaveInput,
  type MemorySaveResult
} from '@shared/memory'
import { injectionKey, serializeEvent, type MemoryEvent, type MemoryEventPayload } from './events'

/** 存/取的唯一接缝。⚠️ read/remove 必须自行拒绝 `notes/` 之外的路径（file 来自渲染进程） */
export interface MemoryBackend {
  /** 列出全部条目文件的绝对路径 */
  listFiles(): string[]
  read(file: string): string | null
  write(file: string, text: string): void
  remove(file: string): boolean
  /** slug → 绝对路径。布局只由 store 层知道，本文件不认路径拼接 */
  pathFor(slug: string): string
  /** 追加一行事件（追加型，不是原子写 —— 半行尾部可容忍） */
  appendEvent(line: string): void
}

/** 解析出来的一条（`file` 由调用方补上） */
export interface ParsedMemory {
  name: string
  description: string
  class: MemoryClass
  origin: MemoryOrigin
  evidence: MemoryEvidence | null
  createdAt: string
  updatedAt: string
  body: string
}

export type ParseResult = { ok: true; parsed: ParsedMemory } | { ok: false; reason: string }

/**
 * 只认这些键。⚠️ **不复用 `parseAgentDefinition` 的宽松正则**（它只 `.trim()`、不校验内容）：
 * 宽松解析下，值里塞一段 `---\n...` 就能提前截断 frontmatter、把正文伪装成键值对。
 */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'class',
  'origin',
  'evidenceConversation',
  'evidenceTurn',
  'createdAt',
  'updatedAt'
])

const REQUIRED_KEYS = ['name', 'description', 'class', 'origin', 'createdAt', 'updatedAt'] as const

/**
 * 严格解析。硬规则：**值一律单行**（多行无法区分"续行"与"新键"），未知键直接拒。
 * ⚠️ 证据用**扁平键**（`evidenceConversation` / `evidenceTurn`）而不是嵌套块 ——
 * 嵌套与"值不许跨行"不能同时成立（plan19 §4.3 原稿自相矛盾，批 1 落盘时改正）。
 */
export function parseMemoryFile(text: string): ParseResult {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { ok: false, reason: '缺少 frontmatter 起始 ---' }

  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { ok: false, reason: 'frontmatter 没有闭合 ---' }

  const fields: Record<string, string> = {}
  for (const raw of normalized.slice(4, end).split('\n')) {
    if (raw.length === 0) continue
    const at = raw.indexOf(':')
    if (at <= 0) return { ok: false, reason: `frontmatter 行无法解析：${raw.slice(0, 40)}` }
    const key = raw.slice(0, at).trim()
    if (!KNOWN_KEYS.has(key)) return { ok: false, reason: `未知的 frontmatter 键：${key}` }
    if (key in fields) return { ok: false, reason: `frontmatter 键重复：${key}` }
    fields[key] = raw.slice(at + 1).trim()
  }

  for (const key of REQUIRED_KEYS) {
    if (!fields[key]) return { ok: false, reason: `frontmatter 缺少 ${key}` }
  }
  if (!(MEMORY_CLASSES as readonly string[]).includes(fields['class']!)) {
    return { ok: false, reason: `class 只能是 ${MEMORY_CLASSES.join(' / ')}` }
  }
  if (!(MEMORY_ORIGINS as readonly string[]).includes(fields['origin']!)) {
    return { ok: false, reason: `origin 只能是 ${MEMORY_ORIGINS.join(' / ')}` }
  }

  let evidence: MemoryEvidence | null = null
  const conv = fields['evidenceConversation']
  const turn = fields['evidenceTurn']
  if (conv !== undefined || turn !== undefined) {
    // 带轮次就必须带会话；反过来允许 —— 会话级指针本身已经是证据
    if (!conv) return { ok: false, reason: '证据指针缺会话 id' }
    if (turn === undefined) {
      evidence = { conversationId: conv }
    } else {
      const n = Number(turn)
      if (!Number.isInteger(n) || n < 0) return { ok: false, reason: '证据轮次号必须是非负整数' }
      evidence = { conversationId: conv, turnIndex: n }
    }
  }

  // 分隔约定：`---` 之后空一行再写正文。⚠️ 只剥**一个**换行 —— 剥零个会让"写→读→写"
  // 每存一次多攒一个空行（正文逐次下移），剥多个又会吃掉正文自己的缩进。
  const after = normalized.slice(end + 5)
  const body = after.startsWith('\n') ? after.slice(1) : after
  return {
    ok: true,
    parsed: {
      name: fields['name']!,
      description: fields['description']!,
      class: fields['class'] as MemoryClass,
      origin: fields['origin'] as MemoryOrigin,
      evidence,
      createdAt: fields['createdAt']!,
      updatedAt: fields['updatedAt']!,
      body
    }
  }
}

/** 序列化。缺证据时**整个键不写**（不留空值 —— 空值读回来又得再剥一遍，两处规则迟早分叉） */
export function serializeMemory(parsed: ParsedMemory): string {
  const lines = [
    '---',
    `name: ${parsed.name}`,
    `description: ${parsed.description}`,
    `class: ${parsed.class}`,
    `origin: ${parsed.origin}`,
    ...(parsed.evidence
      ? [
          `evidenceConversation: ${parsed.evidence.conversationId}`,
          ...(parsed.evidence.turnIndex === undefined
            ? []
            : [`evidenceTurn: ${parsed.evidence.turnIndex}`])
        ]
      : []),
    `createdAt: ${parsed.createdAt}`,
    `updatedAt: ${parsed.updatedAt}`,
    '---',
    ''
  ]
  return `${lines.join('\n')}\n${parsed.body}`
}

/** Windows 保留设备名：这类文件名在 Windows 上根本建不出来（`con.md` 会失败），故在建之前就拒 */
const RESERVED_SLUGS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

/** name → 文件名 slug（空白压成 `-`）。非法字符已由 `validateMemoryFields` 挡住 */
export function slugFor(name: string): string | null {
  const slug = name.trim().replace(/\s+/g, '-')
  if (slug.length === 0) return null
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return null
  return slug
}

const CLASS_LABELS: Record<MemoryClass, string> = {
  style: '风格',
  default: '默认',
  knowledge: '知识'
}

/** 注入索引里的一行。**唯一口径** —— `buildIndex` 的字节账与 `inject` 的正文都用它，不许各写一份 */
export function indexLine(entry: MemoryEntry): string {
  return `- [${CLASS_LABELS[entry.class]}] ${entry.name}：${entry.description}`
}

/**
 * 索引与预算截断。排序：**style 优先**（它总是生效，不该被条件类挤掉），其余按 updatedAt 倒序，
 * 同刻按 name 升序（保证确定性 —— 否则单测会随机翻车）。
 * ⚠️ `omitted` 必须如实带出，不许静默丢（R9.1 三条红线之一：不静默截断）。
 */
export function buildIndex(entries: MemoryEntry[]): MemoryIndex {
  const sorted = [...entries].sort((a, b) => {
    const rank = Number(b.class === 'style') - Number(a.class === 'style')
    if (rank !== 0) return rank
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  const kept: MemoryEntry[] = []
  let bytes = 0
  for (const entry of sorted) {
    if (kept.length >= MEMORY_LIMITS.maxIndexLines) break
    const lineBytes = utf8Bytes(`${indexLine(entry)}\n`)
    if (bytes + lineBytes > MEMORY_LIMITS.maxIndexBytes) break
    bytes += lineBytes
    kept.push(entry)
  }
  return { entries: kept, total: entries.length, omitted: entries.length - kept.length, warnings: [] }
}

export interface MemoryRepoOptions {
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
  /** 注入时钟，便于单测钉住 createdAt / updatedAt */
  now?: () => Date
  /**
   * 当前会话 id（组合根注入）。**写入与删除的事件靠它自动落** ——
   * 若让调用方各自记，忘一次就是一个静默缺口（事件流"事后补不回来"，缺了就是永久缺）。
   */
  conversationId?: () => string | null
  /**
   * 每次写入尝试的回调（**成功与拒绝都调**）。组合根拿它聚出护栏 2 的「本轮写入痕迹」——
   * 若让各处调用方自己上报，忘一次就等于**用户看不见**（那是护栏 2 失效，不是少一条日志）。
   */
  onWrite?: (info: { name: string; ok: boolean; reason?: string }) => void
}

export interface MemoryRepo {
  /** 读全部并建索引。坏文件 fail-soft（跳过 + 留痕），绝不因一条坏数据拖垮整张表 */
  list(): MemoryIndex
  get(file: string): MemoryEntry | null
  listFiles(): string[]
  save(input: MemorySaveInput): MemorySaveResult
  remove(file: string, by?: 'user' | 'model'): boolean
  /**
   * 落一条事件。`write` / `delete` 已由 `save` / `remove` 自动落，这里给 `recall` / `flag` / `inject` 用。
   * ⚠️ `inject` **仅在注入集合变化时才写**（§7.1：它是唯一可能每轮多次的事件，全写会让它主导日志增长）。
   */
  record(payload: MemoryEventPayload): boolean
}

/**
 * CRUD 装配。
 * ⚠️ 读盘路径**也要跑校验**（plan19 §3.4 落点 2）：用户手改文件塞进凭据或授权语时，
 * 该条不注入 + 进警告区 —— 只挡写入侧等于给手改留了后门。
 */
export function createMemoryRepo(backend: MemoryBackend, opts: MemoryRepoOptions = {}): MemoryRepo {
  const warn = opts.onWarn ?? (() => {})
  const now = opts.now ?? (() => new Date())

  function loadAll(): { entries: MemoryEntry[]; warnings: string[] } {
    const entries: MemoryEntry[] = []
    const warnings: string[] = []
    /** 两条留痕通道都走：界面看 `MemoryIndex.warnings`，排查看日志 —— 少一条就不叫"绝不静默" */
    const note = (message: string): void => {
      warnings.push(message)
      warn(message)
    }

    for (const file of backend.listFiles()) {
      const text = backend.read(file)
      if (text === null) {
        note(`${file}：读不出来，已跳过`)
        continue
      }
      const result = parseMemoryFile(text)
      if (!result.ok) {
        note(`${file}：${result.reason}`)
        continue
      }
      const p = result.parsed
      const validation = validateMemoryFields({
        name: p.name,
        description: p.description,
        body: p.body,
        evidence: p.evidence
      })
      if (!validation.ok) {
        note(`${file}：${validation.reason}`)
        continue
      }
      // 手改的文件没经过确认桥 —— 标记档与确认档都要浮出来（否则等于绕过了那一步）
      if (validation.guard.action !== 'allow') {
        note(`${file}：${validation.guard.reason}`)
      }
      entries.push({ ...p, file })
    }
    return { entries, warnings }
  }

  const currentConversation = opts.conversationId ?? (() => null)
  const notify = opts.onWrite ?? (() => {})
  let lastInjectKey: string | null = null

  /** 落一条事件。`inject` 去重：集合没变就不写（否则它在一轮里会被写很多次，主导日志增长） */
  function record(payload: MemoryEventPayload): boolean {
    if (payload.kind === 'inject') {
      const key = injectionKey(payload.names)
      if (key === lastInjectKey) return false
      lastInjectKey = key
    }
    const event = { ...payload, at: now().toISOString() } as MemoryEvent
    backend.appendEvent(serializeEvent(event))
    return true
  }

  /** 所有"拒了"的口都从这里出 —— 事件流要能回答"试过写什么、为什么没成" */
  function refuse(name: string, reason: string, needsConfirm = false): MemorySaveResult {
    record({ kind: 'write', conversationId: currentConversation(), name, rejected: true, reason })
    notify({ name, ok: false, reason })
    return needsConfirm ? { ok: false, reason, needsConfirm: true } : { ok: false, reason }
  }

  return {
    listFiles: () => backend.listFiles(),

    list() {
      const { entries, warnings } = loadAll()
      return { ...buildIndex(entries), warnings }
    },

    get(file) {
      const text = backend.read(file)
      if (text === null) return null
      const parsed = parseMemoryFile(text)
      return parsed.ok ? { ...parsed.parsed, file } : null
    },

    save(input) {
      const validation = validateMemoryFields({
        name: input.name,
        description: input.description,
        body: input.body,
        evidence: input.evidence ?? null
      })
      if (!validation.ok) return refuse(input.name, validation.reason)

      const guard: MemoryGuardVerdict = validation.guard
      if (guard.action === 'confirm' && input.confirmed !== true) {
        return refuse(input.name, guard.reason, true)
      }

      const existing = loadAll().entries
      let file: string
      let createdAt: string
      if (input.file) {
        // 编辑：按 file 定位（**不许按 name 反推** —— 文件可手改，name 与文件名可脱钩）
        const target = existing.find((e) => e.file === input.file)
        if (!target) return refuse(input.name, '要编辑的条目不存在（可能已被删除或改名）')
        file = target.file
        createdAt = target.createdAt
      } else {
        const slug = slugFor(input.name)
        if (slug === null) {
          return refuse(input.name, 'name 无法用作文件名（含保留字或全为空白）')
        }
        const key = memoryNameKey(input.name)
        if (existing.some((e) => memoryNameKey(e.name) === key)) {
          return refuse(input.name, '已存在同名条目。请换一个 name，或先编辑那一条')
        }
        if (existing.length >= MEMORY_LIMITS.maxEntries) {
          return refuse(
            input.name,
            `记忆已达上限（${MEMORY_LIMITS.maxEntries} 条）。请先删除或合并一些条目再写`
          )
        }
        file = backend.pathFor(slug)
        createdAt = now().toISOString()
      }

      backend.write(
        file,
        serializeMemory({
          name: input.name,
          description: input.description,
          class: input.class,
          origin: input.origin ?? 'model',
          evidence: input.evidence ?? null,
          createdAt,
          updatedAt: now().toISOString(),
          body: input.body
        })
      )
      record({
        kind: 'write',
        conversationId: currentConversation(),
        name: input.name,
        origin: input.origin ?? 'model',
        cls: input.class
      })
      notify({ name: input.name, ok: true })
      return { ok: true, file, guard }
    },

    remove(file, by = 'user') {
      // 幂等：文件不存在 = 成功（照 F8 `agents-store` 的口径）
      const before = this.get(file)
      const removed = backend.remove(file)
      if (removed && before) {
        record({ kind: 'delete', conversationId: currentConversation(), name: before.name, by })
      }
      return removed
    },

    record
  }
}
