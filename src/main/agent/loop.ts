import type { AgentChatResult, AgentMessage, AgentLoopResult, AgentTool } from '@shared/agent'
import { trimMessages, type TrimOptions } from './context'

// Agent 主循环（plan6 → P1）：模型 → 工具调用 → 结果回灌 → 循环，直到模型给出最终答案或预算耗尽。
// 预即失控的缰绳：maxRounds 是硬上限（D5 决策），卡死必须能停。
// 上下文管理（P1 收官件）：每轮调用模型前按需裁剪历史，防止突破 contextWindow。

export interface AgentLoopOptions {
  systemPrompt: string
  userTask: string
  tools: AgentTool[]
  /** 轮数硬上限（默认 12）：一轮 = 一次模型调用 + 其工具执行 */
  maxRounds?: number
  /** 上下文窗口（token）；给了才启用历史裁剪 */
  contextWindow?: number
  /** 模型通道（注入式依赖：生产环境是 Provider 的 chatWithTools，测试用 mock） */
  chat(messages: AgentMessage[]): Promise<AgentChatResult>
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // 模型吐了非法 JSON——把原文原样交回让它看到错误，而不是静默吞掉
    return { __raw: raw }
  }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 12)
  const toolMap = new Map(opts.tools.map((t) => [t.schema.name, t]))
  const messages: AgentMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userTask }
  ]

  let lastText = ''
  let rounds = 0

  for (;;) {
    if (rounds >= maxRounds) {
      return { output: lastText, rounds, stopReason: 'max-rounds' }
    }
    rounds++

    // 每轮调用模型前按需裁剪（只有给了 contextWindow 才启用）
    const trimOpts: TrimOptions | null = opts.contextWindow ? { contextWindow: opts.contextWindow } : null
    const sent = trimOpts ? trimMessages(messages, trimOpts).messages : messages

    const res = await opts.chat(sent)
    if (res.text) lastText = res.text

    // 没有工具调用 = 模型认为任务完成，文本即最终交付
    if (res.toolCalls.length === 0) {
      return { output: res.text ?? '', rounds, stopReason: 'completed' }
    }

    // 回灌 assistant（含 tool_calls），再逐个执行并把结果以 tool 角色回灌
    messages.push({
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments }
      }))
    })

    for (const tc of res.toolCalls) {
      const tool = toolMap.get(tc.name)
      let output: string
      if (!tool) {
        output = `错误：未知工具「${tc.name}」。可用工具：${[...toolMap.keys()].join('、') || '（无）'}`
      } else {
        try {
          output = await tool.execute(parseArgs(tc.arguments))
        } catch (err) {
          output = `错误：工具执行异常——${err instanceof Error ? err.message : String(err)}`
        }
      }
      messages.push({ role: 'tool', content: output, tool_call_id: tc.id })
    }
  }
}
