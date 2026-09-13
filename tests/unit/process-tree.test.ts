// 杀进程树单测（plan14 批 C · C1 抽出来的共享实现）—— 两组：
//   ① **分支对不对**（Windows 必须走 taskkill 且带 `/T`）—— 注入 spawn 验，快而确定
//   ② **孤儿真的死没死** —— 起真进程（父 → 孙），杀树之后看日志文件还长不长。
// ⚠️ ② 必须起真进程：实测"只杀 shell 不带 `/T`"会留孙进程继续吐输出，
//    而假 child 根本没有孙进程 —— 那种 bug 用假的验不出来。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { killProcessTree, spawnOptsForGroupKill } from '@main/process-tree'

const dirs: string[] = []

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('分支：Windows 走 taskkill，且**不许缺 /T**', () => {
  const fakeChild = (pid: number | undefined): Parameters<typeof killProcessTree>[0] =>
    ({ pid }) as unknown as Parameters<typeof killProcessTree>[0]

  it('win32 → spawn taskkill，参数里必须有 /T 与 /F 与那个 pid', () => {
    const calls: { file: string; args: string[] }[] = []
    killProcessTree(fakeChild(1234), {
      platform: 'win32',
      spawnFn: ((file: string, args: string[]) => {
        calls.push({ file, args })
        return {} as never
      }) as unknown as typeof spawn
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe('taskkill')
    expect(calls[0]!.args).toEqual(['/pid', '1234', '/T', '/F'])
    // `/T` 丢了就留孤儿（实测）；`/F` 丢了杀不干净
    expect(calls[0]!.args).toContain('/T')
    expect(calls[0]!.args).toContain('/F')
  })

  it('pid 拿不到 → 什么都不做（不瞎杀）', () => {
    const calls: unknown[] = []
    killProcessTree(fakeChild(undefined), {
      platform: 'win32',
      spawnFn: ((...a: unknown[]) => {
        calls.push(a)
        return {} as never
      }) as unknown as typeof spawn
    })
    expect(calls).toHaveLength(0)
  })

  it('POSIX → 按**进程组**杀（负号），不进 taskkill 那条路', () => {
    const spawned: unknown[] = []
    const killed: [number, NodeJS.Signals][] = []
    killProcessTree(fakeChild(4321), {
      platform: 'linux',
      spawnFn: ((...a: unknown[]) => {
        spawned.push(a)
        return {} as never
      }) as unknown as typeof spawn,
      killFn: (pid, sig) => {
        killed.push([pid, sig])
        return true
      }
    })
    expect(spawned).toHaveLength(0) // 不 spawn taskkill
    // ⚠️ **负号才是这条测试的意义**：丢了它 = 只杀 shell 自己、孙进程留成孤儿（旧版只断言"没 spawn taskkill"，去掉负号照样绿）
    expect(killed).toEqual([[-4321, 'SIGTERM']])
  })

  it('POSIX：组杀失败（不是组长 → ESRCH）→ 退化成杀它自己，且**不抛**', () => {
    const killed: number[] = []
    expect(() =>
      killProcessTree(fakeChild(4321), {
        platform: 'linux',
        killFn: (pid) => {
          killed.push(pid)
          if (pid < 0) throw new Error('ESRCH')
          return true
        }
      })
    ).not.toThrow()
    expect(killed).toEqual([-4321, 4321])
  })
})

describe('起进程的选项：POSIX 下要能按进程组杀', () => {
  it('Windows：detached 关掉（配合 windowsHide 不弹窗）', () => {
    const o = spawnOptsForGroupKill('D:/ws', 'win32')
    expect(o.cwd).toBe('D:/ws')
    expect(o.windowsHide).toBe(true)
    expect(o.detached).toBe(false)
  })

  it('POSIX 必须 detached —— 否则 `process.kill(-pid)` 会 ESRCH（"以为杀了整棵树、其实只杀了自己"）', () => {
    // 两个平台都注入：否则在 Windows 开发机上这条断言只在"自己那一支"里打转，POSIX 那支从未被验证过
    for (const p of ['linux', 'darwin'] as NodeJS.Platform[]) {
      expect(spawnOptsForGroupKill('/tmp', p).detached).toBe(true)
    }
  })

  it('默认平台走同一套判据（防"注入值对了、默认值脱节"）', () => {
    expect(spawnOptsForGroupKill('/tmp').detached).toBe(process.platform !== 'win32')
  })
})

describe('真进程：**孙进程必须跟着一起死**（否则就是留孤儿）', () => {
  it('杀掉父进程的树之后，孙进程不再往文件里写', async () => {
    const dir = tmp('jsl-tree-')
    const log = join(dir, 'orphan.log')
    writeFileSync(log, '', 'utf8')

    // 孙进程：每 150ms 追加一行（用 node 自己当"长跑子进程"，两个平台都有）
    const grandchildCode = `
      const { appendFileSync } = require('node:fs')
      setInterval(() => { try { appendFileSync(${JSON.stringify(log)}, 'tick\\n') } catch {} }, 150)
    `
    // 父进程：拉起孙进程，然后自己空转（模拟 shell → 命令 这层）
    const parentCode = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
      setInterval(() => {}, 1000)
    `

    const parent = spawn(process.execPath, ['-e', parentCode], {
      ...spawnOptsForGroupKill(dir),
      stdio: 'ignore'
    })

    await sleep(900)
    const before = existsSync(log) ? statSync(log).size : 0
    expect(before, '孙进程没写东西 —— 这条测试的前提不成立，下面的断言无意义').toBeGreaterThan(0)

    killProcessTree(parent)
    // 给它一点时间真的死掉，然后取两个采样点
    await sleep(700)
    const mid = statSync(log).size
    await sleep(900)
    const after = statSync(log).size

    expect(after, '杀完树之后文件还在长 = **留了孤儿进程**（这正是本函数存在的唯一理由）').toBe(mid)

    // 收尾：万一真留了孤儿，别把它留在机器上
    try {
      parent.kill('SIGKILL')
    } catch {
      // 已经死了
    }
  }, 15000)
})
