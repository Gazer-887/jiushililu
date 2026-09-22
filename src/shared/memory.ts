// 记忆层共享契约（plan19 批 1）。影响面三分类、四字段校验、写入侧判定、预算常量住这里，
// 主进程与渲染进程共用同一份口径。
// ⚠️ 不 import electron —— 渲染进程要引用它；architecture.test.ts 的守卫甲会沿 import 图抓。
// ⚠️ 判定结果只当"快速通道"，不是防线：可被同义改写绕过。真正的兜底是巡检区 + 架构守卫。

/** 影响面三分类 + 画像（plan25 D-071）：决定注入策略与是否需要证据。
 * ⚠️ `profile` 是 LangMem「形态轴」（profile vs collection）折进本字段的**有意取舍**（plan25 §D-071）：
 * 画像 = 单一档案、原地更新、正文直接注入；其余三类 = 多条演进、追加修正、正文走 recall。 */
export const MEMORY_CLASSES = ['style', 'default', 'knowledge', 'profile'] as const
export type MemoryClass = (typeof MEMORY_CLASSES)[number]

/** 注入策略。style 与 profile 总是注入（画像正文全量进注入段，plan25 D-072），另两类按相关性 */
export const MEMORY_CLASS_POLICY: Record<MemoryClass, 'always' | 'conditional'> = {
  style: 'always',
  profile: 'always',
  default: 'conditional',
  knowledge: 'conditional'
}

/** 画像条目的固定 name（全库最多一条；slug 同名）。plan25 D-071 */
export const PROFILE_NAME = 'user-profile'

/**
 * 模型可见的分类集合：remember 工具 enum 与错误文案用（plan25 D-073）。
 * ⚠️ **不含 profile** —— 画像改错的影响面是整份档案，模型直写在 save 层被拒，
 * 工具层连选项都不给（双保险）；画像只能由反思（候选审批）或用户手动产生。
 */
export const MODEL_MEMORY_CLASSES = ['style', 'default', 'knowledge'] as const

/** 谁写的。`reflection` 由批 2 的反思产出，批 1 不会出现，形状先留好 */
export const MEMORY_ORIGINS = ['model', 'user', 'reflection'] as const
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number]

/**
 * 预算常量。⚠️ 全部是 **plan19 §五 声明的无实验支撑初值**（校准协议在 §十二）——
 * 别当测出来的结论引用。
 */
export const MEMORY_LIMITS = {
  /** 条目总数上限；达到后写入被拒（不静默丢） */
  maxEntries: 100,
  /** 注入索引的字节上限。Claude Code 是 25KB，本项目收紧到约 1/3 */
  maxIndexBytes: 8 * 1024,
  /** 注入索引的行数上限（一条一行） */
  maxIndexLines: 100,
  /** 单条正文字节上限；正文不进 prompt，只由 recall 按需读 */
  maxBodyBytes: 4 * 1024,
  /** description 字符上限；它是注入进 prompt 的那一行，**超长即拒、不截断**（截断会静默改语义） */
  maxDescriptionChars: 120,
  /** name 字符上限；同时当文件名用 */
  maxNameChars: 64,
  /** 证据原话进事件流前的截断长度；防 events.jsonl 变成第二份会话正文 */
  maxEvidenceQuoteChars: 240
} as const

/**
 * 证据 = **指针**，不是原话。原话留 events.jsonl（它不注入、不出境）——
 * 会话被删后证据仍在，这是存原话的唯一理由（plan19 §3.6）。
 */
export interface MemoryEvidence {
  conversationId: string
  /**
   * 第几轮。⚠️ **可缺**：通路 A（模型调工具）拿不到循环轮次号，而会话级指针**仍然是有用的证据**。
   * 强制两半都给，会让"只有会话"的情况整个丢掉证据 —— 那是把"不完整"当成"没有"
   * （批 1 落盘时的偏差，plan19 §4.3 原写两者必给）。
   */
  turnIndex?: number
}

/** 一条记忆。`file` 是来源绝对路径——读写删一律按它定位，禁止按 name 反推（文件可手改，二者可脱钩） */
export interface MemoryEntry {
  name: string
  description: string
  class: MemoryClass
  origin: MemoryOrigin
  evidence: MemoryEvidence | null
  createdAt: string
  updatedAt: string
  body: string
  file: string
}

