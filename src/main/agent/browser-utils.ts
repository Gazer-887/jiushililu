// 内置浏览器纯逻辑（plan60）：无 electron import，可单测。
// 放这里而不是 browser.ts —— browser.ts 顶行即 `from 'electron'`，CI 里 import 即炸。

/**
 * 定长环形缓冲（console / network 记录用）。满了丢最旧的，不抛 ——
 * 记录是取证用的，写满时卡死页面才是本末倒置。
 */
export class RingBuffer<T> {
  private items: T[] = []
  constructor(private readonly cap: number) {}
  push(v: T): void {
    this.items.push(v)
    while (this.items.length > this.cap) this.items.shift()
  }
  list(): T[] {
    return [...this.items]
  }
  get length(): number {
    return this.items.length
  }
}

/** console / network 记录各留 200 条（取证够用，不撑内存） */
export const TRACE_CAP = 200

/** dialog 无人处理时的兜底：自动 dismiss 的宽限（plan60 §三.4：页面绝不能被卡死） */
export const DIALOG_AUTO_DISMISS_MS = 500

/** 等待条件的默认上限（plan60：超时报"未出现"而非卡死） */
export const WAIT_DEFAULT_MS = 10000
export const WAIT_MAX_MS = 60000
export const WAIT_POLL_MS = 250
