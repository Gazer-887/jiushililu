import type { AgentMessage } from '@shared/agent'
import { estimateMessageTokens, estimateTokens } from '@shared/tokens'

// 上下文管理（P1 收官件之一）：长对话逼近上下文窗口时的历史裁剪。
// 三层策略（对应检索分级 L0 的思路）：
//   1. 只裁中段——system 与末尾 keepRecent 条永远保留（必要时向前扩到配对 assistant）
//   2. 裁掉的旧消息汇总成一条[历史摘要]占位，保住要点、释放大头
//   3. 估算口径见 @shared/tokens（主/渲染共用同一份算法）

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
}

export interface TrimResult {
  messages: AgentMessage[]
  trimmed: boolean
  /** 被裁掉的消息条数（用于给用户提示与 ACE 复盘） */
  droppedCount: number
}

/**
 * 需要时裁剪历史：保留开头的 system 与末尾 keepRecent 条，中段合并为一条摘要占位。
 * 不做模型调用（摘要由模型在后续轮次自然补全），只做确定性裁剪——P1 保持零副作用。
 */
export function trimMessages(messages: AgentMessage[], opts: TrimOptions): TrimResult {
  const threshold = opts.thresholdRatio ?? 0.75
  const keepRecent = Math.max(1, opts.keepRecent ?? 6)
  const budget = opts.contextWindow * threshold

  if (estimateMessagesTokens(messages) <= budget) {
    return { messages, trimmed: false, droppedCount: 0 }
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

  if (middle.length === 0) return { messages, trimmed: false, droppedCount: 0 }

  const summary: AgentMessage = {
    role: 'user',
    content: `[历史摘要] 此前的 ${middle.length} 条消息因上下文接近上限已折叠。要点：${middle
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
      .map((m) => (m.content as string).slice(0, 120))
      .slice(-3)
      .join(' / ') || '（无文本要点）'}`
  }

  return {
    messages: [...head, summary, ...tail],
    trimmed: true,
    droppedCount: middle.length
  }
}
