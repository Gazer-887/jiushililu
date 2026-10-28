/**
 * **流式事件的唯一发送口**（plan11 §2.1 / §2.5）：把 `conversationId` 在**构造时**闭包捕获，此后这个对象
 * 只能"带着身份"发 —— "漏带 id"不是"要小心"，而是**发不出来**。（"每次 send 都别忘了带 id"这种靠人记的
 * 约定审查已证明守不住：提前返回的分支最容易被漏。）
 * 两条守卫（`tests/unit/stream-envelope.test.ts`）：① 主进程里只有本文件能引用流式通道常量；
 * ② `main/ipc.ts` 里一个裸 `.send(` 都不许有。
 *
 * **例外**（进程级通道，理由必须写在这儿，不许靠"扫不到"蒙混）：`bg:changed` 是"系统里在跑什么命令"，
 * `terminal:data` / `terminal:state` 是**这个工作区**的终端 —— 它们本来就跨会话可见，塞进某条会话的信封里
 * 没有意义（终端载荷带 `sessionId` 供渲染端分辨帧）。豁免登记在测试的 `EXEMPT_CONSTS`，那里有断言
 * 盯着"**每个豁免项旁边都写了理由**"。
 */
import type { WebContents } from 'electron'
import { IPC, type ChatErrorDetails, type ChatErrorPayload, type PlanApprovalRequest, type StreamEnvelope, type ToolConfirmRequest } from '@shared/ipc'
import type { RunTerminal } from '@shared/execution-outcome'
import type { AskRequest } from '@shared/ask'
import type { ToolEvent } from '@shared/agent'
import type { TodoItem } from '@shared/todo'
import type { Goal } from '@shared/goal'
import type { SubagentJobEvent } from '@shared/agent'
import type { TokenUsage } from '@shared/usage'
import type { TokenSaverTier } from '@shared/token-tier'
import type { RequestPolicySnapshot, ServiceTierObservation } from '@shared/request-policy'

/** 允许出现在这一层的通道（类型上收口：别的通道想从这儿发也发不出去） */
type StreamChannel =
  | typeof IPC.chatChunk
  | typeof IPC.chatReasoning
  | typeof IPC.chatTool
  | typeof IPC.chatDone
  | typeof IPC.chatError
  | typeof IPC.todoChanged
  | typeof IPC.goalChanged
  | typeof IPC.subagentChanged
  | typeof IPC.checkpointChanged
  | typeof IPC.askRequest

export interface ChatEmitter {
  chunk(delta: string): void
  reasoning(delta: string): void
  tool(evt: ToolEvent): void
  todos(todos: TodoItem[]): void
  /** Agent 自建了一条目标（plan12 ⑤）—— 单条推，界面并入当前会话的列表 */
  goal(goal: Goal): void
  subagents(list: SubagentJobEvent[]): void
  checkpoint(runId: string): void
  /**
   * 收尾，**带上本轮真实用量**（plan8 R9）：`null` = 厂商没报（界面显示占用估算，不假装知道精确值）。
   * `avoided`（R9.1）= 本轮工具输出窗口化省下的估算 token：它与 `usage` 是两笔账（本地估算 vs 厂商
   * 真值），故**分开传**；`tier` = 这一轮用的省 token 档位 —— 用户定调第 4 条：计量必须记下这轮用的哪一档，
   * 否则事后按档位比数字时说不清"这个数是在哪档下跑出来的"。
   */
  done(
    usage: TokenUsage | null,
    avoided?: number,
    tier?: TokenSaverTier,
    memoryTokens?: number,
    usageComplete?: boolean,
    terminal?: RunTerminal,
    /** S3-30E：只传真实观测（observed=true）；不传 = 本次没有可披露的档位事实 */
    serviceTier?: ServiceTierObservation
  ): void
  /** E26a：`details` 缺省 = 旧字符串路径；有 details 才发结构化 `ChatErrorPayload`。 */
  error(message: string, details?: ChatErrorDetails): void
  /** 危险操作确认（也带会话身份 —— 用户要知道是**哪条会话**在问） */
  confirm(req: ToolConfirmRequest): void
  /** Agent 提问（同确认：带会话身份 —— 用户要知道自己在答**哪条会话**的问题） */
  ask(req: AskRequest): void
  /** 计划批准（plan27）：planner 出完方案后问「要不要执行」。同确认/提问 —— 必须带会话身份，否则并发时用户会批了另一条会话的方案 */
  planApproval(req: PlanApprovalRequest): void
  /** 预览用：这条 emitter 属于哪条会话 */
  readonly conversationId: string
}

