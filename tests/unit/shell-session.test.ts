// Agent 持久 shell 会话单测（plan28 D-085 S2）。真跑 shell（Windows cmd.exe / POSIX bash）——
// 会话复用的核心价值（cd/env 跨步存活）恰恰依赖真实 shell 语义，mock 掉就测了个寂寞。
// 命令都是毫秒级 echo/cd，跑得快；收尾 disposeAllShellSessions 兜底清理。

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createShellSession, disposeAllShellSessions } from '@main/agent/tools/shell-session'

const isWin = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'jsl-shell-session-'))
mkdirSync(join(root, 'sub'))

const sessions: ReturnType<typeof createShellSession>[] = []
const makeSession = (): ReturnType<typeof createShellSession> => {
  const s = createShellSession(root)
  sessions.push(s)
  return s
}

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

afterAll(async () => {
  disposeAllShellSessions()
  // taskkill 异步生效：等句柄释放再删临时目录（删不掉也无害 —— tmpdir 系统会清）
  await new Promise((r) => setTimeout(r, 500))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('shell 会话 · 状态跨步存活（D-085 的核心诉求）', () => {
  it('cd 跨调用存活：进子目录后，下一条命令还在里面', async () => {
    const s = makeSession()
    const cd = await s.run(isWin ? 'cd sub' : 'cd sub', 10_000)
    expect(cd.exitCode).toBe(0)
    const where = await s.run(isWin ? 'cd' : 'pwd', 10_000)
    expect(where.exitCode).toBe(0)
    expect(where.stdout).toContain('sub')
  })

  it('环境变量跨调用存活', async () => {
    const s = makeSession()
    const set = await s.run(isWin ? 'set JSL_TEST_VAL=hello-session' : 'export JSL_TEST_VAL=hello-session', 10_000)
    expect(set.exitCode).toBe(0)
    const read = await s.run(isWin ? 'echo %JSL_TEST_VAL%' : 'echo $JSL_TEST_VAL', 10_000)
    expect(read.stdout).toContain('hello-session')
  })
})

describe('shell 会话 · 失败分型与生命周期', () => {
  it('命令失败 → 退出码如实带出，会话还活着（下一条照常跑）', async () => {
    const s = makeSession()
    // 子 shell 里失败：cmd 用 `cmd /c exit 3`（只设 ERRORLEVEL 不杀会话）；bash 用子 shell
    const fail = await s.run(isWin ? 'cmd /c exit 3' : '(exit 3)', 10_000)
    expect(fail.exitCode).toBe(3)
    expect(fail.timedOut).toBe(false)
    expect(fail.exceeded).toBe(false)
    const after = await s.run(isWin ? 'echo still-alive' : 'echo still-alive', 10_000)
    expect(after.stdout).toContain('still-alive')
  })

  it('超时 → 杀树 + 如实回报 + 会话作废，下一条命令用新会话照常跑', async () => {
    const s = makeSession()
    const stuck = await s.run(
      isWin ? 'node -e "setInterval(function(){},1000)"' : 'sleep 30',
      1_500
    )
    expect(stuck.timedOut).toBe(true)
    // 会话已被超时杀掉 → 下一条命令重开新会话，功能不受影响
    const next = await s.run(isWin ? 'echo fresh-session' : 'echo fresh-session', 10_000)
    expect(next.stdout).toContain('fresh-session')
    expect(next.timedOut).toBe(false)
  })

  it('连续多条命令：序号标记不串扰，输出与命令一一对应', async () => {
    const s = makeSession()
    const a = await s.run(isWin ? 'echo AAA' : 'echo AAA', 10_000)
    const b = await s.run(isWin ? 'echo BBB' : 'echo BBB', 10_000)
    expect(a.stdout).toContain('AAA')
    expect(a.stdout).not.toContain('BBB')
    expect(b.stdout).toContain('BBB')
    expect(b.stdout).not.toContain('AAA')
    // 协议回声（@JSL-DONE-n@）不残留在输出里
    expect(a.stdout).not.toContain('@JSL-DONE')
    expect(b.stdout).not.toContain('@JSL-DONE')
  })

  it('dispose 后状态清零：重新 run 会开新会话（从工作区根开始）', async () => {
    const s = makeSession()
    await s.run(isWin ? 'cd sub' : 'cd sub', 10_000)
    s.dispose()
    const fresh = await s.run(isWin ? 'cd' : 'pwd', 10_000)
    expect(fresh.exitCode).toBe(0)
    expect(fresh.stdout).not.toContain('sub')
  })

  it('spawn 起不来（cwd 不存在 → ENOENT）→ 立即以 spawnError 结算，不挂死', async () => {
    // 回归（2026-09-16）：error 事件只标状态不结算 promise、close 认亲守卫又拦住结算，
    // 曾把 run_command 在 vitest 里吊死 5 秒（runner.test 完全访问档）。正确语义：
    // 起不来 = spawnError，调用方（system-tools）回落一次性 exec。
    const bogus = createShellSession(join(root, 'no-such-dir-xyz'))
    sessions.push(bogus)
    const r = await bogus.run('echo hi', 10_000)
    expect(r.spawnError).not.toBeNull()
    expect(r.exitCode).toBeNull()
    expect(r.stdout).toBe('')
  })
})
