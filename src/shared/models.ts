/**
 * 模型档案（plan7 F5 / F5.1）—— **端点 + 模型目录**。
 *
 * ## 为什么是"端点 → 多个模型"（而不是"一个档案 = 一个模型"）
 *
 * 实测需求（用户 2026-09-12 晚，附配置页截图）：
 * **一把 API Key 通常能调好几个模型**（agnes-image-2.5-flash / agnes-video-2.5-flash / agnes-3.0-flash…）。
 * 做成"一个档案一个模型"的话，用户得为每个模型重填一遍地址与 Key —— 那是没必要的折磨。
 *
 * 所以：
 *   · `ModelProfile` = **端点**（一条连接：地址 + 协议 + 一把 Key + 连接级默认）
 *   · 它下面挂一串 `ModelEntry`（**模型目录**），每条 = 一个模型 ID + 显示名 + **自己的高级设置**
 *
 * ## 有效设置 = 端点默认 ⊕ 该模型的高级设置
 *
 * `settingsOf(profile, entry)` 负责合成。`ModelEntry.settings` **只存改过的字段**
 * （`Partial`）：全量复制会让"端点默认改了、模型没跟着变"这种不一致到处长出来，最难查。
 *
 * ## 本模块的边界
 *
 * **纯逻辑**：不 import electron、不碰 IO、不认识 Key 的密文。
 * 落盘（`main/store/models.ts`）与界面各自独立。
 *
 * ## 红线（AGENTS.md / D-013）
 *
 * **API Key 一个字节都不进 `models.json`** —— 仍按"端点 id → 密文"存 settings.json（safeStorage）。
 */
import type { ModelSettings, ProviderType } from './ipc'

/** 来源标签：界面显示"内置来源 / 用户自定义"（不参与任何逻辑判断） */
export type ModelSource = 'deepseek' | 'custom'

/**
 * 一个**模型**（挂在端点下面）。
 * 注意 `settings` 是**覆盖项**，不是完整设置 —— 见文件头的说明。
 */
export interface ModelEntry {
  id: string
  /** 厂商的模型 ID，一字不差（如 `agnes-image-2.5-flash`） */
  model: string
  /** 显示名（可空 = 用 model 当显示名） */
  name?: string
  /** 这个模型**自己的**高级设置（只存改过的字段） */
  settings?: Partial<ModelSettings>
}

/**
 * **从 baseURL 推来源标签**（深度求索 / 自定义）。
 *
 * 为什么是"推"而不是"存一个用户选的值"：来源是**端点地址的函数**，不是用户的偏好 ——
 * 存下来就会过期（本项目的真事：老数据升级时把每个端点都标成了"深度求索"，
 * 连用户自己加的 agnes 端点也顶着这个标签 ✗）。**推导出来的东西不会撒谎。**
 * 认不出来一律算自定义 —— 宁可不标品牌，也不要标错品牌。
 */
export function sourceOfBaseURL(baseURL: string): ModelSource {
  const url = baseURL.toLowerCase()
  if (url.includes('deepseek')) return 'deepseek'
  return 'custom'
}

/** 来源标签给人看的字（界面只读这一个函数，别在各处各写一遍三元表达式） */
export function sourceLabel(source: ModelSource): string {
  return source === 'deepseek' ? '深度求索' : '自定义'
}
/** 一个**端点**：一条连接 + 它的模型目录 */
export interface ModelProfile {
  id: string
  /** 端点显示名（如 "Agnes AI"） */
  name: string
  source: ModelSource
  providerType: ProviderType
  baseURL: string
  /** 连接级默认：超时；单个模型可用 `settings.timeoutMs` 覆盖 */
  timeoutMs: number
  /** 连接级默认：流式 */
  stream: boolean
  /** ★ 模型目录（至少一条 —— 端点没有模型等于没法用） */
  models: ModelEntry[]
  /** 这个端点当前选中的模型 */
  activeModelId: string
  createdAt: number
  updatedAt: number
}

/** 端点 id / 模型条目的 id 形状（长度封顶，避免被塞进超长串当键用） */
export const PROFILE_NAME_MAX = 60

/** 端点当前选中的模型条目（`activeModelId` 过期时落到第一条 —— 绝不允许"选不中任何模型"） */
export function activeEntry(profile: ModelProfile): ModelEntry | null {
  if (profile.models.length === 0) return null
  return profile.models.find((m) => m.id === profile.activeModelId) ?? profile.models[0]
}

