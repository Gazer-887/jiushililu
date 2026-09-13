// 终端会话层单测（plan14 批 C · C2，**真 PTY 版**）
//
// 这一层守的东西全都该被测到，而且都能在 CI 上测（它不 import electron）：
//   ① 只读档**在启动处**就被拒（plan7 批 C 的验收原文）
//   ② cwd 不存在时给**人话**（不是 `spawn xxx ENOENT` 那种把人带偏的文案）
//   ③ 输出缓冲超限从头部丢、并置 `truncated`
//   ④ **序号单调** —— "切走再切回不重不漏"的唯一依据
//   ⑤ kill 的状态**由我们置位**，不被退出码覆盖
//   ⑥ 切工作区 → 旧会话收掉、新会话在新目录起
//   ⑦ resize 真的透传给 pty（不传的话 vim/进度条会画错）
//
// 大部分用例用**假 pty**（可控、快、且**不必加载原生二进制**）；最后一条用真 node-pty
// 做端到端 —— 那一条同时也是"CI 到底能不能构建原生模块"的早期警报。

import { describe, expect, it } from 'vitest'
import {
  createTerminalSessionStore,
  defaultShell,
  MAX_BUFFER_CHARS,
  terminalEnv,
  type PtyLike,
  type PtyModuleLike,
  type TerminalPermission
} from '@main/terminal-session'

/**
 * 假 pty。
 *
 * ⚠️ pid 用一个**不可能存在的巨大值**：Windows 分支会真的去 spawn
 * `taskkill /pid <pid> /T /F`，随便挑个小数字有**误杀真实进程**的风险。
 */
class FakePty implements PtyLike {
  pid = 999999
  writes: string[] = []
  resizes: [number, number][] = []
  killed = false
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null

  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb
  }
  write(d: string): void {
    this.writes.push(d)
  }
  resize(c: number, r: number): void {
    this.resizes.push([c, r])
  }
  kill(): void {
    this.killed = true
  }
  /** 背压计数：断言"该暂停时暂停一次、该恢复时才恢复" */
  pauseCount = 0
  resumeCount = 0
  pause(): void {
    this.pauseCount += 1
  }
  resume(): void {
    this.resumeCount += 1
  }
  /** 测试用：喂一段输出 */
  feed(d: string): void {
    this.dataCb?.(d)
  }
  /** 测试用：模拟进程自己退出 */
  exit(code: number): void {
    this.exitCb?.({ exitCode: code })
  }
}

interface SpawnCall {
  file: string
  args: string[]
  opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; name: string }
}

function setup(opts?: {
  permission?: TerminalPermission
  /** 可变的权限档（模拟"会话跑着的时候用户在设置里降档"） */
  permissionGetter?: () => TerminalPermission
  root?: string
  exists?: boolean
  platform?: NodeJS.Platform
  spawnThrows?: boolean
  /** 冻结时间用：验"同一毫秒内重启，id 也不许撞" */
  now?: () => number
}) {
  const ptys: FakePty[] = []
  const calls: SpawnCall[] = []
  const ptyModule: PtyModuleLike = {
    spawn(file, args, o) {
      if (opts?.spawnThrows) throw new Error('模拟 spawn 失败')
      calls.push({ file, args, opts: o })
      const p = new FakePty()
      ptys.push(p)
      return p
    }
  }
  const store = createTerminalSessionStore({
    getPermission: opts?.permissionGetter ?? (() => opts?.permission ?? 'write'),
    getWorkspaceRoot: () => opts?.root ?? 'D:/ws',
    exists: () => opts?.exists ?? true,
    platform: opts?.platform ?? 'win32',
    now: opts?.now,
    pty: ptyModule
  })
  return { store, ptys, calls, last: () => ptys[ptys.length - 1]! }
}

describe('只读权限档：在**启动处**就拒绝（不只是把按钮变灰）', () => {
  it('read-only → 拒绝启动、给人话、**而且没有起进程**', () => {
    const { store, ptys } = setup({ permission: 'read-only' })
    const r = store.start()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('read-only')
    expect(r.message).toContain('只读')
    expect(ptys).toHaveLength(0) // 关键：拦在 spawn 之前
    expect(store.current()).toBeNull()
  })

  it('write / full-access → 允许启动', () => {
    for (const p of ['write', 'full-access'] as TerminalPermission[]) {
      const { store } = setup({ permission: p })
      expect(store.start().ok).toBe(true)
    }
  })

  it('被拒绝之后**重启也还是拒绝**（不能因为"重试"就放行）', () => {
    const { store } = setup({ permission: 'read-only' })
    store.start()
    expect(store.restart().ok).toBe(false)
  })
})

