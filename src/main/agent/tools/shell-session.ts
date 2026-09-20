// Agent 专用持久 shell 会话（plan28 D-085 · S2 会话复用）。
//
// 为什么必须做：`exec` 每次冷启动一个 shell ⇒ `cd` / `set` / `call activate` / `source venv`
// **全都不跨步存活** —— Agent 永远进不了目录、激活不了环境（规格原话："新手实现最大的坑"）。
//
// 为什么不是接 `src/main/terminal-session.ts`：那是**用户交互终端**（pty + xterm 流控 +
// ACK 背压），会话属于用户 —— agent 命令混进去既污染用户视图，也没有"命令跑完了"的边界。
// 故这里建**专用非交互会话**：同一份进程树清理（`process-tree.ts`），边界与后台任务一样硬。
//
// 协议（命令 + 回声标记喂给常驻 shell 的 stdin，序号全局单调，模型不可能伪造）：
//   Windows: `<command>` + `echo @JSL-DONE-<n>@:%ERRORLEVEL%`
//   POSIX:   `<command>` + `echo @JSL-DONE-<n>@:$?`
//
// Windows 的两处输出噪音，都在会话内清洗（实测 cmd.exe 26200）：
//  · 版本 banner —— 握手阶段丢弃：spawn 后先喂 `prompt <标记>`，收集到的输出里见到**第一个
//    提示符标记**即视为就绪，之前的字节（banner + 默认提示符）全部扔掉。
//  · 提示符前缀 —— PROMPT 环境变量压不掉（实测回退默认），改用**把提示符设成本会话唯一的
//    `@JSL-PS1@`**，输出里全局剥除该串（每行开头的提示符变成空）。
//
// 生命周期：每个工具集实例一个会话（= 每个 agent run 一个，轮与轮之间 cd 延续，
// 新 run 从工作区根重新开始 —— 可预测性优先）；空闲 10 分钟自动回收；同活会话上限 4 个（LRU）。

import { spawn } from 'node:child_process'
import { killProcessTree, spawnOptsForGroupKill } from '../../process-tree'

export interface ShellRunResult {
  stdout: string
  stderr: string
  /** 退出码。shell 本身中途死亡（如命令是 `exit`）时也是数字（shell 自己的码）；spawn 失败时为 null */
  exitCode: number | null
  timedOut: boolean
  /** 输出超限被我们掐了（会话一并作废重开，与旧行为"超限即杀"同语义） */
  exceeded: boolean
  /** shell 进程没能起来 / 握手前就死了 —— 调用方应回落一次性 exec */
  spawnError: string | null
  elapsedMs: number
}

export interface AgentShellSession {
  run(command: string, timeoutMs: number): Promise<ShellRunResult>
  /** plan43 S3：本会话起壳时用的环境指纹（调用方据此判"要不要换壳"） */
  readonly envFingerprint: string
  dispose(): void
}

const IDLE_MS = 10 * 60_000
const MAX_LIVE_SESSIONS = 4
/** Windows 握手/提示符标记（会话唯一；命令输出里出现同名串的概率可忽略，被剥除也无害） */
const WIN_PROMPT = '@JSL-PS1@'

const liveSessions = new Set<AgentShellSessionImpl>()

function enforceCap(): void {
  // ⚠️ 注释原写"LRU"，实为**按构造顺序 FIFO**：`liveSessions` 是 Set，`add` 不会把已存在的元素
  //    挪到末尾，所以"用过"不刷新位置。且淘汰**不看目标是否正在执行命令**（dispose → 杀进程树），
  //    被挤掉的可能是用户刚批准的那条。共享 shell 槽位后一个 run 只占一格，这条闸很少被触到；
  //    真要改成"用过即置新"或"不杀在跑的"，需连带补并发用例，属独立决策，此处先把话说对。
  while (liveSessions.size > MAX_LIVE_SESSIONS) {
    const oldest = liveSessions.values().next().value
    if (!oldest) break
    oldest.dispose()
  }
}

export function disposeAllShellSessions(): void {
  for (const s of [...liveSessions]) s.dispose()
}

