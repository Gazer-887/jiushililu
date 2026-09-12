import type { AgentChatResult, AgentMessage, AgentLoopResult, AgentTool, ToolEvent } from '@shared/agent'
import { toolCallDetail } from '@shared/tool-detail'
import { windowToolOutput } from '@shared/tool-window'
import { trimMessages, type TrimOptions } from './context'

// Agent 主循环（plan6 → P1；D-032 流式化）：模型 → 工具调用 → 结果回灌 → 循环，
// 直到模型给出最终答案或预算耗尽。
// 缰绳：maxRounds 是硬上限（D5 决策），卡死必须能停；contextWindow 控上下文裁剪。
//
// plan8 R9.1：工具结果在**回灌那一处**过一道窗口化 —— 这里是**唯一**的入口，
// 所以也是唯一需要挂的地方（挂两处迟早会漏一处，这是本项目踩过的老坑）。

/**
 * **自己管好输出的工具**：不给窗口化再加工。
 *
 * - `read_file` 已经按行窗口给了、末尾如实告知了 —— 再压一次等于二次伤害
 *   （把"第 1–200 行"再砍成"头 60 尾 40"，而模型明确要的就是那 200 行）。
 * - 前辈实现里也有同款豁免（"read 工具输出永不处理"），不是我们独有。
 *
 * 判据写在**工具名**上而不是"看输出像不像"，因为"像不像"迟早会判错。
 */
const SELF_MANAGED_TOOLS = new Set(['read_file'])

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
  /**
   * 是否启用工具输出窗口化（plan8 R9.1）。默认 **开**。
   *
   * 为什么要有个开关：这套东西的效果**必须能被 A/B 量出来**（同一段任务开/关各跑一遍，
   * 比厂商真报的 usage 与成败率）—— 没有开关的优化只能靠信仰。
   * 另外它也是排查手段：怀疑"模型没看见原文"时，先关掉它再复现一次。
   */
  toolWindow?: boolean
  /** 工具执行生命周期（界面显示"正在读 xx / 完成 / 失败"） */
  onToolEvent?: (evt: ToolEvent) => void
  /**
   * 工具输出被窗口化时回调（plan8 R9.1）。
   *
   * 存在的理由：压缩**不许静默**。界面那条痕是内存态、会随重挂载丢，
   * 所以还得有一条能事后追的（主进程日志由调用方接上）。
   */
  onToolWindowed?: (info: { name: string; beforeTokens: number; afterTokens: number; reason: string }) => void
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
  /** 窗口化总开关（默认开；关掉时一切原样 —— 校准用） */
  const windowEnabled = opts.toolWindow !== false
  /** 这一轮靠窗口化省下的估算 token（plan8 R9.1 记账用） */
  let avoidedTokens = 0

  for (;;) {
    if (rounds >= maxRounds) {
      return { output: lastText, rounds, stopReason: 'max-rounds', avoidedTokens }
    }
    rounds++

    // 每轮调用模型前按需裁剪（只有给了 contextWindow 才启用）
    const trimOpts: TrimOptions | null = opts.contextWindow ? { contextWindow: opts.contextWindow } : null
    const sent = trimOpts ? trimMessages(messages, trimOpts).messages : messages

    const res = await opts.chat(sent, emitText)
    if (res.text) lastText = res.text

    // 没有工具调用 = 模型认为任务完成，文本即最终交付
    if (res.toolCalls.length === 0) {
      return { output: res.text ?? '', rounds, stopReason: 'completed', avoidedTokens }
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
      // 带上「这一步在干什么」（从入参提取）——
      // 否则界面只能显示干巴巴的「执行中…」，用户看不出它在读哪个文件、跑哪条命令
      opts.onToolEvent?.({
        id: tc.id,
        name: tc.name,
        phase: 'start',
        detail: toolCallDetail(tc.name, tc.arguments)
      })

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

      // 窗口化（plan8 R9.1）：输出去大时留头尾 + 中段按行号采样 + 报错现场保护，
      // 双门控不过就**原样放行**（`windowToolOutput` 自己保证"不压也不亏"）。
      let saved = 0
      if (windowEnabled && !SELF_MANAGED_TOOLS.has(tc.name)) {
        const w = windowToolOutput(output, { toolName: tc.name })
        // **静默是禁止的**：每一次成形都要留下痕迹（界面 + 主进程日志两处）。
        // 只在"确实够大、值得一记"时报（`small` = 这条输出压根没进入判断，报它等于刷日志）
        if (w.reason !== 'small') {
          opts.onToolWindowed?.({
            name: tc.name,
            beforeTokens: w.beforeTokens,
            afterTokens: w.afterTokens,
            reason: w.reason
          })
        }
        if (w.compressed) {
          saved = w.beforeTokens - w.afterTokens
          avoidedTokens += saved
          output = w.text
        }
      }

      const failed = output.startsWith('错误')
      opts.onToolEvent?.({
        id: tc.id,
        name: tc.name,
        phase: failed ? 'error' : 'end',
        summary: summarize(output),
        ...(saved > 0 ? { savedTokens: saved } : {})
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
