/**
 * 请求策略（S3-20A → S89-01）：运行级本地读并发与权限代次合同的唯一出口。
 * 与省 token 四档完全正交：本文件零依赖，不读取也不修改其任一开关。
 * 不碰 electron / IO / 网络；厂商服务档位意图与观测已在 S89-01 整体移除。
 */

/** 本地只读工具批的并发上限：串行 1 路 / 并行 2 路 */
export const TOOL_BATCH_CONCURRENCY_SERIAL = 1
export const TOOL_BATCH_CONCURRENCY_PARALLEL = 2

/** 一份请求策略快照：调用方只认这份，不自己拼"并发"规则 */
export interface RequestPolicySnapshot {
  /** 本 run 允许的本地只读批上限；批内是否真并发出 resolveToolBatchConcurrency 逐批准入 */
  maxLocalReadConcurrency: 1 | 2
}

/** 唯一快照出口：本地读取并行默认开启，逐批资格与串行边界仍由消费方守卫 */
export function resolveRequestPolicy(): RequestPolicySnapshot {
  return { maxLocalReadConcurrency: TOOL_BATCH_CONCURRENCY_PARALLEL }
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

export function isProviderCallPurpose(value: unknown): value is ProviderCallPurpose {
  return typeof value === 'string' && (PROVIDER_CALL_PURPOSES as readonly string[]).includes(value)
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
  if (policy.maxLocalReadConcurrency !== 1 && policy.maxLocalReadConcurrency !== 2) {
    throw new TypeError('ProviderExecutionContext.policy.maxLocalReadConcurrency 非法')
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
    maxLocalReadConcurrency: policy.maxLocalReadConcurrency
  })
}

/**
 * 创建运行态上下文（S3-30T1）。版本由调用方注入，本函数不读 package/全局配置、不导入 electron。
 * 辅助调用与主调用共用同一份并发快照；身份键仍按每次真实调用独立生成。
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
  const policy = frozenPolicyCopy(input.policy)
  const random = typeof input.randomUUID === 'function' ? input.randomUUID : defaultRandomUUID
  const operationId = runtimeKey(random)
  const sessionId = runtimeKey(random)
  if (operationId === sessionId) {
    throw new TypeError('operationId 与 sessionId 必须由随机源产生不同值')
  }
  return Object.freeze({ clientVersion, purpose: input.purpose, operationId, sessionId, policy })
}

// ── 工具批并发上限（S3-40A → S89-01）────────────────────────────────────
// 只回答"这个批最多能同时在途几项"：整批合格 2，其余一律 1。
// 合格资格由真实消费者在每项启动前判定；本文件不认路径、工具身份或权限来源。
// 缺省、未知、非法输入一律保守回收为 1 —— 不允许把配置错误解释成"可以多跑"。

export interface ToolBatchConcurrencyInput {
  /** 只有真实的"整批合格"才可传 true；缺省/未知/抛错路径都按不合格 */
  eligible?: unknown
}

export function resolveToolBatchConcurrency(input: ToolBatchConcurrencyInput = {}): 1 | 2 {
  return input.eligible === true ? TOOL_BATCH_CONCURRENCY_PARALLEL : TOOL_BATCH_CONCURRENCY_SERIAL
}

// ── 权限代次合同 ────────────────────────────────────────────────────────
// 只定义"档位 + 进程内代次"的共享形状与提交门比较规则；真实来源在 store/settings。
// 不把模型或省 token 配置当作权限；非法代次一律判为"已变化"（fail-closed）。

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