/**
 * 合成**有效设置**（内核认识的那份 `ModelSettings`）。
 *
 * 顺序：端点级（协议 / 地址 / 超时 / 流式）→ 模型级覆盖项。
 * 没写进 `entry.settings` 的字段一律取端点默认 —— 于是"改端点默认，所有模型跟着变"是自然结果。
 */
export function settingsOf(profile: ModelProfile, entry: ModelEntry): ModelSettings {
  const over: Partial<ModelSettings> = entry.settings ?? {}
  return {
    providerType: profile.providerType,
    baseURL: profile.baseURL,
    model: entry.model,
    timeoutMs: profile.timeoutMs,
    stream: profile.stream,
    // 下面这些只有"模型级"的默认值（用户没配就是"跟随厂商默认"）
    temperature: over.temperature ?? null,
    topP: over.topP ?? null,
    topK: over.topK ?? null,
    maxTokens: over.maxTokens ?? 4096,
    contextWindow: over.contextWindow ?? 131072,
    reasoningEffort: over.reasoningEffort ?? 'default',
    maxToolRounds: over.maxToolRounds ?? 200,
    supportsImages: over.supportsImages ?? false
  }
}

/** 显示名：用户没写就用模型 ID（列表里不留空白） */
export function entryLabel(entry: ModelEntry): string {
  const name = (entry.name ?? '').trim()
  return name.length > 0 ? name : entry.model
}

/**
 * 新建/改造一个模型条目。空 model 直接拒绝（那是"没有模型"）。
 */
export function makeEntry(input: { id: string; model: string; name?: string; settings?: Partial<ModelSettings> }): ModelEntry {
  return {
    id: input.id,
    model: input.model.trim(),
    ...(input.name && input.name.trim() ? { name: input.name.trim().slice(0, PROFILE_NAME_MAX) } : {}),
    ...(input.settings && Object.keys(input.settings).length > 0 ? { settings: input.settings } : {})
  }
}

/** 新建一个端点（至少要给一个模型条目） */
export function createProfile(input: {
  id: string
  name?: string
  source?: ModelSource
  providerType: ProviderType
  baseURL: string
  timeoutMs?: number
  stream?: boolean
  models: ModelEntry[]
  activeModelId?: string
  now: number
}): ModelProfile {
  const name = (input.name ?? '').trim()
  const first = input.models[0]
  return {
    id: input.id,
    name: (name.length > 0 ? name : first?.model ?? '未命名端点').slice(0, PROFILE_NAME_MAX),
    source: input.source ?? 'custom',
    providerType: input.providerType,
    baseURL: input.baseURL,
    timeoutMs: input.timeoutMs ?? 120000,
    stream: input.stream ?? true,
    models: input.models,
    activeModelId: input.activeModelId ?? first?.id ?? '',
    createdAt: input.now,
    updatedAt: input.now
  }
}

/**
 * 把一份**老的**单模型设置包成端点（迁移入口）。
 * 老档案里"模型级"的字段搬进 `models[0].settings`，连接级的留在端点 —— **参数一个不丢**。
 */
export function profileOf(
  settings: ModelSettings,
  now: number,
  opts?: { id?: string; name?: string; source?: ModelSource }
): ModelProfile {
  const entryId = `${opts?.id ?? 'default'}-m1`
  return createProfile({
    id: opts?.id ?? 'default',
    name: opts?.name ?? settings.model,
    // 来源**从地址推**（不是猜的、也不是存在这儿的固定值）
    source: opts?.source ?? sourceOfBaseURL(settings.baseURL),
    providerType: settings.providerType,
    baseURL: settings.baseURL,
    timeoutMs: settings.timeoutMs,
    stream: settings.stream,
    models: [
      makeEntry({
        id: entryId,
        model: settings.model,
        settings: {
          temperature: settings.temperature,
          topP: settings.topP,
          topK: settings.topK,
          maxTokens: settings.maxTokens,
          contextWindow: settings.contextWindow,
          reasoningEffort: settings.reasoningEffort,
          maxToolRounds: settings.maxToolRounds,
          supportsImages: settings.supportsImages
        }
      })
    ],
    activeModelId: entryId,
    now
  })
}

