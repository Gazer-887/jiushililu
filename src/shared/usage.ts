/**
 * 用量计数（plan8 R9）—— **纯逻辑**：不 import electron、不碰 IO、不认识网络。
 *
 * 为什么**没有**费用：用户定调"不用记钱，计量就好"；更硬的理由是**价格不是能推出来的东西** ——
 * 各家不同、随时调价、还分输入/输出两档，价目表硬编进代码后第一次调价就变成谎话；层里只做**计数**
 * （数错了是 bug，价格错了是误导）。
 * 口径：优先取 Provider 报的真实值（`usage`），拿不到才退回本地估算（`@shared/tokens`）并标 `estimated: true`
 * —— 不标注的话用户会把两笔账当成一回事。
 */

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  /**
   * 输入里**命中前缀缓存**的那部分（plan8 R9.1 §七①）。
   * **缺失 ≠ 0**：`undefined` / `null` 都表示"厂商没报这个数"，不是"命中 0 个" —— 读取方一律 `?? null`，
   * 显示层遇到 null **不渲染**、绝不写 0。
   * 真机实测 DeepSeek：`prompt_cache_hit_tokens` 与 `prompt_tokens_details.cached_tokens` 同值同报，两套都认。
   */
  cachedPromptTokens?: number | null
  /**
   * 输入里**写入前缀缓存**的那部分（Anthropic `cache_creation_input_tokens`，口径 A 起计入 `promptTokens` 总输入）。
   * 三态同 `cachedPromptTokens`：数字（含明确报的 0）是事实，`null` 是厂商没报，`undefined` 是这份账不含这条信息
   * （OpenAI 兼容协议的 `prompt_tokens` 本即总输入，没有写出量可报）。
   */
  cacheWritePromptTokens?: number | null
  /**
   * 输出里**推理（思考链）**的那部分（plan8 R9.1 §七①）。
   * 与上面那个的差别：真机实测 DeepSeek 会明确报 `reasoning_tokens: 0`（这轮没思考）——
   * **报了 0 就是真的 0**，与"没报"是两回事，别一起当 null。
   */
  reasoningTokens?: number | null
}

export interface UsageRecord {
  usage: TokenUsage
  /** 这一笔里有没有**本地估算**的成分 —— 不标注的话用户会把估算与真实值当成一回事 */
  estimated: boolean
  /** 是哪一轮（runId，没有就空） */
  runId?: string
  at: number
  /**
   * 这一笔是**对话**还是**反思**（批 2 plan19 §5.2）。
   * ⚠️ 缺省 = `'chat'`（向后兼容：老记录没字段，不当反思）—— 不标的话会把反思用量算进对话账。
   * 用量牌走 `ConversationUsage.reflectionTotal`（聚合后的字段），不直接 filter `kind`；
   * `kind` 用于**事件流归因**（复盘时回答"反思花了多少"）。
   */
  kind?: 'chat' | 'reflection'
}

/**
 * 按 kind 筛记录。⚠️ 缺省 `'chat'`（与 UsageRecord 字段口径一致）——
 * 老数据没 kind 字段，按 chat 算才不会把反思用量误归到对话账。
 */
export function filterByKind(records: UsageRecord[], kind: 'chat' | 'reflection'): UsageRecord[] {
  return records.filter((r) => (r.kind ?? 'chat') === kind)
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0 }
}

/** 厂商**根本不知道**这个可选计数（没报）—— 与"报了 0"严格区分 */
const unknown = (v: number | null | undefined): boolean => v === null || v === undefined

/**
 * 可选计数的**加法**：数字（**含厂商报的 0**）相加；`null`（厂商明确没报）→ 结果也是 `null`
 * （未知会粘住：半笔账不能当整笔）；`undefined`（这份账**不含**这条信息：`emptyUsage()` 的单位元、
 * 升级前的老数据）→ 忽略它、取有值那侧。
 * ⚠️ 两者必须分开：都当未知的话，"第一轮就报 0 命中"会被判成未知，命中率从此再不显示
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
  const write = addOptional(a.cacheWritePromptTokens, b.cacheWritePromptTokens)
  const reasoning = addOptional(a.reasoningTokens, b.reasoningTokens)
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(write === undefined ? {} : { cacheWritePromptTokens: write }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
  }
}

/**
 * 可选计数的**取大**（合并两个来源时用：内存账本 vs 盘上存档）。
 * 与 `addOptional` 的差别：这里**不区分** `undefined` 和 `null` —— 它回答的是"两个来源里哪个数是真的"，
 * 任一侧报过就是已知；让盘上一条老记录把内存里已经拿到的数抹成"未知"才是错的
 * （渲染端账本"只许往前长"，落到这两个数上就是下面这两行）。
 */
