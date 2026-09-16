import type { AgentMessage } from '@shared/agent'
import { estimateMessageTokens, estimateTokens } from '@shared/tokens'

// 上下文管理（P1 收官件之一）：长对话逼近上下文窗口时的历史裁剪。
// 只裁中段 —— system 与末尾 keepRecent 条永远保留，裁掉的旧消息合成一条[历史摘要]占位（保住要点、释放大头）。
// 裁剪是**确定性**的、不调模型：摘要由模型在后续轮次自然补全（P1 保持零副作用）。

export { estimateTokens }

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : ''
    const callsJson = m.tool_calls ? JSON.stringify(m.tool_calls) : ''
    return sum + estimateMessageTokens(content, callsJson)
  }, 0)
}

export interface TrimOptions {
  /** 上下文窗口（token 数） */
  contextWindow: number
  /** 触发裁剪的占比（默认 0.75，与 DSH compaction 的 thresholdRatio 同思路） */
  thresholdRatio?: number
  /** 最近多少条消息永不裁剪（默认 6） */
  keepRecent?: number
  /**
   * 模型生成的摘要文本（plan26 D-080 滚动摘要）：给了就用它替换机械占位。
   * 不给 = 机械占位（现状行为，零退化）——fail-soft 的兜底路径也走这里。
   */
  summaryText?: string
}

export interface TrimResult {
  messages: AgentMessage[]
  trimmed: boolean
  /** 被裁掉的消息条数（用于给用户提示与 ACE 复盘） */
  droppedCount: number
  /** 被裁内容的字节数（plan26 D-080 裁剪可见性：trim 事件留痕用） */
  droppedBytes: number
  /** 被裁掉的消息原文（plan26 D-080）：**只在内存传递**（喂给摘要调用），
   *  **绝不进执行事件流**（正文禁区，D-077 白名单口径） */
  dropped: AgentMessage[]
}

/**
 * 滚动摘要的 system prompt（plan26 D-080）——独立常量，单测断言内容（防悄悄改坏）。
 * 要点：只输出摘要本身（无前后缀/无解释）；保留事实与决定（尤其"已决定/已否决"）；宁短勿编。
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '你是一个对话压缩器。把给定对话压缩成要点摘要，供后续轮次参考。',
  '要求：',
  '1. 只输出摘要正文，不要任何前后缀、标题或解释；',
  '2. 保留：用户的目标与约束、已做出的决定（含作废的方案与原因）、关键事实与数字、未完成事项；',
  '3. 丢弃：寒暄、重复、已在结论中体现的中间过程；',
  '4. 宁短勿编：不确定的内容不要写；总长控制在 400 字以内。'
].join('\n')

/** 保留开头 system 与末尾 keepRecent 条，中段合并为一条摘要占位；不调模型，只做确定性裁剪 */
export function trimMessages(messages: AgentMessage[], opts: TrimOptions): TrimResult {
  const threshold = opts.thresholdRatio ?? 0.75
  const keepRecent = Math.max(1, opts.keepRecent ?? 6)
  const budget = opts.contextWindow * threshold

  if (estimateMessagesTokens(messages) <= budget) {
    return { messages, trimmed: false, droppedCount: 0, droppedBytes: 0, dropped: [] }
  }

  const head: AgentMessage[] = []
  let rest = messages
  if (messages[0]?.role === 'system') {
    head.push(messages[0])
    rest = messages.slice(1)
  }

  // 末尾 keepRecent 条整体保留；若其中含 tool 消息，向前扩到其配对的 assistant（避免孤儿 tool_call_id）
  let tailStart = Math.max(0, rest.length - keepRecent)
  while (tailStart > 0 && rest[tailStart]!.role === 'tool') tailStart--
  const tail = rest.slice(tailStart)
  const middle = rest.slice(0, tailStart)

  if (middle.length === 0) return { messages, trimmed: false, droppedCount: 0, droppedBytes: 0, dropped: [] }

  // 模型摘要（D-080）优先；不给 = 机械占位（确定性、零模型依赖 —— fail-soft 的兜底就是它）
  const summary: AgentMessage = {
    role: 'user',
    content:
      opts.summaryText && opts.summaryText.trim().length > 0
        ? `[历史摘要] 此前的 ${middle.length} 条消息因上下文接近上限已折叠。
${opts.summaryText.trim()}`
        : `[历史摘要] 此前的 ${middle.length} 条消息因上下文接近上限已折叠。要点：${middle
            .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
            .map((m) => (m.content as string).slice(0, 120))
            .slice(-3)
            .join(' / ') || '（无文本要点）'}`
  }

  return {
    messages: [...head, summary, ...tail],
    trimmed: true,
    droppedCount: middle.length,
    droppedBytes: middle.reduce((sum, m) => sum + Buffer.byteLength(String(m.content ?? ''), 'utf8'), 0),
    dropped: middle
  }
}
