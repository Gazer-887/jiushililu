/**
 * 模型档案（plan7 F5）—— **端点 + 模型目录**：一把 Key 通常能调好几个模型，若做成"一档一模型"，
 * 用户得为每个模型重填地址与 Key；有效设置 = 端点默认 ⊕ 模型级覆盖（`settingsOf`），故
 * `ModelEntry.settings` **只存改过的字段** —— 全量复制会长出"端点默认改了、模型没跟着变"的不一致。
 *
 * 纯逻辑（不 import electron / 不碰 IO / 不认识 Key 密文，落盘见 `main/store/models.ts`）。
 * ⚠️ API Key 一个字节都不进 `models.json`：仍按"端点 id → 密文"存 settings.json（AGENTS.md / D-013）。
 */
import type { ModelSettings, ProviderType, ReasoningConfig, BudgetEncoding, OffEncoding } from './ipc'
import type { InputModality } from './content-parts'
import { BUDGET_ENCODINGS, OFF_ENCODINGS } from './ipc'
import { REASONING_KINDS } from './ipc'
import { modalitiesFromLegacyFlag, normalizeModalities } from './content-parts'

/** 来源标签：界面显示"内置来源 / 用户自定义"（不参与任何逻辑判断） */
export type ModelSource = 'deepseek' | 'custom'

/** 一个**模型**（挂在端点下）：`settings` 是**覆盖项**不是完整设置 —— 见文件头 */
export interface ModelEntry {
  id: string
  /** 厂商的模型 ID，一字不差 */
  model: string
  /** 显示名（可空 = 用 model 当显示名） */
  name?: string
  settings?: Partial<ModelSettings>
  /**
   * K51 探测落盘（plan57 K51 / D-146 D）：官方能力位问回来的模态 + 问到的时刻 + 来源。
   * 与手勾 `settings.inputModalities` **读写同一个语义**，但手勾优先 —— 探测只填"未声明处"，
   * 绝不覆盖用户亲手勾的值（D-146 D"可覆写能力表"）。
   */
  detectedModalities?: InputModality[]
  /** 探测时刻（Date.now()）。超 `DETECT_TTL_MS` 即视为过期，按"未探测"处理 —— 过期数据比没有更坏 */
  detectedAt?: number
  /** 目前只有 Anthropic 官方 `/v1/models` 有这个位（OpenAI 侧无官方位，不填） */
  detectSource?: 'anthropic-models-api'
}

/** 探测缓存有效期：7 天（B3 定案）。过期不断网重探的 quiet 失败，只降级显示与报因 */
export const DETECT_TTL_MS = 7 * 24 * 3600 * 1000

/** 探测记录是否还有效：缺字段、非数字、未来时间一律按无效（防脏数据把过期判成新鲜） */
export function isDetectionFresh(detectedAt: number | undefined, now: number = Date.now()): boolean {
  if (typeof detectedAt !== 'number' || !Number.isFinite(detectedAt)) return false
  const age = now - detectedAt
  if (age < 0) return false
  return age <= DETECT_TTL_MS
}

/** 单个模型官方能力位（目前只有 Anthropic 回这个；OpenAI 侧无官方位，不参与） */
export interface ModelCapabilities {
  /** `capabilities.image_input.supported` 的原值；缺字段 = 该模型没声明 = null 语义 */
  imageInput?: boolean
}

/**
 * K51 落盘映射（纯函数，单测钉住）：按模型 ID 精确匹配档案条目，把官方能力位写成
 * `detectedModalities + detectedAt + detectSource`。**只增不改** —— 手勾 settings、
 * id/name/model 一律不动；对不上的模型 ID 与缺 imageInput 的条目直接跳过。
 * `capabilities` 为空/缺省 = 本次没问到任何位 ⇒ 全表原样返回（失败形状不写盘，K51-3）。
 */
export function applyDetectionToEntries(
  entries: ModelEntry[],
  capabilities: Record<string, ModelCapabilities> | undefined,
  now: number
): ModelEntry[] {
  if (!capabilities) return entries
  let changed = false
  const next = entries.map((e) => {
    const cap = capabilities[e.model]
    if (!cap || typeof cap.imageInput !== 'boolean') return e
    changed = true
    return {
      ...e,
      detectedModalities: (cap.imageInput ? ['text', 'image'] : ['text']) as InputModality[],
      detectedAt: now,
      detectSource: 'anthropic-models-api' as const
    }
  })
  return changed ? next : entries
}

