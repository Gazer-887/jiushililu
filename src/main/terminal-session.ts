import { existsSync } from 'node:fs'
import { killProcessTree } from './process-tree'
import type {
  TerminalChunk,
  TerminalFailReason,
  TerminalPermission,
  TerminalSessionSnapshot,
  TerminalStartResult
} from '@shared/terminal'

// 类型定义在 `@shared/terminal`（主/界面共用一份口径）；这里再导出一次省得记两个来源。⚠️ 渲染层不许 import 本文件 —— 它 import 了 node:fs。
export type {
  TerminalChunk,
  TerminalFailReason,
  TerminalPermission,
  TerminalSessionSnapshot,
  TerminalStartResult
}

// 内置终端的**会话层**（plan14 批 C · C2）—— **真 PTY** 版：伪终端（常驻 shell + 往 stdin 写整行 + 自己回显）做不到 `Ctrl+C`、Tab 补全、`vim`、任何只看 `isatty()` 的工具。
// ⚠️ pty 进程与输出缓冲必须活在主进程：本项目「**切换页签 = 卸载**」是定死的语义（plan9 §W3），而终端要的是"切走再切回来命令还在跑"，渲染层 xterm 只是**可丢弃的视图**（重挂时按序号重放）。
// ⚠️ 不 import electron（同 `checkpoints.ts` / `workspace-write.ts`）：CI 上没有 Electron 二进制，碰 electron 的模块跑不了单测 —— 故 pty 模块是**注入**的（顺带让单测不必加载原生二进制）。

/** 输出缓冲上限（字符数）。超了从**头部**丢，并置 `truncated` —— 尾部才是刚发生的事情 */
export const MAX_BUFFER_CHARS = 200 * 1024

/** **在途**流控的水位线（字符数）—— 与历史缓冲上限是**两件事**：`MAX_BUFFER_CHARS` 管内存占用，这两条管"还没被界面解析完的在途流量"。
 *  ⚠️ 必须有：xterm 的 `write()` 在 `_pendingData` 超 **50MB**（6.0.0 里内联成 `5e7`）时**直接 throw**（`write data discarded`）—— 不是"变慢"，是**整段丢弃 + 渲染进程一个未捕获异常**；官方解法就是 ACK 流控。
 *  水位取 256KB / 64KB：远低于 50MB 硬线，又留住滞回区间（避免在阈值上抖动）。 */
export const HIGH_WATERMARK = 256 * 1024
export const LOW_WATERMARK = 64 * 1024

export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

export interface TerminalShell {
  file: string
  args: string[]
  label: string
}

/** 挑一个 shell。Windows 选 **PowerShell** + `-NoProfile`：本机 Windows 实测不带它裸启动 **5865ms** 且期间零输出，带它只要 307ms。
 *  ⚠️ 但 `-NoProfile` 有代价，**界面文案必须写**：用户 profile 里加载的东西（本机实测会加载 conda 并激活环境）不生效，终端里的 `python` 可能不是他自己 PowerShell 里那个。 */
export function defaultShell(platform: NodeJS.Platform = process.platform): TerminalShell {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
      label: 'PowerShell（未加载 profile）'
    }
  }
  return { file: 'bash', args: ['-l'], label: 'bash' }
}

/** 给终端用的环境变量：**继承本机环境 + 补几个"我是终端"的信号**（不是白名单环境）；`TERM` / `COLORTERM` 只是**描述事实**（没有它很多工具直接降级成纯文本）。
 *  ⚠️ **不设 `FORCE_COLOR`**（真 PTY 下程序自己就是 TTY，再强制会让重定向到文件的场景也混进 ANSI 转义）、**不动 `NO_COLOR`**（那是用户"我不要颜色"的显式信号）、
 *     也**不设 `PYTHONUNBUFFERED`** 之类会改变用户程序运行时行为的开关 —— 那是"善意的越权"，本项目不做。 */
export function terminalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    TERM: base.TERM ?? 'xterm-256color',
    COLORTERM: base.COLORTERM ?? 'truecolor'
  }
}

