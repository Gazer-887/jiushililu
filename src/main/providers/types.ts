import type { ChatMessage, ModelSettings, ProviderType, TestResult } from '@shared/ipc'
import type { TokenUsage } from '@shared/usage'

export interface ProviderRequest {
  settings: ModelSettings
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
}

export interface StreamCallbacks {
  onChunk: (text: string) => void
  /**
   * 这一轮的**真实用量**（plan8 R9）。用回调而非返回值：返回值已被"跑完/抛错"占用，
   * 而 usage **可能出现在流尾、也可能根本不出现**（有的厂商不报）。
   */
  onUsage?: (usage: TokenUsage) => void
}

export interface IProvider {
  readonly type: ProviderType
  /** 流式对话；文本增量通过 cb.onChunk 回调，结束/失败以 Promise resolve/reject 表达 */
  streamChat(req: ProviderRequest, cb: StreamCallbacks): Promise<void>
  /** 最小连通性测试（发一条 1 token 的 "ping"），用于设置页「测试连接」 */
  testConnection(req: ProviderRequest): Promise<TestResult>
  /**
   * 列出端点能调哪些模型（设置页「获取可用模型」）。放 provider 层：取法随协议不同
   * （OpenAI 兼容 `/models`、Anthropic `/v1/models` 且要额外请求头）。
   * ⚠️ 失败要回**人话**（Key 错 / 地址错 / 不支持），不许返回空数组 —— 用户会以为端点没有模型。
   */
  listModels(req: ProviderRequest): Promise<{ ok: boolean; message: string; models: string[] }>
}
