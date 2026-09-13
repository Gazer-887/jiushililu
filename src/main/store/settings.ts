import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { ModelSettings, PermissionPreset } from '@shared/ipc'
import { DEFAULT_TOKEN_TIER, isTokenSaverTier, type TokenSaverTier } from '@shared/token-tier'

// 持久化设置。铁律（D-013 / AGENTS.md）：API Key 只走 safeStorage 加密落盘，绝不存明文。
// safeStorage 在 Windows 用 DPAPI、macOS 用 Keychain（DIARY 术语词典有词条）。

interface StoredSettings extends ModelSettings {
  /** ⚠️ **遗留字段**：多模型之前"整个应用只有一把 Key"用的就是它。迁移时认领走（见 store/models.ts） */
  apiKeyEncrypted?: string
  /**
   * **档案 id → 密文**（多模型：每个模型一把 Key）。放这个文件而不是 `models.json`：红线是"Key 一个字节都不进
   * 模型档案文件"，而 settings.json 一直是 Key 的唯一落脚点；且**同一个 json 只能有一个写入者** —— 两个
   * electron-store 实例各写各的会互相覆盖（本项目踩过"last write wins 静默丢数据"）。
   */
  apiKeysEncrypted?: Record<string, string>
  /** 访问权限档（D-032：能力归模型，权限归人） */
  permissionPreset?: PermissionPreset
  /**
   * 省 token 档位（plan8 R9.1 §七②）。放**全局设置**而非模型档案：用户定调"**档位是全局的**，不做会话级覆盖"
   * —— 它是"你更在乎能力还是在乎钱"的偏好，跟用哪条连接无关。缺字段 = 老配置 → 按 `DEFAULT_TOKEN_TIER`（平衡）
   * 回落，**不写回盘**（写回会让"默认"变成"显式选择"）。
   */
  tokenSaverTier?: TokenSaverTier
}

const store = new Store<StoredSettings>({ name: 'settings' })

/** 当前权限档（默认「可写」：工作区内可读写，命令执行仍需显式授权） */
export function getPermissionPreset(): PermissionPreset {
  return store.store.permissionPreset ?? 'write'
}

export function setPermissionPreset(preset: PermissionPreset): PermissionPreset {
  store.set('permissionPreset', preset)
  return getPermissionPreset()
}

/**
 * 当前**省 token 档位**（plan8 R9.1 §七②）。认不出来的值（老配置 / 手改坏的 json）**回落到默认档**、不抛错 ——
 * 配置坏掉时让应用照常能跑比"启动就炸"重要；且回落方向一律是"更不激进"的那档。
 */
export function getTokenTier(): TokenSaverTier {
  const raw = store.store.tokenSaverTier
  return isTokenSaverTier(raw) ? raw : DEFAULT_TOKEN_TIER
}

export function setTokenTier(tier: TokenSaverTier): TokenSaverTier {
  store.set('tokenSaverTier', tier)
  return getTokenTier()
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function decryptKey(stored: StoredSettings): string {
  if (!stored.apiKeyEncrypted) return ''
  if (!encryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64'))
  } catch {
    return ''
  }
}

// ── 多模型（plan7 F5）：每个档案一把 Key ──────────────────────────────────
// 落点只有这一个文件（红线：Key 不进 models.json），密文一律走 safeStorage。这一组函数**只做存取**；
// "哪把 Key 归哪个档案""旧的 Key 归谁"由 store/models.ts 决定 —— 那些是**可判定**的业务判断，该放在能被单测覆盖的地方。

export function getProfileKey(profileId: string): string {
  const enc = store.store.apiKeysEncrypted?.[profileId]
  if (!enc || !encryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

export function hasProfileKey(profileId: string): boolean {
  return Boolean(store.store.apiKeysEncrypted?.[profileId])
}

export function setProfileKey(profileId: string, apiKey: string): void {
  if (!encryptionAvailable()) {
    throw new Error('系统加密服务不可用。为遵守「Key 不明文落盘」约束，已拒绝保存，请检查运行环境。')
  }
  const next = { ...(store.store.apiKeysEncrypted ?? {}) }
  next[profileId] = safeStorage.encryptString(apiKey).toString('base64')
  store.set('apiKeysEncrypted', next)
}

export function removeProfileKey(profileId: string): void {
  const current = store.store.apiKeysEncrypted
  if (!current || !(profileId in current)) return
  const next = { ...current }
  delete next[profileId]
  store.set('apiKeysEncrypted', next)
}

/** 有 Key 的档案 id（迁移时用来把遗留的那把认领掉、以及清理孤儿 Key） */
export function keyedProfileIds(): string[] {
  return Object.keys(store.store.apiKeysEncrypted ?? {})
}

/** 遗留的单把 Key（只给迁移用） */
export function readLegacyApiKey(): string {
  return decryptKey(store.store)
}

/** 迁移把它认领走之后清掉遗留字段 —— 留着会让人以为"还有一把 Key 没归属" */
export function clearLegacyApiKey(): void {
  store.delete('apiKeyEncrypted' as keyof StoredSettings)
}

/** 遗留的单模型设置（只给迁移用）：没配过就返回空 baseURL/model */
export function readLegacyModelSettings(): ModelSettings {
  const s = store.store
  return {
    providerType: s.providerType ?? 'openai-compatible',
    baseURL: s.baseURL ?? '',
    model: s.model ?? '',
    temperature: s.temperature ?? null,
    topP: s.topP ?? null,
    topK: s.topK ?? null,
    maxTokens: s.maxTokens ?? 4096,
    timeoutMs: s.timeoutMs ?? 120000,
    stream: s.stream ?? true,
    contextWindow: s.contextWindow ?? 131072,
    reasoningEffort: s.reasoningEffort ?? 'default',
    maxToolRounds: s.maxToolRounds ?? 200,
    supportsImages: s.supportsImages ?? false
  }
}

// ⚠️ 这几个老名字（`getSettingsView` / `getDecryptedApiKey` / `hasApiKey` / `saveSettings` / `setModel`）**已经搬去
// store/models.ts** —— 多模型之后它们的语义是"作用于**当前档案**"，而档案与 Key 的对应关系只有那边知道。
// 这里**不做 re-export**：两个模块会互相 import，循环依赖下 re-export 拿到 undefined 的时机很难说（调用方改一行 import 即可）。
