/**
 * **流式事件的唯一发送口**（plan11 §2.1 / §2.5）。
 *
 * ## 为什么要有这个文件
 *
 * 并发的前提是"每条事件都知道自己属于哪一轮跑"。做法有两种：
 *
 * - ❌ **靠人记**：每次 `webContents.send(channel, payload)` 都别忘了带上 `conversationId`。
 *   审查已经证明这种"约定"守不住 —— 现有 10 处发送里有 4 处是**提前返回**的
 *   （"已在跑 / 没配模型 / 没存 Key"），最容易被漏的恰恰是这些不常走的分支。
 * - ✅ **靠结构**：把 `conversationId` 在**构造时**闭包捕获，之后这个对象只能"带着身份"发。
 *   于是"漏带 id"不是"要小心"，而是**发不出来**。
 *
 * 配套两条守卫（`tests/unit/stream-envelope.test.ts`，可判定、不依赖排版）：
 *   ① 主进程里**只有本文件**能引用流式通道常量（其它文件出现即红）；
 *   ② `main/ipc.ts` 里**一个裸 `.send(` 都不许有**。
 *
 * ## 唯一的例外
 *
 * `bg:changed`（后台命令清单）是**进程级**状态 —— "系统里在跑什么命令"本来就跨会话可见，
 * 它不该被塞进"某条会话"的信封里（plan11 §2.3 的取舍）。所以它不在这里发。
 */
import type { WebContents } from 'electron'
import { IPC, type StreamEnvelope, type ToolConfirmRequest } from '@shared/ipc'
import type { ToolEvent } from '@shared/agent'
import type { TodoItem } from '@shared/todo'
import type { SubagentJobEvent } from '@shared/agent'
import type { TokenUsage } from '@shared/usage'
import type { TokenSaverTier } from '@shared/token-tier'

/** 允许出现在这一层的通道（类型上收口：别的通道想从这儿发也发不出去） */
type StreamChannel =
  | typeof IPC.chatChunk
  | typeof IPC.chatReasoning
  | typeof IPC.chatTool
  | typeof IPC.chatDone
  | typeof IPC.chatError
  | typeof IPC.todoChanged
  | typeof IPC.subagentChanged
  | typeof IPC.checkpointChanged

export interface ChatEmitter {
  chunk(delta: string): void
  reasoning(delta: string): void
  tool(evt: ToolEvent): void
  todos(todos: TodoItem[]): void
  subagents(list: SubagentJobEvent[]): void
  checkpoint(runId: string): void
  /**
   * 收尾，**带上本轮真实用量**（plan8 R9）—— 界面据此显示"这轮花了多少"。
   * `null` = 厂商没报（界面显示占用估算，不假装知道精确值）。
   *
   * `avoided`（plan8 R9.1）= 本轮工具输出窗口化**省下的估算 token**（没省就是 0）。
   * 它跟 `usage` 是两笔账（本地估算 vs 厂商真值），所以**分开传**，界面也分开显示。
   *
   * `tier`（plan8 R9.1 §七②）= **这一轮用的省 token 档位**。
   * 用户定调第 4 条：**计量必须记下这轮用的哪一档** —— 否则事后按档位比数字时，
   * 根本说不清"这个数是在哪档下跑出来的"。
   */
  done(usage: TokenUsage | null, avoided?: number, tier?: TokenSaverTier): void
  error(message: string): void
  /** 危险操作确认（也带会话身份 —— 用户要知道是**哪条会话**在问） */
  confirm(req: ToolConfirmRequest): void
  /** 预览用：这条 emitter 属于哪条会话 */
  readonly conversationId: string
}

/**
 * 造一个"绑定到某条会话 + 某个窗口"的发送器。
 *
 * `conversationId` 只在这里出现一次（进闭包），之后所有发送自动带上它。
 */
export function createChatEmitter(win: WebContents, conversationId: string): ChatEmitter {
  const send = <T>(channel: StreamChannel, payload: T): void => {
    // 窗口可能已经关了（用户中途关窗）—— 静默跳过，绝不因为发不出去而炸掉这一轮
    if (win.isDestroyed()) return
    const envelope: StreamEnvelope<T> = { conversationId, payload }
    win.send(channel, envelope)
  }

  return {
    conversationId,
    chunk: (delta) => send(IPC.chatChunk, delta),
    reasoning: (delta) => send(IPC.chatReasoning, delta),
    tool: (evt) => send(IPC.chatTool, evt),
    todos: (todos) => send(IPC.todoChanged, todos),
    subagents: (list) => send(IPC.subagentChanged, list),
    checkpoint: (runId) => send(IPC.checkpointChanged, runId),
    done: (usage, avoided = 0, tier) =>
      send(IPC.chatDone, { usage, avoided, ...(tier ? { tier } : {}) }),
    error: (message) => send(IPC.chatError, message),
    confirm: (req) => {
      if (win.isDestroyed()) return
      win.send(IPC.confirmRequest, { ...req, conversationId })
    }
  }
}
