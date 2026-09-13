import type { TokenUsage } from './usage'

// Agent 内核共享类型（plan6 D1-D8）：工具、消息、循环结果。
// 协议采用 OpenAI tool-calls 格式（DeepSeek 全系原生兼容）。

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentTool {
  schema: ToolSchema
  /** 返回值是给模型看的文本：错误也走文本回，让模型自行纠正 */
  execute(args: Record<string, unknown>): Promise<string>
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** 流式增量累积后的成品 */
export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串：保持原样透传，避免二次序列化误差 */
  arguments: string
}

export interface AgentChatResult {
  text: string | null
  toolCalls: ToolCall[]
  /** 这一轮的真实用量（plan8 R9）；厂商不报就没有这个字段——上层据此决定用真值还是退回估算 */
  usage?: TokenUsage
}

export interface ToolEvent {
  id: string
  name: string
  phase: 'start' | 'error' | 'end'
  /** 从入参提取的一句人话——只有工具名时，界面只能显示干巴巴的「执行中…」 */
  detail?: string
  /** phase=end/error 时的结果摘要（已截断） */
  summary?: string
  /** 这一步输出被窗口化时省下的估算 token：用户看得见"它压了"，才有依据判断活会不会变糊 */
  savedTokens?: number
}

export type AgentStopReason = 'completed' | 'max-rounds'

/** 子代理运行事件（plan7 批 D 右栏「任务」页签）：光有最终结果不够——开始/结束各报一次，界面才有"进行中"可言 */
export interface SubagentJobEvent {
  /** 同一次 spawn 调用起的子代理归到一组 */
  runId: string
  name: string
  index: number
  phase: 'start' | 'end' | 'error'
  /** 已截断，界面只显示一行 */
  task: string
  startedAt: number
  endedAt?: number
  /** 跑了几个工具轮（仅 end 时有意义） */
  rounds?: number
  summary?: string
  error?: string
}

export interface AgentLoopResult {
  /** 模型最后一次的文本回复；超预算时为最后一次已知文本 */
  output: string
  rounds: number
  stopReason: AgentStopReason
  /**
   * 这一轮**避免进入上下文的 token**（plan8 R9.1）。⚠️ 本地估算，与厂商真报的 `usage` 是两笔账，
   * 故单独一个字段、绝不并进 `TokenUsage`；`0` = 这一轮没压（工具输出都不大，属正常）。
   */
  avoidedTokens?: number
}
