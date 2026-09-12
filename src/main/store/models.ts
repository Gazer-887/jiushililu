import Store from 'electron-store'
import { copyFileSync, existsSync } from 'node:fs'
import type { ModelSettings, SettingsSaveInput, SettingsView } from '@shared/ipc'
import {
  activeEntry,
  activeProfile,
  canDeleteEntry,
  canDeleteProfile,
  createProfile,
  legacyKeyOwnerId,
  makeEntry,
  normalizeProfiles,
  profileOf,
  removeProfile,
  settingsOf,
  type ModelEntry,
  type ModelProfile,
  type ModelSaveInput,
  type ModelsView,
  type ModelProfileView
} from '@shared/models'
import { createLogger } from '../log'
import {
  clearLegacyApiKey,
  getProfileKey,
  hasProfileKey,
  readLegacyApiKey,
  readLegacyModelSettings,
  removeProfileKey,
  setProfileKey
} from './settings'
import { maskKey } from './mask'
import { createProvider } from '../providers'

// 端点的落盘（plan7 F5 / F5.1：**端点 + 模型目录**）。
//
// 文件就是 `userData/models.json`（设置页会把这个真实路径显示给用户）。
// ⚠️ **Key 不在这里**：按"端点 id → 密文"存在 settings.json（见 store/settings.ts）。
//
// ## 内核与界面只看见"当前这一个模型"
//
// `getSettingsView()` 这些老名字语义没变 —— 只是从"读设置里那一份"变成
// "读**当前端点的当前模型**"。于是 Agent 主循环、Provider 适配、其它设置页代码全都不用改。
//
// ## 迁移（唯一会动到用户已存配置的一步，所以最谨慎）
//
// 两种历史形状都要认：
//   ① 0.13.16 之前：**扁平**的一条 = 一个模型（`normalizeProfiles` 就地升级）
//   ② 更早：settings.json 里的单模型设置 + 一把 Key（`ensureMigrated` 包成第一个端点）
// ⚠️ 动盘之前**先备份** models.json → models.json.bak-<时间戳>：Key 的归属搞错代价最高。

interface StoredModels {
  profiles?: unknown
  activeId?: string | null
  /** 备份过一次就不再重复备份（避免每次启动都留一份） */
  migratedFrom?: string
}

const store = new Store<StoredModels>({ name: 'models' })
const log = createLogger('models')

const EMPTY: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: '',
  model: '',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 120000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 200,
  supportsImages: false
}

let migrated = false

