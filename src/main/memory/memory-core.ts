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
  type MemoryCandidate,
  type MemoryClass,
  type MemoryEntry,
  type MemoryEvidence,
  type MemoryGuardVerdict,
  type MemoryIndex,
  type MemoryOrigin,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStats
} from '@shared/memory'
import { injectionKey, serializeEvent, type MemoryEvent, type MemoryEventPayload } from './events'
import { findDuplicatePairs, findSimilarEntry } from './similarity'

/** 存/取的唯一接缝。⚠️ read/remove 必须自行拒绝 `notes/` 与 `candidates/` 之外的路径（file 来自渲染进程） */
export interface MemoryBackend {
  /** 列出全部条目文件的绝对路径 */
  listFiles(): string[]
  read(file: string): string | null
  write(file: string, text: string): void
  remove(file: string): boolean
  /** slug → notes 绝对路径。布局只由 store 层知道，本文件不认路径拼接 */
  pathFor(slug: string): string
  /** 批 2：slug → candidates 绝对路径。⚠️ 候选**不进 notes/**，不调 `pathFor` */
  candidatePathFor(slug: string): string
  /** 批 2：列出候选目录全部文件。⚠️ 与 `listFiles()` 互斥 —— 候选不进注入索引段（审查 A P0） */
  listCandidates(): string[]
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
  /**
   * 批 2：候选文件才带的字段，指向**被撞的旧记忆 file 路径**。
   * ⚠️ 只在候选 frontmatter 里出现；正式条目 serialize 不写它（写进 notes 会让普通条目带着指向自己的标记，无意义）。
   */
  conflictWith?: string
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
  'updatedAt',
  // 批 2：候选 frontmatter 才会写它，普通条目不写但解析要认（否则 approve 时读不出旧记忆 file）
  'conflictWith'
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
  // 批 2：conflictWith 只在候选 frontmatter 出现，可有可无
  const conflictWith = fields['conflictWith'] || undefined
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
      body,
      ...(conflictWith === undefined ? {} : { conflictWith })
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
    // 批 2：候选才写 conflictWith。普通条目无此字段（写成 `undefined` 不会出现在数组里）
    ...(parsed.conflictWith ? [`conflictWith: ${parsed.conflictWith}`] : []),
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
  knowledge: '知识',
  profile: '画像'
}

/** 注入排序的优先级：画像（正文全量注入）> 风格（总是生效）> 其余（按相关性取用）。plan25 D-072 */
const CLASS_RANK: Record<MemoryClass, number> = {
  profile: 2,
  style: 1,
  default: 0,
  knowledge: 0
}

/** 遗忘豁免（LRU 不删）：style 永不遗忘（plan19），profile 全库最多一条且是档案（plan25 D-071） */
function isExemptFromForget(entry: MemoryEntry): boolean {
  return entry.class === 'style' || entry.class === 'profile'
}

/** 注入索引里的一行。**唯一口径** —— `buildIndex` 的字节账与 `inject` 的正文都用它，不许各写一份 */
export function indexLine(entry: MemoryEntry): string {
  return `- [${CLASS_LABELS[entry.class]}] ${entry.name}：${entry.description}`
}

/**
 * 索引与预算截断。排序：**画像 > 风格**（画像正文全量注入、风格总是生效，不该被条件类挤掉），
 * 其余按 updatedAt 倒序，同刻按 name 升序（保证确定性 —— 否则单测会随机翻车）。
 * ⚠️ `omitted` 必须如实带出，不许静默丢（R9.1 三条红线之一：不静默截断）。
 */
