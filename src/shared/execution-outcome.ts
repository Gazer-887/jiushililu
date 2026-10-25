/**
 * 执行终态固定分类（真实终态合同 §四）—— **纯类型与常量**：不 import electron、不碰 IO、不认识网络。
 *
 * 为什么单独成文件：终态语义是**跨层事实**，provider、工具、runner、IPC、存档、界面都要说同一套话。
 * 放进 providers/ 会把「执行终态」绑死在某个厂商细节上；放进 agent.ts 又会让纯消费者为拿一个枚举
 * 拖进整个 Agent 内核类型面。
 */

/** 单次工具执行的真实结果。结构优先于文字：有本字段就不再靠文本正则判状态。 */
export type ToolResultState = 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'unknown'

/**
 * 一次运行的结算终态。
 * ⚠️ `max-rounds` **不得显示为成功**：它表示预算耗尽而非任务完成，虽然走 done 通道。
 */
export type RunResultState =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'unknown'
  | 'truncated'
  | 'max-rounds'

/** 固定原因码。只描述「为什么是这个终态」，不携带任何厂商正文。 */
export type OutcomeCode =
  | 'missing-terminal'
  | 'malformed-stream'
  | 'incomplete-tool-call'
  | 'upstream-error'
  | 'http-error'
  | 'network-error'
  | 'first-byte-timeout'
  | 'idle-timeout'
  | 'token-limit'
  | 'content-filter'
  | 'unsupported-stop'
  | 'user-stop'
  | 'permission-denied'
  | 'command-exit'
  | 'command-timeout'
  | 'output-limit'
  | 'unknown-exit'
  | 'tool-error'

/** 一次运行的终态记录。`code` / `httpStatus` 仅在真实观测到时出现，不补默认值。 */
export interface RunTerminal {
  state: RunResultState
  code?: OutcomeCode
  httpStatus?: number
}

export const TOOL_RESULT_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'denied',
  'unknown'
] as const satisfies readonly ToolResultState[]

export const RUN_RESULT_STATES = [
  'completed',
  'failed',
  'cancelled',
  'denied',
  'unknown',
  'truncated',
  'max-rounds'
] as const satisfies readonly RunResultState[]

export const OUTCOME_CODES = [
  'missing-terminal',
  'malformed-stream',
  'incomplete-tool-call',
  'upstream-error',
  'http-error',
  'network-error',
  'first-byte-timeout',
  'idle-timeout',
  'token-limit',
  'content-filter',
  'unsupported-stop',
  'user-stop',
  'permission-denied',
  'command-exit',
  'command-timeout',
  'output-limit',
  'unknown-exit',
  'tool-error'
] as const satisfies readonly OutcomeCode[]

/**
 * Agent 主链**可对外结算**的终态子集。
 * ⚠️ 刻意不含 `max-rounds`：它走 done 通道但不代表成功，展示层必须自己另判；
 * 放进这个集合会让「是不是 Agent 结算态」与「是不是成功」被混为一谈。
 */
export const AGENT_RUN_TERMINALS = [
  'completed',
  'failed',
  'cancelled',
  'denied',
  'unknown',
  'truncated'
] as const satisfies readonly RunResultState[]

/**
 * 失败路径缺省终态：**unknown 而非 failed**。
 * 凭异常形状猜不出用户取消还是真失败 —— 猜错会把「用户主动停止」记成故障，
 * 也会把「未知」粉饰成确定结论。
 */
export const DEFAULT_PROVIDER_FAILURE_TERMINAL: RunTerminal = { state: 'unknown' }

export function isRunResultState(value: unknown): value is RunResultState {
  return typeof value === 'string' && (RUN_RESULT_STATES as readonly string[]).includes(value)
}

export function isToolResultState(value: unknown): value is ToolResultState {
  return typeof value === 'string' && (TOOL_RESULT_STATES as readonly string[]).includes(value)
}

export function isOutcomeCode(value: unknown): value is OutcomeCode {
  return typeof value === 'string' && (OUTCOME_CODES as readonly string[]).includes(value)
}

/** 只认结构：`state` 必须是已知枚举；`code` 若出现也必须是已知码。 */
export function isRunTerminal(value: unknown): value is RunTerminal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { state?: unknown; code?: unknown; httpStatus?: unknown }
  if (!isRunResultState(candidate.state)) return false
  if (candidate.code !== undefined && !isOutcomeCode(candidate.code)) return false
  if (candidate.httpStatus !== undefined && typeof candidate.httpStatus !== 'number') return false
  return true
}
