/**
 * 用量与费用（plan8 R9）—— **纯逻辑**：不 import electron、不碰 IO、不认识网络。
 *
 * ## 为什么"费用"要用户自己填单价
 *
 * 价格不是能推出来的东西：各家不同、随时会变、还分输入/输出两档。
 * 把一张价目表**硬编进代码**，第一次调价就变成谎话（而且用户会拿着错数字做决定）。
 * 所以：**单价由用户在端点里填**；没填就只显示用量、**不假装知道钱**。
 * 这与本项目"全自定义接入、不内置任何模型与 Key"是同一个哲学。
 *
 * ## 口径
 *
 * - `promptTokens` / `completionTokens` 优先取 **Provider 报的真实值**（`usage` 字段）
 * - 拿不到真实值时退回**本地估算**（`@shared/tokens`），并标记 `estimated: true`
 *   —— 估算与真实值混在一起不标注，用户会把两笔账当成一回事
 */

export interface TokenUsage {
  /** 输入（提示词）token */
  promptTokens: number
  /** 输出（回答）token */
  completionTokens: number
}

/** 单价（每 100 万 token 的钱，币种由用户自己理解 —— 我们只做算术，不替它下结论） */
export interface TokenPrice {
  /** 输入单价 / 百万 token */
  inputPerMillion: number
  /** 输出单价 / 百万 token */
  outputPerMillion: number
}

export interface UsageRecord {
  usage: TokenUsage
  /**
   * 这一笔里有没有**本地估算**的成分。
   * 为什么必须有这个标记：估算与真实值混在一起不标注，用户会把两笔账当成一回事。
   */
  estimated: boolean
  /** 是哪一轮（runId，没有就空） */
  runId?: string
  at: number
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0 }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens
  }
}

export function totalTokens(u: TokenUsage): number {
  return u.promptTokens + u.completionTokens
}

/** 纯算术：钱 = 输入 × 输入价 + 输出 × 输出价（单价按**百万 token** 给） */
export function costOf(u: TokenUsage, price: TokenPrice | null): number | null {
  if (!price) return null
  const cost = (u.promptTokens * price.inputPerMillion + u.completionTokens * price.outputPerMillion) / 1_000_000
  return Number.isFinite(cost) ? cost : null
}

/**
 * 给人看的用量：**小数字不说废话，大数字才换单位**。
 * 1.2k 比 1,234 好读；但 842 写成 0.8k 反而更糊涂。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/**
 * 给人看的钱。**没填单价 → null**（界面据此显示"—"而不是 0）——
 * 显示 0 会让用户以为"不要钱"，而那是另一回事。
 */
export function formatCost(cost: number | null): string | null {
  if (cost === null || !Number.isFinite(cost)) return null
  if (cost === 0) return '0'
  if (cost < 0.01) return cost.toFixed(4)
  if (cost < 1) return cost.toFixed(3)
  return cost.toFixed(2)
}

/** 累加一堆记录（会话级的"累计用量"就是它） */
export function sumRecords(records: UsageRecord[]): TokenUsage {
  return records.reduce<TokenUsage>((acc, r) => addUsage(acc, r.usage), emptyUsage())
}

/** 这一堆里有没有估算成分（只要有一条是，就得说"含估算"） */
export function anyEstimated(records: UsageRecord[]): boolean {
  return records.some((r) => r.estimated)
}

/**
 * 单价从"每 100 万 token"的输入框里读进来时用：空串 / 非法 / 负数 → null（= 没填价）。
 * 单独成函数是为了**可单测**：这里宽松一点，界面就不会把 0.0001 这种价当成"你没填"。
 */
export function parsePrice(input: string): number | null {
  const s = input.trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}
