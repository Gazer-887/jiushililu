/**
 * 请求策略（S3-20A）：FAST 纯合同 —— 速度档解析、本地读并发与服务档意图的唯一出口。
 * 与省 token 四档完全正交：本文件零依赖，不读取也不修改其任一开关。
 * 不碰 electron / IO / 网络；`actual/observed` 只陈述观测事实，绝不用请求值回填成功。
 */

export const SPEED_MODES = ['normal', 'fast'] as const
export type SpeedMode = (typeof SPEED_MODES)[number]

export const SPEED_OVERRIDES = ['inherit', 'normal', 'fast'] as const
export type SpeedOverride = (typeof SPEED_OVERRIDES)[number]

export const TIER_SUPPORTS = ['supported', 'unsupported', 'unknown'] as const
export type TierSupport = (typeof TIER_SUPPORTS)[number]

export const DEFAULT_SPEED_MODE: SpeedMode = 'normal'
export const DEFAULT_SPEED_OVERRIDE: SpeedOverride = 'inherit'
export const DEFAULT_TIER_SUPPORT: TierSupport = 'unknown'

/** FAST 意图对应的服务档名；只有模型声明 supported 且模式为 fast 才会进请求 */
export const FAST_SERVICE_TIER = 'priority'

/** 一份请求策略快照：调用方只认这份，不自己拼"档位 → 并发 / 服务档"的规则 */
export interface RequestPolicySnapshot {
  mode: SpeedMode
  maxLocalReadConcurrency: 1 | 2
  requestedServiceTier: string | null
  tierSupport: TierSupport
}

/** 服务档观测：`actual` 是厂商真实回值；回值缺失时 `observed=false`，`actual` 保持 null */
export interface ServiceTierObservation {
  requested: string | null
  actual: string | null
  observed: boolean
}

/** 解析入参：所有字段都收 `unknown`，脏数据由本模块按 fail-closed 规则收口 */
export interface RequestPolicyInput {
  /** 模型条目默认（旧档案缺字段 = undefined，等价 normal） */
  modelDefault?: unknown
  /** 会话覆盖（S3-20B 注入；缺省或 inherit = 用模型默认） */
  sessionOverride?: unknown
  /** 模型是否声明支持 FAST 服务档（缺省 / 非法 = unknown） */
  tierSupport?: unknown
}

export function isSpeedMode(value: unknown): value is SpeedMode {
  return value === 'normal' || value === 'fast'
}

export function isSpeedOverride(value: unknown): value is SpeedOverride {
  return value === 'inherit' || isSpeedMode(value)
}

export function isTierSupport(value: unknown): value is TierSupport {
  return value === 'supported' || value === 'unsupported' || value === 'unknown'
}

/** 缺值 / 旧值 / 非法值一律回 normal：不抛错，也不悄悄升成 fast */
export function normalizeSpeedMode(value: unknown): SpeedMode {
  return isSpeedMode(value) ? value : DEFAULT_SPEED_MODE
}

/** 缺值 / 非法值回 inherit：坏值不得冒充"显式覆盖" */
export function normalizeSpeedOverride(value: unknown): SpeedOverride {
  return isSpeedOverride(value) ? value : DEFAULT_SPEED_OVERRIDE
}

/** 缺值 / 非法值回 unknown：没声明支持就不请求非默认服务档 */
export function normalizeTierSupport(value: unknown): TierSupport {
  return isTierSupport(value) ? value : DEFAULT_TIER_SUPPORT
}

/** 会话优先：inherit（含缺省 / 非法）取模型默认，显式 normal / fast 直接生效 */
export function resolveSpeedMode(modelDefault: unknown, sessionOverride?: unknown): SpeedMode {
  const override = normalizeSpeedOverride(sessionOverride)
  return override === 'inherit' ? normalizeSpeedMode(modelDefault) : override
}

/** 本地只读工具并发：普通档 1（保守），FAST 档 2（更快，但仍是有限并发） */
export function localReadConcurrency(mode: SpeedMode): 1 | 2 {
  return mode === 'fast' ? 2 : 1
}

/** 唯一快照出口：速度档 → 并发与服务档意图；unsupported / unknown 永不请求非默认档 */
export function resolveRequestPolicy(input: RequestPolicyInput = {}): RequestPolicySnapshot {
  const mode = resolveSpeedMode(input.modelDefault, input.sessionOverride)
  const tierSupport = normalizeTierSupport(input.tierSupport)
  return {
    mode,
    maxLocalReadConcurrency: localReadConcurrency(mode),
    requestedServiceTier: mode === 'fast' && tierSupport === 'supported' ? FAST_SERVICE_TIER : null,
    tierSupport
  }
}