export interface PtyLike {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** 背压：暂停读取。标可选 = 假 pty 可以不实现，调用侧一律 `?.()` + try 兜底 —— 背压是"尽力而为"，**不许成为正确性依赖** */
  pause?(): void
  resume?(): void
}

export interface PtyModuleLike {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv
    }
  ): PtyLike
}

export interface TerminalDeps {
  /** 当前权限档。**只读档一律拒绝启动**（plan7 批 C 的验收原文） */
  getPermission: () => TerminalPermission
  getWorkspaceRoot: () => string
  pty: PtyModuleLike
  exists?: (p: string) => boolean
  platform?: NodeJS.Platform
  shell?: TerminalShell
  now?: () => number
}

interface Session {
  snap: TerminalSessionSnapshot
  pty: PtyLike | null
  /** 缓冲里已有的字符数（**历史**，受 `MAX_BUFFER_CHARS` 约束） */
  buffered: number
  /** **已推给界面、尚未收到回执**的字符数（**在途**，受 `HIGH/LOW_WATERMARK` 约束） */
  pendingAck: number
  /** 当前是否已经把 pty 暂停（避免重复 pause / resume 打架） */
  paused: boolean
}

export interface TerminalSessionStore {
  /** 起会话（**幂等**：本工作区已有活会话就返回它） */
  start(size?: { cols: number; rows: number }): TerminalStartResult
  current(): TerminalSessionSnapshot | null
  /** 写**原始按键**（不是整行 —— 真 PTY 下 shell 自己负责行编辑/回显/补全） */
  write(data: string): { ok: true } | { ok: false; message: string }
  /** 终端尺寸变化（`fit()` 之后调）—— 不调的话 `vim`/进度条会画错 */
  resize(cols: number, rows: number): void
  ack(sessionId: string, chars: number): void
/** **重对齐**背压（界面重挂 + 重放之后调）：未回执计数清零，必要时恢复 pty。
 *  ⚠️ 必须有：面板卸载时只退订阅、**不通知主进程** —— 那些帧没人回执，越过水位就把 pty **真按住**（本机 Windows 实测 `pause()` 生效、暂停 2 秒收 0 字节），重挂后终端"活着但永远静止"，故重放结束必须补这一次。 */
  resync(sessionId: string): void
  /** 终止会话（连整棵进程树） */
  kill(): boolean
  restart(): TerminalStartResult
  onData(cb: (sessionId: string, chunk: TerminalChunk) => void): () => void
  onState(cb: (sessionId: string) => void): () => void
  killAll(): void
}

