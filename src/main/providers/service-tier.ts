/**
 * 服务档 / 窄身份 / 认证的唯一纯出口（S3-30A）。
 * OpenAI 与 Anthropic 两条链共用；只做判定，不发请求、不读配置、不导入 electron。
 * ⚠️ 身份只输出真实 UA 与 opencode-v1 的会话头；不开放任意 headers 旁路，不冒充其他客户端。
 */

import type { ModelSettings } from '@shared/ipc'
import type { ProviderExecutionContext, ServiceTierObservation } from '@shared/request-policy'
import { isAuxiliaryProviderCallPurpose, observeServiceTier } from '@shared/request-policy'
import { listProviderPresets, resolvePresetAuth } from '@shared/provider-presets'
import type { ServiceTierObserver } from './types'
import { normalizeBaseURL, resolveApiUrl } from './url'

/** 真实客户端名称：用于 self-ua / opencode-v1 的 User-Agent，不伪装成其他工具 */
export const CLIENT_NAME = 'jiushililu'

export type ProviderProtocol = 'openai-compatible' | 'anthropic'

/** 旧档缺 authentication 时的协议缺省（合同 authentication.missingLegacy） */
export const LEGACY_AUTH_DEFAULTS: Readonly<Record<ProviderProtocol, 'bearer' | 'x-api-key'>> =
  Object.freeze({
    'openai-compatible': 'bearer',
    anthropic: 'x-api-key'
  })

/** 协议缺省值，不是厂商值：显式请求这两个等于没提要求，一律不发 */
const NON_REQUESTED_TIERS = new Set(['auto', 'default'])

/**
 * 本请求要发送的 service_tier：只有不可变策略同时为 fast + supported 才发。
 * `requestedServiceTier` 必须是明确的非默认值；辅助调用的 policy 已被工厂固定为 normal。
 */
export function serviceTierForRequest(context?: ProviderExecutionContext): string | null {
  if (!context) return null
  // 五类辅助调用固定普通：即使调用方交来一份伪造的 fast policy，也不发收费档
  if (isAuxiliaryProviderCallPurpose(context.purpose)) return null
  const policy = context.policy
  if (policy.mode !== 'fast' || policy.tierSupport !== 'supported') return null
  const tier = policy.requestedServiceTier
  if (typeof tier !== 'string') return null
  const trimmed = tier.trim()
  if (trimmed.length === 0 || NON_REQUESTED_TIERS.has(trimmed)) return null
  return trimmed
}

/** 在既有请求体上附加服务档字段；普通模式/缺 context 时原对象一个键都不动。 */
export function withServiceTierField(
  body: Record<string, unknown>,
  context?: ProviderExecutionContext
): Record<string, unknown> {
  const tier = serviceTierForRequest(context)
  if (tier !== null) body['service_tier'] = tier
  return body
}

/**
 * Anthropic 的容量选择值（S3-30B 冻结映射）：FAST 只请求「可选用优先容量」，
 * 不保证拿到优先容量，也绝不等于已经购买。协议只接受 `auto` / `standard_only`，
 * 因此不能把 OpenAI 的 `priority` / `fast` 原样发过去。
 */
export const ANTHROPIC_SERVICE_TIER_AUTO = 'auto'

/**
 * 本请求要发送的 Anthropic `service_tier`：门控与 OpenAI 完全同一条
 * （辅助五类固定普通、必须 fast + supported、明确非默认值），值翻译成本协议的 `auto`。
 */
export function anthropicServiceTierForRequest(context?: ProviderExecutionContext): string | null {
  if (serviceTierForRequest(context) === null) return null
  return ANTHROPIC_SERVICE_TIER_AUTO
}

/** 在既有 Anthropic 请求体上附加容量选择字段；普通模式/缺 context 时原对象一个键都不动。 */
export function withAnthropicServiceTierField(
  body: Record<string, unknown>,
  context?: ProviderExecutionContext
): Record<string, unknown> {
  const tier = anthropicServiceTierForRequest(context)
  if (tier !== null) body['service_tier'] = tier
  return body
}

