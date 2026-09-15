// Playbook 纯逻辑（plan19 批 3）：严格 frontmatter 解析、条目序列化、标签匹配、索引与预算截断、CRUD。
// ⚠️ 不 import electron / fs —— 存储接缝由 `PlaybookBackend` 注入，本文件可单测。
// 地基复用 memory-core.ts 的模式（parseMemoryFile 的严格解析口径），但类型独立（`@shared/playbook.ts`）。

import {
  normalizeTag,
  playbookNameKey,
  PLAYBOOK_LIMITS,
  PLAYBOOK_ORIGINS,
  validatePlaybookFields,
  type PlaybookEntry,
  type PlaybookIndex,
  type PlaybookOrigin,
  type PlaybookSaveInput,
  type PlaybookSaveResult
} from '@shared/playbook'
import { utf8Bytes } from '@shared/memory'
import { serializeEvent, type MemoryEvent, type MemoryEventPayload } from './events'

/** 存储接缝。⚠️ 与 MemoryBackend 同模式，但路径隔离在 `playbooks/` */
export interface PlaybookBackend {
  listFiles(): string[]
  read(file: string): string | null
  write(file: string, text: string): void
  remove(file: string): boolean
  pathFor(slug: string): string
  appendEvent(line: string): void
}

export interface ParsedPlaybook {
  name: string
  description: string
  tags: string[]
  origin: PlaybookOrigin
  createdAt: string
  updatedAt: string
  body: string
}

export type PlaybookParseResult = { ok: true; parsed: ParsedPlaybook } | { ok: false; reason: string }

const KNOWN_KEYS = new Set([
  'name', 'description', 'tags', 'origin', 'createdAt', 'updatedAt'
])

const REQUIRED_KEYS = ['name', 'description', 'tags', 'origin', 'createdAt', 'updatedAt'] as const

/**
 * 严格 frontmatter 解析（与 parseMemoryFile 同口径）。
 * tags 用逗号分隔存储（`tags: file-edit,react`），解析时 trim + normalize。
 */
export function parsePlaybookFile(text: string): PlaybookParseResult {
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
  if (!(PLAYBOOK_ORIGINS as readonly string[]).includes(fields['origin']!)) {
    return { ok: false, reason: `origin 只能是 ${PLAYBOOK_ORIGINS.join(' / ')}` }
  }

  const tagsRaw = fields['tags']!
  const tags = tagsRaw.split(',').map((t) => normalizeTag(t)).filter((t) => t.length > 0)
  if (tags.length === 0) return { ok: false, reason: 'tags 不能为空' }

  const after = normalized.slice(end + 5)
  const body = after.startsWith('\n') ? after.slice(1) : after

  return {
    ok: true,
    parsed: {
      name: fields['name']!,
      description: fields['description']!,
      tags,
      origin: fields['origin'] as PlaybookOrigin,
      createdAt: fields['createdAt']!,
      updatedAt: fields['updatedAt']!,
      body
    }
  }
}

/** 序列化。tags 用逗号分隔 */
export function serializePlaybook(parsed: ParsedPlaybook): string {
  const lines = [
    '---',
    `name: ${parsed.name}`,
    `description: ${parsed.description}`,
    `tags: ${parsed.tags.join(',')}`,
    `origin: ${parsed.origin}`,
    `createdAt: ${parsed.createdAt}`,
    `updatedAt: ${parsed.updatedAt}`,
    '---',
    ''
  ]
  return `${lines.join('\n')}\n${parsed.body}`
}

const RESERVED_SLUGS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

export function slugFor(name: string): string | null {
  const slug = name.trim().replace(/\s+/g, '-')
  if (slug.length === 0) return null
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return null
  return slug
}

/** 注入索引里的一行 */
export function indexLine(entry: PlaybookEntry): string {
  return `- ${entry.name}：${entry.description}`
}

/**
 * 索引与预算截断。与 buildMemoryIndex 同模式：updatedAt 倒序 → 字节/行数双重截断。
 */
export function buildPlaybookIndex(entries: PlaybookEntry[]): PlaybookIndex {
  const sorted = [...entries].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )

  const kept: PlaybookEntry[] = []
  let bytes = 0
  for (const entry of sorted) {
    if (kept.length >= PLAYBOOK_LIMITS.maxEntries) break
    const lineBytes = utf8Bytes(`${indexLine(entry)}\n`)
    if (bytes + lineBytes > PLAYBOOK_LIMITS.maxInjectBytes) break
    bytes += lineBytes
    kept.push(entry)
  }
  return { entries: kept, total: entries.length, omitted: entries.length - kept.length, warnings: [] }
}

