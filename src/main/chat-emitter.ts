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
import { IPC, type StreamEnvelope, type ToolConfirmRequest } from '@shared/ipc'
import type { AskRequest } from '@shared/ask'
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
  | typeof IPC.askRequest

export interface ChatEmitter {
  chunk(delta: string): void
  reasoning(delta: string): void
  tool(evt: ToolEvent): void
  todos(todos: TodoItem[]): void
  subagents(list: SubagentJobEvent[]): void
  checkpoint(runId: string): void
  /**
   * 收尾，**带上本轮真实用量**（plan8 R9）：`null` = 厂商没报（界面显示占用估算，不假装知道精确值）。
   * `avoided`（R9.1）= 本轮工具输出窗口化省下的估算 token：它与 `usage` 是两笔账（本地估算 vs 厂商
   * 真值），故**分开传**；`tier` = 这一轮用的省 token 档位 —— 用户定调第 4 条：计量必须记下这轮用的哪一档，
   * 否则事后按档位比数字时说不清"这个数是在哪档下跑出来的"。
   */
  done(usage: TokenUsage | null, avoided?: number, tier?: TokenSaverTier): void
  error(message: string): void
  /** 危险操作确认（也带会话身份 —— 用户要知道是**哪条会话**在问） */
  confirm(req: ToolConfirmRequest): void
  /** Agent 提问（同确认：带会话身份 —— 用户要知道自己在答**哪条会话**的问题） */
  ask(req: AskRequest): void
  /** 预览用：这条 emitter 属于哪条会话 */
  readonly conversationId: string
}

/**
 * 造一个"绑定到某条会话 + 某个窗口"的发送器：`conversationId` 只在这里进闭包，之后所有发送自动带上它。
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
    },
    ask: (req) => {
      if (win.isDestroyed()) return
      // `conversationId` 通常已由 Agent 那一侧补上；缺了就补 emitter 的 —— 两种都留空是**查不出**这条问题出自哪条会话的
      win.send(IPC.askRequest, { ...req, conversationId: req.conversationId || conversationId })
    }
  }
}
