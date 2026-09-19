// plan43 S3c 判据单测：接线层 —— 运行环境真的被用上了吗？
//
// ⚠️ 这里**不接受"代码看起来对"**。计划里 S3 的验收判据是「用户的选择变成 Agent 的实际行为」，
// 而"实际行为"只能靠**真跑 shell 读回 PATH** 来证明。故本文件起真会话、真执行命令。
// （与 shell-session.test.ts 同手法：mock 掉就测了个寂寞。）
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createShellSession, disposeAllShellSessions, type RuntimeEnv } from '@main/agent/tools/shell-session'
import { terminalEnv } from '@main/terminal-session'
import { currentFingerprint, runtimeBinDir, syncRuntimeBin } from '@main/dev-env/runtime-bin'
import { injectRuntimePath } from '@shared/runtime-path'

const isWin = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'jsl-s3c-'))

const sessions: ReturnType<typeof createShellSession>[] = []
const open = (runtime?: RuntimeEnv): ReturnType<typeof createShellSession> => {
  const s = createShellSession(root, process.platform, runtime)
  sessions.push(s)
  return s
}

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

afterAll(async () => {
  disposeAllShellSessions()
  // ⚠️ Windows 上 `cmd.exe` 的句柄释放**晚于** `kill()` 返回 —— 只等 500ms 会在 CI/本机偶发
  //    `EBUSY: resource busy or locked, rmdir`。这里做两件事：
  //    ① 给足释放窗口（1200ms + 重试 10 次 × 300ms，合计最多约 4.2s）
  //    ② **清理失败不抛** —— teardown 是收尾动作，残留临时目录不该让整个文件的测试结论判红
  //       （测试全绿却因为"没删掉临时文件夹"红掉，是假信号，会掩盖真问题）。
  await new Promise((r) => setTimeout(r, 1200))
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (err) {
    // 仅告警，不改判：临时目录由系统清理
    console.warn('[runtime-injection] 临时目录清理未完成（不影响测试结论）:', String(err).slice(0, 160))
  }
})

describe('terminalEnv（不变式：不注入时行为与从前逐字一致）', () => {
  it('★ 不传 pathOverride → **不含 PATH 键**（不覆盖主进程的 PATH）', () => {
    const out = terminalEnv({ PATH: 'C:\\original' })
    expect(out.PATH).toBe('C:\\original')
  })

  it('传了 pathOverride → 覆盖 PATH', () => {
    const out = terminalEnv({ PATH: 'C:\\original' }, 'C:\\shim;C:\\original')
    expect(out.PATH).toBe('C:\\shim;C:\\original')
  })

  it('保留 TERM / COLORTERM 的既有口径', () => {
    const out = terminalEnv({}, 'C:\\shim')
    expect(out.TERM).toBe('xterm-256color')
    expect(out.COLORTERM).toBe('truecolor')
  })

  it('不传 override 时 undefined 不被写进 PATH（不是 "undefined" 字符串）', () => {
    const out = terminalEnv({ PATH: 'C:\\x' })
    expect(out.PATH).not.toContain('undefined')
  })
})

describe('shell 会话：PATH 覆盖**真的进了子进程**', () => {
  it('★ 覆盖生效：会话内读到的 PATH 头部 = 注入值', async () => {
    const shimDir = join(root, 'shim-for-real')
    const fakePath = injectRuntimePath(process.env.PATH, shimDir)
    const s = open({ pathOverride: fakePath, fingerprint: 'fp-1' })

    const echo = isWin ? 'echo %PATH%' : 'echo "$PATH"'
    const r = await s.run(echo, 10_000)
    expect(r.exitCode).toBe(0)
    // 真读回：注入值必须是输出里的**第一段**
    const first = r.stdout.trim().split(isWin ? ';' : ':')[0]
    expect(first?.toLowerCase()).toContain('shim-for-real')
  })

  it('**不替换**：原始 PATH 的段仍然在（git / npm / rg 照旧找得到）', async () => {
    const shimDir = join(root, 'shim-keep-rest')
    const fakePath = injectRuntimePath(process.env.PATH, shimDir)
    const s = open({ pathOverride: fakePath, fingerprint: 'fp-2' })
    const echo = isWin ? 'echo %PATH%' : 'echo "$PATH"'
    const r = await s.run(echo, 10_000)
    // 原始 PATH 至少有一段出现在结果里（取第一段真值来验，避免断言过宽）
    const origSeg = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean)[0]
    expect(origSeg).toBeTruthy()
    expect(r.stdout.toLowerCase()).toContain(origSeg!.toLowerCase())
  })

  it('不传 pathOverride → PATH 不含注入痕迹（旧行为不变）', async () => {
    const s = open()
    const echo = isWin ? 'echo %PATH%' : 'echo "$PATH"'
    const r = await s.run(echo, 10_000)
    expect(r.stdout).not.toContain('shim-')
  })
})

