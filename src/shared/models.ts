/**
 * 模型档案（Model Profile）—— 多模型管理（plan7 F5，2026-09-12 提前）。
 *
 * ## 为什么要有这一层
 *
 * 现状是"**一份**模型配置 + **一把** API Key"（`shared/ipc.ts` 的 `ModelSettings`
 * 与 `main/store/settings.ts` 的单个 `apiKeyEncrypted`）——
 * 于是想从 DeepSeek 切到另一家，就得**把原来的 Key 覆盖掉**，切回来还得重贴一遍。
 *
 * 这一层把"配置"从单份升级成**档案列表**：
 *   · 每份档案自带一套完整参数（协议 / 地址 / 模型名 / 采样 / 超时 / 上下文窗口…）
 *   · **每个档案一把 Key**，仍然走 safeStorage（见 §红线）
 *   · 有明确的"当前用哪个"（`activeModelId`）
 *
 * ## 红线（AGENTS.md / D-013）
 *
 * **API Key 一个字节都不进 `models.json`** —— 档案文件里只有配置；
 * Key 按"档案 id → 密文"另存，加密走 safeStorage。
 * 本模块是**纯逻辑**：不 import electron、不碰 IO、不认识 Key 的密文，
 * 只回答"哪个档案该拥有那把老 Key"这类**可判定**的问题。
 *
 * ## 与 `ModelSettings` 的关系
 *
 * `profileOf(settings)` 把一份旧的单模型设置包成一个档案；
 * `settingsOf(profile)` 反过来摊平成内核认识的那份 `ModelSettings` ——
 * 内核一行都不用改，它永远只看见"当前这一个模型"。
 */
import type { ModelSettings, ProviderType } from './ipc'

/** 来源标签：给界面显示"这是内置来源还是用户自定义"（不参与任何逻辑判断） */
export type ModelSource = 'deepseek' | 'custom'

export interface ModelProfile extends ModelSettings {
  id: string
  /** 显示名（用户可改；默认取模型名） */
  name: string
  source: ModelSource
  createdAt: number
  updatedAt: number
}

/** 档案 id 的形状：与其它 id 一致（长度封顶，避免被塞进超长串当文件名/键用） */
export const PROFILE_NAME_MAX = 60

/** 设置页看到的档案视图：**Key 永远不明文回传**，只给掩码与"有没有" ✓ 同 settings 的规矩 */
export interface ModelProfileView extends ModelProfile {
  hasApiKey: boolean
  apiKeyMasked: string
}

/** 模型页要的一份数据：列表 + 当前用哪个 */
export interface ModelsView {
  profiles: ModelProfileView[]
  activeId: string | null
  /** `models.json` 的真实路径（设置页要把它显示给用户 —— 说得出就得是真的） */
  filePath: string
}

/** 新建/编辑一个模型的入参（`apiKey` 为空串 = 保留已存的那把不动） */
export interface ModelSaveInput {
  id?: string
  name: string
  settings: ModelSettings
  apiKey: string
}

/**
 * 新建档案。**name 为空时退回模型名** —— 空名字在列表里就是一行无从辨认的空白。
 * 其余字段的合法性由 zod 在 IPC 边界兜（这里只管"档案"这一层的事）。
 */
export function createProfile(
  input: { id: string; settings: ModelSettings; name?: string; source?: ModelSource; now: number },
  defaults?: { name?: string }
): ModelProfile {
  const rawName = (input.name ?? '').trim()
  const name = rawName.length > 0 ? rawName.slice(0, PROFILE_NAME_MAX) : input.settings.model
  return {
    ...input.settings,
    id: input.id,
    name: name.length > 0 ? name : (defaults?.name ?? '未命名模型'),
    source: input.source ?? 'custom',
    createdAt: input.now,
    updatedAt: input.now
  }
}

/** 把一份旧的单模型设置包成档案（**迁移用**：老数据不许丢） */
export function profileOf(
  settings: ModelSettings,
  now: number,
  opts?: { id?: string; name?: string }
): ModelProfile {
  return createProfile(
    {
      id: opts?.id ?? 'default',
      settings,
      name: opts?.name ?? settings.model,
      source: 'deepseek',
      now
    },
    { name: '默认模型' }
  )
}

