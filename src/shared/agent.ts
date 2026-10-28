import type { TokenUsage } from './usage'
import type { WirePart } from './content-parts'
import type { OutcomeCode, RunTerminal, ToolResultState } from './execution-outcome'
import type { TokenSaverTier } from './token-tier'
import type { RequestPolicySnapshot } from './request-policy'

// Agent 内核共享类型（plan6 D1-D8）：工具、消息、循环结果。
// 协议采用 OpenAI tool-calls 格式（DeepSeek 全系原生兼容）。

/**
 * **run 级不可变请求策略**（S3-20D1）：一次 run 只解析一次并冻结，主循环与全部子代理共享同一引用。
 * ⚠️ 只是命名合同：枚举与解析逻辑的唯一真源是 `request-policy.ts`，本文件不得复制任一取值或分支。
 */
export type RunRequestPolicy = Readonly<RequestPolicySnapshot>

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * 可信内建读取的私有暂存（S3-40B）：结果与版本 receipt 在 commit 前都不产生写资格。
 * ⚠️ 只有真实内建 read_file 对象可实现；loop 按**对象身份**判定，不信工具名或 readOnly 自述。
 */
export interface StagedToolRead {
  /** 已成形、可直接回灌模型的文本（成功或错误） */
  text: string
  /** 读取被接受（成功才可能有 receipt） */
  ok: boolean
  /** 版本 receipt：commit 前不写 revisions，discard 时与结果一起丢；key 是唯一 canonical 版本键 */
  receipt: { readonly abs: string; readonly revision: string; readonly key: string } | null
  /** realpath 规范化身份键；null = 无法确认（整批按串行处理） */
  key: string | null
  /** 异步准备后守卫失效：本项未读取、不得提交 */
  blocked?: boolean
}

export interface TrustedReadCapability {
  /** 解析同一文件的规范化身份键；不确定一律回 null */
  canonicalKey(args: Record<string, unknown>): Promise<string | null>
  /** 只暂存结果与 receipt；真正读盘前再核 canStart */
  stage(args: Record<string, unknown>, signal?: AbortSignal, canStart?: () => boolean): Promise<StagedToolRead>
  /** 与结果同一同步门提交：只有这里才登记读版本 */
  commit(staged: StagedToolRead): string
  /** 丢弃结果与 receipt（不碰 revisions） */
  discard(staged: StagedToolRead): void
}

/**
 * Run 级权限/活性守卫（S3-40C2）：父 run 与每个子 run 共用同一份冻结起点与权威来源，
 * 但**各自持有观察状态**——兄弟子 run 不许互相污染已观察到的收紧档位。
 * 同步返回 false 或抛错即拒绝；调用方不得把“用户已批准”当作权限未变的证据。
 */
export interface RunPermissionGuard {
  /** 每项工具真实启动前、异步准备后的读盘前调用；可带实际工具名。 */
  canStart(toolName?: string): boolean
  /** 可信读取的提交门前置：代次变化一律拒绝。 */
  canCommit(): boolean
}

export interface AgentTool {
  schema: ToolSchema
  /**
   * 返回值是**给模型看的文本**：错误也走文本回，让模型自行纠正。
   * `ToolOutcome` 那一支只给需要交图的工具（plan44 S2b）；其余工具返 string，一个字都不用改。
   */
  execute(args: Record<string, unknown>): Promise<string | ToolOutcome>
  /** 本次实际成功落盘的文件，由生产工具提供；不从模型宣称路径推导。读取即消费。 */
  takeProducedFiles?: (args: Record<string, unknown>) => string[]
  /**
   * 可信读取能力（S3-40B）：只有真实内建 read_file 对象会挂它。
   * ⚠️ 它是对象身份而不是名字合同；同名 MCP/插件工具不得被当作它。
   */
  trustedRead?: TrustedReadCapability
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
  usage?: TokenUsage | null
  /**
   * 这一笔用量报告**是否完整**（真实终态合同 §四）。
   * ⚠️ 与「本轮成功/失败」相互独立：已拿到完整有效报告后发生业务截断，这里仍是 `true`；
   * 只有阶段输入或缺少最终输出时才不能自称完整。缺失 ≠ false，未观测就不写这一位。
   */
  usageComplete?: boolean
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
  /**
   * 本步产出的**文件路径**（plan74 Agent 产物入口）：从工具真实入参提取的工作区相对路径
   * （如 write_file 的 path），**不是**从 detail 文本正则猜的 —— 后者会把模型随口写的字符串
   * 当成可读路径（正是计划警告的"不信模型宣称路径"）。界面据此渲染可就地预览的产物卡，
   * 读的是所属会话原工作区的当前文件。仅写/建类工具有；其余为空。
   */
  artifactPaths?: string[]
  /**
   * 结构化执行结果（E24a）：**结构优先于文字**，界面与存档据此展示真实状态。
   * ⚠️ `phase` 保持旧三值不变；`outcome` 才是细分（failed/cancelled/denied/unknown 都走 phase=error）。
   * 老事件不填 ⇒ 沿用旧判据，不推断「肯定成功」。
   */
  outcome?: ToolResultState
  /** 固定原因码；只在真实观测到时出现。 */
  code?: OutcomeCode
  /** 命令的可信退出码；`null` = 无可信退出码（unknown），与明确 0 是两回事。 */
  exitCode?: number | null
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
 * 只有需要交图的那个通路返回结构体 —— 改全体签名会把"加缩略图"变成动工具契约。
 */
export interface ToolOutcome {
  text: string
  images?: ToolImageRef[]
  /**
   * 交给模型的图片（plan57 K52 B2，opt-in，默认关）。
   * `images` 只进界面事件（plan44 S2b 意图不变）；要模型**看见**图，必须走这一位 ——
   * loop 把它挂到 tool 消息的 parts 上随下轮请求出境，用后即 strip（同文件 `stripForwardedImageParts`，
   * 见 loop.ts），不让 base64 在历史里每轮重放（Kiro 事故：整段会话被一张图卡死）。
   * MCP 等老工具不填这位 ⇒ 行为与从前逐字一致。
   */
  forwardImagesToModel?: Array<{ mime: string; ref: string; base64: string }>
  /**
   * 结构化执行结果（E24a）。**结构优先于文字**：有本字段就不再靠文本正则判状态。
   * 老工具不填 ⇒ 行为与从前逐字一致。
   */
  outcome?: ToolResultState
  /** 固定原因码；只在真实观测到时出现，不补默认值。 */
  code?: OutcomeCode
  /**
   * 命令的**可信退出码**。`null` = 无可信退出码（被信号杀死/超时/超限/启动失败），
   * 与「明确报 0」是两回事 —— 前者是 unknown，后者是成功。
   */
  exitCode?: number | null
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
  terminal?: RunTerminal
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
  /**
   * 本轮结算终态（真实终态合同 §四）。可选：旧调用方不填即沿用 `stopReason` 粗判。
   * ⚠️ 有它时**以它为准** —— `stopReason` 表达不了 truncated / denied / unknown。
   */
  terminal?: RunTerminal
  /**
   * 本轮整笔用量报告是否完整。语义同 `AgentChatResult.usageComplete`：
   * 与终态成功/失败独立，未观测就不写。
   */
  usageComplete?: boolean
  /** 本轮生效的省 token 档位（真实观测才写；未观测省略，不填默认档）。 */
  tokenTier?: TokenSaverTier
}