/** 非空字符串才算值：空白串按"没给"处理，不把空串当观测成功 */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * 服务档观测：`actual` 有真实回值才算 observed；缺值一律 null / false，绝不回填 requested。
 * 服务端降级（actual ≠ requested）是真实观测，原样保留供界面披露。
 */
export function observeServiceTier(requested: unknown, actual: unknown): ServiceTierObservation {
  const requestedTier = textOrNull(requested)
  const actualTier = textOrNull(actual)
  return { requested: requestedTier, actual: actualTier, observed: actualTier !== null }
}

// ── S3-30T1 运行态请求上下文 ──────────────────────────────────────────────
// 只描述"这一次真实调用是谁、为什么、按哪份策略"，不碰持久化、日志与网络。

/** 八类真实调用目的（RB-B02 冻结）：新增入口必须先改这里，不允许各层自造字符串。 */
export const PROVIDER_CALL_PURPOSES = [
  'main-chat',
  'one-shot',
  'subagent',
  'reflection',
  'title',
  'prompt-polish',
  'connection-check',
  'model-catalog'
] as const
export type ProviderCallPurpose = (typeof PROVIDER_CALL_PURPOSES)[number]

/** 固定普通档的五类辅助调用：不落会话 FAST，也不隐式请求收费优先档。 */
export const AUXILIARY_PROVIDER_CALL_PURPOSES = [
  'reflection',
  'title',
  'prompt-polish',
  'connection-check',
  'model-catalog'
] as const
export type AuxiliaryProviderCallPurpose = (typeof AUXILIARY_PROVIDER_CALL_PURPOSES)[number]

export function isProviderCallPurpose(value: unknown): value is ProviderCallPurpose {
  return typeof value === 'string' && (PROVIDER_CALL_PURPOSES as readonly string[]).includes(value)
}

export function isAuxiliaryProviderCallPurpose(
  value: unknown
): value is AuxiliaryProviderCallPurpose {
  return (
    typeof value === 'string' &&
    (AUXILIARY_PROVIDER_CALL_PURPOSES as readonly string[]).includes(value)
  )
}

/**
 * 一次真实调用的**运行态**上下文（S3-30T1）：只在内存，不进 ModelSettings、消息、日志或磁盘。
 * ⚠️ 版本由组合根注入；operation/session 键取自可信随机源，不派生自会话 ID、路径、用户名、模型或 Key。
 */
export interface ProviderExecutionContext {
  readonly clientVersion: string
  readonly purpose: ProviderCallPurpose
  readonly operationId: string
  readonly sessionId: string
  readonly policy: Readonly<RequestPolicySnapshot>
}

/** 工厂入参：版本必须由调用方传入；随机源仅供测试注入，默认走平台 CSPRNG。 */
export interface ProviderExecutionContextInput {
  clientVersion: string
  purpose: ProviderCallPurpose
  policy: RequestPolicySnapshot
  randomUUID?: () => string
}

/** 换行与其他控制字符会拼出可注入的字段值，一律拒绝（版本与运行键共用）。 */
function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function headerSafeVersion(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('ProviderExecutionContext.clientVersion 必须是字符串')
  }
  // 先查原文再裁剪：尾随换行/回车被 trim 掉就等于悄悄接受了坏版本。
  if (hasControlChar(value)) {
    throw new TypeError('ProviderExecutionContext.clientVersion 不得包含换行或控制字符')
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new TypeError('ProviderExecutionContext.clientVersion 不能为空或纯空白')
  }
  return trimmed
}

function assertPolicySnapshot(value: unknown): asserts value is RequestPolicySnapshot {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('ProviderExecutionContext.policy 必须是请求策略快照对象')
  }
  const policy = value as Partial<RequestPolicySnapshot>
  if (!isSpeedMode(policy.mode)) {
    throw new TypeError('ProviderExecutionContext.policy.mode 非法')
  }
  if (!isTierSupport(policy.tierSupport)) {
    throw new TypeError('ProviderExecutionContext.policy.tierSupport 非法')
  }
  if (policy.maxLocalReadConcurrency !== 1 && policy.maxLocalReadConcurrency !== 2) {
    throw new TypeError('ProviderExecutionContext.policy.maxLocalReadConcurrency 非法')
  }
  if (policy.requestedServiceTier !== null && typeof policy.requestedServiceTier !== 'string') {
    throw new TypeError('ProviderExecutionContext.policy.requestedServiceTier 非法')
  }
}

