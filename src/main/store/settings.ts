import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { ModelSettings, SettingsSaveInput, SettingsView } from '@shared/ipc'
import { maskKey } from './mask'

// 持久化设置。铁律（D-013 / AGENTS.md）：API Key 只走 safeStorage 加密落盘，绝不存明文。
// safeStorage 在 Windows 用 DPAPI、macOS 用 Keychain（DIARY 术语词典有词条）。

interface StoredSettings extends ModelSettings {
  apiKeyEncrypted?: string
}

const store = new Store<StoredSettings>({ name: 'settings' })

function encryptionAvailable(): boolean {
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

export function getSettingsView(): SettingsView {
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
    supportsImages: s.supportsImages ?? false,
    hasApiKey: Boolean(s.apiKeyEncrypted),
    apiKeyMasked: maskKey(decryptKey(s))
  }
}

export function getDecryptedApiKey(): string {
  return decryptKey(store.store)
}

export function hasApiKey(): boolean {
  return Boolean(store.store.apiKeyEncrypted)
}

export function saveSettings(input: SettingsSaveInput): SettingsView {
  const { apiKey, ...rest } = input

  if (apiKey && apiKey.length > 0) {
    if (!encryptionAvailable()) {
      throw new Error('系统加密服务不可用，为遵守「Key 不明文落盘」铁律已拒绝保存。请检查运行环境。')
    }
    store.set('apiKeyEncrypted', safeStorage.encryptString(apiKey).toString('base64'))
  }

  store.set(rest as StoredSettings)
  return getSettingsView()
}