/** 当前该用哪个端点（命中 → 用它；id 过期 → 第一个；都没有 → null） */
export function activeProfile(profiles: ModelProfile[], activeId: string | null): ModelProfile | null {
  if (profiles.length === 0) return null
  const hit = activeId ? profiles.find((p) => p.id === activeId) : undefined
  return hit ?? profiles[0]
}

/** 能不能删端点：至少要留一个（删空了就发不出任何请求） */
export function canDeleteProfile(profiles: ModelProfile[], id: string): { ok: boolean; reason?: string } {
  if (!profiles.some((p) => p.id === id)) return { ok: false, reason: '这个模型端点不存在（可能已经被删过了）' }
  if (profiles.length <= 1) {
    return { ok: false, reason: '至少要留一个端点 —— 不然就没法发请求了。想换的话请先「添加」' }
  }
  return { ok: true }
}

/**
 * 能不能删一个**模型条目**：端点里至少要留一条。
 * （端点是连接、模型是内容：把内容删空 ≠ 连接没了，但同样没法用。）
 */
export function canDeleteEntry(profile: ModelProfile, entryId: string): { ok: boolean; reason?: string } {
  if (!profile.models.some((m) => m.id === entryId)) return { ok: false, reason: '这个模型不存在（可能已经被删过了）' }
  if (profile.models.length <= 1) {
    return { ok: false, reason: '这个端点至少要留一个模型 —— 不然它就成了一条空连接' }
  }
  return { ok: true }
}

export function removeProfile(profiles: ModelProfile[], id: string): ModelProfile[] {
  return profiles.filter((p) => p.id !== id)
}

/** 迁移的关键一问：**老的那把 Key 归谁** = 列表里第一个端点（可单测，不靠人记） */
export function legacyKeyOwnerId(profiles: ModelProfile[]): string | null {
  return profiles.length > 0 ? profiles[0].id : null
}

// ── 界面用视图类型 ──────────────────────────────────────────────────────────

/** 设置页看到的端点视图：**Key 永远不明文回传**，只给掩码与"有没有" */
export interface ModelProfileView extends ModelProfile {
  hasApiKey: boolean
  apiKeyMasked: string
}

/** 模型页要的一份数据：端点列表 + 当前用哪个 + `models.json` 的真实路径 */
export interface ModelsView {
  profiles: ModelProfileView[]
  activeId: string | null
  filePath: string
}

/**
 * 保存一个**端点**（不是"一个模型"）：连接信息 + 整份模型目录。
 * `apiKey` 为空串 = 保留已存的那把不动（与 `settings:save` 同一约定）。
 */
export interface ModelSaveInput {
  id?: string
  name: string
  providerType: ProviderType
  baseURL: string
  timeoutMs?: number
  stream?: boolean
  /** 模型目录：界面就是照这一份编辑的，保存时整体替换 */
  models: ModelEntry[]
  activeModelId?: string
  apiKey: string
  source?: ModelSource
}

/** 「获取可用模型」的结果：能从厂商那里列出来的模型 ID */
export interface AvailableModels {
  ok: boolean
  /** 给人看的一句话（失败时说清是 Key 错、地址错，还是该端点不提供列表） */
  message: string
  models: string[]
}

// ── 读盘容错 ────────────────────────────────────────────────────────────────

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const nullable = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 单条模型条目的容错：坏条目丢掉（返回 null） */
function normalizeEntry(raw: unknown, fallbackId: string): ModelEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const model = typeof e.model === 'string' ? e.model.trim() : ''
  if (!model) return null
  const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : fallbackId
  const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : undefined
  const s = (e.settings ?? {}) as Record<string, unknown>
  const settings: Partial<ModelSettings> = {}
  if (s.temperature !== undefined) settings.temperature = nullable(s.temperature)
  if (s.topP !== undefined) settings.topP = nullable(s.topP)
  if (s.topK !== undefined) settings.topK = nullable(s.topK)
  if (s.maxTokens !== undefined) settings.maxTokens = num(s.maxTokens, 4096)
  if (s.contextWindow !== undefined) settings.contextWindow = num(s.contextWindow, 131072)
  if (s.reasoningEffort !== undefined) {
    settings.reasoningEffort =
      s.reasoningEffort === 'low' || s.reasoningEffort === 'medium' || s.reasoningEffort === 'high'
        ? s.reasoningEffort
        : 'default'
  }
  if (s.maxToolRounds !== undefined) settings.maxToolRounds = num(s.maxToolRounds, 200)
  if (s.supportsImages !== undefined) settings.supportsImages = s.supportsImages === true
  return {
    id,
    model,
    ...(name ? { name } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  }
}