class AgentShellSessionImpl implements AgentShellSession {
  private child: ReturnType<typeof spawn> | null = null
  private seq = 0
  private idleTimer: NodeJS.Timeout | null = null
  /** false = shell 没在跑，或 Windows 握手还没见到第一个提示符标记（输出待丢弃） */
  private ready = false
  /** 握手期累积（见 ready 语义）；就绪后清空 */
  private handshakeBuf = ''
  /** 本轮 run 的"就绪前死亡"结算回调（spawn 起不来时由 error 处理器调用）；空闲时为 null */
  private earlyDeath: (() => void) | null = null
  /** plan43 S3：起 shell 时用的**环境指纹**。用于判断"设置变了要不要换壳"。 */
  private fingerprint = ''

  constructor(
    private readonly cwd: string,
    private readonly platform: NodeJS.Platform = process.platform,
    /** plan43 S3：本次 run 的环境（PATH 覆盖 + 指纹）。每次 run 现读，见 `AgentShellSessionDeps` */
    private readonly runtime: RuntimeEnv = { pathOverride: undefined, fingerprint: '' }
  ) {
    liveSessions.add(this)
    this.fingerprint = runtime.fingerprint
    enforceCap()
  }

  /** plan43 S3：环境指纹（供调用方比对"是否与当前设置一致"） */
  get envFingerprint(): string {
    return this.fingerprint
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private armIdle(): void {
    this.clearIdle()
    // unref：不挡进程退出（vitest / 应用关闭不等它）
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_MS)
    this.idleTimer.unref()
  }

  private killShell(): void {
    if (this.child) {
      // 进程树清理（D-085 红线）：杀 shell 不杀子进程会留孤儿
      try {
        killProcessTree(this.child)
      } catch {
        // 尽力而为：进程可能已退出
      }
    }
    this.dead = true
    this.ready = false
    this.child = null
  }

  private dead = true

  dispose(): void {
    this.clearIdle()
    this.killShell()
    liveSessions.delete(this)
  }