/**
 * 从 baseURL 推来源标签：来源是**地址的函数**、不是用户偏好 —— 存下来就会过期
 * （老数据升级时曾把用户自加的 agnes 端点也标成"深度求索"）。认不出来一律算自定义。
 */
export function sourceOfBaseURL(baseURL: string): ModelSource {
  const url = baseURL.toLowerCase()
  if (url.includes('deepseek')) return 'deepseek'
  return 'custom'
}

/** 界面只读这一个函数，别在各处各写一遍三元表达式 */
export function sourceLabel(source: ModelSource): string {
  return source === 'deepseek' ? '深度求索' : '自定义'
}
/** 一个**端点**：一条连接 + 它的模型目录 */
export interface ModelProfile {
  id: string
  name: string
  source: ModelSource
  providerType: ProviderType
  baseURL: string
  /** 连接级默认：超时；单个模型可用 `settings.timeoutMs` 覆盖 */
  timeoutMs: number
  stream: boolean
  /** 模型目录，至少一条 —— 端点没有模型等于没法用 */
  models: ModelEntry[]
  activeModelId: string
  createdAt: number
  updatedAt: number
}

/** id / 显示名的长度上限 —— 封顶，免得超长串被当键用 */
export const PROFILE_NAME_MAX = 60

/** 端点当前选中的条目；`activeModelId` 过期时落到第一条 —— 绝不允许"选不中任何模型" */
export function activeEntry(profile: ModelProfile): ModelEntry | null {
  if (profile.models.length === 0) return null
  return profile.models.find((m) => m.id === profile.activeModelId) ?? profile.models[0]
}

/**
 * 合成**有效设置**：端点级（协议 / 地址 / 超时 / 流式）→ 模型级覆盖项；
 * 没写进 `entry.settings` 的一律取端点默认（于是"改端点默认、所有模型跟着变"是自然结果）。
 */
export function settingsOf(profile: ModelProfile, entry: ModelEntry): ModelSettings {
  const over: Partial<ModelSettings> = entry.settings ?? {}
  return {
    providerType: profile.providerType,
    baseURL: profile.baseURL,
    model: entry.model,
    timeoutMs: profile.timeoutMs,
    stream: profile.stream,
    // 这些只有模型级默认值；没配即"跟随厂商默认"
    temperature: over.temperature ?? null,
    topP: over.topP ?? null,
    topK: over.topK ?? null,
    maxTokens: over.maxTokens ?? 4096,
    contextWindow: over.contextWindow ?? 131072,
    reasoningEffort: over.reasoningEffort ?? 'default',
    // 思考能力**只存模型级**（没有端点默认这层）：档位白名单是"这个模型支持什么"的事实，
    // 端点级的默认值没有意义 —— 同一个端点下不同模型能吃的档不一样。
    ...(over.reasoning ? { reasoning: over.reasoning } : {}),
    maxToolRounds: over.maxToolRounds ?? 200,
    inputModalities: over.inputModalities ?? ['text']
  }
}

/** 用户没写名就用模型 ID（列表里不留空白） */
export function entryLabel(entry: ModelEntry): string {
  const name = (entry.name ?? '').trim()
  return name.length > 0 ? name : entry.model
}

/** 新建/改造一个模型条目；空 `model` 直接拒绝（那是"没有模型"） */
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