/** 迁移前备份（只做一次）。备份失败不阻断 —— 但要留痕，别让人以为备份过了。 */
function backupOnce(tag: string): void {
  try {
    const file = store.path
    if (!existsSync(file)) return
    const dest = `${file}.bak-${tag}`
    if (existsSync(dest)) return
    copyFileSync(file, dest)
    log.info('迁移前已备份模型档案', { from: file, to: dest })
  } catch (err) {
    log.warn('迁移前备份失败（继续迁移，但请留意）', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** 首次访问时迁移：老的扁平形状 / settings 里的单模型 → 端点 + 模型目录。**幂等**。 */
function ensureMigrated(): void {
  if (migrated) return
  migrated = true

  const raw = normalizeProfiles(store.store.profiles)
  if (raw.profiles.length > 0) {
    // 形状可能被"就地升级"过（扁平 → 端点）→ 写回去，避免每次读都重算
    if (JSON.stringify(raw.profiles) !== JSON.stringify(store.store.profiles)) {
      backupOnce(new Date().toISOString().replace(/[:.]/g, '-'))
      store.set('profiles', raw.profiles)
    }
    return
  }

  const legacy = readLegacyModelSettings()
  if (!legacy.baseURL || !legacy.model) return // 从没配过 → 保持空列表

  backupOnce('legacy')
  const now = Date.now()
  const profile = profileOf(legacy, now, { id: 'p-default', name: legacy.model })
  store.set('profiles', [profile])
  store.set('activeId', profile.id)
  store.set('migratedFrom', 'settings-single-model')

  const legacyKey = readLegacyApiKey()
  const owner = legacyKeyOwnerId([profile])
  if (legacyKey && owner) {
    setProfileKey(owner, legacyKey)
    clearLegacyApiKey()
  }
  log.info('已把老的单模型配置迁移成第一个端点', {
    id: profile.id,
    models: profile.models.map((m) => m.model),
    keyMoved: Boolean(legacyKey)
  })
}

/** 端点列表（含当前 id）。坏条目丢掉并**留痕**，绝不静默。 */
export function listProfiles(): { profiles: ModelProfile[]; activeId: string | null } {
  ensureMigrated()
  const { profiles, dropped } = normalizeProfiles(store.store.profiles)
  if (dropped > 0) {
    log.warn('模型档案里有读不懂的条目，已跳过', { dropped, kept: profiles.length })
    store.set('profiles', profiles)
  }
  return { profiles, activeId: store.store.activeId ?? null }
}

export function getActiveProfile(): ModelProfile | null {
  const { profiles, activeId } = listProfiles()
  return activeProfile(profiles, activeId)
}

/** 当前**模型条目**（端点的 activeModelId 过期时落到第一条） */
export function getActiveEntry(): { profile: ModelProfile; entry: ModelEntry } | null {
  const profile = getActiveProfile()
  if (!profile) return null
  const entry = activeEntry(profile)
  return entry ? { profile, entry } : null
}

/** 界面视图（Key 只给掩码） */
export function modelsView(): ModelsView {
  const { profiles, activeId } = listProfiles()
  return {
    profiles: profiles.map(
      (p): ModelProfileView => ({
        ...p,
        hasApiKey: hasProfileKey(p.id),
        apiKeyMasked: maskKey(getProfileKey(p.id))
      })
    ),
    activeId,
    filePath: store.path
  }
}

export function modelsFilePath(): string {
  return store.path
}

// ── 内核与界面看见的"那一个模型" ───────────────────────────────────────────

export function getSettingsView(): SettingsView {
  const active = getActiveEntry()
  if (!active) return { ...EMPTY, hasApiKey: false, apiKeyMasked: '' }
  return {
    ...settingsOf(active.profile, active.entry),
    hasApiKey: hasProfileKey(active.profile.id),
    apiKeyMasked: maskKey(getProfileKey(active.profile.id))
  }
}

export function getDecryptedApiKey(): string {
  const active = getActiveEntry()
  return active ? getProfileKey(active.profile.id) : ''
}

export function hasApiKey(): boolean {
  const active = getActiveEntry()
  return active ? hasProfileKey(active.profile.id) : false
}

/** 老的"保存设置"入口 —— 现在写进**当前端点的当前模型**（没有端点则建一个） */
export function saveSettings(input: SettingsSaveInput): SettingsView {
  const { apiKey, ...rest } = input
  const active = getActiveEntry()
  const now = Date.now()
  if (active) {
    const entry = makeEntry({
      id: active.entry.id,
      model: rest.model,
      ...(active.entry.name ? { name: active.entry.name } : {}),
      settings: {
        temperature: rest.temperature,
        topP: rest.topP,
        topK: rest.topK,
        maxTokens: rest.maxTokens,
        contextWindow: rest.contextWindow,
        reasoningEffort: rest.reasoningEffort,
        maxToolRounds: rest.maxToolRounds,
        supportsImages: rest.supportsImages
      }
    })
    saveEndpoint({
      id: active.profile.id,
      name: active.profile.name,
      providerType: rest.providerType,
      baseURL: rest.baseURL,
      timeoutMs: rest.timeoutMs,
      stream: rest.stream,
      models: active.profile.models.map((m) => (m.id === entry.id ? entry : m)),
      activeModelId: active.profile.activeModelId,
      apiKey
    })
  } else {
    const entry = makeEntry({
      id: `m-${now.toString(36)}`,
      model: rest.model,
      settings: {
        temperature: rest.temperature,
        topP: rest.topP,
        topK: rest.topK,
        maxTokens: rest.maxTokens,
        contextWindow: rest.contextWindow,
        reasoningEffort: rest.reasoningEffort,
        maxToolRounds: rest.maxToolRounds,
        supportsImages: rest.supportsImages
      }
    })
    const created = createProfile({
      id: `p-${now.toString(36)}`,
      name: rest.model,
      providerType: rest.providerType,
      baseURL: rest.baseURL,
      timeoutMs: rest.timeoutMs,
      stream: rest.stream,
      models: [entry],
      now
    })
    store.set('profiles', [created])
    store.set('activeId', created.id)
    if (apiKey && apiKey.length > 0) setProfileKey(created.id, apiKey)
  }
  return getSettingsView()
}

/**
 * 输入框那个"快速切模型"：先看名字能不能对上目录里已有的模型（对上就切过去），
 * 对不上就**改当前模型条目的模型 ID**（"同一条连接上换个名字"这种用法）。
 */
export function setModel(model: string): SettingsView {
  const active = getActiveEntry()
  if (!active) return getSettingsView()
  const hit = active.profile.models.find((m) => m.model === model)
  if (hit) {
    setActiveEntry(active.profile.id, hit.id)
    return getSettingsView()
  }
  saveEndpoint({
    id: active.profile.id,
    name: active.profile.name,
    providerType: active.profile.providerType,
    baseURL: active.profile.baseURL,
    timeoutMs: active.profile.timeoutMs,
    stream: active.profile.stream,
    models: active.profile.models.map((m) =>
      m.id === active.entry.id ? { ...m, model: model.trim() } : m
    ),
    activeModelId: active.entry.id,
    apiKey: ''
  })
  return getSettingsView()
}

// ── 端点与模型目录的增删改（供设置页调用）────────────────────────────────

/** 新建或整体更新一个端点（模型目录按传入的整份替换） */
export function saveEndpoint(input: ModelSaveInput): ModelProfile {
  const now = Date.now()
  const { profiles, activeId } = listProfiles()
  const entries = input.models
    .map((m) => (m.model.trim() ? m : null))
    .filter((m): m is ModelEntry => m !== null)
  if (entries.length === 0) throw new Error('一个端点至少要有一个模型 —— 模型 ID 不能空着')

  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined
  const activeModelId =
    input.activeModelId && entries.some((m) => m.id === input.activeModelId)
      ? input.activeModelId
      : (entries[0]?.id ?? '')

  if (existing) {
    const updated: ModelProfile = {
      ...existing,
      name: (input.name.trim() || existing.name).slice(0, 60),
      providerType: input.providerType,
      baseURL: input.baseURL,
      timeoutMs: input.timeoutMs ?? existing.timeoutMs,
      stream: input.stream ?? existing.stream,
      models: entries,
      activeModelId,
      updatedAt: now
    }
    store.set(
      'profiles',
      profiles.map((p) => (p.id === existing.id ? updated : p))
    )
    if (input.apiKey && input.apiKey.length > 0) setProfileKey(existing.id, input.apiKey)
    return updated
  }

  const created = createProfile({
    id: input.id ?? `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name,
    source: input.source ?? 'custom',
    providerType: input.providerType,
    baseURL: input.baseURL,
    timeoutMs: input.timeoutMs,
    stream: input.stream,
    models: entries,
    activeModelId,
    now
  })
  store.set('profiles', [...profiles, created])
  if (!activeId) store.set('activeId', created.id) // 第一个端点自动成为当前
  if (input.apiKey && input.apiKey.length > 0) setProfileKey(created.id, input.apiKey)
  return created
}

/** 删除端点（护栏：至少留一个）；Key 跟着端点走，不留孤儿密文 */
export function deleteProfileById(id: string): void {
  const { profiles, activeId } = listProfiles()
  const allowed = canDeleteProfile(profiles, id)
  if (!allowed.ok) throw new Error(allowed.reason ?? '这个端点不能删')
  const next = removeProfile(profiles, id)
  store.set('profiles', next)
  removeProfileKey(id)
  if (activeId === id) store.set('activeId', next[0]?.id ?? null)
  log.info('已删除模型端点', { id, remaining: next.length })
}

export function setActiveProfile(id: string): void {
  const { profiles } = listProfiles()
  if (!profiles.some((p) => p.id === id)) throw new Error('这个端点不存在（可能已经被删过了）')
  store.set('activeId', id)
}

/** 切当前**端点内的**模型（护栏：至少留一条） */
export function setActiveEntry(profileId: string, entryId: string): void {
  const { profiles } = listProfiles()
  const profile = profiles.find((p) => p.id === profileId)
  if (!profile) throw new Error('这个端点不存在（可能已经被删过了）')
  const guard = canDeleteEntry(profile, entryId) // 复用同一套"条目存不存在"的判断
  if (!guard.ok && !profile.models.some((m) => m.id === entryId)) throw new Error(guard.reason ?? '这个模型不存在')
  store.set(
    'profiles',
    profiles.map((p) => (p.id === profileId ? { ...p, activeModelId: entryId, updatedAt: Date.now() } : p))
  )
}

/** 测试连接：用端点自己的 Key 与**它当前选中的模型** */
export function profileForTest(id: string): { settings: ModelSettings; apiKey: string } | null {
  const { profiles } = listProfiles()
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return null
  const entry = activeEntry(profile)
  if (!entry) return null
  return { settings: settingsOf(profile, entry), apiKey: getProfileKey(profile.id) }
}

/**
 * 「获取可用模型」：问厂商这个端点能调哪些模型。
 *
 * 失败必须**给人话**（Key 没填 / 地址不对 / 该端点不提供模型列表），
 * 绝不静默返回空数组 —— 那会让用户以为"这个端点没有模型"。
 */
export async function listAvailableModels(id: string): Promise<{ ok: boolean; message: string; models: string[] }> {
  const { profiles } = listProfiles()
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return { ok: false, message: '这个端点不存在（可能已经被删过了）', models: [] }
  const apiKey = getProfileKey(profile.id)
  if (!apiKey) return { ok: false, message: '这个端点还没有填 API Key：先保存 Key 再来拉取', models: [] }

  const entry = activeEntry(profile)
  const settings = entry ? settingsOf(profile, entry) : { ...EMPTY, baseURL: profile.baseURL, providerType: profile.providerType }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(profile.timeoutMs, 20000))
  try {
    const provider = createProvider(profile.providerType)
    return await provider.listModels({ settings, apiKey, messages: [], signal: controller.signal })
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      models: []
    }
  } finally {
    clearTimeout(timer)
  }
}