/**
 * 读盘容错：**逐条校验**，坏条目丢掉并计数；**同时认两种形状**。
 *
 * - **新形状**：带 `models: []` 的端点
 * - **老形状**（0.13.16 及以前）：扁平的一条 = 一个模型 → 就地升级成"端点 + 一条目录"
 *   （用 `profileOf`，与迁移同一条代码路径 ⇒ 不会出现"两套升级逻辑各写一遍"的漂移）
 *
 * 幂等：升级结果本身就是新形状，再读一次不会重复搬。
 */
export function normalizeProfiles(raw: unknown): { profiles: ModelProfile[]; dropped: number } {
  if (!Array.isArray(raw)) return { profiles: [], dropped: 1 }
  const out: ModelProfile[] = []
  const seen = new Set<string>()
  let dropped = 0

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      dropped++
      continue
    }
    const p = item as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    const baseURL = typeof p.baseURL === 'string' ? p.baseURL : ''
    const providerType = p.providerType
    const okProvider = providerType === 'openai-compatible' || providerType === 'anthropic'
    if (!id || !baseURL || !okProvider || seen.has(id)) {
      dropped++
      continue
    }
    seen.add(id)
    const createdAt = num(p.createdAt, 0)
    // ⚠️ **不信盘里的 source**：它是地址的函数，老数据里存错过（全被标成深度求索）→ 读时重推一次
    // （sourceOfBaseURL 是纯的，重推不会破坏用户任何设置 —— 它本来也不是用户能改的东西）
    const source: ModelSource = sourceOfBaseURL(baseURL)
    const provider = providerType as ProviderType

    // 老形状：没有 models 数组，但有一个顶层 model 字符串 → 原地升级
    if (!Array.isArray(p.models)) {
      const model = typeof p.model === 'string' ? p.model.trim() : ''
      if (!model) {
        dropped++
        continue
      }
      out.push(
        profileOf(
          {
            providerType: provider,
            baseURL,
            model,
            temperature: nullable(p.temperature),
            topP: nullable(p.topP),
            topK: nullable(p.topK),
            maxTokens: num(p.maxTokens, 4096),
            timeoutMs: num(p.timeoutMs, 120000),
            stream: p.stream !== false,
            contextWindow: num(p.contextWindow, 131072),
            reasoningEffort:
              p.reasoningEffort === 'low' || p.reasoningEffort === 'medium' || p.reasoningEffort === 'high'
                ? p.reasoningEffort
                : 'default',
            maxToolRounds: num(p.maxToolRounds, 200),
            supportsImages: p.supportsImages === true
          },
          createdAt || Date.now(),
          { id, ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim() } : {}) }
        )
      )
      continue
    }

    // 新形状：逐个模型条目做容错
    const entries: ModelEntry[] = []
    const seenEntry = new Set<string>()
    for (const [idx, rawEntry] of (p.models as unknown[]).entries()) {
      const entry = normalizeEntry(rawEntry, `${id}-m${idx + 1}`)
      if (!entry || seenEntry.has(entry.id)) {
        dropped++
        continue
      }
      seenEntry.add(entry.id)
      entries.push(entry)
    }
    if (entries.length === 0) {
      // 端点一条模型都没有 = 没法用 → 整条丢掉（并计数，让人知道发生了什么）
      dropped++
      continue
    }
    const activeModelId =
      typeof p.activeModelId === 'string' && entries.some((m) => m.id === p.activeModelId)
        ? p.activeModelId
        : entries[0].id
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : entries[0].model
    out.push({
      id,
      name: name.slice(0, PROFILE_NAME_MAX),
      source,
      providerType: provider,
      baseURL,
      timeoutMs: num(p.timeoutMs, 120000),
      stream: p.stream !== false,
      models: entries,
      activeModelId,
      createdAt,
      updatedAt: num(p.updatedAt, createdAt)
    })
  }
  return { profiles: out, dropped }
}
