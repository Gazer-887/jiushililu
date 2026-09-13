import { existsSync } from 'node:fs'
import { killProcessTree } from './process-tree'
import type {
  TerminalChunk,
  TerminalFailReason,
  TerminalPermission,
  TerminalSessionSnapshot,
  TerminalStartResult
} from '@shared/terminal'

// 类型定义在 `@shared/terminal`（纯类型，主进程与界面共用一份口径 —— 渲染层不许 import 本文件，
// 因为这里 import 了 node:fs）。这里再导出一次，方便主进程侧引用时不用记两个来源。
export type {
  TerminalChunk,
  TerminalFailReason,
  TerminalPermission,
  TerminalSessionSnapshot,
  TerminalStartResult
}

// 内置终端的**会话层**（plan14 批 C · C2）—— **真 PTY** 版。
//
// ## 为什么是真 PTY（以及为什么推翻了自己第一版）
//
// 第一版按 plan7 原文的「`child_process` + 不用 node-pty」写的是**伪终端**：
// 常驻 shell + 往 stdin 写整行 + 自己回显。那一版能跑命令，但**做不到**：
// `Ctrl+C`（`\x03` 只是普通字节）、Tab 补全、行内编辑、`vim`/`top`、
// 任何只看 `isatty()` 的工具（进度条、分页、交互确认）。
//
// 调研查出「node-pty = 原生编译坑」这条前提**对 Windows x64 已经不成立**
// （1.1.0 起是 N-API 预编译），用户据此拍板改用真 PTY。
// **我在 Electron 33 里实测确认**：`require('node-pty')` 零 rebuild 加载成功，
// 子进程里 `process.stdout.isTTY === true`、`resize(132,40)` 后子进程看到 `columns=132`。
//
// ## 会话为什么活在主进程
//
// 因为本项目「**切换页签 = 卸载**」是定死的语义（plan9 §W3），而终端的核心体验是
// "切走再切回来，命令还在跑、历史还在"。所以：**pty 进程 + 输出缓冲都放主进程**，
// 渲染层的 xterm 只是**一个可丢弃的视图**（重挂时按序号重放）。
//
// ## 这一层为什么不 import electron
//
// 与 `checkpoints.ts` / `workspace-write.ts` 同样的约束：CI 上没有 Electron 二进制，
// 碰 electron 的模块**跑不了单测**。而这一层要守的东西（权限门控、cwd 校验、缓冲上限、
// 序号单调、kill 语义、resize 透传）**全都该被测到** —— 所以 pty 模块也是**注入**的
// （顺带让单测不必加载原生二进制）。

/** 输出缓冲上限（字符数）。超了从**头部**丢，并置 `truncated` —— 尾部才是刚发生的事情 */
export const MAX_BUFFER_CHARS = 200 * 1024

/**
 * **在途**流控的水位线（字符数）—— 与"历史缓冲上限"是**两件事**，别混为一谈：
 *   · `MAX_BUFFER_CHARS` 管**已经发生过的历史**（内存占用）；
 *   · 这两条管**还没被界面解析完的在途流量**。
 *
 * 为什么必须有：xterm 的 `write()` 内部有 `_pendingData` 计数，超过 **50MB**
 * （6.0.0 里已内联成 `5e7`）时**直接 throw** ——
 * `write data discarded, use flow control to avoid losing data`。
 * 不是"变慢"，是**整段丢弃 + 渲染进程里一个未捕获异常**。
 * 官方给的解法就是 ACK 流控：界面每解析完一段回执一次，主进程按"未回执字符数"
 * 暂停 / 恢复 pty 的读取（`IPty.pause()` / `resume()`，typings 第 189/194 行）。
 *
 * 水位取 256KB / 64KB：远低于 50MB 的硬线，又留住滞回区间（避免在阈值上抖动）。
 */
export const HIGH_WATERMARK = 256 * 1024
export const LOW_WATERMARK = 64 * 1024

/** 默认终端尺寸（渲染层 `fit()` 之后会立刻 `resize` 成真实尺寸） */
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

export interface TerminalShell {
  file: string
  args: string[]
  /** 给界面显示的名字 */
  label: string
}

/**
 * 挑一个 shell。
 *
 * Windows 选 **PowerShell**（不带 `-NoProfile` 会慢到不可接受：实测裸启动 **5865ms**、
 * 其中 profile 占 5.4–7.5 秒且**期间零输出**；带 `-NoProfile` 只要 307ms）。
 *
 * ⚠️ **但 `-NoProfile` 有代价，必须让用户知道**：用户 profile 里加载的东西
 * （本机实测会加载 conda 并激活环境）**不会生效**，所以终端里的 `python`
 * 可能不是他在自己 PowerShell 里那个。界面文案要写，别让人自己困惑。
 */
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

