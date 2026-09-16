import type { PlanApprovalRequest, PlanApprovalResult } from '@shared/ipc'

// 计划批准桥（plan27）—— 补的缺口：planner agent 输出方案后本轮即结束，用户只能手动切到执行 agent
// 并重述一遍。真正缺的不是「只读」（planner 靠只声明读类工具已经做到物理只读），而是
// **plan → execute 的交接**：让它在给出方案后**停下来等人点头**，而不是把控制权直接丢回给人。
//
// 四条设计决定（与 `confirm.ts` 同源，理由同样成立）：
// ① **无人应答 = 拒绝**（超时 / 窗口已关 / 渲染崩了 / 被中止都按拒绝）—— 绝不能因为没等到答复就放过去；
// ② 请求带**唯一 id** 成对响应（防旧响应误配新请求）；
// ③ 桥**不知道**「谁该弹卡」—— 由 runner 决定何时调（这里只管"问一次、等答复"）；
// ④ 与 confirm / ask **各走一条通道**：那两条问的是「这一次要不要」，这条问的是「这份方案要不要执行」，
//    且载荷是一整篇方案（长文本），混用会污染安全关键路径的固定文案。
//
// ⚠️ 本文件**不许 import electron**（见 runner.ts 文件头同款约束）——
// 它要能进单测链路，也要过 `tests/unit/architecture.test.ts` 的守卫。
// 推窗口、取主窗口这些事由组合根（index.ts）在 `send` 里做。

/**
 * 批准等待超时：超过按**拒绝**处理（安全默认）。
 *
 * ⚠️ 这里刻意比 confirm 桥的 60s **长一个量级**，原因不同：confirm 桥等的是「要不要执行这条命令」
 * （看一眼就能答），这里等的是「要不要执行这份方案」——**读完一份方案需要分钟级**。
 * 把两者定成同一个数，等于逼用户在没读完时随便点一个。
 */
const PLAN_APPROVAL_TIMEOUT_MS = 600_000

export interface PlanApprovalBridge {
  /**
   * 请求用户批准方案；返回是否批准。
   * 无人应答（超时 / 窗口不可用 / 被中止）一律 `false`。
   * `opts.signal` 中止 ⇒ 立即按拒绝收尾（用户点了「停止」就是不想再等）。
   */
  request(req: Omit<PlanApprovalRequest, 'id'>, opts?: { signal?: AbortSignal }): Promise<boolean>
  /** 渲染进程回传答复；返回是否匹配到待决请求 */
  respond(result: PlanApprovalResult): boolean
  /** 丢弃某个待决请求（按拒绝处理）—— 窗口关闭/渲染崩溃时调用 */
  abortAll(reason: string): void
}

export interface PlanApprovalBridgeDeps {
  /** 把请求推给界面；无法推送（没有窗口）时返回 false */
  send(req: PlanApprovalRequest): boolean
  /** 日志留痕 */
  log(message: string, extra?: unknown): void
  /**
   * 批准结论回调：每次「用户真的决定了」时触发（含超时/中止的按拒绝）。
   * `reason` = 用户答复 / timeout / undeliverable / aborted，供时间线分辨「拒是怎么来的」。
   */
  onDecide?: (info: { conversationId: string; agent: string; allowed: boolean; reason: string }) => void
  /** 超时毫秒数（默认 10 分钟）；测试用短超时 */
  timeoutMs?: number
}

export function createPlanApprovalBridge(deps: PlanApprovalBridgeDeps): PlanApprovalBridge {
  interface Pending {
    resolve: (allowed: boolean) => void
    timer: ReturnType<typeof setTimeout>
    req: PlanApprovalRequest
    /** 中止监听器的解绑函数（无 signal 时为 noop） */
    detach: () => void
  }
  const pending = new Map<string, Pending>()
  const timeoutMs = deps.timeoutMs ?? PLAN_APPROVAL_TIMEOUT_MS
  let seq = 0

  /** 统一的收尾路径：解绑、出队、留痕、兑现。**所有出口都走它**，免得某条路忘了清 timer 或忘了打点 */
  const settle = (id: string, allowed: boolean, reason: string): void => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    p.detach()
    deps.onDecide?.({ conversationId: p.req.conversationId, agent: p.req.agent, allowed, reason })
    p.resolve(allowed)
  }

  const bridge: PlanApprovalBridge = {
    request(base, opts) {
      const id = `p${++seq}-${Date.now().toString(36)}`
      const req: PlanApprovalRequest = { ...base, id }

      // 推不出去 = 没有人能批准 = 拒绝（而不是"悄悄放行"）
      if (!deps.send(req)) {
        deps.log('计划批准请求无法送达界面，按拒绝处理', { agent: base.agent })
        deps.onDecide?.({ conversationId: base.conversationId, agent: base.agent, allowed: false, reason: 'undeliverable' })
        return Promise.resolve(false)
      }

      deps.log('请求计划批准', { agent: base.agent, planChars: base.plan.length })

      return new Promise<boolean>((resolve) => {
        // 已中止（用户在发起前就点了停止）：直接拒绝，不建待决项 —— 否则会留一条永远等不到的 pending
        if (opts?.signal?.aborted) {
          deps.onDecide?.({ conversationId: base.conversationId, agent: base.agent, allowed: false, reason: 'aborted' })
          resolve(false)
          return
        }

        const timer = setTimeout(() => {
          deps.log('计划批准超时，按拒绝处理', { agent: base.agent })
          settle(id, false, 'timeout')
        }, timeoutMs)

        const onAbort = (): void => {
          deps.log('本轮被中止，计划批准按拒绝处理', { agent: base.agent })
          settle(id, false, 'aborted')
        }
        opts?.signal?.addEventListener('abort', onAbort, { once: true })
        const detach = (): void => opts?.signal?.removeEventListener('abort', onAbort)

        pending.set(id, { resolve, timer, req, detach })
      })
    },

    respond(result) {
      const p = pending.get(result.id)
      if (!p) return false // 过期或伪造的响应，忽略
      deps.log('计划批准结果', { agent: p.req.agent, allowed: result.allowed })
      settle(result.id, result.allowed, 'user')
      return true
    },

    abortAll(reason) {
      // 先取 key 快照：`settle` 内部会 `pending.delete`，直接遍历 Map 边删边遍历容易漏项。
      // ⚠️ 不在循环外另调 `onDecide` —— `settle` 里已经调了，重复打点会让时间线出现两条矛盾记录。
      const ids = [...pending.keys()]
      for (const id of ids) settle(id, false, reason)
      if (ids.length > 0) deps.log('丢弃全部待决计划批准（按拒绝）', { reason, count: ids.length })
    }
  }

  return bridge
}