/** 注入用的索引视图。`omitted` / `warnings` 必须如实带到界面与 prompt，不许静默丢 */
export interface MemoryIndex {
  /** 只含校验通过且未被预算截断的条目（进注入段） */
  entries: MemoryEntry[]
  /** 盘上全部条目数（含被截断的） */
  total: number
  /** 因预算被截断而未注入的条目数 */
  omitted: number
  /**
   * 注入索引段**已用字节**（逐行 UTF-8，含行尾换行），与 `omitted` 同一把尺子算出来的。
   * 上限不在这里重复传：界面直接读 `MEMORY_LIMITS.maxIndexBytes`，少一处副本少一处漂移。
   */
  usedBytes: number
  /** 解析或校验失败被跳过的文件与原因（fail-soft，但绝不静默） */
  warnings: string[]
  /**
   * 疑似重复对（plan33 问题四）：loadAll 两两检测的结构化结果。
   * ⚠️ 与 `warnings` 分家 —— 重复不是"加载失败"，之前混在里面被显示成坏档，谁也不会去清。
   */
  duplicates: MemoryDuplicatePair[]
  /**
   * 候选条目（批 2）：待批准的反思产出。⚠️ **不进注入段** ——
   * 物理隔离在 `memory/candidates/`，`listFiles()` 只列 `notes/`（审查 A P0）。
   * 巡检区用这个字段显示候选 + 批准/拒绝按钮；批准后变成正式条目进 `entries`。
   */
  candidates: MemoryEntry[]
}

/** 保存入参。`file` 缺省 = 新建；带 `file` = 编辑既有条目 */
export interface MemorySaveInput {
  name: string
  description: string
  class: MemoryClass
  body: string
  origin?: MemoryOrigin
  evidence?: MemoryEvidence | null
  file?: string
  /** 判定为 `confirm` 档的写入，须经确认桥点头后带 `true` 再来一次 */
  confirmed?: boolean
  /**
   * **强制另存**（plan33 问题四）：新条目与库内某条高度相似时，save 会拒绝并带回 `similar`；
   * 用户在「选中即记」卡片上明确选了「仍要另存」才带 `true`。模型通路**不暴露**这个字段 ——
   * 模型被拒后只能换更具体的 name，这是闸门的目的。
   */
  force?: boolean
  /**
   * 候选标记（批 2）：指向**被这条候选撞上的旧记忆 file**。
   * ⚠️ 候选 = 带 `conflictWith` 的 `MemorySaveInput`（即 `MemoryCandidate`）。没有 conflictWith = 全新候选（不撞名）。
   * 仅在 `saveCandidate` 写入候选目录时使用；正式 save 路径不写它。
   */
  conflictWith?: string
}

/**
 * 候选记忆（批 2）。形态 = `MemorySaveInput` + `conflictWith`。
 * ⚠️ 候选**不进索引段**（物理隔离在 `memory/candidates/`，`listFiles()` 只列 `notes/`）——
 *    不批准就绝不注入，这是护栏（审查 A P0）。
 * 批准 = 用候选内容覆盖旧记忆 + 删除候选文件（审查 B P1，否则同名双条进索引）。
 */
export type MemoryCandidate = MemorySaveInput & { conflictWith?: string }

/**
 * 记忆层统计（批 2 §六 · 存活率与使用率）。
 * ⚠️ 全部从事件流算，不读盘 —— 否则"删了又写回"会让数字假性归零。
 * 存活率 = 未删除 / 写入总数；使用率 = 被 recall / 存活。
 * 缺字段 = 没事件可算 → 界面显示「暂无」，**不替它编 0**（与 tier/avoided 同口径）。
 */
export interface MemoryStats {
  /** 写入总数（含已删除的） */
  written: number
  /** 当前存活数（写入 - 删除） */
  alive: number
  /** 被 recall 过的存活条目数 */
  recalled: number
  /** 存活率（0–1）：alive / written。written=0 时为 null */
  survivalRate: number | null
  /** 使用率（0–1）：recalled / alive。alive=0 时为 null */
  usageRate: number | null
  // ── 批 4：纠正与误伤 ──
  /** 被纠正 ≥1 次的条目数（按 name 聚类） */
  correctedCount: number
  /** 被纠正 ≥2 次的条目数（重复纠正 = 同一条记忆被二次纠正） */
  repeatCorrectedCount: number
  /** 被用户 flag 的条目数 */
  flaggedCount: number
  /** 重复纠正率（0–1）：repeatCorrectedCount / correctedCount。correctedCount=0 时为 null */
  repeatCorrectionRate: number | null
  /** 误伤率（0–1）：flaggedCount / written。written=0 时为 null */
  falsePositiveRate: number | null
}