export function buildIndex(entries: MemoryEntry[]): MemoryIndex {
  const sorted = [...entries].sort((a, b) => {
    const rank = CLASS_RANK[b.class] - CLASS_RANK[a.class]
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
  // candidates / duplicates 由 list() 填真值；buildIndex 只管索引段，故给空数组占位（类型要它，语义不需要它）
  return {
    entries: kept,
    total: entries.length,
    omitted: entries.length - kept.length,
    warnings: [],
    duplicates: [],
    candidates: []
  }
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
   * **合并疑似重复**（plan33 问题四）：把 `olderFile` 的正文并入 `newerFile`（方向按 createdAt
   * 在方法内重判 —— 调用方传的顺序不 trusted），删除较旧那条。合并留痕（write + delete 事件）。
   */
  merge(olderFile: string, newerFile: string): { ok: boolean; message: string }
  /**
   * 落一条事件。`write` / `delete` 已由 `save` / `remove` 自动落，这里给 `recall` / `flag` / `inject` 用。
   * ⚠️ `inject` **仅在注入集合变化时才写**（§7.1：它是唯一可能每轮多次的事件，全写会让它主导日志增长）。
   */
  record(payload: MemoryEventPayload): boolean
  // ── 批 2：反思候选通路 ──
  /** 找出与给定 name 撞名的既有条目（按 `memoryNameKey` 比较） */
  findConflict(name: string): MemoryEntry | null
  /**
   * 写一条候选到 `candidates/`。⚠️ 必须先调 `validateMemoryFields` ——
   * 反思从会话正文提炼，正文里可能含用户贴过的凭据（审查 E P0）。
   * 命中凭据形状 → 候选不落盘 + 留痕 + 返回空串。
   */
  saveCandidate(input: MemoryCandidate, conflictWith?: string): string
  /**
   * 批准候选：若有 conflictWith，用候选内容覆盖旧记忆 + 删候选；否则把候选提升为正式条目。
   * ⚠️ 必须删候选文件（审查 B P1，否则同名双条进索引）。
   */
  approveCandidate(file: string): MemorySaveResult
  /** 拒绝候选：删候选文件（幂等；不落事件 —— 拒绝是用户行为，不进事件流） */
  rejectCandidate(file: string): boolean
  /** 从事件流算统计（存活率 / 使用率）。⚠️ 不读盘 —— 否则"删了又写回"会让数字假性归零 */
  computeStats(events: MemoryEvent[]): MemoryStats
}

/**
 * CRUD 装配。
 * ⚠️ 读盘路径**也要跑校验**（plan19 §3.4 落点 2）：用户手改文件塞进凭据或授权语时，
 * 该条不注入 + 进警告区 —— 只挡写入侧等于给手改留了后门。
 */
export function createMemoryRepo(backend: MemoryBackend, opts: MemoryRepoOptions = {}): MemoryRepo {
  const warn = opts.onWarn ?? (() => {})
  const now = opts.now ?? (() => new Date())

  function loadAll(): {
    entries: MemoryEntry[]
    warnings: string[]
    duplicates: MemoryIndex['duplicates']
  } {
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
    // plan25 D-071：画像全库最多一条 —— 手改文件可能造出第二条，加载时消解：
    // 取 updatedAt 最新的那条生效，其余**不静默丢**（从注入集中移除 + 双通道留痕）。
    // 不删文件 —— 删除是用户的决定，系统只做"哪条生效"的消解。
    const profileEntries = entries.filter((e) => e.class === 'profile')
    if (profileEntries.length > 1) {
      const sortedProfiles = [...profileEntries].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
      )
      const keepProfile = sortedProfiles[0]!
      for (const stale of sortedProfiles.slice(1)) {
        entries.splice(entries.indexOf(stale), 1)
        note(
          `画像重复：${stale.file} 与 ${keepProfile.file} 同为画像，仅保留更新时间较新的后者（此文件未注入，可手动清理）`
        )
      }
    }

    // 批 4 → plan33 问题四升级：相似检测从 includes 字符串判定升级为 bigram Jaccard + 包含
    // （`similarity.ts` 唯一口径），且从 warnings（会被面板显示成"未能加载"）**分家**为结构化
    // `duplicates` —— 重复不是坏档，堆在坏档区等于没人去清。
    const duplicates = findDuplicatePairs(entries).map((p) => ({
      files: [p.a.file, p.b.file] as [string, string],
      names: [p.a.name, p.b.name] as [string, string],
      descriptions: [p.a.description, p.b.description] as [string, string]
    }))
    return { entries, warnings, duplicates }
  }

  /** 候选条目（批 2）：从 candidates/ 读，**不进注入索引段**（buildIndex 不见它们） */
  function loadCandidates(): MemoryEntry[] {
    const out: MemoryEntry[] = []
    for (const file of backend.listCandidates()) {
      const text = backend.read(file)
      if (text === null) continue
      const result = parseMemoryFile(text)
      if (!result.ok) continue
      out.push({ ...result.parsed, file })
    }
    return out
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
      const { entries, warnings, duplicates } = loadAll()
      const candidates = loadCandidates()
      return { ...buildIndex(entries), warnings, duplicates, candidates }
    },

    get(file) {
      const text = backend.read(file)
      if (text === null) return null
      const parsed = parseMemoryFile(text)
      return parsed.ok ? { ...parsed.parsed, file } : null
    },

    save(input) {
      // plan25 D-073：模型不许直写画像（remember 工具连选项都不给，这里是 save 层的兜底闸）。
      // 画像只能由反思候选（审批后生效）或用户手动产生 —— 模型一句话覆盖整份档案的影响面太大。
      if (input.class === 'profile' && (input.origin ?? 'model') === 'model') {
        return refuse(
          input.name,
          '画像（profile）不允许由模型直接写入。如需更新画像，请让用户在记忆页手动编辑，或在反思流程中作为候选提交'
        )
      }

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
        // plan33 问题四（写入闸门）：撞名拦不住"同义" —— 「用户喜欢深色主题」和「用户偏好深色模式」
        // 是两条，而模型/反复记录就是同义堆积的源头。相似度闸门在这里收口：
        // 拒绝并带回 `similar` 指针（UI 据此给"更新那条/仍要另存"二选一）；模型通路没有 force，
        // 被拒后只能换更具体的 name —— 这正是闸门的目的。存量堆积走面板的「疑似重复」区清理。
        if (input.force !== true) {
          const similar = findSimilarEntry(
            { name: input.name, description: input.description },
            existing
          )
          if (similar) {
            const reason =
              `已存在高度相似的记忆「${similar.name}」（摘要：${similar.description}）。` +
              '若要更新它，请编辑那一条而不是新建；若内容确实不同，请换一个更具体的 name 再存。'
            record({
              kind: 'write',
              conversationId: currentConversation(),
              name: input.name,
              rejected: true,
              reason
            })
            notify({ name: input.name, ok: false, reason })
            return {
              ok: false,
              reason,
              similar: { file: similar.file, name: similar.name, description: similar.description }
            }
          }
        }
        if (existing.length >= MEMORY_LIMITS.maxEntries) {
          // 批 4：LRU 遗忘 —— 按 updatedAt 找最旧的非豁免条目删除（style/profile 豁免，plan25 D-071）
          const candidates = existing.filter((e) => !isExemptFromForget(e))
            .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
          if (candidates.length === 0) {
            return refuse(
              input.name,
              `记忆已达上限（${MEMORY_LIMITS.maxEntries} 条），且只剩风格/画像类条目无法自动遗忘。请先手动删除一些条目再写`
            )
          }
          const toForget = candidates[0]!
          backend.remove(toForget.file)
          record({
            kind: 'delete',
            conversationId: currentConversation(),
            name: toForget.name,
            by: 'system'
          })
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

    // plan33 问题四：合并疑似重复对。方向**在方法内重判**（按 createdAt 取新旧）——
    // 调用方传的顺序不 trusted；正文把较旧那条以引用块并入较新那条，信息不丢（不静默合并）。
    merge(olderFile, newerFile) {
      const a = this.get(olderFile)
      const b = this.get(newerFile)
      if (!a || !b) return { ok: false, message: '要合并的条目有一边已不存在（可能已被删除）' }
      if (a.file === b.file) return { ok: false, message: '同一条目不需要合并' }
      const older = a.createdAt <= b.createdAt ? a : b
      const newer = a.createdAt <= b.createdAt ? b : a
      backend.write(
        newer.file,
        serializeMemory({
          name: newer.name,
          description: newer.description,
          class: newer.class,
          origin: newer.origin,
          evidence: newer.evidence,
          createdAt: newer.createdAt,
          updatedAt: now().toISOString(),
          body: `${newer.body}\n\n## 合并自「${older.name}」\n\n${older.body}`
        })
      )
      backend.remove(older.file)
      record({
        kind: 'write',
        conversationId: currentConversation(),
        name: newer.name,
        origin: newer.origin,
        cls: newer.class
      })
      record({ kind: 'delete', conversationId: currentConversation(), name: older.name, by: 'user' })
      notify({ name: newer.name, ok: true })
      return { ok: true, message: `已把「${older.name}」并入「${newer.name}」并删除旧条` }
    },

    record,

    findConflict(name) {
      const key = memoryNameKey(name)
      return loadAll().entries.find((e) => memoryNameKey(e.name) === key) ?? null
    },

    saveCandidate(input, conflictWith) {
      // ⚠️ 必须先调 validateMemoryFields（审查 E P0：反思从会话正文提炼，
      //    正文里可能含用户贴过的凭据 —— 候选不能凭"模型说的"就落盘）
      const validation = validateMemoryFields({
        name: input.name,
        description: input.description,
        body: input.body,
        evidence: input.evidence ?? null
      })
      if (!validation.ok) {
        // 候选不落盘 + 留痕（走 write 事件 rejected 变体，与 refuse 同口径）
        record({
          kind: 'write',
          conversationId: currentConversation(),
          name: input.name,
          rejected: true,
          reason: validation.reason
        })
        notify({ name: input.name, ok: false, reason: validation.reason })
        return ''
      }

      const slug = slugFor(input.name)
      if (slug === null) {
        const reason = 'name 无法用作文件名（含保留字或全为空白）'
        record({
          kind: 'write',
          conversationId: currentConversation(),
          name: input.name,
          rejected: true,
          reason
        })
        notify({ name: input.name, ok: false, reason })
        return ''
      }

      const ts = now().toISOString()
      const file = backend.candidatePathFor(slug)
      backend.write(
        file,
        serializeMemory({
          name: input.name,
          description: input.description,
          class: input.class,
          origin: 'reflection',
          evidence: input.evidence ?? null,
          createdAt: ts,
          updatedAt: ts,
          body: input.body,
          ...(conflictWith ? { conflictWith } : {})
        })
      )
      return file
    },

    approveCandidate(file) {
      const text = backend.read(file)
      if (text === null) return { ok: false, reason: '候选文件读不出来或不存在' }
      const parsed = parseMemoryFile(text)
      if (!parsed.ok) return { ok: false, reason: `候选解析失败：${parsed.reason}` }
      const p = parsed.parsed

      // 带冲突：用候选内容覆盖旧记忆 + 删候选（审查 B P1，否则同名双条进索引）
      if (p.conflictWith) {
        // plan25 D-073 断言：覆盖分支只对反思来源开放 —— 候选文件由 saveCandidate 落盘
        // （origin 固定 'reflection'）。若未来出现别的候选来源，这里先拦住，不许静默绕过审批语义。
        if (p.origin !== 'reflection') {
          return { ok: false, reason: '候选来源异常（只允许反思流程产生候选），已拒绝覆盖' }
        }
        const oldEntry = this.get(p.conflictWith)
        // 旧记忆可能已被删了 —— origin / createdAt 兜底，不报错（用户删旧记忆后还能批准候选）
        const origin = oldEntry?.origin ?? 'reflection'
        const createdAt = oldEntry?.createdAt ?? now().toISOString()
        backend.write(
          p.conflictWith,
          serializeMemory({
            name: p.name,
            description: p.description,
            class: p.class,
            origin,
            evidence: p.evidence,
            createdAt,
            updatedAt: now().toISOString(),
            body: p.body
            // ⚠️ 正式条目不写 conflictWith（只在候选 frontmatter 里出现）
          })
        )
        backend.remove(file)
        const oldName = oldEntry?.name ?? p.name
        record({
          kind: 'approve',
          conversationId: currentConversation(),
          name: p.name,
          oldName
        })
        notify({ name: p.name, ok: true })
        return { ok: true, file: p.conflictWith, guard: { action: 'allow' } }
      }

      // 全新候选：调 save 提升为正式条目 + 删候选（save 会自动落 write 事件）。
      // ⚠️ 批准 = 用户认可 → origin 变成 'user'（plan19 判据 2 注意点；
      //    不是 'reflection' —— 候选批准后就是正式记忆，反思只负责"产出"，不决定"接受"）
      const saveResult = this.save({
        name: p.name,
        description: p.description,
        class: p.class,
        body: p.body,
        origin: 'user',
        evidence: p.evidence
      })
      if (saveResult.ok) {
        backend.remove(file)
        record({
          kind: 'approve',
          conversationId: currentConversation(),
          name: p.name,
          oldName: ''
        })
      }
      return saveResult
    },

    rejectCandidate(file) {
      // 幂等：文件不存在 = 成功。不落事件（拒绝是用户行为，不进事件流）
      if (backend.read(file) === null) return true
      return backend.remove(file)
    },

    computeStats: (events) => computeStats(events)
  }
}

/**
 * 从事件流算记忆统计（批 2 §六 · 存活率与使用率）。
 * ⚠️ 纯逻辑、不读盘 —— "删了又写回"会让盘上条数假性归零，事件流才是历史真相。
 */
export function computeStats(events: MemoryEvent[]): MemoryStats {
  let written = 0
  let deleted = 0
  const recalledNames = new Set<string>()
  const deletedNames = new Set<string>()
  // 批 4：纠正与误伤计数
  const correctedCounts = new Map<string, number>() // name → 纠正次数
  let flaggedCount = 0

  for (const e of events) {
    if (e.kind === 'write') {
      const rejected = 'rejected' in e && (e as { rejected?: unknown }).rejected === true
      if (!rejected) written++
    } else if (e.kind === 'delete') {
      deleted++
      deletedNames.add((e as { name: string }).name)
    } else if (e.kind === 'recall' && (e as { found?: boolean }).found === true) {
      recalledNames.add((e as { name: string }).name)
    } else if (e.kind === 'correct') {
      const name = (e as { name: string }).name
      correctedCounts.set(name, (correctedCounts.get(name) ?? 0) + 1)
    } else if (e.kind === 'flag') {
      flaggedCount++
    }
  }
  const alive = Math.max(0, written - deleted)
  let recalled = 0
  for (const name of recalledNames) {
    if (!deletedNames.has(name)) recalled++
  }
  recalled = Math.min(alive, recalled)

  // 批 4：纠正率
  let correctedCount = 0
  let repeatCorrectedCount = 0
  for (const count of correctedCounts.values()) {
    if (count >= 1) correctedCount++
    if (count >= 2) repeatCorrectedCount++
  }

  return {
    written,
    alive,
    recalled,
    survivalRate: written === 0 ? null : alive / written,
    usageRate: alive === 0 ? null : recalled / alive,
    correctedCount,
    repeatCorrectedCount,
    flaggedCount,
    repeatCorrectionRate: correctedCount === 0 ? null : repeatCorrectedCount / correctedCount,
    falsePositiveRate: written === 0 ? null : flaggedCount / written
  }
}
