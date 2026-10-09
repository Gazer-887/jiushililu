import type { ChatDonePayload, ConversationMeta } from './ipc'
import type { TokenSaverTier } from './token-tier'
import {
  addUsage,
  emptyUsage,
  extendUsageCoverage,
  hasReportedUsage,
  mergeUsageSnapshots,
  type TokenUsage
} from './usage'

/** 对话实报、本地估算与独立反思分账；来源和覆盖范围随累计账一起保存。 */
export interface ConversationUsage {
  total: TokenUsage
  last: TokenUsage | null
  usageReported: boolean
  usageComplete?: boolean
  lastComplete?: boolean
  tier?: TokenSaverTier
  avoided: number
  memory: number
  reflectionTotal?: TokenUsage
}

/** 实际报告的缺失明细是未知；数学单位元才允许省略字段。 */
function reportedDetails(usage: TokenUsage): TokenUsage {
  return {
    ...usage,
    cachedPromptTokens: usage.cachedPromptTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null
  }
}

export function accumulateConversationUsage(
  prev: ConversationUsage | undefined,
  done: ChatDonePayload
): ConversationUsage {
  const reported = hasReportedUsage(done.usage, true)
  const usage = reported && done.usage ? reportedDetails(done.usage) : null
  const complete = reported ? done.usageComplete : false
  return {
    ...prev,
    total: usage
      ? addUsage(hasReportedUsage(prev?.total, prev?.usageReported) && prev ? reportedDetails(prev.total) : emptyUsage(), usage)
      : (prev?.total ?? emptyUsage()),
    last: usage,
    usageReported: reported || hasReportedUsage(prev?.total, prev?.usageReported),
    usageComplete: prev ? extendUsageCoverage(prev.usageComplete, complete) : complete,
    lastComplete: complete,
    avoided: (prev?.avoided ?? 0) + (done.avoided ?? 0),
    memory: (prev?.memory ?? 0) + (done.memoryTokens ?? 0),
    ...(done.tier !== undefined ? { tier: done.tier } : {})
  }
}

/** 磁盘是累计快照，不能当成最近一轮；明确漏报不被晚到快照洗成完整。 */
export function mergeConversationUsage(
  cur: ConversationUsage | undefined,
  meta: ConversationMeta
): ConversationUsage | undefined {
  if (
    !cur &&
    !meta.usage &&
    meta.usageReported === undefined &&
    meta.usageComplete === undefined &&
    meta.avoidedTokens === undefined &&
    meta.memoryTokens === undefined &&
    !meta.tokenTier &&
    !meta.reflectionUsage
  )
    return undefined
  const storedReported = hasReportedUsage(meta.usage, meta.usageReported)
  const total =
    storedReported && meta.usage
      ? hasReportedUsage(cur?.total, cur?.usageReported) && cur
        ? mergeUsageSnapshots(cur.total, meta.usage)
        : meta.usage
      : (cur?.total ?? meta.usage ?? emptyUsage())
  const reflectionTotal =
    cur?.reflectionTotal && meta.reflectionUsage
      ? mergeUsageSnapshots(cur.reflectionTotal, meta.reflectionUsage)
      : (cur?.reflectionTotal ?? meta.reflectionUsage)
  const complete =
    cur?.usageComplete === false || meta.usageComplete === false
      ? false
      : (cur?.usageComplete ?? meta.usageComplete)
  return {
    ...cur,
    total,
    last: cur?.last ?? null,
    usageReported: hasReportedUsage(cur?.total, cur?.usageReported) || storedReported,
    ...(complete !== undefined ? { usageComplete: complete } : {}),
    avoided: Math.max(cur?.avoided ?? 0, meta.avoidedTokens ?? 0),
    memory: Math.max(cur?.memory ?? 0, meta.memoryTokens ?? 0),
    ...((cur?.tier ?? meta.tokenTier) ? { tier: cur?.tier ?? meta.tokenTier } : {}),
    ...(reflectionTotal ? { reflectionTotal } : {})
  }
}
