import { describe, expect, it } from 'vitest'
import {
  formatViolations,
  percentileR7,
  thresholdViolations,
  type BenchmarkMetrics,
  type BenchmarkThresholds
} from '../helpers/benchmark-metrics'

// 全部预期值手算写出，不调用被测函数推导：
// R7 定义 q = p/100、h = (n-1)*q，取 floor(h) 与 ceil(h) 两样本线性插值。
// 1..20 的 P95：h = 19 × 0.95 = 18.05 → 19 + 0.05 × (20 − 19) = 19.05
// 1..20 的 P50：h = 19 × 0.50 = 9.50  → 10 + 0.50 × (11 − 10) = 10.50

const BASE: BenchmarkThresholds = { listP95Ms: 50, saveP95Ms: 50, listHeapDeltaMB: 20 }
const PASSING: BenchmarkMetrics = { listP95Ms: 1.5, saveP95Ms: 5.6, listHeapDeltaMB: 0.29 }

describe('percentileR7', () => {
  it('1..20 的 P95 为 19.05、P50 为 10.5', () => {
    const samples = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(percentileR7(samples, 95)).toBeCloseTo(19.05, 10)
    expect(percentileR7(samples, 50)).toBeCloseTo(10.5, 10)
  })

  // 顺序无关性用**同一多重集合**验证：下面两者都恰是 1..20 的一个排列，
  // 所以预期值是手算常量，不调用被测函数推导（否则测试与实现同源、一起错也会绿）。
  // 乱序数组同时是「输入不变」的探针：被测函数一旦原地排序，这里立刻红。
  it('1..20 的乱序排列仍为 P95=19.05、P50=10.5，且不修改入参数组', () => {
    const ordered = Array.from({ length: 20 }, (_, i) => i + 1)
    const shuffled = [7, 1, 20, 13, 4, 16, 9, 2, 18, 11, 5, 19, 8, 14, 3, 17, 10, 15, 6, 12]
    expect([...shuffled].sort((a, b) => a - b)).toEqual(ordered)

    const orderedBefore = [...ordered]
    const shuffledBefore = [...shuffled]
    expect(percentileR7(ordered, 95)).toBeCloseTo(19.05, 10)
    expect(percentileR7(ordered, 50)).toBeCloseTo(10.5, 10)
    expect(percentileR7(shuffled, 95)).toBeCloseTo(19.05, 10)
    expect(percentileR7(shuffled, 50)).toBeCloseTo(10.5, 10)
    expect(ordered).toEqual(orderedBefore)
    expect(shuffled).toEqual(shuffledBefore)
  })

  // 手算：n=5、q=0.95 → h=4×0.95=3.8，floor=3 / ceil=4，10 + 0.8×(20−10) = 18；
  // P50：h=4×0.50=2，floor=ceil=2，直接取排序后第 3 个值 = 3。
  it('含 1/2/3/10/20 的乱序输入：P50=3、P95=18，且不修改入参数组', () => {
    const shuffled = [2, 10, 1, 20, 3]
    const before = [...shuffled]
    expect(percentileR7(shuffled, 50)).toBeCloseTo(3, 10)
    expect(percentileR7(shuffled, 95)).toBeCloseTo(18, 10)
    expect(shuffled).toEqual(before)
  })

  it('单样本返回自身', () => {
    expect(percentileR7([7.25], 95)).toBe(7.25)
    expect(percentileR7([7.25], 0)).toBe(7.25)
    expect(percentileR7([7.25], 100)).toBe(7.25)
  })

  it('P0 取最小、P100 取最大', () => {
    const samples = [12.5, 3.25, 88, 40.75, 7]
    expect(percentileR7(samples, 0)).toBe(3.25)
    expect(percentileR7(samples, 100)).toBe(88)
  })

  it('全部重复值时各分位都等于该值', () => {
    expect(percentileR7([5, 5, 5, 5], 95)).toBe(5)
    expect(percentileR7([5, 5, 5, 5], 50)).toBe(5)
    expect(percentileR7([0, 0, 0], 95)).toBe(0)
  })

  it('空数组报错', () => {
    expect(() => percentileR7([], 95)).toThrow(/样本为空/)
  })

  it('NaN 与 Infinity 样本报错', () => {
    expect(() => percentileR7([1, Number.NaN, 3], 95)).toThrow(/非有限值/)
    expect(() => percentileR7([1, Number.POSITIVE_INFINITY], 95)).toThrow(/非有限值/)
    expect(() => percentileR7([1, Number.NEGATIVE_INFINITY], 95)).toThrow(/非有限值/)
  })

  it('非法 p 报错（越界与非有限）', () => {
    const s = [1, 2, 3]
    expect(() => percentileR7(s, -0.1)).toThrow(/p 必须在 0 至 100 之间/)
    expect(() => percentileR7(s, 100.1)).toThrow(/p 必须在 0 至 100 之间/)
    expect(() => percentileR7(s, Number.NaN)).toThrow(/p 必须在 0 至 100 之间/)
    expect(() => percentileR7(s, Number.POSITIVE_INFINITY)).toThrow(/p 必须在 0 至 100 之间/)
  })
})

