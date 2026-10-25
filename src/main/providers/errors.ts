// 把各厂商的 HTTP 错误翻译成人话。
// 常见坑的对照说明见 DIARY/专题-模型接入配置.md 的踩坑表。

import type { RunTerminal } from '@shared/execution-outcome'
import type { TokenSaverTier } from '@shared/token-tier'
import type { TokenUsage } from '@shared/usage'

/**
 * 单个请求的失败事实（V2 补正 §三）。
 * `usage` 是**该请求最终已观测的有效累计值**：阶段值不得再次相加；全漏报为 null，明确报 0 保留 0。
 * `usageComplete` 只描述这一笔报告是否完整，**与 terminal 成功/失败相互独立**。
 */
export interface ProviderFailureFacts {
  scope: 'request'
  terminal: RunTerminal
  usage: TokenUsage | null
  usageComplete: boolean
}

/**
 * 整轮运行的失败事实。`usage` 与 `ChatDonePayload.usage` 同口径：整轮累计已知账，全漏报为 null。
 * `avoidedTokens` / `tokenTier` **只在真实观测到时出现** —— 未观测就省略，不造 0、不填默认档。
 */
export interface RunFailureFacts {
  scope: 'run'
  runId: string
  terminal: RunTerminal
  usage: TokenUsage | null
  usageComplete: boolean
  avoidedTokens?: number
  tokenTier?: TokenSaverTier
}

/** 事实白名单：只有这些键允许进入错误对象（原始正文/cause/厂商 message 一律不落地）。 */
const PROVIDER_FACT_KEYS = ['scope', 'terminal', 'usage', 'usageComplete'] as const
const RUN_FACT_KEYS = [
  'scope',
  'runId',
  'terminal',
  'usage',
  'usageComplete',
  'avoidedTokens',
  'tokenTier'
] as const

/** 只挑白名单键并做浅拷贝，防止调用方事后改原对象影响已构造的事实。 */
function pickFacts<T extends object>(source: T, keys: readonly string[]): T {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in source) picked[key] = (source as Record<string, unknown>)[key]
  }
  return picked as T
}

/** usage 快照：避免外部持有同一对象后改数字，把已结算的账悄悄改掉。 */
function snapshotUsage(usage: TokenUsage | null): TokenUsage | null {
  return usage === null ? null : { ...usage }
}

export class ProviderError extends Error {
  readonly status?: number
  /** 受控事实。旧调用不传，故可为 undefined —— 旧异常**不得**凭文本猜出一笔 usage。 */
  readonly facts?: ProviderFailureFacts

  constructor(message: string, status?: number, failure?: ProviderFailureFacts) {
    // HTTP错误只公开状态和固定解释，不允许调用方绕过映射透传正文。
    super(status !== undefined && status >= 100 ? mapHttpError(status, '') : message)
    this.name = 'ProviderError'
    this.status = status
    if (failure) {
      const picked = pickFacts(failure, PROVIDER_FACT_KEYS)
      this.facts = {
        scope: 'request',
        terminal: { ...picked.terminal },
        usage: snapshotUsage(picked.usage),
        usageComplete: picked.usageComplete
      }
    }
  }
}

/**
 * 整轮运行的失败载体（V2 补正 §三）。
 * constructor **只接事实**：message 由固定本地映射生成，不接受原始厂商正文或 cause ——
 * 这样错误对象本身就不会成为密钥/正文的外泄通道（logger 一打印就出事）。
 */
export class AgentRunFailure extends Error {
  readonly facts: RunFailureFacts

  constructor(failure: RunFailureFacts) {
    super(describeRunFailure(failure))
    this.name = 'AgentRunFailure'
    const picked = pickFacts(failure, RUN_FACT_KEYS)
    const facts: RunFailureFacts = {
      scope: 'run',
      runId: picked.runId,
      terminal: { ...picked.terminal },
      usage: snapshotUsage(picked.usage),
      usageComplete: picked.usageComplete
    }
    // 可选位只在真实存在时挂上：`'key' in facts` 为 false 才代表"没观测到"。
    if (picked.avoidedTokens !== undefined) facts.avoidedTokens = picked.avoidedTokens
    if (picked.tokenTier !== undefined) facts.tokenTier = picked.tokenTier
    this.facts = facts
  }
}

/** 固定本地映射：按终态给一句人话，绝不拼接任何外部文本。 */
function describeRunFailure(failure: RunFailureFacts): string {
  const { state, code } = failure.terminal
  if (state === 'cancelled') return '本次运行已取消'
  if (state === 'denied') return '本次运行被拒绝：未获得所需权限'
  if (state === 'truncated') return '本次运行被截断：未产出完整结果'
  if (state === 'unknown') return `本次运行结果未知${code ? `（${code}）` : ''}`
  return `本次运行失败${code ? `（${code}）` : ''}`
}

export function mapHttpError(status: number, _body: string): string {
  switch (status) {
    case 401:
      return '认证失败（401）：API Key 无效或未生效，请检查是否复制完整'
    case 403:
      return '无权限（403）：Key 权限不足或已被禁用'
    case 404:
      return '接口或模型不存在（404）：优先检查 baseURL 的 /v1 拼接与模型名拼写'
    case 429:
      return '请求过频或额度不足（429）：稍后重试或检查账户余额'
    case 500:
    case 502:
    case 503:
      return `服务端异常（HTTP ${status}）：厂商侧问题，稍后重试`
    default:
      return `请求失败（HTTP ${status}）：请检查请求参数、模型配置与接口兼容性`
  }
}

/**
 * 取消识别**单一入口**：名字判断 + 受控终态判断合并在一处。
 * ⚠️ 首包/idle 超时是 `unknown` 而**不是** cancelled —— 超时不是用户停止，
 * 混进来会把"没等到回复"记成"用户主动取消"，从而吞掉可重试的失败。
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof ProviderError) return err.facts?.terminal.state === 'cancelled'
  if (err instanceof AgentRunFailure) return err.facts.terminal.state === 'cancelled'
  return false
}

/**
 * 「拉取模型列表」三档人话（plan47 S2）。同一状态码在列表场景语义不同：
 * 404 = 端点不提供列表接口（不是模型名拼错），必须给手填兜底；
 * 401/403 指向 Key 类型 —— 按量与套餐常是两把 Key（实证见 DIARY/专题-模型接入配置.md）。
 */
export function mapListModelsError(status: number): string {
  if (status === 404 || status === 405 || status === 501) {
    return `此端点不提供模型列表（HTTP ${status}）：请手动填写模型 ID`
  }
  if (status === 401 || status === 403) {
    return `API Key 被拒绝（HTTP ${status}）：确认 Key 类型与通道匹配 —— 按量计费与套餐计划往往是两把不同的 Key`
  }
  if (status === 429) {
    return '请求过频或额度不足（429）：稍后重试，或检查账户余额'
  }
  return `拉取模型列表失败（HTTP ${status}）：请核对接口地址与 Key`
}

/** 网络层失败（连接拒绝 / DNS 解析不了；fetch 抛 TypeError）：三档里的第三档 */
export const LIST_MODELS_NETWORK_ERROR = '连不上该端点：请检查网络与代理设置，本地服务请确认其已启动'
