import { spawn, type ChildProcess } from 'node:child_process'
import type { BackgroundTask } from '@shared/background'

// 后台任务注册表（plan7 批 D 后半 —— 右栏「任务」页签的"后台任务"区）。
//
// 为什么要有它：`run_command` 是 `exec` + 30s 超时的**同步**执行 ——
// 跑构建、起 dev server、下大文件都会撞超时，模型只能干等。
// 这里给命令一个"后台跑"的形态：立刻返回 id，输出持续累积，随时可查可停。
//
// 三条边界（2026-09-12 与用户敲定）：
//   ① 窗口/会话结束时**跟着终止** —— 留一堆没人管的进程是隐患（与 R5 的 abortAll 同一口径）
//   ② 后台命令**仍需逐次确认** —— 安全不能因为"后台"就打折（确认在工具层做）
//   ③ 输出**内存累积 + 上限截断**，不落盘

/** 单条任务保留的输出上限（内存里存着，别把进程撑爆） */
export const MAX_OUTPUT = 64 * 1024

/** 同时挂着的后台任务上限（防手滑起一百个） */
export const MAX_TASKS = 8

/** 输出推送节流窗口（毫秒）—— 命令吐字节很快，不该每个 chunk 都推一次 IPC */
const EMIT_THROTTLE_MS = 150

export interface BackgroundTaskStore {
  start(opts: { command: string; cwd: string; agent: string }): BackgroundTask
  list(): BackgroundTask[]
  get(id: string): BackgroundTask | null
  /** 终止一条；返回是否真的发过终止信号 */
  kill(id: string): boolean
  /** 全部终止（窗口关闭时调用 —— 边界①） */
  killAll(): void
  /**
   * 订阅状态变化。**只通知"变了"这个事实**，具体数据由调用方自己 list() ——
   * 避免把可能很大的 output 塞进事件里。
   */
  onChange(cb: () => void): () => void
}

/**
 * 杀进程树。
 * 为什么不能只 `child.kill()`：命令是经 shell 起的（`shell: true`），
 * 杀掉 shell 并不杀掉它拉起的子进程 —— 那些会变成孤儿，端口继续占着。
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T 连带子进程。这里**不经 shell**，故不受 Git Bash 的 `/F` 路径转换坑影响
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM') // 负号 = 整个进程组
  } catch {
    child.kill('SIGTERM')
  }
}

export function createBackgroundTaskStore(): BackgroundTaskStore {
  const tasks = new Map<string, BackgroundTask>()
  const children = new Map<string, ChildProcess>()
  const listeners = new Set<() => void>()
  let seq = 0
  let emitTimer: ReturnType<typeof setTimeout> | null = null

  /** 立即通知（状态变化用） */
  const emitNow = (): void => {
    for (const cb of listeners) cb()
  }

  /** 节流通知（输出追加用） */
  const emitSoon = (): void => {
    if (emitTimer) return
    emitTimer = setTimeout(() => {
      emitTimer = null
      emitNow()
    }, EMIT_THROTTLE_MS)
  }

  const finish = (id: string, status: BackgroundTask['status'], exitCode?: number): void => {
    const t = tasks.get(id)
    if (!t || t.status !== 'running') return
    t.status = status
    t.endedAt = Date.now()
    if (exitCode !== undefined) t.exitCode = exitCode
    children.delete(id)
    emitNow()
  }

  const killOne = (id: string): boolean => {
    const child = children.get(id)
    const t = tasks.get(id)
    if (!child || !t || t.status !== 'running') return false
    killTree(child)
    finish(id, 'killed')
    return true
  }

  return {
    start({ command, cwd, agent }) {
      if (tasks.size >= MAX_TASKS) {
        throw new Error(`后台任务已达上限（${MAX_TASKS} 个），请先停掉一些再起`)
      }
      const id = `bg-${++seq}`
      const task: BackgroundTask = {
        id,
        command,
        cwd,
        agent,
        startedAt: Date.now(),
        status: 'running',
        output: '',
        truncated: false
      }
      tasks.set(id, task)

      // shell: true —— 与前台 run_command 同一种执行语义（管道、&& 照常）
      const child = spawn(command, { cwd, shell: true, windowsHide: true })
      children.set(id, child)

      const append = (buf: Buffer): void => {
        const t = tasks.get(id)
        if (!t) return
        t.output += buf.toString('utf8')
        if (t.output.length > MAX_OUTPUT) {
          // 只留尾部：报错通常在末尾，头部的进度噪声价值低
          t.output = t.output.slice(-MAX_OUTPUT)
          t.truncated = true
        }
        emitSoon()
      }

      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.on('error', (err) => {
        append(Buffer.from(`\n[启动失败] ${err.message}\n`, 'utf8'))
        finish(id, 'failed')
      })
      child.on('close', (code) => {
        finish(id, code === 0 ? 'done' : 'failed', code ?? undefined)
      })

      emitNow()
      return task
    },

    list() {
      return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
    },

    get(id) {
      return tasks.get(id) ?? null
    },

    kill: killOne,

    killAll() {
      for (const id of [...children.keys()]) killOne(id)
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