/** 默认随机源：平台 CSPRNG；拿不到就明确失败，绝不用计数/时间等弱随机冒充。 */
function defaultRandomUUID(): string {
  const webCrypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof webCrypto?.randomUUID !== 'function') {
    throw new Error('运行环境缺少 crypto.randomUUID，拒绝退化为弱随机源')
  }
  return webCrypto.randomUUID()
}

function runtimeKey(source: () => string): string {
  const value = source()
  if (typeof value !== 'string') {
    throw new TypeError('运行态请求键必须是字符串')
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new TypeError('运行态请求键不能为空或纯空白')
  }
  if (hasControlChar(trimmed)) {
    throw new TypeError('运行态请求键不得包含换行或控制字符')
  }
  return trimmed
}

/** 复制并冻结：调用方之后再改输入对象，不会影响已创建的上下文。 */
function frozenPolicyCopy(policy: RequestPolicySnapshot): Readonly<RequestPolicySnapshot> {
  return Object.freeze({
    mode: policy.mode,
    maxLocalReadConcurrency: policy.maxLocalReadConcurrency,
    requestedServiceTier: policy.requestedServiceTier,
    tierSupport: policy.tierSupport
  })
}

/**
 * 创建运行态上下文（S3-30T1）。版本由调用方注入，本函数不读 package/全局配置、不导入 electron。
 * ⚠️ 辅助五类固定按 normal 解析（调用方传入的 FAST 意图不生效）；其余三类原样复制显式快照。
 */
export function createProviderExecutionContext(
  input: ProviderExecutionContextInput
): ProviderExecutionContext {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('ProviderExecutionContext 入参必须是对象')
  }
  const clientVersion = headerSafeVersion(input.clientVersion)
  if (!isProviderCallPurpose(input.purpose)) {
    throw new TypeError('ProviderExecutionContext.purpose 非法')
  }
  assertPolicySnapshot(input.policy)
  const policy = isAuxiliaryProviderCallPurpose(input.purpose)
    ? Object.freeze(
        resolveRequestPolicy({
          modelDefault: DEFAULT_SPEED_MODE,
          tierSupport: input.policy.tierSupport
        })
      )
    : frozenPolicyCopy(input.policy)
  const random = typeof input.randomUUID === 'function' ? input.randomUUID : defaultRandomUUID
  const operationId = runtimeKey(random)
  const sessionId = runtimeKey(random)
  if (operationId === sessionId) {
    throw new TypeError('operationId 与 sessionId 必须由随机源产生不同值')
  }
  return Object.freeze({ clientVersion, purpose: input.purpose, operationId, sessionId, policy })
}

// ── 工具批并发上限（S3-40A）──────────────────────────────────────────────
// 只回答"这个批最多能同时在途几项"：普通 1，FAST 且本批全部合格 2。
// 合格资格由真实消费者在每项启动前判定；本文件不认路径、工具身份或权限来源。
// 缺省、未知、非法输入一律保守回收为 1 —— 不允许把配置错误解释成"可以多跑"。

export const TOOL_BATCH_CONCURRENCY_SERIAL = 1
export const TOOL_BATCH_CONCURRENCY_FAST = 2

export interface ToolBatchConcurrencyInput {
  mode?: unknown
  /** 只有真实的"整批合格"才可传 true；缺省/未知/抛错路径都按不合格 */
  eligible?: unknown
}

export function resolveToolBatchConcurrency(input: ToolBatchConcurrencyInput = {}): 1 | 2 {
  if (input.mode !== 'fast') return TOOL_BATCH_CONCURRENCY_SERIAL
  if (input.eligible !== true) return TOOL_BATCH_CONCURRENCY_SERIAL
  return TOOL_BATCH_CONCURRENCY_FAST
}

// ── 权限代次合同 ────────────────────────────────────────────────────────
// 只定义"档位 + 进程内代次"的共享形状与提交门比较规则；真实来源在 store/settings。
// 不把 FAST、模型或省 token 配置当作权限；非法代次一律判为"已变化"（fail-closed）。

export interface PermissionStateSnapshot<P extends string = string> {
  /** 当前权限档（具体枚举由调用方以泛型带入，本文件不复制权限取值） */
  preset: P
  /** 进程内单调代次：只在真实权限状态变化时推进 */
  generation: number
}

/** 提交门判断：只有两边都是同一非负安全整数才算"未变化"；其余一律保守视为已变化。 */
export function isPermissionGenerationCurrent(observed: unknown, current: unknown): boolean {
  return (
    typeof observed === 'number' &&
    typeof current === 'number' &&
    Number.isSafeInteger(observed) &&
    Number.isSafeInteger(current) &&
    observed >= 0 &&
    observed === current
  )
}