export interface PlaybookRepoOptions {
  onWarn?: (message: string) => void
  now?: () => Date
  conversationId?: () => string | null
}

export interface PlaybookRepo {
  list(): PlaybookIndex
  get(file: string): PlaybookEntry | null
  listFiles(): string[]
  save(input: PlaybookSaveInput): PlaybookSaveResult
  remove(file: string): boolean
  record(payload: MemoryEventPayload): boolean
  /** 按活跃标签召回匹配的条目（条件召回 = tags 交集非空） */
  recall(activeTags: string[]): PlaybookEntry[]
}

export function createPlaybookRepo(backend: PlaybookBackend, opts: PlaybookRepoOptions = {}): PlaybookRepo {
  const now = opts.now ?? (() => new Date())

  function loadAll(): { entries: PlaybookEntry[]; warnings: string[] } {
    const entries: PlaybookEntry[] = []
    const warnings: string[] = []
    for (const file of backend.listFiles()) {
      const text = backend.read(file)
      if (text === null) { warnings.push(`${file}：读不出来`); continue }
      const result = parsePlaybookFile(text)
      if (!result.ok) { warnings.push(`${file}：${result.reason}`); continue }
      const p = result.parsed
      const validation = validatePlaybookFields({ name: p.name, description: p.description, body: p.body, tags: p.tags })
      if (!validation.ok) { warnings.push(`${file}：${validation.reason}`); continue }
      entries.push({ ...p, file })
    }
    return { entries, warnings }
  }

  const currentConversation = opts.conversationId ?? (() => null)

  function record(payload: MemoryEventPayload): boolean {
    backend.appendEvent(serializeEvent({ ...payload, at: now().toISOString() } as MemoryEvent))
    return true
  }

  return {
    listFiles: () => backend.listFiles(),

    list() {
      const { entries, warnings } = loadAll()
      return { ...buildPlaybookIndex(entries), warnings }
    },

    get(file) {
      const text = backend.read(file)
      if (text === null) return null
      const parsed = parsePlaybookFile(text)
      return parsed.ok ? { ...parsed.parsed, file } : null
    },

    save(input) {
      const validation = validatePlaybookFields({
        name: input.name,
        description: input.description,
        body: input.body,
        tags: input.tags
      })
      if (!validation.ok) {
        record({ kind: 'playbook_write', conversationId: currentConversation(), name: input.name, rejected: true, reason: validation.reason })
        return { ok: false, reason: validation.reason }
      }

      const existing = loadAll().entries
      let file: string
      let createdAt: string
      if (input.file) {
        const target = existing.find((e) => e.file === input.file)
        if (!target) return { ok: false, reason: '要编辑的条目不存在' }
        file = target.file
        createdAt = target.createdAt
      } else {
        const slug = slugFor(input.name)
        if (slug === null) return { ok: false, reason: 'name 无法用作文件名' }
        const key = playbookNameKey(input.name)
        if (existing.some((e) => playbookNameKey(e.name) === key)) {
          return { ok: false, reason: '已存在同名条目' }
        }
        file = backend.pathFor(slug)
        createdAt = now().toISOString()
      }

      const normalizedTags = input.tags.map(normalizeTag)
      backend.write(file, serializePlaybook({
        name: input.name,
        description: input.description,
        tags: normalizedTags,
        origin: input.origin ?? 'model',
        createdAt,
        updatedAt: now().toISOString(),
        body: input.body
      }))
      record({ kind: 'playbook_write', conversationId: currentConversation(), name: input.name, origin: input.origin ?? 'model', cls: normalizedTags[0] ?? 'default' })
      return { ok: true, file }
    },

    remove(file) {
      const before = this.get(file)
      const removed = backend.remove(file)
      if (removed && before) {
        record({ kind: 'playbook_recall', conversationId: currentConversation(), name: before.name, found: false })
      }
      return removed
    },

    record,

    recall(activeTags) {
      const normalized = activeTags.map(normalizeTag)
      if (normalized.length === 0) return []
      const { entries } = loadAll()
      return entries.filter((e) => e.tags.some((t) => normalized.includes(normalizeTag(t))))
    }
  }
}