describe('启动：幂等 / cwd / 尺寸 / 环境', () => {
  it('同一工作区重复 start → **同一个会话**，只起了一个进程', () => {
    const { store, ptys } = setup()
    const a = store.start()
    const b = store.start()
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.session.id).toBe(a.session.id)
    expect(ptys).toHaveLength(1)
  })

  it('**cwd 不存在时给人话**，且不起进程', () => {
    const { store, ptys } = setup({ exists: false })
    const r = store.start()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('cwd-missing')
    expect(r.message).toContain('工作区不存在')
    expect(ptys).toHaveLength(0)
  })

  it('spawn 抛错 → spawn-failed（**如实转述**，不吞）', () => {
    const { store } = setup({ spawnThrows: true })
    const r = store.start()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('spawn-failed')
    expect(r.message).toContain('模拟 spawn 失败')
  })

  it('起的命令与尺寸都按参数走（**cwd 必须是工作区**）', () => {
    const { store, calls } = setup({ root: 'D:/my-proj' })
    store.start({ cols: 120, rows: 33 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts.cwd).toBe('D:/my-proj')
    expect(calls[0]!.opts.cols).toBe(120)
    expect(calls[0]!.opts.rows).toBe(33)
    expect(calls[0]!.opts.name).toBe('xterm-256color')
    expect(calls[0]!.file).toBe('powershell.exe')
  })

  it('**切了工作区 → 旧会话收掉、新会话在新目录起**', () => {
    let root = 'D:/ws-a'
    const ptys: FakePty[] = []
    const calls: SpawnCall[] = []
    const store = createTerminalSessionStore({
      getPermission: () => 'write',
      getWorkspaceRoot: () => root,
      exists: () => true,
      platform: 'win32',
      pty: {
        spawn(file, args, o) {
          calls.push({ file, args, opts: o })
          const p = new FakePty()
          ptys.push(p)
          return p
        }
      }
    })

    const a = store.start()
    expect(a.ok).toBe(true)
    if (!a.ok) return
    root = 'D:/ws-b'
    const b = store.start()
    expect(b.ok).toBe(true)
    if (!b.ok) return

    expect(b.session.id).not.toBe(a.session.id)
    expect(b.session.workspaceRoot).toBe('D:/ws-b')
    expect(calls[1]!.opts.cwd).toBe('D:/ws-b')
    expect(ptys).toHaveLength(2)
    // ⚠️ 断言**可观察的状态**，不是"`child.kill()` 有没有被调用"：
    //    Windows 分支走 `taskkill /T /F`（按 pid），**根本不碰 `kill()`** ——
    //    第一版我就是那么断言的，于是用例红了而实现是对的。
    expect(a.session.status).toBe('killed')
  })
})

