import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initLogger } from '@main/log'
import { breadcrumb, peekTracedBlocks, startWatchdog, stopWatchdog, traceSpan, traceSync } from '@main/watchdog'

// 同步块插桩（plan49 A+B）的判据测试。
// 核心不是"有没有记日志"，而是**归因给谁**：crumbs 只有时刻点、且必然落在停滞末段，
// 拿它指元凶＝倒果为因（plan49 §9.1）。这里每条用例都盯住"不许把旁观者判成凶手"。

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 同步忙等：构造真实的事件循环占死（不能用 setTimeout，那会让出循环） */
const busyWait = (ms: number): void => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 占住循环
  }
}
const readLog = (dir: string): string => {
  const f = join(dir, 'app.log')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1

describe('同步块插桩', () => {
  let dir = ''
  const open = (): string => {
    dir = mkdtempSync(join(tmpdir(), 'jsl-block-'))
    initLogger(dir, 'info')
    return dir
  }
  afterEach(() => {
    stopWatchdog()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('归因给横跨停滞起点的块，而不是恢复后的末段记录', async () => {
    const d = open()
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    traceSync('blk:culprit', () => busyWait(220))
    traceSync('blk:after', () => busyWait(70)) // 占死解除后才跑的块
    breadcrumb('> agents:list') // 恢复后的第一拍 —— 旧口径会把它当成元凶
    await sleep(150)
    const content = readLog(d)
    expect(content).toContain('事件循环停滞')
    // 判据自测：实现若退化成"取最后入档的块"，这里就会归给 blk:after 而红
    expect(content).toContain('"block":{"label":"blk:culprit"')
    expect(content).not.toContain('"label":"blk:after"')
    expect(content).not.toContain('"label":"agents:list"')
  })

  it('无单一横跨者时给出窗口内聚合（n / sumMs / top），不只报 null', async () => {
    const d = open()
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    for (let i = 0; i < 6; i++) traceSync('blk:acc', () => busyWait(60))
    await sleep(150)
    const content = readLog(d)
    expect(content).toContain('事件循环停滞')
    expect(content).toContain('"inWindow":{')
    expect(content).toMatch(/"coveredMs":\d{2,}/)
    expect(content).toContain('"top":{"label":"blk:acc"')
  })

  it('窗口覆盖时长必须去重：嵌套外层被算两遍会说出"块比停滞还长"', async () => {
    const d = open()
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    traceSync('blk:outer', () => {
      traceSync('blk:inner', () => busyWait(200))
      busyWait(80)
    })
    await sleep(150)
    const content = readLog(d)
    const stall = Number(content.match(/"stallMs":(\d+)/)?.[1] ?? 0)
    const covered = Number(content.match(/"coveredMs":(\d+)/)?.[1] ?? 0)
    expect(stall).toBeGreaterThan(0)
    expect(covered).toBeGreaterThan(0)
    // 未去重时 covered = 280 + 200 = 480，远大于 stall ⇒ 整条诊断日志失去可信度
    expect(covered).toBeLessThanOrEqual(stall + 60)
  })

  it('嵌套块归因最外层（内层只是外层的耗时来源）', async () => {
    const d = open()
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    traceSync('blk:outer', () => {
      traceSync('blk:inner', () => busyWait(200))
      busyWait(80)
    })
    await sleep(150)
    const content = readLog(d)
    expect(content).toContain('"label":"blk:outer"')
    expect(content).not.toContain('"label":"blk:inner"')
  })

  it('异步跨度不参与归属：await 期间循环是空的，它是旁观者', async () => {
    const d = open()
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    const witnessing = traceSpan('span:witness', async () => {
      await sleep(320)
    })
    await sleep(50)
    busyWait(200) // 真正的占死者，未被打点
    await witnessing
    await sleep(150)
    const content = readLog(d)
    expect(content).toContain('事件循环停滞')
    expect(content).not.toContain('"label":"span:witness"')
    // 跨度本身仍留面包屑（进出与耗时可见），只是不参与元凶判定
    expect(content).toContain('span:witness')
  })

  it('占死者未被打点时如实报 null，并用 traced 计数区分"没抓到"与"没插桩"', async () => {
    const d = open()
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    traceSync('blk:tiny', () => busyWait(5)) // 低于入档下限，不进归属池
    busyWait(220) // 未打点的占死者
    await sleep(150)
    const content = readLog(d)
    expect(content).toContain('事件循环停滞')
    expect(content).toContain('"block":null')
    expect(content).toContain('"inWindow":null')
    expect(content).toMatch(/"traced":[1-9]/) // 插桩在干活，只是这次没抓到
  })

  it('慢告警后 reporting 一定复位（闸卡在 true = 插桩永久静默失效）', () => {
    open()
    traceSync('blk:reset-probe', () => busyWait(600))
    const after = peekTracedBlocks()
    traceSync('blk:next', () => 1)
    expect(peekTracedBlocks()).toBe(after + 1)
  })

  it('慢块即使正常完成也记一条；同 label 节流不刷屏', async () => {
    open()
    traceSync('blk:slow', () => busyWait(600))
    traceSync('blk:slow', () => busyWait(600))
    const content = readLog(dir)
    expect(countOf(content, '"label":"blk:slow"')).toBe(1)
    expect(content).toContain('长任务已完成')
  })

  it('traced 计数：每次进入 traceSync 加一（自检信号，防校验器自己坏了还判"无异常"）', () => {
    const before = peekTracedBlocks()
    traceSync('blk:count', () => 1)
    expect(peekTracedBlocks()).toBe(before + 1)
  })

  it('traceSync 不吞异常也不改返回值', () => {
    const before = peekTracedBlocks()
    expect(traceSync('blk:ret', () => 'ok')).toBe('ok')
    expect(() =>
      traceSync('blk:throw', () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(peekTracedBlocks()).toBe(before + 2)
  })
})
