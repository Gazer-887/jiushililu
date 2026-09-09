import type { ChatMessage, ModelSettings, ProviderType, TestResult } from '@shared/ipc'

export interface ProviderRequest {
  settings: ModelSettings
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
}

export interface StreamCallbacks {
  onChunk: (text: string) => void
}

export interface IProvider {
  readonly type: ProviderType
  /** 流式对话；文本增量通过 cb.onChunk 回调，结束/失败以 Promise resolve/reject 表达 */
  streamChat(req: ProviderRequest, cb: StreamCallbacks): Promise<void>
  /** 最小连通性测试（发一条 1 token 的 "ping"），用于设置页「测试连接」 */
  testConnection(req: ProviderRequest): Promise<TestResult>
}