describe('输出缓冲与序号（"切走再切回不重不漏"的全部依据）', () => {
  it('序号**从 1 开始且单调**，nextSeq 始终是"下一个要发的"', () => {
    const { store, last } = setup()
    store.start()
    last().feed('a')
    last().feed('b')
    const snap = store.current()!
    expect(snap.chunks.map((c) => c.seq)).toEqual([1, 2])
    expect(snap.nextSeq).toBe(3)
  })

  it('onData 推的是**增量**，带同一套序号（渲染层按它去重）', () => {
    const { store, last } = setup()
    store.start()
    const got: string[] = []
    store.onData((_id, c) => got.push(`${c.seq}:${c.data}`))
    last().feed('\x1b[31m红\x1b[0m')
    last().feed('\r\n')
    expect(got).toEqual(['1:\x1b[31m红\x1b[0m', '2:\r\n'])
  })

  it('缓冲超限 → **从头部丢**、置 truncated、序号继续往前走（不回头）', () => {
    const { store, last } = setup()
    store.start()
    const big = 'x'.repeat(50 * 1024)
    for (let i = 0; i < 8; i++) last().feed(big) // 400KB > 200KB 上限
    const snap = store.current()!
    expect(snap.truncated).toBe(true)
    expect(snap.chunks.reduce((s, c) => s + c.data.length, 0)).toBeLessThanOrEqual(MAX_BUFFER_CHARS)
    const seqs = snap.chunks.map((c) => c.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(snap.nextSeq).toBe(9) // 8 段都发过
  })
})

describe('只读档：**运行期**也要现查（不是只在启动处拦一次）', () => {
  it('会话跑着时降到只读 → write / resize 立刻被拒，pty 一个字节都没收到', () => {
    let perm: TerminalPermission = 'write'
    const { store, ptys } = setup({ permissionGetter: () => perm })
    expect(store.start().ok).toBe(true)
    const p = ptys[0]!

    perm = 'read-only' // 用户在设置里降档（会话仍在跑）

    const w = store.write('whoami\r')
    expect(w.ok).toBe(false)
    if (!w.ok) expect(w.message).toContain('只读')
    store.resize(132, 40)
    expect(p.writes).toHaveLength(0)
    expect(p.resizes).toHaveLength(0)
  })

  it('只读档下点「重启终端」→ **拒绝且无副作用**（不许先把会话杀掉再报错）', () => {
    let perm: TerminalPermission = 'write'
    const { store, ptys } = setup({ permissionGetter: () => perm })
    store.start()
    const p = ptys[0]!
    p.feed('老会话的输出\n')

    perm = 'read-only'
    const r = store.restart()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('read-only')
    // 关键：会话**没被杀**、缓冲**没被丢** —— 用户视角不该是"点了一下终端没了"
    expect(p.killed).toBe(false)
    expect(store.current()?.status).toBe('running')
    expect(store.current()!.chunks).toHaveLength(1)
  })
})

describe('会话身份：旧 pty 的迟到输出不许记到新会话头上', () => {
  it('重启之后，旧 pty 再喂数据 → 新会话的缓冲与序号都不受影响', () => {
    const { store, ptys } = setup()
    store.start()
    const first = ptys[0]!
    first.feed('OLD\n')
    expect(store.current()!.chunks[0]!.data).toBe('OLD\n')

    store.restart() // teardown 是异步的：旧 pty 这时**还没真死**
    const second = ptys[1]!
    expect(second).not.toBe(first)
    expect(store.current()!.nextSeq).toBe(1)

    first.feed('STALE\n') // 旧 shell 临终前的一口气 —— 老实现会把它记成新会话的帧
    const snap = store.current()!
    expect(snap.chunks).toHaveLength(0)
    expect(snap.nextSeq).toBe(1)
  })

  it('旧 pty 的 onExit 也不许把新会话的状态改掉', () => {
    const { store, ptys } = setup()
    store.start()
    const first = ptys[0]!
    store.restart()
    first.exit(3) // 旧进程此刻才真正退出
    expect(store.current()!.status).toBe('running')
    expect(store.current()!.exitCode).toBeUndefined()
  })
})

describe('会话 id：**必须唯一**（毫秒时间戳会撞号，撞了界面就认不出"换了会话"）', () => {
  it('时间被冻在同一毫秒时，restart 出来的新会话 id 仍与旧的不同', () => {
    // 为什么这条非有不可：`restart()` = teardown（旧 pty 已为 null 时是纯内存操作、0ms）→ start，
    // 两次取时间戳完全可能同毫秒 → 新旧同 id → 渲染层判定"还是同一个会话"→
    // 不重放、`nextSeq` 停在旧高位 → 新 shell 的输出被逐帧丢弃（屏幕死寂但状态是"运行中"）。
    const { store } = setup({ now: () => 1_700_000_000_000 })
    const a = store.start()
    store.kill()
    const b = store.restart()
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.session.id).not.toBe(a.session.id)
  })
})

