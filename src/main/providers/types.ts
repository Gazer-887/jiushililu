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
  /**
   * **列出这个端点能调哪些模型**（设置页「获取可用模型」）。
   *
   * 为什么放在 provider 层：不同协议的取法不一样（OpenAI 兼容 `/models`、
   * Anthropic `/v1/models` 且要额外请求头），塞进通用代码里必然写成 if/else 泥巴。
   *
   * 失败也要**给人话**（Key 错 / 地址错 / 该端点不支持），绝不返回空数组糊弄 ——
   * 那会让用户以为"这个端点没有模型"。
   */
  listModels(req: ProviderRequest): Promise<{ ok: boolean; message: string; models: string[] }>
}
