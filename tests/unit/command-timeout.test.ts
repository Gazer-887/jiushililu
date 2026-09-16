import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSystemTools } from '@main/agent/tools/system-tools'
import type { AgentTool } from '@shared/agent'

// run_command 的超时与输出上限（plan28 D-086 / D-088）。
//
// 这组用例盯的是一个**误导性报错**：改造前，超时与输出超限都被报成「命令执行出错」。
// 而这两件事都不是"命令错了"—— 一个是我们的耐心用完了，一个是我们的缓冲满了。
// 模型看不懂这个区别，就会去读 stderr 找不存在的 bug，或者以为命令真的失败而重试。
// 所以断言的重点是**报错文案必须说清"这是谁的问题"**，而不只是"返回了非空字符串"。

const cmd = (root: string): AgentTool => createSystemTools(root).find((t) => t.schema.name === 'run_command')!

const root = mkdtempSync(join(tmpdir(), 'jsl-cmd-timeout-'))

/** 跨平台地"睡一会儿"：不依赖 sleep 命令是否存在 */
const sleepCmd = (ms: number): string => `node -e "setTimeout(function(){}, ${ms})"`

describe('run_command · 超时可调（D-086）', () => {
  it('默认能跑通一条快命令', async () => {
    const out = await cmd(root).execute({ command: 'node -e "console.log(12345)"' })
    expect(out).toContain('12345')
    expect(out).toContain('[stdout]')
  })

  it('timeoutMs 超过上限 → **拒绝执行**（不静默夹取）', async () => {
    const out = await cmd(root).execute({ command: 'node -e "console.log(1)"', timeoutMs: 999_999 })
    expect(out).toContain('超出允许范围')
    expect(out).toContain('background=true') // 指条明路，而不是只说"不行"
    expect(out).not.toContain('[stdout]') // 确实没跑
  })

  it('timeoutMs 低于下限 → 拒绝', async () => {
    const out = await cmd(root).execute({ command: 'node -e "console.log(1)"', timeoutMs: 10 })
    expect(out).toContain('超出允许范围')
  })

  it('timeoutMs 不是数字 → 人话报错', async () => {
    const out = await cmd(root).execute({ command: 'node -e "console.log(1)"', timeoutMs: 'abc' as never })
    expect(out).toContain('必须是数字')
  })

  it('放宽后的 timeoutMs 真的生效（1s 跑不完的命令在 5s 限时下能跑完）', async () => {
    const out = await cmd(root).execute({ command: sleepCmd(1500), timeoutMs: 5000 })
    expect(out).not.toContain('超时')
    expect(out).toContain('[stdout]')
  }, 15_000)

  it('**超时 ≠ 命令失败**：文案要说清是"我们不等了"，并给出放大限时的路子', async () => {
    const out = await cmd(root).execute({ command: sleepCmd(5000), timeoutMs: 1000 })
    expect(out).toContain('超时')
    expect(out).toContain('不代表命令失败')
    expect(out).toContain('timeoutMs') // 告诉模型怎么改
    expect(out).not.toContain('命令执行出错') // ← 这就是修复前的那句误导
  }, 15_000)

  it('命令自己失败（非零退出）仍如实报「执行出错」——修超时不能把真错误也放过', async () => {
    const out = await cmd(root).execute({ command: 'node -e "process.exit(3)"' })
    expect(out).toContain('命令执行出错')
    expect(out).toContain('exit=3')
  })
})

describe('run_command · 输出超限不再误报为失败（D-088）', () => {
  it('输出超过上限 → 说明是**输出上限掐的**，不是命令失败，并给出去向建议', async () => {
    // 造一段必定超上限的输出（上限 8MB）
    const out = await cmd(root).execute({
      command: 'node -e "process.stdout.write(String.fromCharCode(120).repeat(9*1024*1024))"',
      timeoutMs: 60_000
    })
    expect(out).toContain('输出超过')
    expect(out).toContain('已被终止')
    expect(out).toContain('不是命令本身失败')
    expect(out).not.toContain('命令执行出错') // ← 修复前正是这句误报
  }, 60_000)

  it('正常大小的输出原样返回，不带任何截断标记（超限提示不能变成日常噪音）', async () => {
    const out = await cmd(root).execute({ command: 'node -e "console.log(\'ok\')"' })
    expect(out).toContain('ok')
    expect(out).not.toContain('输出超过')
  })
})
