import type { TokenUsage } from './usage'
import type { WirePart } from './content-parts'

// Agent 内核共享类型（plan6 D1-D8）：工具、消息、循环结果。
// 协议采用 OpenAI tool-calls 格式（DeepSeek 全系原生兼容）。

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentTool {
  schema: ToolSchema
  /**
   * 返回值是**给模型看的文本**：错误也走文本回，让模型自行纠正。
   * `ToolOutcome` 那一支只给需要交图的工具（plan44 S2b）；其余工具返 string，一个字都不用改。
   */
  execute(args: Record<string, unknown>): Promise<string | ToolOutcome>
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /**
   * 出境形态的多模态内容块（plan57 片③）：**base64 已就位**，provider 只认这个、不再碰文件系统。
   * 有它时 provider 以本字段为准，`content` 那份文本不再重复下发（两者同源，见 `ChatMessage.parts`）。
   * ⚠️ 存档里放的却是**引用**（`ContentPart`），物化发生在组合根 —— 别把 base64 写进会话存档。
   */
  parts?: WirePart[]
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
  /**
   * 这一步产出的**图片产物引用**（plan44 S2b）：只存名字/类型/大小，正文在 `mcp-artifacts/` 里。
   * ⚠️ 它属于 `segments`（本地渲染与回看资产），**不发给模型** —— 与"记忆正文不进 prompt、
   *    要细节用 recall"是同一条口径：模型不需要看见截图，用户需要。
   */
  images?: ToolImageRef[]
}

/**
 * 图片产物的引用（plan44 S2b）。
 * ⚠️ `name` 是**由主进程生成的受限文件名**，读取侧按它做白名单校验 —— 存路径等于给穿越留门。
 */
export interface ToolImageRef {
  name: string
  mime: string
  bytes: number
}

/**
 * 工具执行结果（plan44 S2b 起允许带图片）。
 * `execute` 的返回类型刻意是 `string | ToolOutcome`：**老工具一个字都不用改**，
 * 只有需要交图的那一个通路返回结构体 —— 改全体签名会把"加缩略图"变成动工具契约。
 */
export interface ToolOutcome {
  text: string
  images?: ToolImageRef[]
}

/**
 * 助手消息的时间线分段（plan36 D-100 候选）：thinking / 工具 / 正文按**真实发生顺序**排列，
 * 渲染与回顾按序交错。`content` 恒等于全部 text 段拼接（模型侧合同不变）。
 */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; event: ToolEvent }

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
