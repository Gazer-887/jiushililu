import type { ChatMessage, ModelSettings, ProviderType, TestResult } from '@shared/ipc'
import type { ProviderExecutionContext, ServiceTierObservation } from '@shared/request-policy'
import type { TokenUsage } from '@shared/usage'

/**
 * 单请求服务档观察回调（S3-30A-R1）：由调用方在每次真实请求上各自提供。
 * ⚠️ 运行态内部参数：只在内存里传递，不跨请求共享（没有全局 latest），不进消息/日志/磁盘。
 */
export type ServiceTierObserver = (observation: ServiceTierObservation) => void

export interface ProviderRequest {
  settings: ModelSettings
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  /**
   * 运行态请求上下文（S3-30T1）：真实版本、调用目的、随机运行键与不可变策略。
   * ⚠️ 只在内存；不进 ModelSettings、消息、日志或磁盘。旧调用者不填 = 旧行为。
   */
  context?: ProviderExecutionContext
}

export interface StreamCallbacks {
  onChunk: (text: string) => void
  /**
   * 这一轮的**真实用量**（plan8 R9）。用回调而非返回值：返回值已被"跑完/抛错"占用，
   * 而 usage **可能出现在流尾、也可能根本不出现**（有的厂商不报）。
   */
  onUsage?: (usage: TokenUsage) => void
  /**
   * 服务档观测（S3-30T1 / S3-30A-R1）：observed=true 才代表厂商真实回值；缺报保持 actual=null /
   * observed=false 且绝不回填 requested，失败/断流前已观测的事实不丢。
   * 单请求内部参数（每次调用各持一份，无全局 latest）；旧调用者不填 = 不观测。
   */
  onServiceTier?: (observation: ServiceTierObservation) => void
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
  listModels(req: ProviderRequest): Promise<{
    ok: boolean
    message: string
    models: string[]
    /** K51：官方能力位（目前只有 Anthropic lane 填；缺省 = 没问到，调用方不得据此改档案） */
    capabilities?: Record<string, { imageInput?: boolean }>
  }>
}
