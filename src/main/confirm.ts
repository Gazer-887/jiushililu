import type { ToolConfirmRequest, ToolConfirmResult } from '@shared/ipc'

// 危险操作「逐次确认」桥（plan8 R5）—— 补的缺口：权限档是**粗粒度开关**（只读/可写/完全访问），
// 而"可写"档下模型仍可执行任意 shell 命令，用户没法说"这一次让我看一眼"。
// 三条设计决定：① **无人应答 = 拒绝**（超时 / 窗口已关 / 渲染崩了都按拒绝 —— 绝不能因为没等到答复就
// 放过去）；② 请求带**唯一 id** 成对响应（防旧响应误配新请求）；③ 桥不知道"哪些工具危险"，由 runner 决定何时调。
// plan11：待决**可以有多个**（两条会话各挂各的 id），界面按队列逐条问（`ConfirmDialog`）。
// ⚠️ 不许再加 `hasPending()`：它曾全仓零调用点 —— 那种 API 会让人以为有这道防线，实际没有（已删）。

/** 确认超时：超过则按拒绝处理（安全默认） */
const CONFIRM_TIMEOUT_MS = 60_000

export interface ConfirmBridge {
  /** 请求用户确认；返回是否允许。无人应答（超时 / 窗口不可用）一律 false */
  ask(req: Omit<ToolConfirmRequest, 'id'>): Promise<boolean>
  /** 渲染进程回传答复；返回是否匹配到待决请求 */
  respond(result: ToolConfirmResult): boolean
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
