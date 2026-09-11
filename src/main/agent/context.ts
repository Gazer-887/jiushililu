import type { AgentMessage } from '@shared/agent'

// 上下文管理（P1 收官件之一）：长对话逼近上下文窗口时的历史裁剪。
// 三层策略（对应检索分级 L0 的思路）：
//   1. 只裁中段——system 与末尾 keepRecent 条永远保留（必要时向前扩到配对 assistant）
//   2. 裁掉的旧消息汇总成一条[历史摘要]占位，保住要点、释放大头
//   3. 估算用字符数分区折算（见 estimateTokens）

/**
 * token 估算（保守上限）：CJK 字符按 1 token/字计，其余按 4 字符/token。
 * 说明：早前用统一的 字符/2.5 折算，对中文严重低估（100 中文字实际≈100 token，
 * 公式只算 40），会导致裁剪触发过晚、防溢出失效——交叉验证抓出后改为分区计数。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk++ // CJK 统一表意文字 / 假名 / 全角标点区
  }
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 4)
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : ''
    const callsJson = m.tool_calls ? JSON.stringify(m.tool_calls) : ''
    return sum + estimateTokens(content) + estimateTokens(callsJson) + 4
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
