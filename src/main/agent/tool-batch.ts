// 有界工具批执行（S3-40A/40B → S89-01）：整批合格默认最多 2 路，其余 1 路，结果按原输入顺序回灌。
// 资格/路径规范化/读版本属于真实消费者；本模块不认识工具类别，也不发模型请求。
// ⚠️ 四条硬约束：① 每项启动前同步核 `canStart`（与启动之间无 await）；
// ② 取消后不启动排队项，在途等结算（中止不等于 OS I/O 结束）；
// ③ 取消/提交门失效时结算项标 `stale`，调用方不得提交；
// ④ 结果与版本只在全部结算后的同一同步门提交，guard 失败整批 `discard`。
import { resolveToolBatchConcurrency } from '@shared/request-policy'
import { acquireWatchdogLease } from '../watchdog'

export type ToolBatchItemStatus = 'fulfilled' | 'rejected' | 'skipped'

export interface ToolBatchItemResult<T, R> {
  index: number
  item: T
  /** skipped = 未启动（取消 / canStart 拒绝 / 排队未轮到） */
  status: ToolBatchItemStatus
  started: boolean
  /** 启动后遇到取消/批级中止/提交门失效：结果已结算但不新鲜，调用方不得当成功提交 */
  stale: boolean
  /** 结果与副作用是否已在同一同步门提交；false = 不得使用 value */
  committed: boolean
  value?: R
  error?: unknown
  leaseId?: string
}

export interface ToolBatchResult<T, R> {
  /** 与输入等长、按原下标排列；完成快慢不改变顺序 */
  results: Array<ToolBatchItemResult<T, R>>
  startedCount: number
  aborted: boolean
}

export interface RunToolBatchInput<T, R> {
  items: readonly T[]
  /** 整批是否全部合格；只有显式 true 才可能放宽到 2 路 */
  eligible?: unknown
  /**
   * 每项真正启动前的最后一道门（同步）。抛错按"不许启动"处理。
   * 调用前提：不得在这里做异步等待；需要异步准备的检查应在 run 内部完成并再次核权。
   */
  canStart?: (item: T, index: number) => boolean
  signal?: AbortSignal
  run: (item: T, index: number) => Promise<R>
  /** 每个在途项持有的看门狗租约 phase（默认 tool:batch） */
  leasePhase?: string
  /**
   * 提交门（同步，全部在途项结算后调用一次）：看 signal / run 活性 / 当前守卫。
   * 返回 false 或抛错 = 整批不提交，标 stale 并调用 discard。
   */
  guard?: (results: ReadonlyArray<ToolBatchItemResult<T, R>>) => boolean
  /** 与结果同一同步门提交；**不得**在其中做异步等待（S3-40B 的版本 receipt 在此落账） */
  commit?: (results: ReadonlyArray<ToolBatchItemResult<T, R>>) => void
  /** 提交门失效时丢弃结果与 receipt；不触碰任何已提交状态 */
  discard?: (results: ReadonlyArray<ToolBatchItemResult<T, R>>) => void
}

/**
 * 跑一批工具项。**不重试、不整批重跑、不发新请求**：
 * - 单项失败只标该项 rejected，其他已完成结果保留；
 * - 取消只拒绝**后续启动**，在途项等结算后标 stale；
 * - 结果始终按输入顺序返回，调用方按 `index`/`item` 与原 `tool_call` 配对。
 */
export async function runToolBatch<T, R>(input: RunToolBatchInput<T, R>): Promise<ToolBatchResult<T, R>> {
  const { items, signal, canStart, run } = input
  // 上限只由策略纯函数给出：不合格批一律 1 路，绝不放宽成无界起跑
  const limit = resolveToolBatchConcurrency({ eligible: input.eligible })
  const leasePhase = input.leasePhase ?? 'tool:batch'
  const results: Array<ToolBatchItemResult<T, R>> = items.map((item, index) => ({
    index,
    item,
    status: 'skipped',
    started: false,
    stale: false,
    committed: false
  }))
  let next = 0
  let startedCount = 0
  let aborted = signal?.aborted === true

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) {
        aborted = true
        return
      }
      const index = next++
      if (index >= items.length) return
      const item = items[index]!
      // 启动前最后一道门：先看取消，再同步问 canStart；这之后到 run 调用之间没有 await
      if (signal?.aborted) {
        aborted = true
        return
      }
      let allowed = true
      try {
        allowed = canStart ? canStart(item, index) === true : true
      } catch {
        allowed = false
      }
      if (!allowed) continue
      // canStart 可能同步触发取消并仍返回 true：拿租约/启动前必须再核一次
      if (signal?.aborted) {
        aborted = true
        continue
      }
      const lease = acquireWatchdogLease(leasePhase)
      startedCount++
      results[index] = {
        index,
        item,
        status: 'rejected',
        started: true,
        stale: false,
        committed: false,
        leaseId: lease.id
      }
      try {
        const value = await run(item, index)
        const stale = signal?.aborted === true
        if (stale) aborted = true
        results[index] = { ...results[index]!, status: 'fulfilled', value, stale }
      } catch (error) {
        const stale = signal?.aborted === true
        if (stale) aborted = true
        results[index] = { ...results[index]!, status: 'rejected', error, stale }
      } finally {
        lease.release()
      }
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  // 结果与副作用在同一同步门结算：从这里到 commit 之间没有 await。
  // guard/commit/discard 必须是同步且不抛的；guard 失效 = 整批作废（含已 fulfilled 的项）。
  // 任何未启动项（canStart 拒绝/取消）都使整批失败：不得只提交已成功的项。
  let allowed =
    aborted !== true && signal?.aborted !== true && results.every((result) => result.started)
  if (allowed) {
    try {
      allowed = input.guard ? input.guard(results) === true : true
    } catch {
      allowed = false
    }
    // guard 可能同步 abort 并仍返回 true：提交前必须再核一次，且中间无 await
    if (allowed && (aborted === true || signal?.aborted === true)) allowed = false
  }
  if (allowed) {
    input.commit?.(results)
    for (const r of results) if (r.started) r.committed = true
  } else {
    aborted = true
    for (const r of results) {
      if (r.started) r.stale = true
      r.committed = false
    }
    input.discard?.(results)
  }
  return {
    results,
    startedCount,
    aborted: aborted || signal?.aborted === true
  }
}