describe('背压（ACK 流控）：xterm 顶到 50MB 会**抛异常丢数据**，所以必须在途限流', () => {
  it('未回执字符越过高水位 → 暂停 pty；回执到低水位以下才恢复（滞回，不抖）', () => {
    const { store, ptys } = setup()
    store.start()
    const p = ptys[0]!
    const id = store.current()!.id
    const piece = 'x'.repeat(64 * 1024) // 64KB 一片

    for (let i = 0; i < 5; i++) p.feed(piece) // 320KB > 256KB 高水位
    expect(p.pauseCount).toBe(1) // 只暂停一次，不是每片都暂停

    store.ack(id, 64 * 1024)
    expect(p.resumeCount).toBe(0) // 还剩 256KB 未回执，仍在阈值之上 —— 不许抖
    store.ack(id, 256 * 1024)
    expect(p.resumeCount).toBe(1)
  })

  it('回执**对不上会话**（重启后迟到的回执）→ 丢弃，别把新会话的状态改掉', () => {
    const { store, ptys } = setup()
    store.start()
    const oldId = store.current()!.id
    const piece = 'y'.repeat(64 * 1024)
    for (let i = 0; i < 5; i++) ptys[0]!.feed(piece)
    expect(ptys[0]!.pauseCount).toBe(1)

    store.restart()
    const second = ptys[1]!
    store.ack(oldId, 10 * 1024 * 1024)
    expect(second.resumeCount).toBe(0)
  })

  it('假 pty 没实现 pause/resume → 静默降级，不许抛（背压是尽力而为，不是正确性依赖）', () => {
    let feed: ((d: string) => void) | null = null
    const store = createTerminalSessionStore({
      getPermission: () => 'write',
      getWorkspaceRoot: () => 'D:/ws',
      exists: () => true,
      platform: 'win32',
      pty: {
        spawn() {
          return {
            pid: 999999,
            onData(cb: (d: string) => void) {
              feed = cb
            },
            onExit() {},
            write() {},
            resize() {},
            kill() {}
          } as PtyLike
        }
      }
    })
    store.start()
    expect(() => feed?.('z'.repeat(300 * 1024))).not.toThrow()
    expect(store.current()!.chunks).toHaveLength(1)
  })

  it('**单段**就超过缓冲上限时也要截断（"保住最后一段"的循环会漏掉这种输入）', () => {
    const { store, ptys } = setup()
    store.start()
    ptys[0]!.feed('A'.repeat(MAX_BUFFER_CHARS + 5000) + 'TAIL')
    const snap = store.current()!
    expect(snap.truncated).toBe(true)
    const total = snap.chunks.reduce((n, c) => n + c.data.length, 0)
    expect(total).toBeLessThanOrEqual(MAX_BUFFER_CHARS)
    expect(snap.chunks[0]!.data.endsWith('TAIL')).toBe(true) // 留的是**尾部**（刚发生的事）
  })

  it('resync（重放后的重对齐）→ 未回执清零并恢复 pty，之后能重新计数', () => {
    // 场景：切走页签期间没人回执（订阅退了、主进程照旧推）→ 水位越线把 pty 按住 →
    // 切回来只有重放、没有任何回执 → 不复位就**永远静止**。
    const { store, ptys } = setup()
    store.start()
    const p = ptys[0]!
    const id = store.current()!.id
    for (let i = 0; i < 5; i++) p.feed('x'.repeat(64 * 1024))
    expect(p.pauseCount).toBe(1)

    store.resync(id)
    expect(p.resumeCount).toBe(1)

    // 清零之后要能重新累计（不是"永久免疫"）
    for (let i = 0; i < 5; i++) p.feed('x'.repeat(64 * 1024))
    expect(p.pauseCount).toBe(2)
  })

  it('resync 对不上会话 → 不动（不许把新会话的状态改了）', () => {
    const { store, ptys } = setup()
    store.start()
    const oldId = store.current()!.id
    for (let i = 0; i < 5; i++) ptys[0]!.feed('y'.repeat(64 * 1024))
    store.restart()
    store.resync(oldId)
    expect(ptys[1]!.resumeCount).toBe(0)
  })
})

describe('输入 / resize / 终止', () => {
  it('write 写的是**原始按键**，**不加换行**（真 PTY 下 shell 自己管行编辑）', () => {
    const { store, last } = setup()
    store.start()
    expect(store.write('l')).toEqual({ ok: true })
    expect(store.write('s')).toEqual({ ok: true })
    expect(store.write('\r')).toEqual({ ok: true })
    expect(last().writes).toEqual(['l', 's', '\r']) // 若是"写整行"，这里会多出 \n
  })

  it('**resize 透传给 pty**，并记进快照（不传的话 vim/进度条会画错）', () => {
    const { store, last } = setup()
    store.start({ cols: 80, rows: 24 })
    store.resize(132, 40)
    expect(last().resizes).toEqual([[132, 40]])
    expect(store.current()!.cols).toBe(132)
    expect(store.current()!.rows).toBe(40)
  })

  it('尺寸没变 → **不烦 pty**（拖拽会高频触发 fit）', () => {
    const { store, last } = setup()
    store.start({ cols: 80, rows: 24 })
    store.resize(80, 24)
    store.resize(80, 24)
    expect(last().resizes).toEqual([])
  })

  it('会话结束后再写 → 给人话，不抛错', () => {
    const { store, last } = setup()
    store.start()
    last().exit(0)
    const r = store.write('x')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('重启终端')
  })

  it('进程自己退出 → exited + 退出码', () => {
    const { store, last } = setup()
    store.start()
    last().exit(0)
    expect(store.current()?.status).toBe('exited')
    expect(store.current()?.exitCode).toBe(0)
  })

  it('**kill 之后 onExit 不许把状态改回 exited**（我们杀的不算"程序自己退出"）', () => {
    const { store, last } = setup()
    store.start()
    expect(store.kill()).toBe(true)
    expect(store.current()?.status).toBe('killed')
    last().exit(1) // 被杀时拿到的终止码，不是程序退出码
    expect(store.current()?.status).toBe('killed')
  })

  it('killAll（窗口关闭的挂点）→ 会话终止', () => {
    const { store, last } = setup()
    const r = store.start()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    store.killAll()
    expect(r.session.status).toBe('killed')
    expect(last().killed).toBe(true)
    expect(store.current()).toBeNull()
  })

  it('restart → 旧会话终止、新会话在新 id 上', () => {
    const { store, ptys } = setup()
    const first = store.start()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const r = store.restart()
    expect(r.ok).toBe(true)
    expect(ptys).toHaveLength(2)
    expect(first.session.status).toBe('killed')
    if (r.ok) expect(r.session.id).not.toBe(first.session.id)
  })
})

