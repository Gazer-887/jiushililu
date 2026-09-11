import type { AgentChatResult, AgentMessage, AgentLoopResult, AgentTool, ToolEvent } from '@shared/agent'
import { trimMessages, type TrimOptions } from './context'

// Agent 主循环（plan6 → P1；D-032 流式化）：模型 → 工具调用 → 结果回灌 → 循环，
// 直到模型给出最终答案或预算耗尽。
// 缰绳：maxRounds 是硬上限（D5 决策），卡死必须能停；contextWindow 控上下文裁剪。

export interface AgentLoopOptions {
  systemPrompt: string
  /** 对话历史（不含 system；本循环在最前面补 system）。D-032：带完整历史，多轮有记忆 */
  history: AgentMessage[]
  tools: AgentTool[]
  /** 轮数硬上限（默认 12）：一轮 = 一次模型调用 + 其工具执行 */
  maxRounds?: number
  /** 上下文窗口（token）；给了才启用历史裁剪 */
  contextWindow?: number
  /**
   * 模型通道（注入式依赖）：
   * streaming=true 时实现方应把文本增量喂给 onText；返回累积后的完整结果。
   */
  chat(messages: AgentMessage[], onText: (delta: string) => void): Promise<AgentChatResult>
  /** 文本增量回调（流式上屏）；不传则忽略 */
  onText?: (delta: string) => void
  /** 工具执行生命周期（界面显示"正在读 xx / 完成 / 失败"） */
  onToolEvent?: (evt: ToolEvent) => void
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

/** 结果摘要（界面显示用）：折叠空白 + 截断 */
function summarize(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 12)
  const toolMap = new Map(opts.tools.map((t) => [t.schema.name, t]))
  const messages: AgentMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    ...opts.history
  ]

  const emitText = (delta: string): void => opts.onText?.(delta)

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

    const res = await opts.chat(sent, emitText)
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
      opts.onToolEvent?.({ id: tc.id, name: tc.name, phase: 'start' })

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

      const failed = output.startsWith('错误')
      opts.onToolEvent?.({
        id: tc.id,
        name: tc.name,
        phase: failed ? 'error' : 'end',
        summary: summarize(output)
      })

      // 注入边界标记：工具产出（文件内容/网页/命令输出）一律是**数据**，不是指令
      messages.push({
        role: 'tool',
        content: `<tool_output name="${tc.name}">\n${output}\n</tool_output>`,
        tool_call_id: tc.id
      })
    }
  }
}
