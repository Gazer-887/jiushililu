// 「Agent 向用户提问（带选项）」的共享契约：主/渲染共用，纯类型与常量，不 import electron（CI 无二进制）。
// 与危险操作确认（shared/ipc 的 ToolConfirm*）刻意分开：确认是**是/否 + 安全语义**（没人答复 = 拒绝），
// 提问是**开放选择 + 信息语义**（没人答复 = 未作答）—— 两条默认值相反，合用一个类型必让其中之一失真。
// 回执的三种形态有**优先级**：`skip` > `text` > `values`（顺序与理由写在 `main/ask.ts` 的 respond 里）。

export interface AskOption {
  value: string
  label: string
  description?: string
}

export interface AskRequest {
  id: string
  question: string
  options: AskOption[]
  multiSelect?: boolean
  /** 发起方工具名，界面用来显示"这条问题出自哪个工具" */
  tool?: string
  conversationId?: string
}

/** 渲染层回执：只回 value，label 由主进程按 options 还原 —— 界面不该成为文案来源 */
export interface AskResult {
  id: string
  values: string[]
  /** 用户**明确不答**（「跳过本题」）。⚠️ 与"没人答复"是两件事：前者是有意的（模型据此换路），后者是超时/中断 */
  skip?: boolean
  /** 用户**自己写的答案**（可以不在 options 里）。⚠️ 它是答案本身而不是选项的补充值，故**不受** `values` 那条"脏值过滤"约束 */
  text?: string
}

export type AskAnswer =
  | { answered: true; values: string[]; labels: string[]; text?: string }
  | { answered: false; reason: 'timeout' | 'aborted' | 'no-window' | 'skipped' }

/** 少于两个选项就不叫选择题，该直接用文字问 */
export const ASK_MIN_OPTIONS = 2
export const ASK_MAX_OPTIONS = 10
/** 提问超时放宽到确认（60s）之上：这是要人拿主意的事，不是点头放行 */
export const ASK_TIMEOUT_MS = 5 * 60_000
