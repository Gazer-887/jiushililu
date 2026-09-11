import type { ToolConfirmRequest, ToolConfirmResult } from '@shared/ipc'

// 危险操作「逐次确认」桥（plan8 R5）
//
// 补的是这条缺口：权限档是**粗粒度的档位开关**（只读/可写/完全访问），
// 但"可写"档下模型仍可执行任意 shell 命令 —— 用户没法说"这一次让我看一眼"。
//
// 三个设计决定：
//   ① **无人应答 = 拒绝**（安全默认）。超时、窗口已关、渲染进程崩了，
//      一律按拒绝处理 —— 绝不能因为"没等到答复"就把危险操作放过去。
//   ② 请求带**唯一 id** 并成对响应，避免旧响应误配新请求。
//   ③ 桥本身不知道"哪些工具危险"，由调用方（runner）决定何时调 —— 单一职责。

/** 确认超时：超过则按拒绝处理（安全默认） */
const CONFIRM_TIMEOUT_MS = 60_000

export interface ConfirmBridge {
  /**
   * 请求用户确认；返回是否允许。
   * 无人应答（超时 / 窗口不可用）一律返回 false。
   */
  ask(req: Omit<ToolConfirmRequest, 'id'>): Promise<boolean>
  /** 渲染进程回传答复；返回是否匹配到待决请求 */
  respond(result: ToolConfirmResult): boolean
  /** 当前是否已有待决请求（界面据此避免重复弹） */
  hasPending(): boolean
  /** 丢弃某个待决请求（按拒绝处理）—— 窗口关闭/渲染崩溃时调用 */
  abortAll(reason: string): void
}

export interface ConfirmBridgeDeps {
  /** 把请求推给界面；无法推送（没有窗口）时返回 false */
  send(req: ToolConfirmRequest): boolean
  /** 日志留痕 */
  log(message: string, extra?: unknown): void
  /** 超时毫秒数（默认 60s）；测试用短超时 */
  timeoutMs?: number
}

export function createConfirmBridge(deps: ConfirmBridgeDeps): ConfirmBridge {
  interface Pending {
    resolve: (allowed: boolean) => void
    timer: ReturnType<typeof setTimeout>
    req: ToolConfirmRequest
  }
  const pending = new Map<string, Pending>()
  const timeoutMs = deps.timeoutMs ?? CONFIRM_TIMEOUT_MS
  let seq = 0

  const bridge: ConfirmBridge = {
    ask(base) {
      const id = `c${++seq}-${Date.now().toString(36)}`
      const req: ToolConfirmRequest = { ...base, id }

      // 推不出去 = 没有人能确认 = 拒绝（而不是"悄悄放行"）
      if (!deps.send(req)) {
        deps.log('危险操作确认无法送达界面，按拒绝处理', { tool: base.tool })
        return Promise.resolve(false)
      }

      deps.log('请求危险操作确认', { tool: base.tool, detail: base.detail })

      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          deps.log('危险操作确认超时，按拒绝处理', { tool: base.tool })
          resolve(false)
        }, timeoutMs)
        pending.set(id, { resolve, timer, req })
      })
    },

    respond(result) {
      const p = pending.get(result.id)
      if (!p) return false // 过期或伪造的响应，忽略
      pending.delete(result.id)
      clearTimeout(p.timer)
      deps.log('危险操作确认结果', { tool: p.req.tool, allowed: result.allowed })
      p.resolve(result.allowed)
      return true
    },

    hasPending() {
      return pending.size > 0
    },

    abortAll(reason) {
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.resolve(false) // 按拒绝处理
      }
      if (pending.size > 0) deps.log('丢弃全部待决确认（按拒绝）', { reason, count: pending.size })
      pending.clear()
    }
  }

  return bridge
}