/** 只认真实回值：非空字符串以外（缺失 / 空串 / 非字符串）一律 null，绝不以 requested 回填。 */
export function readServiceTierValue(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const value = (payload as { service_tier?: unknown }).service_tier
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * 结果里的服务档观测：缺 context 且服务端也没回值时**省略字段**（旧调用者形状不变）；
 * 其余情况一律给 `ServiceTierObservation`，缺报保持 actual=null / observed=false。
 */
export function serviceTierForResult(
  requested: string | null,
  actual: string | null,
  context?: ProviderExecutionContext
): ServiceTierObservation | undefined {
  if (context === undefined && actual === null) return undefined
  return observeServiceTier(requested, actual)
}

/**
 * 单请求服务档观察器（S3-30A-R1）：每次调用各建一个，不跨请求共享，不提供全局 latest。
 * observe 只在真实回值时通知且不清空已知值；finalize 仅在从未观测时补 observed=false。
 * 两者共同保证：失败前已知档位不丢，缺报事件不覆盖先前 observed=true 的事实。
 */
export interface ServiceTierEmitter {
  observe(actual: string | null): void
  finalize(): void
}

export function createServiceTierEmitter(
  requested: string | null,
  observer?: ServiceTierObserver
): ServiceTierEmitter {
  let lastActual: string | null = null
  return {
    observe(actual: string | null): void {
      if (!observer) return
      const observation = observeServiceTier(requested, actual)
      if (observation.actual === null || observation.actual === lastActual) return
      lastActual = observation.actual
      observer(observation)
    },
    finalize(): void {
      if (!observer || lastActual !== null) return
      observer(observeServiceTier(requested, null))
    }
  }
}

export interface ResolvedProviderAuth {
  header: 'Authorization' | 'x-api-key'
  /** bearer 时不带 `Bearer ` 前缀，由组装 header 的一方加 */
  value: string
}

/** 单头认证：auto 只按精确匹配预设协议面的已知 authDefault 解析，unknown 一律拒绝（0 请求）。 */
export function resolveProviderAuth(
  settings: Pick<ModelSettings, 'authentication' | 'baseURL'>,
  protocol: ProviderProtocol,
  apiKey: string
): ResolvedProviderAuth {
  const choice = settings.authentication
  let concrete: 'bearer' | 'x-api-key'
  if (choice === undefined) {
    concrete = LEGACY_AUTH_DEFAULTS[protocol]
  } else if (choice === 'bearer' || choice === 'x-api-key') {
    concrete = choice
  } else if (choice === 'auto') {
    concrete = resolveAutoAuth(settings.baseURL, protocol)
  } else {
    throw new Error('认证方式非法：仅支持 auto / bearer / x-api-key')
  }
  if (protocol === 'openai-compatible' && concrete === 'x-api-key') {
    throw new Error('OpenAI-compatible 协议与 x-api-key 认证不兼容：请显式选择 bearer')
  }
  return concrete === 'bearer'
    ? { header: 'Authorization', value: apiKey }
    : { header: 'x-api-key', value: apiKey }
}

/** 认证头（恰好一个）：bearer 只发 Authorization，x-api-key 只发 x-api-key。 */
export function buildAuthHeaders(
  settings: Pick<ModelSettings, 'authentication' | 'baseURL'>,
  protocol: ProviderProtocol,
  apiKey: string
): Record<string, string> {
  const auth = resolveProviderAuth(settings, protocol, apiKey)
  return auth.header === 'Authorization'
    ? { Authorization: `Bearer ${auth.value}` }
    : { 'x-api-key': auth.value }
}

/** 精确匹配预设协议面后按 10B 的 resolvePresetAuth 解析 auto；无匹配/未知/冲突一律 fail-closed。 */
function resolveAutoAuth(baseURL: string, protocol: ProviderProtocol): 'bearer' | 'x-api-key' {
  const base = normalizeBaseURL(baseURL)
  const candidates = listProviderPresets().filter((preset) =>
    preset.faces.some(
      (face) =>
        face.protocol === protocol &&
        face.baseUrlTemplate.trim().length > 0 &&
        normalizeBaseURL(face.baseUrlTemplate) === base
    )
  )
  if (candidates.length === 0) {
    throw new Error(
      '认证方式 auto 无法解析：当前地址不在任何已知预设的协议面上，请显式选择 bearer 或 x-api-key'
    )
  }
  const resolutions = candidates.map((preset) => resolvePresetAuth(preset, protocol, 'auto'))
  for (const resolution of resolutions) {
    if (!resolution.ok || !resolution.auth) {
      throw new Error(`认证方式 auto 无法解析：${resolution.reason ?? '预设认证缺省未知'}`)
    }
  }
  const values = new Set(resolutions.map((resolution) => resolution.auth as 'bearer' | 'x-api-key'))
  if (values.size > 1) {
    throw new Error('认证方式 auto 解析冲突：同一地址匹配到多个不同认证缺省，请显式选择')
  }
  return [...values][0] as 'bearer' | 'x-api-key'
}

/** header 值只允许单行可见文本：控制字符会拼出可注入字段，一律拒绝。 */
function headerToken(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串`)
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${label}不得包含换行或控制字符`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new TypeError(`${label}不能为空或纯空白`)
  return trimmed
}

/**
 * 窄身份头：default 不附加任何东西（旧行为）；self-ua 用真实客户端名 + 组合根版本；
 * opencode-v1 再加本次上下文稳定随机的 x-opencode-session（官方要求按会话稳定）。
 * ⚠️ 缺 context 时明确拒绝，不伪造版本或随机键。
 */
export function buildIdentityHeaders(
  settings: Pick<ModelSettings, 'requestIdentity'>,
  context?: ProviderExecutionContext
): Record<string, string> {
  const mode = settings.requestIdentity
  if (mode === undefined || mode === 'default') return {}
  if (mode !== 'self-ua' && mode !== 'opencode-v1') {
    throw new Error('身份策略非法：仅支持 default / self-ua / opencode-v1')
  }
  if (!context) {
    throw new Error('该端点要求真实客户端身份，但本次调用缺少运行上下文：已拒绝发送')
  }
  const headers: Record<string, string> = {
    'User-Agent': `${CLIENT_NAME}/${headerToken(context.clientVersion, '客户端版本')}`
  }
  if (mode === 'opencode-v1') {
    headers['x-opencode-session'] = headerToken(context.sessionId, '会话键')
  }
  return headers
}

/** 组装请求头：JSON 内容类型 + 唯一认证头 + 窄身份头；没有任意 headers 入口。 */
export function buildProviderHeaders(
  settings: Pick<ModelSettings, 'authentication' | 'baseURL' | 'requestIdentity'>,
  protocol: ProviderProtocol,
  apiKey: string,
  context?: ProviderExecutionContext,
  options: { json?: boolean } = {}
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  Object.assign(headers, buildAuthHeaders(settings, protocol, apiKey))
  Object.assign(headers, buildIdentityHeaders(settings, context))
  return headers
}

/** Anthropic 必需协议头：与认证方式、身份策略正交，任何一层都不得删除或覆盖它。 */
export const ANTHROPIC_PROTOCOL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'anthropic-version': '2023-06-01'
})