/**
 * 自动记忆成本设置（批 2）。
 * ⚠️ `autoMemoryEnabled` 缺省 = 未设，由档位提供默认值（轻量档关、其余档开）；显式设过不被档位覆盖。
 * `reflectionModel` 缺省 = 跟随对话模型。
 * `reflectionDailyLimit` 缺省 = 20（§五声明的无实验支撑初值，校准协议在 §十二）。
 */
export interface MemoryAutoSettings {
  /** 自动记忆开关。undefined = 未设（由档位提供默认值） */
  autoMemoryEnabled?: boolean
  /** 反思用哪个模型。undefined = 跟随对话模型 */
  reflectionModel?: string
  /** 日上限。undefined = 20 */
  reflectionDailyLimit?: number
}

/**
 * 保存结果。`guard` 带回判定，供调用方决定是否标记巡检区；
 * `needsConfirm` = 该写入落确认档且尚未过确认桥 —— **不是失败**，是"去问用户一句再回来"。
 * `similar`（plan33 问题四）= 被相似度闸门拦下时的**既有相似条目**指针 ——
 * 「选中即记」卡片据此给出「更新那条 / 仍要另存」的二选一。
 */
export type MemorySaveResult =
  | { ok: true; file: string; guard: MemoryGuardVerdict }
  | {
      ok: false
      reason: string
      needsConfirm?: boolean
      similar?: { file: string; name: string; description: string }
    }

/** 一对疑似重复的存量条目（plan33 问题四）：面板「疑似重复」区的数据源 */
export interface MemoryDuplicatePair {
  files: [string, string]
  names: [string, string]
  descriptions: [string, string]
}

/**
 * 护栏 2 的推送载荷（D-043 的 `<MemoryNotice />` 面板数据源）。
 * ⚠️ 只带**本轮**写了什么 —— 全量巡检归右抽屉的巡检区，两者按时机分工，不是重复。
 */
export interface MemoryNoticeEvent {
  conversationId: string
  /** 本轮写成的条目名 */
  written: string[]
  /** 本轮被拒的条目（写不进也要让用户看见，含首条理由） */
  rejected: { name: string; reason: string }[]
}

/**
 * 切换记忆开关的结果。`warnFullAccess` = 开启那一刻正处于**完全访问档** ——
 * 最大风险组合，界面要**当场**告警（判据 14：只在设置页躺一行字等于没写）。
 */
export interface MemorySwitchResult {
  enabled: boolean
  warnFullAccess: boolean
}

/** UTF-8 字节数。快路径：全 ASCII 时字符数即字节数 */
export function utf8Bytes(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return new TextEncoder().encode(text).length
  }
  return text.length
}

/**
 * 撞名比较的**唯一口径**。撞名规则是"新建撞既有同名 → 拒绝"（plan19 §4.3），
 * 比较一律走这里，不许各处各写一份 trim/lower。
 */
export function memoryNameKey(name: string): string {
  return name.trim().toLowerCase()
}

// ── 写入侧判定（plan19 §3.4）──────────────────────────────────────────────

/**
 * 判定四档。**`reject` 不带"确认后即可写"的口子** —— 拒绝写入的记忆根本不存在，
 * 而"确认后写入"的记忆仍会被注入（plan19 §3.2）。
 */
export type MemoryGuardVerdict =
  | { action: 'allow' }
  | { action: 'mark'; reason: string }
  | { action: 'confirm'; reason: string }
  | { action: 'reject'; reason: string }

/** 跳过确认的表述：只在这些词出现时才是"要授权"，故归硬拒 */
const SKIP_CONFIRM_PHRASES = [
  '免确认',
  '不用问',
  '不必问',
  '无需确认',
  '跳过确认',
  '不要确认',
  '不用确认',
  '别问我'
] as const

/**
 * ⚠️ 比上表低一档（走确认桥而非硬拒）：这些词在**合法语境高频**
 * （「CI 自动执行测试」「静默失败」），硬拒会丢真记忆 —— 与敏感名词同一个论证。
 * 折入审查意见时曾把「自动执行」误留在硬拒档，此处改正。
 */
const AUTONOMY_PHRASES = ['自动执行', '自动运行', '静默', '免打扰'] as const

/** 授权相关的名词：单现只是话题，降级为标记 */
const AUTHORIZATION_NOUNS = ['权限', '越权', '授权', '提权'] as const

