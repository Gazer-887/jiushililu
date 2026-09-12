import Store from 'electron-store'
import type { ModelSettings, SettingsSaveInput, SettingsView } from '@shared/ipc'
import {
  activeProfile,
  canDeleteProfile,
  createProfile,
  legacyKeyOwnerId,
  normalizeProfiles,
  profileOf,
  removeProfile,
  settingsOf,
  type ModelProfile,
  type ModelSource
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

// 模型档案的落盘（plan7 F5 多模型管理）。
//
// 文件就是 `userData/models.json` —— 与设置页上那句提示一致（用户看得见路径，就得是真的）。
// ⚠️ **Key 不在这里**：它按"档案 id → 密文"存在 settings.json（见 store/settings.ts 的 apiKeysEncrypted）。
//
// ## 这个模块承担的那件"必须能单测"的事
//
// 内核与界面**永远只看见"当前这一个模型"** —— `getSettingsView()` 这类老名字的语义没变，
// 只是从"读 settings 里的那一份"变成了"读**当前档案**"。于是 ipc.ts / runner / 设置页
// 的其余部分一行都不用改。
//
// ## 迁移（只能有一次，且不许丢东西）
//
// 老数据是"一份模型配置 + 一把 Key"。首次读档案时若发现列表是空的、而老配置有 baseURL/model，
// 就把它包成**第一个档案**，并把那把老 Key 认领给它（`legacyKeyOwnerId` 定归属，可单测）。
// 不迁移 = 要用户重填一遍 Key，那是耍流氓。

interface StoredModels {
  profiles?: unknown
  activeId?: string | null
}

const store = new Store<StoredModels>({ name: 'models' })
const log = createLogger('models')

/** 没配过模型时的兜底（**不是**默认模型：baseURL/model 为空 = "还没配"） */
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

/** 迁移只做一次（进程内）；失败也不反复重试，但会留痕 */
let migrated = false

/**
 * 首次访问时把老数据迁进来。**幂等**：列表已有档案就直接返回。
 */
function ensureMigrated(): void {
  if (migrated) return
  migrated = true
  const raw = normalizeProfiles(store.store.profiles)
  if (raw.profiles.length > 0) return

  const legacy = readLegacyModelSettings()
  if (!legacy.baseURL || !legacy.model) return // 从没配过 → 保持空列表（界面提示"还没配模型"）

  const profile = profileOf(legacy, Date.now(), { id: 'p-default', name: legacy.model })
  store.set('profiles', [profile])
  store.set('activeId', profile.id)

  const legacyKey = readLegacyApiKey()
  const owner = legacyKeyOwnerId([profile])
  if (legacyKey && owner) {
    setProfileKey(owner, legacyKey)
    clearLegacyApiKey()
  }
  log.info('已把老的单模型配置迁移成第一个模型档案', {
    id: profile.id,
    model: profile.model,
    keyMoved: Boolean(legacyKey)
  })
}

/** 档案列表（含当前 id）。坏条目丢掉并**留痕**，绝不静默。 */
export function listProfiles(): { profiles: ModelProfile[]; activeId: string | null } {
  ensureMigrated()
  const { profiles, dropped } = normalizeProfiles(store.store.profiles)
  if (dropped > 0) {
    log.warn('模型档案里有读不懂的条目，已跳过', { dropped, kept: profiles.length })
    // 顺手把可读的那部分写回去：否则每次读都重复告警
    store.set('profiles', profiles)
  }
  return { profiles, activeId: store.store.activeId ?? null }
}

/** 当前档案（三条兜底见 `@shared/models` 的 activeProfile） */
export function getActiveProfile(): ModelProfile | null {
  const { profiles, activeId } = listProfiles()
  return activeProfile(profiles, activeId)
}

// ── 内核与界面看见的"那一个模型"（名字沿用旧的，语义 = 当前档案）───────────

export function getSettingsView(): SettingsView {
  const profile = getActiveProfile()
  if (!profile) {
    return { ...EMPTY, hasApiKey: false, apiKeyMasked: '' }
  }
  return {
    ...settingsOf(profile),
    hasApiKey: hasProfileKey(profile.id),
    apiKeyMasked: maskKey(getProfileKey(profile.id))
  }
}

export function getDecryptedApiKey(): string {
  const profile = getActiveProfile()
  return profile ? getProfileKey(profile.id) : ''
}

export function hasApiKey(): boolean {
  const profile = getActiveProfile()
  return profile ? hasProfileKey(profile.id) : false
}

/** 老的"保存设置"入口 —— 现在写进**当前档案**（没有档案则建一个） */
export function saveSettings(input: SettingsSaveInput): SettingsView {
  const { apiKey, ...rest } = input
  const current = getActiveProfile()
  const now = Date.now()
  if (current) {
    if (apiKey && apiKey.length > 0) setProfileKey(current.id, apiKey)
    saveProfile({ id: current.id, settings: rest, name: current.name, source: current.source, now })
  } else {
    const created = createProfile({ id: `p-${now.toString(36)}`, settings: rest, now })
    store.set('profiles', [created])
    store.set('activeId', created.id)
    if (apiKey && apiKey.length > 0) setProfileKey(created.id, apiKey)
  }
  return getSettingsView()
}

/** 输入框下拉那个"快速切模型"：改的是**当前档案**的模型名（其余配置与 Key 原地不动） */
export function setModel(model: string): SettingsView {
  const current = getActiveProfile()
  if (!current) return getSettingsView()
  saveProfile({
    id: current.id,
    settings: { ...settingsOf(current), model },
    name: current.name,
    source: current.source,
    now: Date.now()
  })
  return getSettingsView()
}

// ── 多模型管理的增删改（供设置页调用）──────────────────────────────────

/** 新建或更新一个档案；`apiKey` 为空串 = 不动已存的 Key */
export function saveProfile(input: {
  id?: string
  settings: ModelSettings
  name: string
  source?: ModelSource
  apiKey?: string
  now?: number
}): ModelProfile {
  const now = input.now ?? Date.now()
  const { profiles, activeId } = listProfiles()
  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined

  if (existing) {
    const updated: ModelProfile = {
      ...existing,
      ...input.settings,
      name: input.name.trim() || input.settings.model,
      updatedAt: now
    }
    store.set(
      'profiles',
      profiles.map((p) => (p.id === existing.id ? updated : p))
    )
    if (input.apiKey && input.apiKey.length > 0) setProfileKey(existing.id, input.apiKey)
    return updated
  }

  const created = createProfile(
    {
      id: input.id ?? `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      settings: input.settings,
      name: input.name,
      source: input.source ?? 'custom',
      now
    },
    { name: input.settings.model }
  )
  store.set('profiles', [...profiles, created])
  if (!activeId) store.set('activeId', created.id) // 第一个档案自动成为当前
  if (input.apiKey && input.apiKey.length > 0) setProfileKey(created.id, input.apiKey)
  return created
}

/**
 * 删除一个档案。**护栏在 `@shared/models` 的 canDeleteProfile**（至少要留一个）——
 * 这里只负责在拦下时抛出**人话**理由，让设置页原样显示。
 */
export function deleteProfileById(id: string): void {
  const { profiles, activeId } = listProfiles()
  const allowed = canDeleteProfile(profiles, id)
  if (!allowed.ok) throw new Error(allowed.reason ?? '这个模型不能删')

  const next = removeProfile(profiles, id)
  store.set('profiles', next)
  removeProfileKey(id) // Key 跟着档案走，别留孤儿密文
  if (activeId === id) store.set('activeId', next[0]?.id ?? null)
  log.info('已删除模型档案', { id, remaining: next.length })
}

export function setActiveProfile(id: string): void {
  const { profiles } = listProfiles()
  if (!profiles.some((p) => p.id === id)) throw new Error('这个模型不存在（可能已经被删过了）')
  store.set('activeId', id)
}

/** 测试连接要用的：某个档案的设置 + 它自己的 Key */
export function profileForTest(id: string): { settings: ModelSettings; apiKey: string } | null {
  const { profiles } = listProfiles()
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return null
  return { settings: settingsOf(profile), apiKey: getProfileKey(profile.id) }
}

/**
 * `models.json` 的**真实路径** —— 设置页要把它显示给用户。
 * 说得出就得是真的：硬编码一个字面量路径，会在换了 userData 之后变成谎话
 * （本项目的 HTML 预览提示就吃过这个亏：文案里的路径可能与实际不符）。
 */
export function modelsFilePath(): string {
  return store.path
}