export function mergeOptionalMax(
  a: number | null | undefined,
  b: number | null | undefined
): number | null | undefined {
  if (unknown(a) && unknown(b)) return a === null || b === null ? null : undefined
  if (unknown(a)) return b
  if (unknown(b)) return a
  return Math.max(a as number, b as number)
}

/**
 * 旧版逐字段取大助手，仅保留给历史半账形状的回归对照。
 * 不能据此认定协议计量完整；生产协议以完整累计器收口，累计账合并走mergeUsageSnapshots。
 */
export function mergeUsageHalves(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = mergeOptionalMax(a.cachedPromptTokens, b.cachedPromptTokens)
  const write = mergeOptionalMax(a.cacheWritePromptTokens, b.cacheWritePromptTokens)
  const reasoning = mergeOptionalMax(a.reasoningTokens, b.reasoningTokens)
  return {
    promptTokens: Math.max(a.promptTokens, b.promptTokens),
    completionTokens: Math.max(a.completionTokens, b.completionTokens),
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(write === undefined ? {} : { cacheWritePromptTokens: write }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
  }
}

/**
 * 合并同一累计账的快照。明确未报告的字段保持未知；较小范围的旧数不能补成较大范围的整笔账。
 * 协议内阶段计数应以最终报告收口，不能借这个取大操作认定两半齐全。
 */
export function mergeUsageSnapshots(a: TokenUsage, b: TokenUsage): TokenUsage {
  const optional = (
    left: number | null | undefined,
    right: number | null | undefined,
    leftScope: number,
    rightScope: number
  ): number | null | undefined => {
    if (left === null || right === null) return null
    if (left === undefined && right === undefined) return undefined
    if (left === undefined) return leftScope > rightScope ? null : right
    if (right === undefined) return rightScope > leftScope ? null : left
    return Math.max(left, right)
  }
  const cached = optional(
    a.cachedPromptTokens,
    b.cachedPromptTokens,
    a.promptTokens,
    b.promptTokens
  )
  const write = optional(
    a.cacheWritePromptTokens,
    b.cacheWritePromptTokens,
    a.promptTokens,
    b.promptTokens
  )
  const reasoning = optional(
    a.reasoningTokens,
    b.reasoningTokens,
    a.completionTokens,
    b.completionTokens
  )
  return {
    promptTokens: Math.max(a.promptTokens, b.promptTokens),
    completionTokens: Math.max(a.completionTokens, b.completionTokens),
    ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    ...(write === undefined ? {} : { cacheWritePromptTokens: write }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
  }
}

/** 旧正计数沿原报告契约保留；旧全0无法辨认空账与真0，必须有新来源标记才显示为实报。 */
export function hasReportedUsage(
  usage: TokenUsage | null | undefined,
  reported?: boolean
): boolean {
  if (
    !usage ||
    !Number.isFinite(usage.promptTokens) ||
    !Number.isFinite(usage.completionTokens) ||
    usage.promptTokens < 0 ||
    usage.completionTokens < 0
  )
    return false
  if (reported !== undefined) return reported
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    (usage.cachedPromptTokens ?? 0) > 0 ||
    (usage.reasoningTokens ?? 0) > 0
  )
}

/** 顺序追加报告：漏报事实粘住，旧覆盖范围未记也不能凭新一轮报告补成完整历史。 */
export function extendUsageCoverage(
  previous: boolean | undefined,
  current: boolean | undefined
): boolean | undefined {
  if (previous === false || current === false) return false
  if (previous === undefined || current === undefined) return undefined
  return true
}

export function totalTokens(u: TokenUsage): number {
  return u.promptTokens + u.completionTokens
}

/**
 * 给人看的用量：**小数字不说废话，大数字才换单位** —— 1.2k 比 1,234 好读，但 842 写成 0.8k 反而更糊涂。
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
 * **缓存命中率** = 命中量 / 输入量（0–1，plan8 R9.1 §七①）。三种情况必须分开对待：
 * 厂商没报命中量 → `null`（**不是 0**：写 0 等于替厂商宣布"一点没命中"）；输入为 0（除零没有意义）
 * → `null`；脏数据（命中量 > 输入量）→ **夹到 1**，既不抛错也不显示成 130%。
 */
export function cacheHitRate(u: TokenUsage): number | null {
  if (unknown(u.cachedPromptTokens)) return null
  if (u.promptTokens <= 0) return null
  return Math.min(1, Math.max(0, (u.cachedPromptTokens as number) / u.promptTokens))
}

/**
 * **思考占比** = 推理量 / 输出量（0–1）。
 * ⚠️ 与命中率的差别：`reasoning_tokens: 0` 是厂商**明确报的 0**（这轮没思考），所以这里返回 `0`
 * 而不是 `null` —— "没思考"是事实，"没报"才是未知。
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