/**
 * 敏感名词：「密钥放在 1Password 里」是合法的 reference 记忆，只标记不拒。
 * ⚠️ **刻意不含裸词 `token`**（plan19 §3.4 的列表里有，此处偏离）：本项目自己的功能名
 * 「Token Saver」与用量牌都在用这个词，裸词会大面积误标真记忆 —— 与"授权语义词"同一个论证。
 * 真正的凭据靠"形状"识别（见下），不靠这一个词。
 */
const SENSITIVE_NOUNS = ['密钥', '凭证', 'password', 'secret', 'credential'] as const

/** 凭据的已知前缀：几乎不可能误杀（没有正常句子以 `ghp_` 开头）→ 硬拒 */
const CREDENTIAL_PREFIXES = [
  'sk-',
  'ghp_',
  'gho_',
  'github_pat_',
  'glpat-',
  'gldt_',
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'xoxr-',
  'xoxs-',
  'xapp-',
  'AKIA',
  'AIza',
  'ya29.',
  'npm_',
  'pypi-',
  'eyJ'
] as const

/** 真实凭据的形状。`known-prefix` 硬拒；`high-entropy` 走确认桥（无前缀长串可能只是普通文本） */
export interface CredentialHit {
  kind: 'known-prefix' | 'high-entropy'
  sample: string
}

/** 无前缀高熵串：长度 ≥32、且大小写/数字至少占两类 —— 宁可多弹一次确认，也不放过 */
const HIGH_ENTROPY = /[A-Za-z0-9+/_-]{32,}/g

function looksHighEntropy(token: string): boolean {
  const hasLower = /[a-z]/.test(token)
  const hasUpper = /[A-Z]/.test(token)
  const hasDigit = /[0-9]/.test(token)
  return Number(hasLower) + Number(hasUpper) + Number(hasDigit) >= 2
}

/** 找凭据形状。命中已知前缀直接返回；否则返回第一个高熵候选 */
export function findCredentialShape(text: string): CredentialHit | null {
  for (const prefix of CREDENTIAL_PREFIXES) {
    const at = text.indexOf(prefix)
    if (at >= 0) return { kind: 'known-prefix', sample: text.slice(at, at + prefix.length + 12) }
  }
  if (/PRIVATE KEY/.test(text)) return { kind: 'known-prefix', sample: 'PRIVATE KEY' }
  for (const m of text.matchAll(HIGH_ENTROPY)) {
    if (looksHighEntropy(m[0])) return { kind: 'high-entropy', sample: m[0] }
  }
  return null
}

function includesAny(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}

/**
 * 对一段文本做写入侧判定。**判定强度取四档里最严重的那个**；
 * `reason` 一律给人看的话（含指路），不许只回一个错误码。
 */
export function guardMemoryText(text: string): MemoryGuardVerdict {
  const cred = findCredentialShape(text)
  if (cred && cred.kind === 'known-prefix') {
    return {
      action: 'reject',
      reason: '文本含疑似凭据（密钥/token）。请在密钥管理中保存，不要写进记忆'
    }
  }
  if (includesAny(text, SKIP_CONFIRM_PHRASES)) {
    return { action: 'reject', reason: '这条属于权限设置，请到「设置 → 权限」修改' }
  }
  if (cred) {
    return { action: 'confirm', reason: '文本含疑似长凭据串，需要你确认一次' }
  }
  if (includesAny(text, AUTONOMY_PHRASES)) {
    return { action: 'confirm', reason: '这条涉及"不打断我"的授权口径，需要你确认一次' }
  }
  if (includesAny(text, AUTHORIZATION_NOUNS) || includesAny(text, SENSITIVE_NOUNS)) {
    return { action: 'mark', reason: '这条含权限或敏感词，已标记以便巡检' }
  }
  return { action: 'allow' }
}

/** 四档的严重度排序，用于对多段文本取最严结论 */
const VERDICT_RANK: Record<MemoryGuardVerdict['action'], number> = {
  allow: 0,
  mark: 1,
  confirm: 2,
  reject: 3
}

/** 取更严重的那个判定 */
function worse(a: MemoryGuardVerdict, b: MemoryGuardVerdict): MemoryGuardVerdict {
  return VERDICT_RANK[b.action] > VERDICT_RANK[a.action] ? b : a
}

/**
 * 事件流写入前的净化：命中凭据形状则打码，再按上限截断。
 * ⚠️ 硬拒只挡记忆条目、**不挡证据流** —— 用户在聊天里贴过的 token 会原样落进 events.jsonl。
 */
