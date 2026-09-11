// Agent 内核共享类型（P1，plan6 拍板：D1-D8）——工具、消息、循环结果。
// 协议采用 OpenAI tool-calls 格式（DeepSeek / V4 全系原生兼容）。

/** 工具的定义（发给模型的 JSON Schema） */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>
}

/** 一个可执行的工具 = 定义 + 执行器 */
export interface AgentTool {
  schema: ToolSchema
  /** 执行工具；返回值是给模型看的文本结果（错误也用文本回，让模型自行纠正） */
  execute(args: Record<string, unknown>): Promise<string>
}

/** Agent 循环中的消息（在 ChatMessage 基础上扩展 tool 角色） */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** 模型请求调用一个工具（流式累积后的成品） */
export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串（与 OpenAI 协议一致，保持原样以免二次序列化误差） */
  arguments: string
}

/** 模型一轮对话的产出：文本回复与/或工具调用请求 */
export interface AgentChatResult {
  text: string | null
  toolCalls: ToolCall[]
}

/** 工具执行的生命周期事件（供界面显示"正在读 xx / 完成 / 失败"） */
export interface ToolEvent {
  id: string
  name: string
  phase: 'start' | 'end' | 'error'
  /** phase=end/error 时的结果摘要（已截断，供界面显示） */
  summary?: string
}

export type AgentStopReason = 'completed' | 'max-rounds'

/**
 * 子代理运行事件（plan7 批 D：右栏「任务」页签要显示"谁在跑、跑了几轮、结果如何"）。
 * 光有最终结果数组不够 —— 得在开始/结束时各报一次，界面才有"进行中"可言。
 */
export interface SubagentJobEvent {
  /** 一次 spawn 调用 = 一个 runId，同批的子代理归到一组 */
  runId: string
  /** 子代理定义名 */
  name: string
  /** 在本次批次里的序号 */
  index: number
  phase: 'start' | 'end' | 'error'
  /** 派给它的任务（已截断，界面显示一行） */
  task: string
  startedAt: number
  endedAt?: number
  /** 跑了几个工具轮（仅 end 时有意义） */
  rounds?: number
  /** 结果摘要（已截断） */
  summary?: string
  error?: string
}

export interface AgentLoopResult {
  /** 最终文本输出（模型最后一次的文本回复；超预算时为最后一次已知文本） */
  output: string
  rounds: number
  stopReason: AgentStopReason
}
