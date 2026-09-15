import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { ModelSettings, PermissionPreset } from '@shared/ipc'
import { DEFAULT_TOKEN_TIER, isTokenSaverTier, type TokenSaverTier } from '@shared/token-tier'
import type { SystemSettings } from '@shared/system'
import type { NetworkCredentials, NetworkSettings } from '@shared/network'
import { normalizeNetwork } from '@shared/network'

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
  /** **记忆开关**（plan19 批 1）。缺字段 = 老配置 → 视为开（否则记忆批做了等于没做） */
  memoryEnabled?: boolean
  /**
   * **自动记忆（反思）开关**（批 2 plan19）。`undefined` = 未显式设 → 由省 token 档位提供默认值
   * （轻量档关、其余开 —— 反思是额外一次模型调用，省 token 用户不应被默认烧钱）。
   * ⚠️ 显式设过的不会被档位覆盖（用户的选择优先于档位默认）。
   */
  autoMemoryEnabled?: boolean
  /**
   * 反思模型（批 2）。缺字段 = 跟随对话模型；非空 = 用户为反思单独指定了一个模型档案 id。
   * ⚠️ 反思是写长期资产，**不该用轻量档的 `reasoningEffortOverride: 'low'`**（§8.3 第 3 条）。
   */
  reflectionModel?: string
  /** 反思日上限（批 2）。缺字段 = 20。⚠️ 反思也烧 token，需要日上限挡失控 */
  reflectionDailyLimit?: number
  /**
   * **电脑控制开关**（2026-09-15 用户需求）。当前版本**尚无对应的电脑控制工具**——开关先落门控：
   * 状态进自视段（模型如实报告自身配置），工具上线后此处即权限闸。缺字段 = 老配置 → `false`：
   * 涉及鼠标键盘的权限必须由用户显式开启，不能替他默认。
   */
  computerControlEnabled?: boolean
  /**
   * 省 token 档位（plan8 R9.1 §七②）。放**全局设置**而非模型档案：用户定调"**档位是全局的**，不做会话级覆盖"
   * —— 它是"你更在乎能力还是在乎钱"的偏好，跟用哪条连接无关。缺字段 = 老配置 → 按 `DEFAULT_TOKEN_TIER`（平衡）
   * 回落，**不写回盘**（写回会让"默认"变成"显式选择"）。
   */
  tokenSaverTier?: TokenSaverTier
  /**
   * **锁屏与熄屏后继续运行**（plan7 批 F1）：阻止**系统**进入睡眠（不是让屏幕常亮 —— 用户定调"屏幕可以关，
   * 后台任务要继续跑"）。缺字段 = 老配置 → `false`：阻止睡眠必须由用户显式开启，不能替他默认。
   */
  keepRunning?: boolean
  /** **开机自启**（plan7 批 F1）。⚠️ 只有安装版会写进来：开发态写入的启动项指向 electron.exe，不是本应用 */
  openAtLogin?: boolean
  /**
   * **网络代理**（plan7 批 F2）。⚠️ `proxyRules` 里**不含凭据** —— 保存前从地址里剥走、应用时拼回。
   * 缺字段 = 老配置 → 跟随系统（与 Electron 自身默认一致）。
   */
  proxyMode?: NetworkSettings['proxyMode']
  proxyRules?: string
  /** 代理账号密码的**密文**（明文只存在于内存；JSON 序列化，避免密码里的冒号把格式搞坏） */
  proxyCredentialsEncrypted?: string
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
 * **记忆开关**（plan19 批 1）。批 1 只管**通路 A**（模型工具 remember / recall）是否下发 ——
 * 通路 B（选中即记）是用户主动行为，不受它管（批 2 起这个开关才长出"自动记忆"的语义）。
 * 缺省 = **开**：否则记忆批做了等于没做。判断走 `!== false`（手改坏成 undefined 也不至于静默关掉）。
 */
export function getMemoryEnabled(): boolean {
  return store.store.memoryEnabled !== false
}

export function setMemoryEnabled(enabled: boolean): boolean {
  store.set('memoryEnabled', enabled)
  return getMemoryEnabled()
}

/**
 * **自动记忆（反思）开关**（批 2 plan19）。
 * 未显式设过 → 按**省 token 档位**给默认：轻量档关（反思是额外一次模型调用，省 token 用户不应被默认烧钱）；
 * 其余档开（rich / ultimate / balanced）。
 * ⚠️ 显式设过的不被档位覆盖 —— 用户的明确选择优先于档位默认。
 */
