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
  /**
   * 输入里**命中前缀缓存**的那部分（plan8 R9.1 §七①）。
   *
   * **缺失 ≠ 0**：`undefined` / `null` 一律表示"厂商没报这个数"，不是"命中 0 个"。
   * 二者在界面上长得一样（一个 0%），但一个是事实、一个是不知道 ——
   * 所以读取方一律用 `?? null`，显示层遇到 null **不渲染**，绝不写 0。
   * 真机实测（DeepSeek）：`prompt_cache_hit_tokens: 2048` 与
   * `prompt_tokens_details.cached_tokens: 2048` 同值同报，两套都认。
   */
  cachedPromptTokens?: number | null
  /**
   * 输出里**推理（思考链）**的那部分（plan8 R9.1 §七①）。
   *
   * 注意它和上面那个的差别：真机实测 DeepSeek 会明确报 `reasoning_tokens: 0`
   * （这轮没思考）—— **报了 0 就是真的 0**，与"没报"是两回事，别一起当 null。
   */
  reasoningTokens?: number | null
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

/** 这个可选计数**根本不知道**（没报）—— 与"报了 0"严格区分 */
const unknown = (v: number | null | undefined): boolean => v === null || v === undefined

/**
 * 可选计数的**加法**。这里的规矩分三种，一个都不能省：
 *
 * | 值 | 含义 | 累加时怎么办 |
 * |---|---|---|
 * | 数字 | 厂商报的真值（**包括 0**） | 相加 |
 * | `null` | 厂商**明确没报**这个数 | 结果也是 `null`（未知会粘住：半笔账不能当整笔） |
 * | `undefined` | 这份账**不含**这条信息（空账单位元 / 升级前的老数据） | 忽略它，取有值那侧 |
 *
 * 为什么非要把 `undefined` 和 `null` 分开：`emptyUsage()` 是累加的**单位元**，
 * 它没有这两个键；而"厂商这轮没报"是**未知**。要是把两者都当未知，
 * 那么"第一轮就报 0 命中"这种完全正常的情况会被判成未知 —— 命中率从此再不显示
 * （2026-09-13 被真渲染门禁抓出来的真实缺陷），功能等于没做。
 */
function addOptional(
  a: number | null | undefined,
  b: number | null | undefined
): number | null | undefined {
  if (a === null || b === null) return null
  if (a === undefined) return b
  if (b === undefined) return a
  return a + b
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = addOptional(a.cachedPromptTokens, b.cachedPromptTokens)
  const reasoning = addOptional(a.reasoningTokens, b.reasoningTokens)
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
  }
}

/**
 * 可选计数的**取大**（合并两个来源时用：内存账本 vs 盘上存档）。
 *
 * 与 `addOptional` 的差别：这里**不区分** `undefined` 和 `null`。
 * 用途决定了这一点 —— 它回答的是"两个来源里哪个数是真的"，
 * 任一侧报过就是已知；让盘上一条老记录把内存里已经拿到的数抹成"未知"才是错的。
 * 渲染端账本那条"只许往前长"的规矩，落到这两个数上就是下面这两行。
 */
export function mergeOptionalMax(
  a: number | null | undefined,
  b: number | null | undefined
): number | null | undefined {
  if (unknown(a) && unknown(b)) return undefined
  if (unknown(a)) return b
  if (unknown(b)) return a
  return Math.max(a as number, b as number)
}

/**
 * 合并**同一轮的两份半账**（Anthropic 把 usage 分两处报：`message_start` 给输入、
 * `message_delta` 给输出）。
 *
 * 规则是**逐字段取大的那份**，不是相加：
 * - 两半各自只报自己那侧，另一侧写 0（`message_start` 里那个 `output_tokens: 1` 是占位）
 * - **相加会把这个占位也算进去**（真实用例：88 + 1 = 89，多算一格）
 * - 取大则天然正确：输入取 start 的 321、输出取 delta 的 88
 *
 * 对 `cached` / `reasoning` 尤其重要：它们**只出现在其中一半**，
 * 若按"另一侧缺失 = 未知"处理，会被抹成 null —— 界面就再也看不到命中率了。
 */
export function mergeUsageHalves(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = mergeOptionalMax(a.cachedPromptTokens, b.cachedPromptTokens)
  const reasoning = mergeOptionalMax(a.reasoningTokens, b.reasoningTokens)
  return {
    promptTokens: Math.max(a.promptTokens, b.promptTokens),
    completionTokens: Math.max(a.completionTokens, b.completionTokens),
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
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

/**
 * **缓存命中率** = 命中量 / 输入量（0–1，plan8 R9.1 §七①）。
 *
 * 三种情况必须分开对待：
 * - 厂商没报命中量 → `null`（**不是 0**：写 0 等于替厂商宣布"一点没命中"）
 * - 输入为 0（除零没有意义）→ `null`
 * - 脏数据（命中量 > 输入量）→ **夹到 1**，既不抛错也不显示成 130%
 */
export function cacheHitRate(u: TokenUsage): number | null {
  if (unknown(u.cachedPromptTokens)) return null
  if (u.promptTokens <= 0) return null
  return Math.min(1, Math.max(0, (u.cachedPromptTokens as number) / u.promptTokens))
}

/**
 * **思考占比** = 推理量 / 输出量（0–1）。
 *
 * ⚠️ 与命中率的差别在这一点：`reasoning_tokens: 0` 是厂商**明确报的 0**（这轮没思考），
 * 所以这里返回 `0` 而不是 `null` —— "没思考"是事实，"没报"才是未知。
 */
export function reasoningShare(u: TokenUsage): number | null {
  if (unknown(u.reasoningTokens)) return null
  if (u.completionTokens <= 0) return null
  return Math.min(1, Math.max(0, (u.reasoningTokens as number) / u.completionTokens))
}

/** 给人看的百分比：`null` = 不知道 → 破折号，**绝不渲染成 0%** */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

/** 这一堆里有没有估算成分（只要有一条是，就得说"含估算"） */
export function anyEstimated(records: UsageRecord[]): boolean {
  return records.some((r) => r.estimated)
}
