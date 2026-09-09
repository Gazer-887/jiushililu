// 主 / 渲染进程共享的 IPC 通道定义与类型 —— 两边类型都从这里引用，唯一来源。

export type ProviderType = 'openai-compatible' | 'anthropic'

export interface ModelSettings {
  providerType: ProviderType
  baseURL: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  stream: boolean
}

/** 设置页看到的视图：Key 永远不明文回传，只给掩码 */
export interface SettingsView extends ModelSettings {
  hasApiKey: boolean
  apiKeyMasked: string
}

/** 保存入参：apiKey 为空串表示"保留已存 Key 不变" */
export interface SettingsSaveInput extends ModelSettings {
  apiKey: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsTest: 'settings:test',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatChunk: 'chat:chunk',
  chatDone: 'chat:done',
  chatError: 'chat:error'
} as const

/** preload 暴露给渲染进程的受控桥（contextIsolation 下唯一的系统通道） */
export interface ApiBridge {
  getSettings(): Promise<SettingsView>
  saveSettings(input: SettingsSaveInput): Promise<SettingsView>
  testConnection(input: SettingsSaveInput): Promise<TestResult>
  chatSend(messages: ChatMessage[]): Promise<void>
  chatAbort(): Promise<void>
  onChatChunk(cb: (text: string) => void): () => void
  onChatDone(cb: () => void): () => void
  onChatError(cb: (message: string) => void): () => void
}
