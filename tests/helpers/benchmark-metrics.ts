// 性能基准的**统计与判词纯函数**（plan10 §2.3 / S992）。
//
// 为什么单独成文件：bench 要量的是磁盘耗时与堆变化，那类断言在单测里必然抖；
// 但「P95 怎么算」「阈值怎么比」是确定性逻辑，可以在单测里钉死。
// 于是这里只放纯函数——不 import 产品代码、不碰 fs、不读时钟。

/** 普通三档进入判词的三个指标（口径见 plan10 §2.3 预登记阈值） */
export interface BenchmarkMetrics {
  /** 列表 R7 P95，毫秒 */
  listP95Ms: number
  /** 保存 R7 P95，毫秒 */
  saveP95Ms: number
  /** 单次列表造成的堆增量，MB（bytes / 1024 / 1024） */
  listHeapDeltaMB: number
}

/** 与 {@link BenchmarkMetrics} 同形的预登记阈值 */
export type BenchmarkThresholds = BenchmarkMetrics

/** 一条超线明细：指标、实际值、阈值 */
export interface ThresholdViolation {
  metric: keyof BenchmarkMetrics
  actual: number
  threshold: number
}

const METRIC_ORDER: readonly (keyof BenchmarkMetrics)[] = ['listP95Ms', 'saveP95Ms', 'listHeapDeltaMB']

/**
 * R7 百分位（Type 7 quantile）线性插值。
 *
 * 依据：NIST/ITL 记录的百分位定义指出小样本下目标位置常落在两个观测值之间、
 * 不存在唯一通用插值法；R7 是 Excel 与 R 默认采用的一种。本项目选它并把算法名
 * 与样本数一并记录，避免"P95"含义随实现漂移。
 * https://itl.nist.gov/div898/handbook/prc/section2/prc262.htm
 *
 * 约定：q = p / 100，h = (n - 1) * q，取 floor(h) 与 ceil(h) 两个样本线性插值。
 * 不修改入参（先复制再排序）。
 */
export function percentileR7(samples: readonly number[], p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`percentileR7: p 必须在 0 至 100 之间，收到 ${String(p)}`)
  }
  if (samples.length === 0) {
    throw new Error('percentileR7: 样本为空，无法计算百分位')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  for (const v of sorted) {
    if (!Number.isFinite(v)) {
      throw new Error(`percentileR7: 样本含非有限值 ${String(v)}`)
    }
  }
  const h = (sorted.length - 1) * (p / 100)
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  const low = sorted[lo] as number
  if (lo === hi) return low
  return low + (h - lo) * ((sorted[hi] as number) - low)
}

/**
 * 逐项检查三个预登记门槛，返回超线明细。
 *
 * 判定是**严格小于**：实际值等于阈值即视为超线。
 * 非有限指标（NaN / ±Infinity）不算通过——它无法与阈值比较，不许被默认为合格。
 * 旧实现漏判 list P95、且只打印不失败，这里三项一次交齐。
 */
export function thresholdViolations(
  metrics: BenchmarkMetrics,
  thresholds: BenchmarkThresholds
): ThresholdViolation[] {
  const out: ThresholdViolation[] = []
  for (const metric of METRIC_ORDER) {
    const actual = metrics[metric]
    const threshold = thresholds[metric]
    if (!Number.isFinite(actual) || actual >= threshold) {
      out.push({ metric, actual, threshold })
    }
  }
  return out
}

/** 把超线明细拼成一句人读的失败原因（档位由调用方拼在前） */
export function formatViolations(violations: readonly ThresholdViolation[]): string {
  return violations
    .map((v) => `${v.metric} 实际 ${String(v.actual)} 阈值 ${String(v.threshold)}`)
    .join('；')
}