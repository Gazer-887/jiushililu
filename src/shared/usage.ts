/**
 * 用量（plan8 R9）—— **纯逻辑**：不 import electron、不碰 IO、不认识网络。
 *
 * ## 为什么**没有**费用
 *
 * 2026-09-12 用户定调：**"不用记钱，计量就好"**。
 * 早先版本里有过一盘"单价 × 用量 = 钱"的算术（还带一支 `parsePrice`），已删 ——
 * 理由不只是"用户说不要"，还有一条更硬的：**价格不是能推出来的东西**。
 * 各家不同、随时调价、还分输入/输出两档；把价目表硬编进代码，第一次调价就变成谎话。
 * 所以这一层只做**计数**：数错了是 bug，价格错了是误导。
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

/** 累加一堆记录（会话级的"累计用量"就是它） */
export function sumRecords(records: UsageRecord[]): TokenUsage {
  return records.reduce<TokenUsage>((acc, r) => addUsage(acc, r.usage), emptyUsage())
}

/** 这一堆里有没有估算成分（只要有一条是，就得说"含估算"） */
export function anyEstimated(records: UsageRecord[]): boolean {
  return records.some((r) => r.estimated)
}