  /** 确保常驻 shell 在跑；返回 false = 起不来（调用方回落一次性执行） */
  private ensureSpawned(): boolean {
    if (!this.dead && this.child && this.child.exitCode === null) return true
    this.clearIdle()
    // stdio 不传 = 三路全 pipe（默认），正好是我们要的
    // plan43 S3：PATH 覆盖（用户选中的运行时）—— 不传 env 时 spawn 继承主进程环境，
    // 而主进程环境是**应用启动时**的快照，故必须显式给出覆盖值才能让"选中的运行时"生效。
    const opts: Parameters<typeof spawn>[2] = { ...spawnOptsForGroupKill(this.cwd, this.platform) }
    if (this.runtime.pathOverride !== undefined) {
      opts.env = { ...process.env, PATH: this.runtime.pathOverride }
    }
    try {
      this.child =
        this.platform === 'win32'
          ? spawn('cmd.exe', ['/q'], opts)
          : spawn('/bin/bash', ['--noediting'], opts)
    } catch {
      this.child = null
      this.dead = true
      return false
    }
    const child = this.child
    // spawn 失败（ENOENT，Windows 上 cwd 不存在也是这个错）走 error 事件而不是 throw。
    // ⚠️ 起不来时**立即结算本轮**（spawnError）—— spawn 失败时 close 并不一定可靠；
    //    同时**不清 this.child**（留给 close 认亲清理；即便 close 不来，dead=true 也会让下次 run 重生）。
    child.once('error', () => {
      if (this.child !== child) return
      const wasReady = this.ready
      this.dead = true
      this.ready = false
      if (!wasReady) {
        const cb = this.earlyDeath
        this.earlyDeath = null
        cb?.()
      }
    })
    // ⚠️ 全部 unref：空闲会话**不许拽住事件循环**。否则挂着的子进程管道是活动句柄，
    //    会把 vitest worker（以及任何等待自然退出的宿主）吊死（实测全量测试挂死 13 分钟）。
    //    生命周期由 idle 定时器（同样 unref'd）+ LRU 上限管理，不靠句柄计数。
    child.unref()
    // 子进程流类型上没声明 unref（运行时有）—— 不 unref 会拽住事件循环（vitest 挂死教训）
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream) (stream as unknown as { unref(): void }).unref()
    }
    this.dead = false
    this.ready = this.platform !== 'win32' // POSIX 非交互 bash 无 banner/提示符，无需握手
    this.handshakeBuf = ''
    if (!this.ready) {
      // Windows 握手：把提示符设成本会话唯一标记；见到它 = banner 结束、cmd 就绪
      child.stdin?.write(`prompt ${WIN_PROMPT}\r\n`)
    }
    return true
  }

  /**
   * **同一个会话内串行执行**。`runNow` 往同一个 stdin 写命令、往同一个 stdout 收字节，
   * 并发调用会让 A 收到 B 的输出、超时时的 `killShell()` 还会连带杀掉对方正在跑的壳。
   *
   * ⚠️ 这条路径 0.13.79 起才真实可达：子代理第一次拿到 `run_command`（0.13.78），
   * 而同一个 run 内主/子代理**共享同一个常驻 shell**（共享是对的 —— 各持一份会撞上
   * 同活上限，而淘汰不看是否在跑）。并发派发此前从未被执行过。
   */
  private chain: Promise<unknown> = Promise.resolve()
  run(command: string, timeoutMs: number): Promise<ShellRunResult> {
    const next = this.chain.then(() => this.runNow(command, timeoutMs))
    // 前一条失败不许卡住后面的命令：链上只挂"完成"，错误由各自的调用方从 next 里取
    this.chain = next.catch(() => undefined)
    return next
  }

  private runNow(command: string, timeoutMs: number): Promise<ShellRunResult> {
    // 计时从这里开始 —— 放在 `run()` 里会把**排队时间**算进超时，长队列后面全误判超时
    const startedAt = Date.now()
    if (!this.ensureSpawned()) {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        exceeded: false,
        spawnError: 'shell 进程启动失败',
        elapsedMs: 0
      })
    }
    const child = this.child!
    const seq = ++this.seq
    const marker = `@JSL-DONE-${seq}@`
    const markerRe = new RegExp(`${marker}:(-?\\d+)`)

    return new Promise<ShellRunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let exceeded = false

      // spawn 起不来（error 事件、就绪前死亡）→ 立即以 spawnError 结算，调用方回落一次性 exec
      this.earlyDeath = () => {
        if (settled) return
        clearTimeout(timer)
        settled = true
        resolve({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          exceeded: false,
          spawnError: 'shell 进程启动失败',
          elapsedMs: Date.now() - startedAt
        })
      }

      const MAX_BUFFER = 8 * 1024 * 1024
      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // ⚠️ 摘除本 run 的监听器：会话跨 run 复用**同一个 child**，不摘的话旧闭包会
        //    跨 run 无限累积输出 —— 大输出时旧闭包先撞 MAX_BUFFER，误判超限把 shell 杀掉，
        //    在途的一个管道缓冲块（实测恰 64KB）随之丢失（实测 8MB 命令在复用会话上丢 65536 字节）。
        child.stdout!.removeListener('data', onStdout)
        child.stderr!.removeListener('data', onStderr)
        this.earlyDeath = null
        // 清洗：标记回声行剥掉（协议回声不是命令产物），提示符串全局剥掉（Windows 噪音）。
        // ⚠️ **禁止用正则做这件事**：`[^\r\n]*marker…` 这类模式在"巨长单行 + 无匹配"上
        //    会灾难性回溯（实测 8MB 输出把事件循环吊死数小时级），必须走 indexOf 定位切割。
        let clean = stdout
        const mi = clean.indexOf(marker)
        if (mi !== -1) {
          const lineStart = clean.lastIndexOf('\n', mi) + 1
          const lineEnd = clean.indexOf('\n', mi)
          clean = lineEnd === -1 ? clean.slice(0, lineStart) : clean.slice(0, lineStart) + clean.slice(lineEnd + 1)
        }
        clean = clean.split(WIN_PROMPT).join('')
        if (exceeded) {
          // 超限即杀（与旧行为同语义）：会话作废，下次 run 重开
          this.killShell()
        } else if (this.dead) {
          // shell 已死（timeout 杀的 / 命令是 exit / 自己崩了）—— 下次 run 重开
        } else {
          this.armIdle()
        }
        resolve({
          stdout: clean,
          stderr,
          exitCode,
          timedOut,
          exceeded,
          spawnError: null,
          elapsedMs: Date.now() - startedAt
        })
      }

      const timer = setTimeout(() => {
        timedOut = true
        this.killShell()
        finish(null)
      }, timeoutMs)

      const onStdout = (chunk: Buffer): void => {
        const text = chunk.toString()
        // Windows 握手期：丢弃直到见到第一个提示符标记（banner + 默认提示符全在里面）
        if (!this.ready) {
          this.handshakeBuf += text
          const idx = this.handshakeBuf.indexOf(WIN_PROMPT)
          if (idx === -1) return
          this.ready = true
          const rest = this.handshakeBuf.slice(idx + WIN_PROMPT.length)
          this.handshakeBuf = ''
          if (rest.length > 0) onText(rest)
          return
        }
        onText(text)
      }

      const onText = (text: string): void => {
        const prevLen = stdout.length
        stdout += text
        if (stdout.length + stderr.length > MAX_BUFFER) {
          exceeded = true
          this.killShell()
          finish(null)
          return
        }
        // 标记只可能出现在**新增文本**或跨块边界上 —— 只扫尾部。
        // （逐块全串 exec 在 8MB 输出上是 O(n²)；不致命但纯浪费，一并修掉。）
        const m = markerRe.exec(stdout.slice(Math.max(0, prevLen - marker.length - 16)))
        if (m) finish(Number(m[1]))
      }

      const onStderr = (chunk: Buffer): void => {
        stderr += chunk.toString()
        if (stdout.length + stderr.length > MAX_BUFFER) {
          exceeded = true
          this.killShell()
          finish(null)
        }
      }
      child.stdout!.on('data', onStdout)
      child.stderr!.on('data', onStderr)
      // shell 死了（命令是 exit / 自己崩了 / 被我们杀）。已 settle 的（超时/超限先行）忽略。
      // ⚠️ 先认亲：本 promise 只属于**这一个** child。旧 child 的迟到死亡事件既不许踩
      //    新会话的 ready/child/dead，也不许替新 run 做 resolve（新会话握手期 ready=false，
      //    会被误判成"shell 在就绪前退出"提前返回）；wasReady 必须在置 false 前取。
      child.once('close', (code) => {
        const wasReady = this.ready
        const isCurrent = this.child === child
        if (isCurrent) {
          this.dead = true
          this.ready = false
          this.child = null
        }
        if (settled || !isCurrent) return
        if (!wasReady) {
          // 握手没完成就死了：环境起不来 —— 调用方回落一次性 exec
          clearTimeout(timer)
          settled = true
          resolve({
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            exceeded: false,
            spawnError: 'shell 在就绪前退出',
            elapsedMs: Date.now() - startedAt
          })
          return
        }
        // 正常运行中 shell 死了：手上有什么就交什么（exitCode = shell 自己的退出码）
        finish(typeof code === 'number' ? code : null)
      })

      // 喂命令 + 标记回声（cmd 逐行执行，标记行读到的 %ERRORLEVEL% 即上一行的退出码）
      if (this.platform === 'win32') {
        child.stdin!.write(`${command}\r\necho ${marker}:%ERRORLEVEL%\r\n`)
      } else {
        child.stdin!.write(`${command}\necho ${marker}:$?\n`)
      }
    })
  }
}

/**
 * plan43 S3：一个 shell 会话的**运行环境**。
 *
 * `fingerprint` 的用途（**确定性生效**的关键）：`shell-session` 是常驻复用的，
 * 用户改了「开发环境」设置后，若下一个 run 继续复用旧壳，就会**用上旧环境**；
 * 若等 10 分钟空闲回收才变，那是"碰运气生效"。
 * → 调用方在每个 run 开始时比对指纹：**不同就淘汰旧会话、起新的**。
 *   与 VS Code 的取舍一致 —— **已开的终端不动**（正在跑的东西不该被抽凳子），
 *   但**新的执行**一定用新环境。
 */
export interface RuntimeEnv {
  /** PATH 覆盖值（`undefined` = 不改 PATH，保持原行为） */
  pathOverride: string | undefined
  /** 环境指纹（`runtimeFingerprint()` 产出）；空串 = 未启用开发环境 */
  fingerprint: string
}

export function createShellSession(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  runtime: RuntimeEnv = { pathOverride: undefined, fingerprint: '' }
): AgentShellSession {
  return new AgentShellSessionImpl(cwd, platform, runtime)
}