describe('thresholdViolations', () => {
  it('三项都在线下时无超线', () => {
    expect(thresholdViolations(PASSING, BASE)).toEqual([])
  })

  it('list P95 单独超线', () => {
    const v = thresholdViolations({ ...PASSING, listP95Ms: 50.01 }, BASE)
    expect(v).toHaveLength(1)
    expect(v[0]).toEqual({ metric: 'listP95Ms', actual: 50.01, threshold: 50 })
  })

  it('save P95 单独超线', () => {
    const v = thresholdViolations({ ...PASSING, saveP95Ms: 127.7 }, BASE)
    expect(v).toHaveLength(1)
    expect(v[0]?.metric).toBe('saveP95Ms')
    expect(v[0]?.actual).toBe(127.7)
  })

  it('list 堆增量单独超线', () => {
    const v = thresholdViolations({ ...PASSING, listHeapDeltaMB: 30.01 }, BASE)
    expect(v).toHaveLength(1)
    expect(v[0]?.metric).toBe('listHeapDeltaMB')
  })

  it('恰等于阈值即判超线（严格小于）', () => {
    const v = thresholdViolations({ listP95Ms: 50, saveP95Ms: 50, listHeapDeltaMB: 20 }, BASE)
    expect(v.map((x) => x.metric)).toEqual(['listP95Ms', 'saveP95Ms', 'listHeapDeltaMB'])
  })

  it('边界两侧：略低于通过、略高于失败', () => {
    expect(thresholdViolations({ ...PASSING, listP95Ms: 49.999 }, BASE)).toEqual([])
    expect(thresholdViolations({ ...PASSING, listP95Ms: 50.001 }, BASE)).toHaveLength(1)
    expect(thresholdViolations({ ...PASSING, listHeapDeltaMB: 19.999 }, BASE)).toEqual([])
    expect(thresholdViolations({ ...PASSING, listHeapDeltaMB: 20.001 }, BASE)).toHaveLength(1)
  })

  it('未四舍五入的值参与判定（50.0000001 不能因显示成 50.0 而通过）', () => {
    const v = thresholdViolations({ ...PASSING, saveP95Ms: 50.0000001 }, BASE)
    expect(v).toHaveLength(1)
    expect(v[0]?.actual).toBe(50.0000001)
  })

  it('多项同时失败时全部列出且顺序稳定', () => {
    const v = thresholdViolations({ listP95Ms: 80, saveP95Ms: 90, listHeapDeltaMB: 25 }, BASE)
    expect(v).toEqual([
      { metric: 'listP95Ms', actual: 80, threshold: 50 },
      { metric: 'saveP95Ms', actual: 90, threshold: 50 },
      { metric: 'listHeapDeltaMB', actual: 25, threshold: 20 }
    ])
  })

  it('非有限指标不能判通过', () => {
    const nanResult = thresholdViolations({ ...PASSING, listP95Ms: Number.NaN }, BASE)
    expect(nanResult).toHaveLength(1)
    expect(nanResult[0]?.metric).toBe('listP95Ms')
    const infResult = thresholdViolations({ ...PASSING, listHeapDeltaMB: Number.POSITIVE_INFINITY }, BASE)
    expect(infResult).toHaveLength(1)
    expect(infResult[0]?.metric).toBe('listHeapDeltaMB')
    const negInfResult = thresholdViolations({ ...PASSING, saveP95Ms: Number.NEGATIVE_INFINITY }, BASE)
    expect(negInfResult).toHaveLength(1)
  })

  it('formatViolations 输出含指标、实际值与阈值', () => {
    const text = formatViolations(thresholdViolations({ ...PASSING, saveP95Ms: 127.7 }, BASE))
    expect(text).toContain('saveP95Ms')
    expect(text).toContain('127.7')
    expect(text).toContain('50')
  })
})