/**
 * 对话并发闸（plan11 §2.1）—— **纯逻辑，可单测**。
 *
 * ## 为什么要单独抽出来
 *
 * 这道闸管的是"主进程允许几条会话同时跑"。它**没法在 `verify-shot` 里验** ——
 * 那个脚本把 `chat:send` 整个 stub 掉了（渲染端自己就会把 `streaming` 置 true），
 * 所以**不管闸是 1 还是 3，界面上都是两个"正在生成"**（实测：把上限改回 1，那 6 条并发断言照样全绿）。
 * 换句话说：**只有把它抽成纯函数，这道闸才真正被验到**。
 *
 * ## 三条规则
 *
 * 1. **同会话重复发送 → 拒绝**（"这条会话已经在跑了"）—— 一条会话同时跑两轮，消息会自己串自己
 * 2. **跨会话 → 放行** —— 这正是本计划要的能力
 * 3. **总数超上限 → 拒绝**，且理由里带上限数字（每跑一条会话就是一堆工具调用 / 子进程，
 *    不设上限等于允许用户一键把机器压垮）
 *
 * 本模块**不 import electron**：与 runner / checkpoints 同样的约束，可被单测直接 import。
 */

export interface ChatGateAcquired {
  ok: true
  /** 这一轮的取消句柄（用户点「停止」时用它） */
  controller: AbortController
}

export interface ChatGateRejected {
  ok: false
  /** 给人看的一句话（直接送到界面上，不写"操作失败"这种废话） */
  message: string
}

export type ChatGateResult = ChatGateAcquired | ChatGateRejected

export interface ChatGate {
  /** 试着开始一轮；成功则拿到取消句柄 */
  begin(conversationId: string): ChatGateResult
  /** 收尾（正常结束 / 出错都一样） */
  end(conversationId: string): void
  /** 停掉某条会话（**只停那一条** —— 并发时停错会话是事故） */
  abort(conversationId: string): void
  /** 这条会话在跑吗（会话回滚要用它判断"能不能现在回滚"） */
  isRunning(conversationId: string): boolean
  /** 当前在跑几条 */
  size(): number
}

export function createChatGate(max: number): ChatGate {
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`并发上限必须是 ≥1 的整数，收到 ${String(max)}`)
  }
  const running = new Map<string, AbortController>()

  return {
    begin(conversationId) {
      if (running.has(conversationId)) {
        return { ok: false, message: '这条会话已经在跑了：请先点「停止」或等它完成' }
      }
      if (running.size >= max) {
        return { ok: false, message: `同时最多跑 ${max} 条会话：等有会话跑完再发` }
      }
      const controller = new AbortController()
      running.set(conversationId, controller)
      return { ok: true, controller }
    },

    end(conversationId) {
      running.delete(conversationId)
    },

    abort(conversationId) {
      running.get(conversationId)?.abort()
    },

    isRunning(conversationId) {
      return running.has(conversationId)
    },

    size() {
      return running.size
    }
  }
}