export function getAutoMemoryEnabled(): boolean {
  const stored = store.store.autoMemoryEnabled
  if (typeof stored === 'boolean') return stored
  const tier = getTokenTier()
  return tier !== 'light'
}

export function setAutoMemoryEnabled(enabled: boolean): boolean {
  store.set('autoMemoryEnabled', enabled)
  return getAutoMemoryEnabled()
}

/**
 * 反思模型（批 2）。返回 `undefined` = 跟随对话模型；
 * 返回非空字符串 = 用户为反思单独指定的**模型档案 id**。
 */
export function getReflectionModel(): string | undefined {
  const v = store.store.reflectionModel
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function setReflectionModel(model: string | null): void {
  // null = 切回"跟随对话模型"
  if (model === null) {
    store.delete('reflectionModel' as keyof StoredSettings)
    return
  }
  store.set('reflectionModel', model)
}

/**
 * 反思日上限（批 2）。缺省 20（与 `DEFAULT_REFLECTION_DAILY_LIMIT` 同口径）。
 * 老数据 / 手改坏值都回落到 20 —— 配置坏了让应用照常能跑。
 */
export function getReflectionDailyLimit(): number {
  const v = store.store.reflectionDailyLimit
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 20
}

export function setReflectionDailyLimit(limit: number): number {
  store.set('reflectionDailyLimit', limit)
  return getReflectionDailyLimit()
}

/**
 * **电脑控制开关**（2026-09-15 用户需求）。判断走 `=== true`（与记忆开关相反）：权限类开关
 * 手改坏成 undefined 时宁可"静默关着"，不许"静默开着"。
 */
export function getComputerControlEnabled(): boolean {
  return store.store.computerControlEnabled === true
}

export function setComputerControlEnabled(enabled: boolean): boolean {
  store.set('computerControlEnabled', enabled)
  return getComputerControlEnabled()
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

/** 系统集成（plan7 批 F1）的落盘意图。与档位同一口径：缺字段回落 `false`、**不写回盘** */
export function getSystemSettings(): SystemSettings {
  const s = store.store
  return { keepRunning: s.keepRunning === true, openAtLogin: s.openAtLogin === true }
}

export function setSystemSettings(patch: Partial<SystemSettings>): void {
  if (patch.keepRunning !== undefined) store.set('keepRunning', patch.keepRunning)
  if (patch.openAtLogin !== undefined) store.set('openAtLogin', patch.openAtLogin)
}

// ── 网络代理（plan7 批 F2）：意图落盘，凭据加密 ────────────────────────────
// ⚠️ **凭据绝不进明文配置**（AGENTS.md 红线）：地址里的 `user:pass` 在保存前就被剥走了，
//    剩下这一段只负责把剥出来的那份加密存好。读不到（未加密过 / 加密服务不可用）一律当"没有凭据"，
//    而不是报错 —— 没有凭据只是**走不了需要认证的代理**，不该让设置页打不开。

export function getNetworkSettings(): NetworkSettings {
  return normalizeNetwork({ proxyMode: store.store.proxyMode, proxyRules: store.store.proxyRules })
}

export function setNetworkSettings(patch: Partial<NetworkSettings>): void {
  if (patch.proxyMode !== undefined) store.set('proxyMode', patch.proxyMode)
  if (patch.proxyRules !== undefined) store.set('proxyRules', patch.proxyRules)
}

export function getNetworkCredentials(): NetworkCredentials | null {
  const enc = store.store.proxyCredentialsEncrypted
  if (!enc || !encryptionAvailable()) return null
  try {
    const raw = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as NetworkCredentials).user === 'string' &&
      typeof (parsed as NetworkCredentials).pass === 'string'
    ) {
      return { user: (parsed as NetworkCredentials).user, pass: (parsed as NetworkCredentials).pass }
    }
    return null
  } catch {
    // 密文损坏（换了系统用户、密钥环不可用）→ 当没配过，用户重填一次即可
    return null
  }
}

export function setNetworkCredentials(credentials: NetworkCredentials | null): void {
  if (credentials === null) {
    store.delete('proxyCredentialsEncrypted' as keyof StoredSettings)
    return
  }
  if (!encryptionAvailable()) {
    throw new Error(
      '系统加密服务不可用。为遵守「凭据不明文落盘」的约束，已拒绝保存代理账号密码 —— 请检查运行环境，或改用不需要认证的代理地址。'
    )
  }
  store.set(
    'proxyCredentialsEncrypted',
    safeStorage.encryptString(JSON.stringify(credentials)).toString('base64')
  )
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