/** 把档案摊平成内核认识的 `ModelSettings`（**内核一行都不用改**） */
export function settingsOf(profile: ModelProfile): ModelSettings {
  const {
    providerType,
    baseURL,
    model,
    temperature,
    topP,
    topK,
    maxTokens,
    timeoutMs,
    stream,
    contextWindow,
    reasoningEffort,
    maxToolRounds,
    supportsImages
  } = profile
  return {
    providerType,
    baseURL,
    model,
    temperature,
    topP,
    topK,
    maxTokens,
    timeoutMs,
    stream,
    contextWindow,
    reasoningEffort,
    maxToolRounds,
    supportsImages
  }
}

/**
 * 当前该用哪个档案。
 *
 * 三条兜底（**都不许静默变成"没有模型可用"**）：
 *   ① `activeId` 命中 → 用它
 *   ② 没命中（档案被删了 / 存档里的 id 过期）→ 用第一个
 *   ③ 一个都没有 → null（调用方要当成"还没配模型"来提示，而不是崩）
 */
export function activeProfile(profiles: ModelProfile[], activeId: string | null): ModelProfile | null {
  if (profiles.length === 0) return null
  const hit = activeId ? profiles.find((p) => p.id === activeId) : undefined
  return hit ?? profiles[0]
}

/**
 * 还能不能删。
 *
 * ⚠️ **至少要留一个**：一个都没有 = 应用没法用（发不出任何请求），
 * 而"用户删完之后界面一片空白、不知道该干嘛"是最糟的收尾。
 */
export function canDeleteProfile(profiles: ModelProfile[], id: string): { ok: boolean; reason?: string } {
  if (!profiles.some((p) => p.id === id)) return { ok: false, reason: '这个模型不存在（可能已经被删过了）' }
  if (profiles.length <= 1) {
    return { ok: false, reason: '至少要留一个模型 —— 不然就没法发请求了。想换的话请先「添加模型」' }
  }
  return { ok: true }
}

/** 删除后的档案列表（**纯函数**：调用方负责先过 `canDeleteProfile`） */
export function removeProfile(profiles: ModelProfile[], id: string): ModelProfile[] {
  return profiles.filter((p) => p.id !== id)
}

/**
 * 档案 id → 该用哪把 Key。
 *
 * 迁移的关键一问：**老的那把 Key 归谁？** 答案是"迁移后列表里的第一个档案" ——
 * 因为旧数据就是"当前在用的那一个模型"。这条写成函数是为了**可单测**，
 * 而不是散在主进程里靠人记。
 */
export function legacyKeyOwnerId(profiles: ModelProfile[]): string | null {
  return profiles.length > 0 ? profiles[0].id : null
}

/**
 * 读盘容错：**逐条校验**，坏条目丢掉并计数 —— 与目标（plan11/12）同一套纪律。
 *
 * 为什么必须：这份文件会被手改、被旧版本写、被中断的写截断。
 * 一个坏条目就让整份模型配置消失，是"静默丢数据"里最不该发生的一种
 * （用户会以为自己的 Key 和配置一起没了）。
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
    const model = typeof p.model === 'string' ? p.model : ''
    const providerType = p.providerType
    const okProvider = providerType === 'openai-compatible' || providerType === 'anthropic'
    if (!id || !baseURL || !model || !okProvider || seen.has(id)) {
      dropped++
      continue
    }
    seen.add(id)
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    const createdAt = num(p.createdAt, 0)
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : model
    const source: ModelSource = p.source === 'deepseek' ? 'deepseek' : 'custom'
    const nullable = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null
    out.push({
      id,
      name,
      source,
      providerType: providerType as ProviderType,
      baseURL,
      model,
      temperature: nullable(p.temperature),
      topP: nullable(p.topP),
      topK: nullable(p.topK),
      maxTokens: num(p.maxTokens, 4096),
      timeoutMs: num(p.timeoutMs, 60_000),
      stream: p.stream !== false,
      contextWindow: num(p.contextWindow, 128_000),
      reasoningEffort:
        p.reasoningEffort === 'low' || p.reasoningEffort === 'medium' || p.reasoningEffort === 'high'
          ? p.reasoningEffort
          : 'default',
      maxToolRounds: num(p.maxToolRounds, 12),
      supportsImages: p.supportsImages === true,
      createdAt,
      updatedAt: num(p.updatedAt, createdAt)
    })
  }
  return { profiles: out, dropped }
}