describe('shell 与环境变量（每一条都是"不做就会踩"的）', () => {
  it('Windows → powershell 且**必须带 -NoProfile**（裸启动实测 5865ms vs 307ms）', () => {
    const s = defaultShell('win32')
    expect(s.file).toBe('powershell.exe')
    expect(s.args).toContain('-NoProfile')
    expect(s.label).toContain('未加载') // 代价要写在界面上（conda 等环境不生效）
  })

  it('非 Windows → bash', () => {
    expect(defaultShell('linux').file).toBe('bash')
  })

  it('env 里给足"我像个终端"的信号（TERM / COLORTERM），但**不设 FORCE_COLOR**', () => {
    const env = terminalEnv({ PATH: '/x' })
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.PATH).toBe('/x') // 原有环境要保留
    // 真 PTY 下程序自己就是 TTY、本来就有颜色；再强制一次只会让
    // `工具 > 文件` 这种重定向场景也带 ANSI 转义 —— 属于"善意的越权"，不做。
    expect(env.FORCE_COLOR).toBeUndefined()
  })

  it('**不动用户的 NO_COLOR**（那是显式信号），也**不设会改变程序行为的开关**', () => {
    const env = terminalEnv({ NO_COLOR: '1' })
    expect(env.NO_COLOR).toBe('1')
    // PYTHONUNBUFFERED 会改变用户程序的运行时行为 —— 那属于"善意的越权"，不做
    expect(env.PYTHONUNBUFFERED).toBeUndefined()
  })

  it('用户自己设了 TERM 就别覆盖他的', () => {
    expect(terminalEnv({ TERM: 'screen-256color' }).TERM).toBe('screen-256color')
  })
})

describe('真 node-pty 端到端（同时也是"CI 能不能构建原生模块"的早期警报）', () => {
  it('起真会话 → 敲命令 → 收到输出 → kill', async () => {
    const pty = (await import('node-pty')) as unknown as PtyModuleLike
    const store = createTerminalSessionStore({
      getPermission: () => 'write',
      getWorkspaceRoot: () => process.cwd(),
      pty
    })

    const r = store.start({ cols: 100, rows: 30 })
    expect(r.ok, '真 node-pty 起不来 —— 原生模块没构建成功？').toBe(true)
    if (!r.ok) return

    let buf = ''
    store.onData((_id, c) => {
      buf += c.data
    })
    // 判据：`JSL_PTY_42` 这个串**只可能由 shell 执行产生**。
    // 敲进去的原文是 `JSL_PTY_$((6*7))` —— bash 与 PowerShell 都会把 `$((6*7))` 算成 42，
    // 而**一行回显/重绘无论怎么拼都拼不出 `JSL_PTY_42`**（原文里根本没有那两个字符）。
    // 顺带这也是跨平台的：不依赖"回显与执行输出恰好相邻"（Windows conpty 与 Linux tty
    // 的回显形态不同，相邻性在 Linux 上不成立）。
    expect(store.write('echo JSL_PTY_$((6*7))\r').ok).toBe(true)

    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !buf.includes('JSL_PTY_42')) {
      await new Promise((res) => setTimeout(res, 120))
    }
    expect(buf, '真 PTY 没执行出结果（只回显了命令行 = 背后没有真 shell）').toContain('JSL_PTY_42')

    store.killAll()
    expect(store.current()).toBeNull()
  }, 20000)
})
