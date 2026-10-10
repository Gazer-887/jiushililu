// 最小校准读数：复用追加事件流，零模型调用、不迁移历史。日志轮转后缺坐标就是未知。
import type { MemoryCalibrationStats } from '@shared/memory'
import type { MemoryEvent } from './events'

const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** 从仍保留的入/出队事件重放年龄；采样时刻注入，方便跨重启验证。 */
export function queueWaitSample(queue: string[], events: MemoryEvent[], now: Date, enqueued?: string): { waitDays: number[]; unknownAges: number } {
  const starts = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== 'reflection_queue' || typeof e.conversationId !== 'string') continue
    if (e.action === 'dequeue') starts.delete(e.conversationId)
    if (e.action === 'enqueue') {
      const at = Date.parse(e.at)
      if (Number.isFinite(at)) starts.set(e.conversationId, at)
    }
  }
  if (enqueued !== undefined) starts.set(enqueued, now.getTime())
  const waitDays: number[] = []
  let unknownAges = 0
  for (const id of queue) {
    const start = starts.get(id)
    if (start === undefined || start > now.getTime()) unknownAges++
    else waitDays.push(Math.floor((now.getTime() - start) / 86400000))
  }
  return { waitDays, unknownAges }
}

export function computeMemoryCalibration(events: MemoryEvent[]): MemoryCalibrationStats {
  const reasons = new Map<string, number>()
  const reflection = { attempted: 0, skipped: 0, failed: 0, hits: 0, hitRate: null as number | null }
  const injection = { samples: 0, totalEntries: 0, omittedEntries: 0, truncatedSamples: 0, truncationRate: null as number | null }
  const queueSamples: MemoryCalibrationStats['queueSamples'] = []
  for (const e of events) {
    if (e.kind === 'write' && 'rejected' in e && e.rejected === true && typeof e.reason === 'string') {
      reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1)
    } else if (e.kind === 'reflection_sample') {
      if (e.outcome === 'skipped') reflection.skipped++
      else if (e.outcome === 'completed' || e.outcome === 'failed') {
        reflection.attempted++
        if (e.outcome === 'failed') reflection.failed++
        else if (nonnegative(e.candidates) && e.candidates > 0) reflection.hits++
      }
    } else if (e.kind === 'injection_sample' && nonnegative(e.total) && nonnegative(e.omitted) && e.omitted <= e.total) {
      injection.samples++
      injection.totalEntries += e.total
      injection.omittedEntries += e.omitted
      if (e.omitted > 0) injection.truncatedSamples++
    } else if (e.kind === 'reflection_queue' && nonnegative(e.depth) && Array.isArray(e.waitDays) && e.waitDays.every(nonnegative) && nonnegative(e.unknownAges)) {
      queueSamples.push({ at: e.at, depth: e.depth, waitDays: e.waitDays, unknownAges: e.unknownAges })
    }
  }
  reflection.hitRate = reflection.attempted === 0 ? null : reflection.hits / reflection.attempted
  injection.truncationRate = injection.totalEntries === 0 ? null : injection.omittedEntries / injection.totalEntries
  const rejectionReasons = [...reasons].map(([reason, count]) => ({ reason, count }))
  return { rejectedWrites: rejectionReasons.reduce((n, x) => n + x.count, 0), rejectionReasons, reflection, injection, queueSamples }
}