export function sanitizeEvidenceQuote(text: string): string {
  const cred = findCredentialShape(text)
  const masked = cred ? text.split(cred.sample).join('[已脱敏]') : text
  return masked.length > MEMORY_LIMITS.maxEvidenceQuoteChars
    ? masked.slice(0, MEMORY_LIMITS.maxEvidenceQuoteChars)
    : masked
}

// ── 唯一校验口径 ──────────────────────────────────────────────────────────

const NAME_FORBIDDEN = /[\\/:*?"<>|\r\n\t]/

/** frontmatter 的边界串。出现在值里就能伪造出一段新 frontmatter */
const FM_BOUNDARY = '---'

function hasControlChars(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(text)
}

export type MemoryValidation =
  | { ok: true; guard: MemoryGuardVerdict }
  | { ok: false; reason: string }

/**
 * 记忆条目的**唯一校验口径** —— 写入工具、管理表单、读盘解析**三处共用**，不许各写一遍。
 * 比 `validateAgentFields` 严：多查换行、控制字符、frontmatter 边界串、长度上限与凭据形状。
 * ⚠️ 覆盖**全部会进 prompt 或会落盘的文本字段**：name + description + body + evidence。
 *    name 尤其不能漏 —— 注入索引是 "name + description" 一行一条，name 会进 system prompt。
 */
export function validateMemoryFields(input: {
  name: string
  description: string
  body: string
  evidence?: MemoryEvidence | null
}): MemoryValidation {
  const name = input.name
  if (name.length === 0) return { ok: false, reason: 'name 缺失' }
  if (name.length > MEMORY_LIMITS.maxNameChars) {
    return { ok: false, reason: `name 超出上限（${MEMORY_LIMITS.maxNameChars} 字符）` }
  }
  if (NAME_FORBIDDEN.test(name)) {
    return { ok: false, reason: 'name 含非法字符：不能包含 \\ / : * ? " < > | 与换行、制表符' }
  }
  if (name.startsWith(FM_BOUNDARY)) {
    return { ok: false, reason: 'name 不能以 --- 开头（会被当成 frontmatter 边界）' }
  }

  const desc = input.description
  if (desc.length === 0) return { ok: false, reason: 'description 缺失' }
  if (desc.length > MEMORY_LIMITS.maxDescriptionChars) {
    return {
      ok: false,
      reason: `description 超出上限（${MEMORY_LIMITS.maxDescriptionChars} 字符），请压缩后再存`
    }
  }
  if (hasControlChars(desc)) {
    return { ok: false, reason: 'description 必须是单行：不能含换行或其他控制字符' }
  }
  if (desc.includes(FM_BOUNDARY)) {
    return { ok: false, reason: 'description 不能含 ---（会被当成 frontmatter 边界，从而伪造字段）' }
  }

  const body = input.body
  if (body.trim().length === 0) return { ok: false, reason: '正文不能为空' }
  if (utf8Bytes(body) > MEMORY_LIMITS.maxBodyBytes) {
    return { ok: false, reason: `正文超出上限（${MEMORY_LIMITS.maxBodyBytes / 1024} KB）` }
  }
  // 行首 --- 会在下次解析时被当成 frontmatter 起始，把正文伪装成字段
  if (body.split(/\r?\n/).some((line) => line.trimStart() === FM_BOUNDARY)) {
    return { ok: false, reason: '正文不能有一行只写 ---（会被解析器当成 frontmatter 边界）' }
  }

  const evidence = input.evidence ?? null
  if (evidence) {
    if (evidence.conversationId.length === 0) {
      return { ok: false, reason: '证据指针缺会话 id' }
    }
    if (hasControlChars(evidence.conversationId) || evidence.conversationId.includes(FM_BOUNDARY)) {
      return { ok: false, reason: '证据指针的会话 id 含非法字符' }
    }
    if (evidence.turnIndex !== undefined && (!Number.isInteger(evidence.turnIndex) || evidence.turnIndex < 0)) {
      return { ok: false, reason: '证据指针的轮次号必须是非负整数' }
    }
  }

  // 四段文本逐段判定，取最严结论
  let guard = guardMemoryText(name)
  for (const text of [desc, body, evidence?.conversationId ?? '']) {
    guard = worse(guard, guardMemoryText(text))
  }
  if (guard.action === 'reject') return { ok: false, reason: guard.reason }
  return { ok: true, guard }
}