/**
 * 造一个"绑定到某条会话 + 某个窗口"的发送器：`conversationId` 只在这里进闭包，之后所有发送自动带上它。
 * 第三 / 第四参数可选：本地轮次身份与本 run 冻结策略，仅在提供时写进信封；旧双参调用方形状不变。
 */
export function createChatEmitter(
  win: WebContents,
  conversationId: string,
  requestId?: string,
  requestPolicy?: Readonly<RequestPolicySnapshot>
): ChatEmitter {
  // ⚠️ 只有显式提供本地身份才附加字段：后台待办 / 检查点等旧调用者不得被绑到某次聊天轮
  const identity: { requestId?: string; requestPolicy?: Readonly<RequestPolicySnapshot> } =
    requestId !== undefined ? { requestId, ...(requestPolicy ? { requestPolicy } : {}) } : {}
  const send = <T>(channel: StreamChannel, payload: T): void => {
    // 窗口可能已经关了（用户中途关窗）—— 静默跳过，绝不因为发不出去而炸掉这一轮
    if (win.isDestroyed()) return
    const envelope: StreamEnvelope<T> = { conversationId, payload, ...identity }
    win.send(channel, envelope)
  }

  /**
   * E26a 单结算：done 与 error 争用同一个出口，先到者生效；后续调用直接丢弃。
   * chunk/tool 等过程事件不受影响，只锁终止事件。
   */
  let settled = false
  const settle = <T>(channel: StreamChannel, payload: T): void => {
    if (settled) return
    settled = true
    send(channel, payload)
  }

  return {
    conversationId,
    chunk: (delta) => send(IPC.chatChunk, delta),
    reasoning: (delta) => send(IPC.chatReasoning, delta),
    tool: (evt) => send(IPC.chatTool, evt),
    todos: (todos) => send(IPC.todoChanged, todos),
    goal: (goal) => send(IPC.goalChanged, goal),
    subagents: (list) => send(IPC.subagentChanged, list),
    checkpoint: (runId) => send(IPC.checkpointChanged, runId),
    done: (usage, avoided = 0, tier, memoryTokens, usageComplete, terminal, serviceTier) =>
      settle(IPC.chatDone, {
        usage,
        avoided,
        ...(usageComplete !== undefined ? { usageComplete } : {}),
        // 注入税（plan19 §5.2）：**本地估算**，只在真有记忆段时才带 —— 没有就不带，界面也就不显示
        ...(memoryTokens && memoryTokens > 0 ? { memoryTokens } : {}),
        ...(tier ? { tier } : {}),
        ...(terminal ? { terminal } : {}),
        // S3-30E：只带真实回值；缺报（observed=false）与旧调用者都不带，不补默认
        ...(serviceTier && serviceTier.observed === true ? { serviceTier } : {})
      }),
    error: (message, details) => {
      if (!details) {
        settle(IPC.chatError, message)
        return
      }
      const payload: ChatErrorPayload = {
        message,
        terminal: details.terminal,
        usage: details.usage,
        usageComplete: details.usageComplete,
        // 未知就不带：不造 0、不造默认档（合同 V2 §3.2）
        ...(details.avoided !== undefined ? { avoided: details.avoided } : {}),
        ...(details.tier ? { tier: details.tier } : {}),
        ...(details.memoryTokens && details.memoryTokens > 0 ? { memoryTokens: details.memoryTokens } : {}),
        // S3-30E：失败前已观测的真实档位才带；未知不带（单结算语义不变）
        ...(details.serviceTier && details.serviceTier.observed === true
          ? { serviceTier: details.serviceTier }
          : {})
      }
      settle(IPC.chatError, payload)
    },
    confirm: (req) => {
      if (win.isDestroyed()) return
      win.send(IPC.confirmRequest, { ...req, conversationId })
    },
    ask: (req) => {
      if (win.isDestroyed()) return
      // `conversationId` 通常已由 Agent 那一侧补上；缺了就补 emitter 的 —— 两种都留空是**查不出**这条问题出自哪条会话的
      win.send(IPC.askRequest, { ...req, conversationId: req.conversationId || conversationId })
    },
    planApproval: (req) => {
      if (win.isDestroyed()) return
      // 同 ask：`conversationId` 走载荷（不只在信封里），缺了补 emitter 的
      win.send(IPC.planApprovalRequest, { ...req, conversationId: req.conversationId || conversationId })
    }
  }
}
