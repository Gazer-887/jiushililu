import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initLogger } from '@main/log'
import { setWatchdogPhase, startWatchdog, stopWatchdog } from '@main/watchdog'

// 看门狗（plan37 S0）：把「主进程被同步任务占死」变成带时长与阶段归属的日志证据。
// 计时用真实定时器 + 同步忙等构造 —— 阈值给足余量，避免 CI 高负载下的边界抖动。

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** logger 首写才建 app.log —— 「不该有日志」的用例里文件可能压根不存在 */
const readLog = (dir: string): string => {
  const f = join(dir, 'app.log')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

describe('事件循环看门狗', () => {
  let dir = ''
  afterEach(() => {
    stopWatchdog()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('同步停滞超过阈值 → 一条 WARN 带 stallMs 与**停滞起点时的**阶段', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsl-watchdog-'))
    initLogger(dir, 'info')
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    setWatchdogPhase('tool:blocker')
    const end = Date.now() + 200
    while (Date.now() < end) {
      // 同步忙等：模拟占死事件循环的长任务
    }
    // 解冻后立刻设回 idle —— 归属必须靠阶段历史回溯，而不是读当前值
    setWatchdogPhase('idle')
    await sleep(150)
    const content = readLog(dir)
    expect(content).toContain('事件循环停滞')
    expect(content).toContain('"phase":"tool:blocker"')
    expect(content).toMatch(/"stallMs":\d{2,}/)
  })

  it('无停滞 → 不产生任何 WARN（看门狗不刷日志）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsl-watchdog-'))
    initLogger(dir, 'info')
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    await sleep(150)
    const content = readLog(dir)
    expect(content).not.toContain('事件循环停滞')
  })

  it('重复 start 不加第二个计时器；stop 后不再上报', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jsl-watchdog-'))
    initLogger(dir, 'info')
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    startWatchdog({ intervalMs: 20, thresholdMs: 60 })
    stopWatchdog()
    const end = Date.now() + 200
    while (Date.now() < end) {
      // 停狗之后的停滞不该再上报
    }
    await sleep(80)
    const content = readLog(dir)
    expect(content).not.toContain('事件循环停滞')
  })

  it('阶段 save/restore 契约：set 返回前值（并发路径回存前值、不硬写 idle）', () => {
    const outer = setWatchdogPhase('tool:outer')
    expect(setWatchdogPhase('conversation:save')).toBe('tool:outer')
    setWatchdogPhase(outer)
    expect(setWatchdogPhase('tool:outer')).toBe(outer) // 同值不追加历史（幂等）
    setWatchdogPhase('idle')
  })
})