/**
 * 给终端用的环境变量。
 *
 * 说白了就是**继承本机环境 + 补几个"我是终端"的信号**（别把它读成"白名单环境"，
 * 第一版注释写成"不是裸继承"，与实现不符，已改口）。
 *   · `TERM` / `COLORTERM`：告诉程序"我在什么终端里"（没有它很多工具直接降级成纯文本），
 *     只是**描述事实**，不改变程序的判定逻辑。
 *   · **不设 `FORCE_COLOR`**（第一版设过，已撤掉）：真 PTY 下程序自己就是 TTY、本来就有颜色，
 *     再强制一次只会带来副作用 —— `工具 > 文件` 这种重定向到文件的场景也会被染色，
 *     文件里混进 ANSI 转义。与"不做善意越权"是同一条原则。
 *
 * ⚠️ **两条不许做的**：
 *   · **不动 `NO_COLOR`** —— 那是用户的显式信号（"我不要颜色"），尊重它。
 *   · **不设 `PYTHONUNBUFFERED`** 之类会**改变用户程序运行时行为**的开关 ——
 *     那是"善意的越权"，本项目的原则是不做。真正的 buffering 问题在真 PTY 下基本消失
 *     （有 TTY 时程序默认就是行缓冲）。
 */
export function terminalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    TERM: base.TERM ?? 'xterm-256color',
    COLORTERM: base.COLORTERM ?? 'truecolor'
  }
}

/** node-pty 里我们要用到的那一小块（注入用，避免单测加载原生二进制） */
export interface PtyLike {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** 背压：暂停读取（node-pty 的 `IPty` 有这两条）。标可选 = 假 pty 可以不实现，
   *  调用侧一律 `?.()` + try 兜底 —— 背压是"尽力而为"，不许成为正确性依赖 */
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
  /** pty 实现（生产注入真 node-pty；测试注入假的 → 单测不必加载原生二进制） */
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
  /** 界面的回执：这一段已经解析完了（**背压用**，主进程据此决定要不要恢复 pty 读取） */
  ack(sessionId: string, chars: number): void
  /**
   * **重对齐**背压（界面重挂 + 重放之后调）：未回执计数清零，必要时恢复 pty。
   *
   * 为什么必须有：面板卸载时只退订阅、**不通知主进程**，而主进程照旧往所有窗口推 ——
   * 那些帧没人回执，`pendingAck` 只增不减，越过水位就把 pty **真按住**了
   * （实测：Windows 上 `pause()` 生效，暂停 2 秒收 0 字节）。
   * 重挂时即使重放完全正常，也没有任何东西会把水位压回去 → **终端"活着但永远静止"**。
   * 所以重放结束必须补一次重对齐。
   */
  resync(sessionId: string): void
  /** 终止会话（连整棵进程树） */
  kill(): boolean
  /** 重启（= kill + start）—— 界面上的「重启终端」 */
  restart(): TerminalStartResult
  /** 订阅增量输出（**不是整段缓冲**） */
  onData(cb: (sessionId: string, chunk: TerminalChunk) => void): () => void
  /** 订阅状态变化（起/停/退出） */
  onState(cb: (sessionId: string) => void): () => void
  /** 全部终止（窗口关闭时调用，与 `background.killAll` 同一挂点） */
  killAll(): void
}