/** 老的单模型设置 → 端点（迁移入口）：模型级字段搬进 `models[0].settings` —— 参数一个不丢 */
export function profileOf(
  settings: ModelSettings,
  now: number,
  opts?: { id?: string; name?: string; source?: ModelSource }
): ModelProfile {
  const entryId = `${opts?.id ?? 'default'}-m1`
  return createProfile({
    id: opts?.id ?? 'default',
    name: opts?.name ?? settings.model,
    // 来源从地址推，见 sourceOfBaseURL
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
          // 同 `settingsOf`：**白名单重建**，漏一个字段它就在这条路上蒸发。
          // 今天两个调用方（扁平老形状升级 / 遗留单模型设置）手里都没有 `reasoning` 所以丢不了，
          // 但签名收的是 `ModelSettings` —— 将来谁传一个带 `reasoning` 的进来就静默丢。
          ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
          maxToolRounds: settings.maxToolRounds,
          inputModalities: settings.inputModalities
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

/** 快速切换器的精确匹配结果（plan39 D-101）：命中给端点+条目；未命中**不产生任何写操作** */
export interface ModelSwitchResult {
  ok: boolean
  message?: string
}

/**
 * 按模型名在**全部端点**里精确找条目（plan39）：同名多条优先当前端点。
 * 纯函数进 shared 的理由：store/models.ts 挂 electron-store 进不了单测图，匹配逻辑必须可测。
 */
export function findModelEntry(
  profiles: ModelProfile[],
  activeId: string | null,
  name: string
): { profileId: string; entryId: string } | null {
  const ordered = [...profiles].sort((a, b) => (a.id === activeId ? -1 : 0) - (b.id === activeId ? -1 : 0))
  for (const p of ordered) {
    const entry = p.models.find((m) => m.model === name)
    if (entry) return { profileId: p.id, entryId: entry.id }
  }
  return null
}

/** 能不能删端点：至少要留一个（删空了就发不出任何请求） */
export function canDeleteProfile(profiles: ModelProfile[], id: string): { ok: boolean; reason?: string } {
  if (!profiles.some((p) => p.id === id)) return { ok: false, reason: '该模型端点不存在（可能已被删除）' }
  if (profiles.length <= 1) {
    return { ok: false, reason: '至少要留一个端点 —— 否则无法发起请求；如需更换，请先「添加」' }
  }
  return { ok: true }
}

/** 能不能删一个模型条目：端点里至少要留一条（内容删空 ≠ 连接没了，但同样没法用） */
export function canDeleteEntry(profile: ModelProfile, entryId: string): { ok: boolean; reason?: string } {
  if (!profile.models.some((m) => m.id === entryId)) return { ok: false, reason: '该模型不存在（可能已被删除）' }
  if (profile.models.length <= 1) {
    return { ok: false, reason: '该端点至少要留一个模型 —— 不然它就成了一条空连接' }
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

/** 保存**端点**（不是"一个模型"）：`apiKey` 空串 = 保留已存的那把不动（同 `settings:save`） */
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

/**
 * 输入框 chip 的**单字段补丁**（plan58 R2）。只收白名单字段：
 * 合法性（白名单判档）由主进程合成整表过 `modelSaveSchema` —— 与整表保存同一道闸。
 * 片③ 起 `contextWindow` 也走这里（上下文窗口 chip）。
 */
export interface ModelPatchEntryInput {
  profileId: string
  entryId: string
  patch: {
    reasoningEffort?: string
    reasoning?: ReasoningConfig
    contextWindow?: number
  }
}

/**
 * 单字段补丁的合并（plan58 R2 / Q2）。**只覆盖 patch 带的键**，其余原样保留 ——
 * 校验（handler 合成整表）与落盘（store）都走这一份合并，防的就是 `models:save`
 * 那种"整表提交互相覆盖"的回退。可单测：Q2 的"其它字段逐字节不变"钉在这里。
 */
export function mergeEntrySettings(
  settings: Partial<ModelSettings> | undefined,
  patch: { reasoningEffort?: string; reasoning?: ReasoningConfig; contextWindow?: number }
): Partial<ModelSettings> {
  return { ...(settings ?? {}), ...patch }
}

/** 「获取可用模型」的结果：能从厂商那里列出来的模型 ID */
export interface AvailableModels {  ok: boolean
  /** 给人看的一句话（失败时说清是 Key 错、地址错，还是该端点不提供列表） */
  message: string
  models: string[]
  /**
   * K51 顺手带回的官方能力位（目前只有 Anthropic lane 填；OpenAI 侧无官方位，缺省）。
   * 缺省/空对象 = 本次没问到任何位，调用方不得据此改档案（失败形状不写盘）。
   */
  capabilities?: Record<string, ModelCapabilities>
}

/**
 * 「拉取可用模型」入参（plan47 S1）：**协议 + 地址 + Key 三样对即可拉，不要求端点已保存**。
 * `id` 只在编辑已存端点且用户没重填 Key 时用——回落那一把已存的密文 Key。
 * 明文 Key 经 IPC 单向送进主进程、不回渲染端，与 `IPC.settingsTest` 同一条规矩（本项目硬约束是「代码不出本机」）。
 */
export interface FetchAvailableInput {
  id?: string
  providerType: ProviderType
  baseURL: string
  timeoutMs?: number
  apiKey?: string
}

/**
 * 免保存拉取的 Key 解析链（plan47 S1）：入参明文（表单里刚填的）→ 有 `id` 时用该端点已存密文 → 空串。
 * 抽成纯函数是为脱离 electron-store 单测四条路（有 Key / 无 Key 有 id / 无 Key 无 id / id 指向空 Key 端点）。
 * 空串由调用方翻成人话「请先填写 API Key」，**不静默发请求**。
 */
export function resolveFetchApiKey(input: FetchAvailableInput, savedKey: string): string {
  if (input.apiKey && input.apiKey.length > 0) return input.apiKey
  if (input.id && savedKey.length > 0) return savedKey
  return ''
}

// ── 读盘容错 ────────────────────────────────────────────────────────────────

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const nullable = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * `reasoning` 的读盘容错（plan58 片⓪）。
 *
 * ⚠️ 这个函数**必须存在**，否则 `normalizeEntry` 那个"从空对象白名单重建 settings"的写法
 * 会把 `reasoning` 整段丢掉 —— 字段在类型里、用户填得进去、读一次就没了（`no-dead-wiring` 同族）。
 * `kind` 认不出就整个丢掉（宁可不许有，不许存一个界面会照着渲染的半截配置）。
 */
function normalizeReasoning(raw: unknown): ReasoningConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!REASONING_KINDS.includes(r.kind as (typeof REASONING_KINDS)[number])) return undefined
  const out: ReasoningConfig = { kind: r.kind as ReasoningConfig['kind'] }
  if (Array.isArray(r.levels)) {
    // 去重保序：同一档名填两次不该让界面出现两个同名选项
    const levels = [
      ...new Set(r.levels.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))
    ]
    if (levels.length > 0) out.levels = levels
  }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.budget === 'number' && Number.isFinite(r.budget)) out.budget = r.budget
  // 片②（缺口 C）两个出境编码：只在取值集合内收，认不出 = 当它没填（omission 语义，界面会披露）
  if (BUDGET_ENCODINGS.includes(r.budgetEncoding as BudgetEncoding)) {
    out.budgetEncoding = r.budgetEncoding as BudgetEncoding
  }
  if (OFF_ENCODINGS.includes(r.offEncoding as OffEncoding)) {
    out.offEncoding = r.offEncoding as OffEncoding
  }
  return out
}

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
  // ⚠️ 档名**只做形状容错，不按词表洗**（plan58 R6 + 用户 09-27 裁定「读盘不洗，原值保留」）。
  // 合法性由保存时的 `modelSaveSchema.superRefine` 按该模型自己声明的 `reasoning.levels` 判 ——
  // 洗在这里等于**静默改掉用户填的值**且无处可查，而我们三家端点的档名**一格都没实测过**
  // （plan58 §丁），照着别家文档洗等于拿文档值冒充实测值。
  if (typeof s.reasoningEffort === 'string' && s.reasoningEffort.trim()) {
    settings.reasoningEffort = s.reasoningEffort
  }
  const reasoning = normalizeReasoning(s.reasoning)
  if (reasoning) settings.reasoning = reasoning
  if (s.maxToolRounds !== undefined) settings.maxToolRounds = num(s.maxToolRounds, 200)
  // 新字段优先；只有旧字段时**就地迁移**（0.13.92 及以前的档案里存的是 `supportsImages: boolean`）。
  // 迁移只发生在读盘这一处，写盘一律只写新字段 ⇒ 不会出现两份真相同时可写。
  const mods = normalizeModalities(s.inputModalities)
  if (mods) settings.inputModalities = mods
  else if (s.supportsImages !== undefined) settings.inputModalities = modalitiesFromLegacyFlag(s.supportsImages === true)
  return {
    id,
    model,
    ...(name ? { name } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  }
}

/**
 * 读盘容错：逐条校验，坏条目丢掉并计数；**同时认两种形状** —— 新形状带 `models: []`，
 * 老形状（0.13.16 及以前）是扁平的一条 = 一个模型，就地走 `profileOf` 升级成"端点 + 一条目录"
 * （与迁移同一代码路径，避免两套升级逻辑漂移）。幂等：升级结果即新形状，再读不会重复搬。
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
    // ⚠️ 不信盘里的 source：它是地址的函数，老数据存错过（全被标成深度求索）→ 读时重推
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
            // 扁平老形状（0.13.16 及以前）：档名同样只做形状容错，不按词表洗（同 `normalizeEntry`）
            reasoningEffort:
              typeof p.reasoningEffort === 'string' && p.reasoningEffort.trim()
                ? p.reasoningEffort
                : 'default',
            maxToolRounds: num(p.maxToolRounds, 200),
            // 扁平老形状（0.13.16 及以前）没有模态概念：按旧布尔迁移，缺省即「只有文本」
            inputModalities: modalitiesFromLegacyFlag(p.supportsImages === true)
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
      // 端点一条模型都没有 = 没法用 → 整条丢掉并计数
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
