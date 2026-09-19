import { describe, expect, it, vi } from 'vitest'

// 诊断层不许反噬主流程（plan49 A+B 复查 P0）。
// `try { return fn() } finally { ... }` 里只要 finally 抛错，就会**顶掉原始异常**、
// 连 err.code 一起丢 —— 上层靠 EACCES / EEXIST / ENOENT 分型的分支会全部走错。
// 落盘抛错是有真实来源的：log.ts 的控制台输出那一句在 try 之外（stdout 管道被关即抛）。

vi.mock('@main/log', () => ({
  createLogger: () => ({
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: () => {
      throw new Error('stdout 管道已关闭')
    }
  })
}))

const { createLogger } = await import('@main/log')
const { traceSync } = await import('@main/watchdog')

/** 触发慢块告警（SLOW_BLOCK_MS=500）用的同步忙等 */
const busyWait = (ms: number): void => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 占住循环
  }
}

describe('诊断失败不外溢', () => {
  it('前置自证：mock 真的装上了（否则下面两条都是假通过）', () => {
    expect(() => createLogger('probe').warn('x')).toThrow('stdout 管道已关闭')
  })

  it('慢块落盘抛错时，原始异常与 err.code 一并原样上抛', () => {
    let caught: unknown
    try {
      traceSync('blk:read', () => {
        busyWait(600)
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toContain('ENOENT')
    expect((caught as { code?: string }).code).toBe('ENOENT')
  })

  it('慢块落盘抛错时，正常返回值照样返回', () => {
    const out = traceSync('blk:ok', () => {
      busyWait(600)
      return 'payload'
    })
    expect(out).toBe('payload')
  })
})
