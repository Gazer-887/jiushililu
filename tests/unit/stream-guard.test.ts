import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStreamGuard, DEFAULT_STREAM_TIMEOUTS } from '@main/providers/stream-guard'

// 两层流守卫（plan29 D-090）。这组用例盯的是一条**能区分两种"慢"**的属性：
//  · 还在来数据 = 慢，不该掐；
//  · 数据不再来了 = 卡死，该立刻掐并说清是哪一层。
// 原来的整轮墙钟分不开这两件事 —— 它只知道"总共花了多久"，于是正常的长任务会被误杀，
// 而真正卡死的又说不清卡在哪（报的是一句笼统的「请求超时」）。

afterEach(() => {
  vi.useRealTimers()
})

const T = { firstByteMs: 1000, idleMs: 500 }

describe('createStreamGuard（纯逻辑）', () => {
  it('分片持续到来 → **永不触发**（慢不等于卡死）', () => {
    vi.useFakeTimers()
    const g = createStreamGuard(undefined, { timeouts: T })
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(400) // 每次都短于 idle 500
      g.onChunk()
    }
    expect(g.signal.aborted).toBe(false)
    expect(g.timeoutMessage()).toBeNull()
    g.dispose()
  })

  it('一个分片都没来 → 首包超时（口径是 firstByteMs）', () => {
    vi.useFakeTimers()
    const g = createStreamGuard(undefined, { timeouts: T })
    vi.advanceTimersByTime(999)
    expect(g.signal.aborted).toBe(false) // 还没到点，不许提前掐
    vi.advanceTimersByTime(2)
    expect(g.signal.aborted).toBe(true)
    expect(g.timeoutMessage()).toContain('首包超时')
    g.dispose()
  })

  it('首包到了之后转用**分片间隔**口径（同一段时间，首包没过、分片间隔过了）', () => {
    vi.useFakeTimers()
    const g = createStreamGuard(undefined, { timeouts: T })
    vi.advanceTimersByTime(900) // 首包计时走了 900 / 1000
    g.onChunk() // 首包到达 → 表切到 idle 口径 500
    vi.advanceTimersByTime(400) // idle 只走了 400
    expect(g.signal.aborted).toBe(false) // ← 若实现忘了重置，这里会误报
    vi.advanceTimersByTime(200) // idle 累计 600 > 500
    expect(g.signal.aborted).toBe(true)
    expect(g.timeoutMessage()).toContain('流中断')
    g.dispose()
  })

  it('中断发生在首包之后 → 文案是「流中断」，不是「首包超时」（分层不能混）', () => {
    vi.useFakeTimers()
    const g = createStreamGuard(undefined, { timeouts: T })
    g.onChunk()
    vi.advanceTimersByTime(501)
    expect(g.timeoutMessage()).toContain('流中断')
    expect(g.timeoutMessage()).not.toContain('首包')
    g.dispose()
  })

  it('用户主动停止 → signal 中止，但**不产生超时文案**（两件事必须分得开）', () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const g = createStreamGuard(ac.signal, { timeouts: T })
    ac.abort()
    expect(g.signal.aborted).toBe(true)
    expect(g.timeoutMessage()).toBeNull() // ← 别把"用户不想做了"说成"超时"
    expect(g.userAborted()).toBe(true)
    g.dispose()
  })

  it('传入时就已经 abort 的信号 → 立刻中止，且不算超时', () => {
    const ac = new AbortController()
    ac.abort()
    const g = createStreamGuard(ac.signal, { timeouts: T })
    expect(g.signal.aborted).toBe(true)
    expect(g.timeoutMessage()).toBeNull()
    expect(g.userAborted()).toBe(true)
    g.dispose()
  })

  it('dispose 之后表就停了 → 不再中止（收尾必须真的收干净）', () => {
    vi.useFakeTimers()
    const g = createStreamGuard(undefined, { timeouts: T })
    g.dispose()
    vi.advanceTimersByTime(60_000)
    expect(g.signal.aborted).toBe(false)
    expect(g.timeoutMessage()).toBeNull()
  })

  it('守卫超时走的是**自己的 signal**（底层 fetch 才能被一起停掉）', () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const g = createStreamGuard(ac.signal, { timeouts: T })
    expect(g.signal).not.toBe(ac.signal) // 不能直接把用户的 signal 透传出去（否则哨兵无处落脚）
    vi.advanceTimersByTime(1001)
    expect(g.signal.aborted).toBe(true)
    expect(ac.signal.aborted).toBe(false) // 守卫超时**不该**反向去中止用户的 controller
    g.dispose()
  })

  it('超时回调会把"哪一层 + 等了多久"报出来（日志要能区分三种卡法）', () => {
    vi.useFakeTimers()
    const seen: Array<{ kind: string; ms: number }> = []
    const g = createStreamGuard(undefined, {
      timeouts: T,
      onTimeout: (kind, ms) => seen.push({ kind, ms })
    })
    vi.advanceTimersByTime(1001)
    expect(seen).toEqual([{ kind: 'first-byte', ms: 1000 }])
    g.dispose()
  })

  it('默认口径有值且量级合理（首包 60s / 分片 90s）', () => {
    expect(DEFAULT_STREAM_TIMEOUTS.firstByteMs).toBe(60_000)
    expect(DEFAULT_STREAM_TIMEOUTS.idleMs).toBe(90_000)
  })
})