export function createTerminalSessionStore(deps: TerminalDeps): TerminalSessionStore {
  const exists = deps.exists ?? existsSync
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? process.platform
  const shell = deps.shell ?? defaultShell(platform)

  /** 当前会话（**每工作区一个**，见 plan14 §三⑦） */
  let session: Session | null = null
  /** 会话序号：保证 id **唯一**（只用时间戳会撞号 —— 见 `start()` 里那段说明） */
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
    // 超限从**头部**丢：尾部才是刚刚发生的事
    while (s.buffered > MAX_BUFFER_CHARS && s.snap.chunks.length > 1) {
      const dropped = s.snap.chunks.shift()
      s.buffered -= dropped?.data.length ?? 0
      s.snap.truncated = true
    }
    // ⚠️ **单段本身就超限**的兜底：上面的循环刻意保住最后一段（渲染层要有个落点），
    //    于是一段 4MB 的 `cat` 输出能让 `buffered` 一直超限 —— 缓冲无界增长。
    //    这里把这一段**从头部截掉**、只留尾部。最坏情况是截断点落在 ANSI 转义中间
    //    （渲染出几个乱码字符），比内存持续上涨可接受。
    if (s.buffered > MAX_BUFFER_CHARS) {
      const only = s.snap.chunks[0]
      if (only) {
        const cut = s.buffered - MAX_BUFFER_CHARS
        only.data = only.data.slice(cut)
        s.buffered -= cut
        s.snap.truncated = true
      }
    }

    // 在途流控：推出去就计入"未回执"，越过高水位就暂停 pty 的读取
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

  /** 收掉当前会话（不清 buffer —— 调用方决定要不要保留快照） */
  const teardown = (): void => {
    const s = session
    if (!s) return
    if (s.pty) {
      // 先按 pid 杀整棵树，再让 pty 自己收尾（两条路都走：pty.kill 只管它自己那层）
      killProcessTree({ pid: s.pty.pid })
      try {
        s.pty.kill()
      } catch {
        // 已经没了 —— 幂等
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

    // ②b 切了工作区 → 把旧会话收掉：那个 shell 还停在**上一个项目**的目录里，
    //     留着比收掉更让人困惑（"我明明切了项目，终端还在旧项目里"）
    if (session) {
      teardown()
      session = null
    }

    // ③ cwd 必须存在。不先查的话，报出来的是 `spawn powershell.exe ENOENT` ——
    //    **看着像找不到 shell，其实是找不到目录**，那种文案会把排查方向带偏。
    if (!exists(root)) {
      return { ok: false, reason: 'cwd-missing', message: `工作区不存在或已被移动：${root}` }
    }

    const cols = size?.cols && size.cols > 0 ? size.cols : DEFAULT_COLS
    const rows = size?.rows && size.rows > 0 ? size.rows : DEFAULT_ROWS
    // ⚠️ id **必须唯一**，不能只用时间戳：`restart()` 走的是
    //    teardown（旧 pty 已为 null 时是纯内存操作，实测 0ms）→ start，
    //    两次 `Date.now()` 完全可能落在**同一毫秒** → 新旧会话同 id →
    //    渲染层判定"还是同一个会话"→ 不 reset、不重放、`nextSeq` 停在旧高位 →
    //    新 shell 的输出从 seq 1 起、被逐帧丢弃：状态栏写"运行中"，屏幕**彻底死寂**。
    //    间歇性、且主进程侧一切正常（最能带偏排查方向的那种）。自增序号保证唯一，
    //    时间戳只留作日志可读。
    idSeq += 1
    const id = `term-${idSeq}-${now().toString(36)}`

    let pty: PtyLike
    try {
      pty = deps.pty.spawn(shell.file, shell.args, {
        // `name` 会进 `TERM` 一类的协商；xterm-256color 是兼容性最好的那个
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

    // ⚠️ 闭包里**只认 `self`**，不许读外层的 `session`：那个变量会被下一次 `start()` 换掉，
    //    而旧 pty 在真正死掉之前**仍可能回调**（`teardown()` 发 taskkill 是异步的、pty.kill 也是）。
    //    读外层变量的话，旧 shell 临终前那段输出会被记成**新会话**的帧 ——
    //    序号还是"合法"的（新会话紧接着的号），界面无从分辨。这是"错位重放"的最短路径。
    pty.onData((data) => {
      if (session !== self || self.snap.status !== 'running') return
      emitData(self, data)
    })
    pty.onExit(({ exitCode }) => {
      // ⚠️ 退出码**只在"不是我们杀的"时候有意义**（我们 kill 时拿到的是终止码，不是程序退出码）。
      //    所以状态由**我们发起的 kill 动作**置位，这里不许覆盖它。
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
      // ⚠️ 权限档**每次现查**，不能只信 `start()` 那次检查：用户可能在会话跑着的时候
      //    把档位降到只读。只在启动处拦的话就成了"看着被拦、其实没拦"——比完全不拦更坏。
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
          // 同上：尽力而为
        }
      }
    },

    resync(id) {
      const s = session
      if (!s || s.snap.id !== id) return
      // 界面刚重放过一屏 —— 此刻"在途"这个概念在这个新视图上已经归零，
      // 不复位的话 pty 会**永远停在暂停上**（没有任何东西会再产生回执）
      s.pendingAck = 0
      if (s.paused) {
        s.paused = false
        try {
          s.pty?.resume?.()
        } catch {
          // 尽力而为
        }
      }
    },

    resize(cols, rows) {
      // 只读档同样不许动会话（与 `write` 同一条口径）
      if (deps.getPermission() === 'read-only') return
      const s = session
      if (!s || s.snap.status !== 'running' || !s.pty) return
      // 尺寸没变就别烦 pty（拖拽时会高频触发）
      if (s.snap.cols === cols && s.snap.rows === rows) return
      s.snap.cols = cols
      s.snap.rows = rows
      try {
        s.pty.resize(cols, rows)
      } catch {
        // 会话刚好在这时结束了 —— 忽略，不值得抛给用户
      }
    },

    kill() {
      const s = session
      if (!s || !s.pty) return false
      teardown()
      return true
    },

    restart() {
      // ⚠️ 权限检查必须在 `teardown()` **之前**：反过来的话，只读档下点「重启终端」
      //    会先把正在跑的会话杀掉、连缓冲一起丢掉，然后才告诉用户"被拒绝" ——
      //    用户视角是"点了一下，终端没了"。**拒绝必须无副作用。**
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