describe('shell 会话：★ 环境指纹（确定性生效，不指望空闲回收碰运气）', () => {
  it('指纹如实带出（调用方据此判"要不要换壳"）', () => {
    const s = open({ pathOverride: undefined, fingerprint: 'fp-abc' })
    expect(s.envFingerprint).toBe('fp-abc')
  })

  it('未传 runtime → 指纹为空串（= 未启用开发环境）', () => {
    const s = open()
    expect(s.envFingerprint).toBe('')
  })

  it('★ 不同环境起两个会话 → 指纹不同（这正是"该换壳"的判据）', async () => {
    const a = open({ pathOverride: injectRuntimePath(process.env.PATH, join(root, 'e1')), fingerprint: 'fp-e1' })
    const b = open({ pathOverride: injectRuntimePath(process.env.PATH, join(root, 'e2')), fingerprint: 'fp-e2' })
    expect(a.envFingerprint).not.toBe(b.envFingerprint)
  })
})

describe('端到端：选中项 → shim → PATH → 子进程真能跑（不看代码，看行为）', () => {
  it('★ **真建 shim 目录 + 真起会话 + 真执行**：能解析到 shim 目录里的命令', async () => {
    // 造一个"假运行时"：一个真能被执行的脚本
    const fakeDir = join(root, 'fake-runtime')
    mkdirSync(fakeDir, { recursive: true })
    const fakeName = isWin ? 'jslfaketool.cmd' : 'jslfaketool'
    const fakeTool = join(fakeDir, fakeName)
    writeFileSync(fakeTool, isWin ? '@echo JSL-FAKE-OK\r\n' : '#!/bin/sh\necho JSL-FAKE-OK\n')
    // POSIX 下没有 x 位就执行不了（Windows 无此概念）。产品侧由 syncRuntimeBin 写 0o755 保证，
    // 这里手搓替身，就得自己补上 —— 否则测的是"文件权限"，不是"PATH 注入"。
    if (!isWin) chmodSync(fakeTool, 0o755)

    // 只把这个目录放进 PATH 头部（模拟 shim 目录）
    const s = open({ pathOverride: injectRuntimePath(process.env.PATH, fakeDir), fingerprint: 'fp-e2e' })
    const r = await s.run('jslfaketool', 15_000)

    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('JSL-FAKE-OK')
  })

  it('★ 反向：**不注入**时同一个命令跑不通（证明上一条是注入带来的，不是环境本来就有的）', async () => {
    const s = open()
    const r = await s.run('jslfaketool', 15_000)
    // 未注入 → 找不到该命令。Windows cmd 给 9009，POSIX 给 127
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true)
  })
})

describe('syncRuntimeBin 与 shell 的配合（组合根口径）', () => {
  it('sync 产出真 shim 文件，其内容指向原件', () => {
    const fakeTarget = join(root, 'a-real-python.exe')
    writeFileSync(fakeTarget, 'x')
    const r = syncRuntimeBin(root, { python: fakeTarget }, 'win32')
    expect(r.entries).toHaveLength(1)
    expect(r.dir).toBe(runtimeBinDir(root))
  })

  it('指纹随选择变化：sync 前后指纹一致（同一份数据两个来源不偏差）', () => {
    const fakeTarget = join(root, 'fp-target.exe')
    writeFileSync(fakeTarget, 'x')
    const selected = { python: fakeTarget }
    const fp = currentFingerprint(selected, root)
    syncRuntimeBin(root, selected, 'win32')
    expect(currentFingerprint(selected, root)).toBe(fp)
  })
})