export function createTerminalSessionStore(deps: TerminalDeps): TerminalSessionStore {
  const exists = deps.exists ?? existsSync
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? process.platform
  const shell = deps.shell ?? defaultShell(platform)

  let session: Session | null = null
  let idSeq = 0
  const dataListeners = new Set<(sessionId: string, chunk: TerminalChunk) => void>()
  const stateListeners = new Set<(sessionId: string) => void>()

  const notifyState = (id: string): void => {
    for (const cb of stateListeners) cb(id)
  }

  const emitData = (s: Session, data: string): void => {
    if (data === '') return
    const chunk: TerminalChunk = { seq: s.snap.nextSeq, data }
    s.snap.nextSeq += 1
    s.snap.chunks.push(chunk)
    s.buffered += data.length
    while (s.buffered > MAX_BUFFER_CHARS && s.snap.chunks.length > 1) {
      const dropped = s.snap.chunks.shift()
      s.buffered -= dropped?.data.length ?? 0
      s.snap.truncated = true
    }
    // ⚠️ **单段本身就超限**的兜底：上面的循环刻意保住最后一段（渲染层要有个落点），于是一段巨量输出能让 `buffered` 一直超限。
    //    这里把这一段**从头部截掉**只留尾部；最坏是截断点落在 ANSI 转义中间（渲染出几个乱码字符），比内存持续增长可接受。
    if (s.buffered > MAX_BUFFER_CHARS) {
      const only = s.snap.chunks[0]
      if (only) {
        const cut = s.buffered - MAX_BUFFER_CHARS
        only.data = only.data.slice(cut)
        s.buffered -= cut
        s.snap.truncated = true
      }
    }

    s.pendingAck += data.length
    if (!s.paused && s.pendingAck > HIGH_WATERMARK) {
      s.paused = true
      try {
        s.pty?.pause?.()
      } catch {
        // 假 pty / 会话刚好结束 —— 忽略（背压尽力而为即可）
      }
    }

    for (const cb of dataListeners) cb(s.snap.id, chunk)
  }

  const teardown = (): void => {
    const s = session
    if (!s) return
    if (s.pty) {
      // 先按 pid 杀整棵树，再让 pty 自己收尾（两条路都走：pty.kill 只管它自己那层）
      killProcessTree({ pid: s.pty.pid })
      try {
        s.pty.kill()
      } catch {
        // 可能已经自己退出了 —— 幂等
      }
    }
    s.pty = null
    s.paused = false
    s.pendingAck = 0
    s.snap.status = 'killed'
    s.snap.endedAt = s.snap.endedAt ?? now()
    notifyState(s.snap.id)
  }

  const start = (size?: { cols: number; rows: number }): TerminalStartResult => {
    // ① 权限档：只读档**在启动处**就拒绝（不只是把按钮变灰 —— 主进程这一侧必须也拦）
    if (deps.getPermission() === 'read-only') {
      return {
        ok: false,
        reason: 'read-only',
        message: '当前是「只读」权限档：这台机器只读，终端不执行命令'
      }
    }

    const root = deps.getWorkspaceRoot()

    // ② 幂等：本工作区已有**活着的**会话就直接给它
    if (session && session.snap.status === 'running' && session.snap.workspaceRoot === root) {
      return { ok: true, session: session.snap }
    }

    // ②b 切了工作区 → 收掉旧会话：那个 shell 还停在**上一个项目**的目录里，留着比收掉更让人困惑（"我明明切了项目，终端还在旧项目里"）
    if (session) {
      teardown()
      session = null
    }

    // ③ cwd 必须存在：不先查的话报出来的是 `spawn powershell.exe ENOENT` —— **看着像找不到 shell，其实是找不到目录**。
    if (!exists(root)) {
      return { ok: false, reason: 'cwd-missing', message: `工作区不存在或已被移动：${root}` }
    }

    const cols = size?.cols && size.cols > 0 ? size.cols : DEFAULT_COLS
    const rows = size?.rows && size.rows > 0 ? size.rows : DEFAULT_ROWS
    // ⚠️ id **必须唯一**，不能只用时间戳：`restart()` 走 teardown → start，两次 `Date.now()` 完全可能落在**同一毫秒** →
    //    新旧会话同 id → 渲染层判定"还是同一个会话"、不 reset 不重放 → 新 shell 的输出被逐帧丢弃（状态栏写"运行中"、屏幕**彻底死寂**）。
    idSeq += 1
    const id = `term-${idSeq}-${now().toString(36)}`

    let pty: PtyLike
    try {
      pty = deps.pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: root,
        env: terminalEnv(process.env)
      })
    } catch (err) {
      return {
        ok: false,
        reason: 'spawn-failed',
        message: err instanceof Error ? err.message : String(err)
      }
    }

    const snap: TerminalSessionSnapshot = {
      id,
      cwd: root,
      workspaceRoot: root,
      shell: shell.label,
      status: 'running',
      startedAt: now(),
      cols,
      rows,
      chunks: [],
      nextSeq: 1,
      truncated: false
    }
    const self: Session = { snap, pty, buffered: 0, pendingAck: 0, paused: false }
    session = self

    // ⚠️ 闭包里**只认 `self`**，不许读外层 `session`：它会被下一次 `start()` 换掉，而旧 pty 在真正死掉之前**仍可能回调**
    //    （teardown 的 taskkill 与 pty.kill 都是异步的）→ 读外层变量会把旧 shell 临终那段输出记成**新会话**的帧，且序号还是"合法"的、界面无从分辨。
    pty.onData((data) => {
      if (session !== self || self.snap.status !== 'running') return
      emitData(self, data)
    })
    pty.onExit(({ exitCode }) => {
      // ⚠️ 退出码**只在"不是我们杀的"时候有意义**（我们 kill 时拿到的是终止码，不是程序退出码）：状态由**我们发起的 kill 动作**置位，这里不许覆盖它。
      if (session !== self || self.snap.status !== 'running') return
      self.snap.exitCode = exitCode
      self.snap.status = 'exited'
      self.snap.endedAt = now()
      self.pty = null
      notifyState(self.snap.id)
    })

    notifyState(id)
    return { ok: true, session: snap }
  }

  return {
    start,

    current() {
      return session?.snap ?? null
    },

    write(data) {
      // ⚠️ 权限档**每次现查**，不能只信 `start()` 那次检查：用户可能在会话跑着的时候把档位降到只读，只拦启动处就成了"看着被拦、其实没拦"—— 比完全不拦更坏。
      if (deps.getPermission() === 'read-only') {
        return { ok: false, message: '当前是「只读」权限档：终端不执行任何命令' }
      }
      const s = session
      if (!s || s.snap.status !== 'running' || !s.pty) {
        return { ok: false, message: '会话已经结束了 —— 点「重启终端」再试' }
      }
      s.pty.write(data)
      return { ok: true }
    },

    ack(id, chars) {
      const s = session
      // 会话对不上（重启/切工作区之后迟到的回执）就丢掉，别把计数记到新会话头上
      if (!s || s.snap.id !== id) return
      if (!Number.isFinite(chars) || chars <= 0) return
      s.pendingAck = Math.max(0, s.pendingAck - chars)
      if (s.paused && s.pendingAck < LOW_WATERMARK) {
        s.paused = false
        try {
          s.pty?.resume?.()
        } catch {
          // 假 pty / 会话刚结束 —— 背压尽力而为
        }
      }
    },

    resync(id) {
      const s = session
      if (!s || s.snap.id !== id) return
      // 界面刚重放过一屏 —— "在途"这个概念在新视图上已经归零，不复位的话 pty 会**永远停在暂停上**（没有任何东西会再产生回执）
      s.pendingAck = 0
      if (s.paused) {
        s.paused = false
        try {
          s.pty?.resume?.()
        } catch {
          // 同上：尽力而为
        }
      }
    },

    resize(cols, rows) {
      // 只读档同样不许动会话（与 `write` 同一条口径）
      if (deps.getPermission() === 'read-only') return
      const s = session
      if (!s || s.snap.status !== 'running' || !s.pty) return
      if (s.snap.cols === cols && s.snap.rows === rows) return
      s.snap.cols = cols
      s.snap.rows = rows
      try {
        s.pty.resize(cols, rows)
      } catch {
        // 会话刚好在这时结束了 —— 不值得抛给用户
      }
    },

    kill() {
      const s = session
      if (!s || !s.pty) return false
      teardown()
      return true
    },

    restart() {
      // ⚠️ 权限检查必须在 `teardown()` **之前**：反过来的话，只读档下点「重启终端」会先把正在跑的会话杀掉、连缓冲一起丢掉，
      //    然后才告诉用户"被拒绝" —— 用户视角是"点了一下，终端没了"。**拒绝必须无副作用。**
      if (deps.getPermission() === 'read-only') {
        return {
          ok: false,
          reason: 'read-only',
          message: '当前是「只读」权限档：这台机器只读，终端不执行命令'
        }
      }
      teardown()
      session = null
      return start()
    },

    onData(cb) {
      dataListeners.add(cb)
      return () => dataListeners.delete(cb)
    },

    onState(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },

    killAll() {
      teardown()
      session = null
    }
  }
}
