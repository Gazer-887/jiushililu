import type { AgentChatResult, AgentMessage, AgentLoopResult, AgentTool, ToolEvent } from '@shared/agent'
import { toolCallDetail } from '@shared/tool-detail'
import { windowToolOutput } from '@shared/tool-window'
import { createLogger } from '../log'
import { DEFAULT_TOKEN_TIER, resolvePolicy, type TokenPolicy } from '@shared/token-tier'
import { trimMessages, type TrimOptions } from './context'

// Agent 主循环（plan6；D-032 流式化）：模型 → 工具调用 → 结果回灌 → 循环，直到出最终答案或预算耗尽。
// 缰绳：maxRounds 是硬上限（D5 决策），卡死必须能停；contextWindow 控历史裁剪。
// plan8 R9.1：窗口化只挂在**结果回灌这一处** —— 它是唯一入口，挂两处迟早漏一处（踩过）。

/**
 * **自己管好输出的工具**：不给窗口化再加工 —— `read_file` 已按行窗口给过并如实告知，
 * 再压一次等于把「第 1–200 行」砍成「头 60 尾 40」，而模型要的正是那 200 行。
 * 判据挂在**工具名**上而不是"看输出像不像"——"像不像"迟早会判错。
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
  /** 模型通道（注入式依赖）：streaming 时把文本增量喂给 onText，返回累积后的完整结果 */
  chat(messages: AgentMessage[], onText: (delta: string) => void): Promise<AgentChatResult>
  /** 文本增量回调（流式上屏）；不传则忽略 */
  onText?: (delta: string) => void
  /**
   * 是否启用工具输出窗口化（plan8 R9.1），默认**开**。留开关是为了效果能被 A/B 量出来
   * （同一段任务开/关各跑一遍比 usage）；排查"模型没看见原文"时也靠它先关掉再复现。
   */
  toolWindow?: boolean
  /**
   * 省 token 档位解析出的开关（plan8 R9.1 §七②）。**调用方只给 policy、不认识档位名**，
   * 加档 / 改取值只动 `@shared/token-tier`；不给 = 平衡档（与改造前一致）。
   */
  policy?: TokenPolicy
  /** 工具执行生命周期（界面显示"正在读 xx / 完成 / 失败"） */
  onToolEvent?: (evt: ToolEvent) => void
  /**
   * 工具输出被窗口化时回调（plan8 R9.1）。压缩**不许静默**：界面那条痕是内存态、
   * 会随重挂载丢，所以还得有一条能事后追的（主进程日志由调用方接上）。
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

/** 主循环的日志器（§七④：像"前缀缓存失效"这类**值得但必须知情**的代价要留痕） */
const log = createLogger('agent-loop')

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
  /**
   * 省 token 档位（§七②）：不给就是平衡档。
   *
   * ⚠️ `toolWindow: false` **压过**档位 —— 两者不是一回事：那是校准脚本要的"**这一轮**强行原样"
   * （一次实验），档位是"**用户长期**要不要省"（一个偏好）；混成一个就说不清"为什么没压"。
   */
  const policy = opts.policy ?? resolvePolicy(DEFAULT_TOKEN_TIER)
  /** 窗口化总开关：档位说关就关（土豪档），或被校准时强行关掉 */
  const windowEnabled = opts.toolWindow === false ? false : policy.windowEnabled
  /** 这一轮靠窗口化省下的估算 token（plan8 R9.1 记账用） */
  let avoidedTokens = 0

  for (;;) {
    if (rounds >= maxRounds) {
      return { output: lastText, rounds, stopReason: 'max-rounds', avoidedTokens }
    }
    rounds++

    // 每轮调用模型前按需裁剪（只有给了 contextWindow 才启用）
    const trimOpts: TrimOptions | null = opts.contextWindow ? { contextWindow: opts.contextWindow } : null
    let sent = messages
    if (trimOpts) {
      const trim = trimMessages(messages, trimOpts)
      sent = trim.messages
      /**
       * ⚠️ **前缀稳定的已知破坏点**（plan8 R9.1 §七④）：折叠会在**中间**插一条「[历史摘要]」，
       * 而前缀缓存要求"开头一模一样" —— 从摘要往后**缓存全部失效**（本轮输入 token 明显偏高）。
       * 这是**值得的代价**（不折叠就撞上下文上限、整轮作废），但必须是**知情的代价**，故在此留痕。
       */
      if (trim.trimmed) {
        log.info('历史已折叠：前缀缓存将从摘要处失效', { 折叠条数: trim.droppedCount, 轮次: rounds })
      }
    }

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
      // 带上「这一步在干什么」（从入参提取），否则界面只能显示干巴巴的「执行中…」
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

      // 窗口化（plan8 R9.1）：留头尾 + 中段按行号采样 + 报错现场保护；双门控不过就原样放行
      let saved = 0
      if (windowEnabled && !SELF_MANAGED_TOOLS.has(tc.name)) {
        // 档位（§七②）只调**三个数**：进判断的门槛、相对门、绝对预算 ——
        // 头尾行数、采样条数不随档位变，三条红线（不静默 / 不压报错现场 / 不伪造）正挂在它们上。
        const w = windowToolOutput(output, {
          toolName: tc.name,
          minBytes: policy.minBytes,
          keepRatioMax: policy.keepRatioMax,
          maxTokens: policy.maxTokens
        })
        // **静默是禁止的**：每次成形都要留痕（界面 + 主进程日志两处）。
        // `small` = 压根没进判断，报它等于刷日志
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