/** Anthropic 请求头：内容类型（目录拉取可关）+ 唯一认证头 + 协议版本头 + 窄身份头。 */
export function buildAnthropicHeaders(
  settings: Pick<ModelSettings, 'authentication' | 'baseURL' | 'requestIdentity'>,
  apiKey: string,
  context?: ProviderExecutionContext,
  options: { json?: boolean } = {}
): Record<string, string> {
  return {
    ...buildProviderHeaders(settings, 'anthropic', apiKey, context, options),
    // 放最后：协议必需头不允许被认证/身份任何一路顺手覆盖掉
    ...ANTHROPIC_PROTOCOL_HEADERS
  }
}

/**
 * 目录 URL：预设元数据声明了 models 路径时按同 origin 解析（S3-10B 的 paths.models），
 * 否则沿用既有 resolveApiUrl 算法（Gemini /v1beta/openai 不得被再插 /v1）。
 */
export function resolveModelsRequestUrl(baseURL: string, protocol: ProviderProtocol): string {
  const base = normalizeBaseURL(baseURL)
  const preset = listProviderPresets().find((candidate) =>
    candidate.faces.some(
      (face) =>
        face.protocol === protocol &&
        face.baseUrlTemplate.trim().length > 0 &&
        normalizeBaseURL(face.baseUrlTemplate) === base
    )
  )
  // 目录端点按预设声明（同一预设的聊天面可能分列，如 OpenCode 的 /openai/v1 与 /v1/models）
  const metadataUrl =
    preset?.faces.find((face) => face.paths?.models)?.paths?.models ?? undefined
  if (!metadataUrl) return resolveApiUrl(baseURL, 'models')
  try {
    const target = new URL(metadataUrl)
    const origin = new URL(base)
    return `${origin.origin}${target.pathname}${target.search}`
  } catch {
    return resolveApiUrl(baseURL, 'models')
  }
}
