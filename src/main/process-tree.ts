import { spawn } from 'node:child_process'

/**
 * 杀进程树 —— 全项目唯一实现（终端与后台任务共用）。
 *
 * 为什么不能只 `child.kill()`：命令经 shell 起（`shell: true`），杀 shell 不杀它拉起的子进程，
 * 那些会变成孤儿（占着端口、继续输出）。
 *
 * 调用方须知（均为实测结论）：
 * - **退出码不可信**：`taskkill /F` 下退出码是 1、`Stop-Process -Force` 是 4294967295，
 *   会与"命令真的失败"撞车。所以"被杀"必须由**发起 kill 的一方**置位，不许用退出码反推。
 * - `taskkill` 对**不存在**的 pid 返回 **128** = 幂等成功。只许看退出码，
 *   **不许解析其文本**（`SUCCESS:` / `ERROR:` 随系统语言本地化）。
 * - `/T` 不能省（省了就留孤儿）；**不许**用 `taskkill /IM <名>`（会误杀用户的同名进程）。
 * - POSIX 的 `process.kill(-pid)`（整组）要求子进程以 `detached: true` 起 —— 见 `spawnOptsForGroupKill`。
 */

/**
 * 只要能给个 pid 就够 —— `ChildProcess` 与 node-pty 的 `IPty` 因此共用这一份实现。
 *
 * ⚠️ 刻意**不收** `kill`：两种句柄的签名不同（`NodeJS.Signals` vs `string`），收进来只会让类型打架。
 */
export interface KillableLike {
  pid?: number | undefined
}

/**
 * 杀掉一棵进程树。
 *
 * ⚠️ **不管结果**：尽力而为 + 幂等 —— 进程可能已自己退出（Windows 返回 128、POSIX 抛 ESRCH），
 * 那也算成功。调用方**不要**用返回值判断"有没有真杀掉"。
 */
export function killProcessTree(
  child: KillableLike,
  opts: {
    spawnFn?: typeof spawn
    platform?: NodeJS.Platform
    /** 注入用：POSIX 发信号。必须可注入 —— 否则"负号（整组）"在 Windows 开发机上验不到，
     *  而它正是"留不留孤儿"的分水岭。 */
    killFn?: (pid: number, signal: NodeJS.Signals) => boolean
  } = {}
): void {
  const pid = child.pid
  if (pid === undefined) return
  const platform = opts.platform ?? process.platform

  if (platform === 'win32') {
    // 用数组参数、不经 shell —— 因此不受 Git Bash 把 `/F` 转成 `F:/` 的那个坑影响
    const doSpawn = opts.spawnFn ?? spawn
    const spawned = doSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    // ⚠️ 必须挂 `error`：Node 的语义是"`error` 无监听器就抛出"，而主进程里一个未捕获异常 = 应用没了。
    //    这里本来就只是尽力而为，taskkill 拉不起来（PATH / EPERM / 句柄耗尽）不该升级成崩溃。
    if (spawned && typeof spawned.on === 'function') spawned.on('error', () => {})
    return
  }

  // POSIX：负号 = 整个进程组；不是组长时抛 ESRCH，退化成只杀它自己（至少不留主进程）
  const doKill = opts.killFn ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s))
  try {
    doKill(-pid, 'SIGTERM')
  } catch {
    try {
      doKill(pid, 'SIGTERM')
    } catch {
      // 已经没了 —— 幂等，不报错
    }
  }
}

/**
 * 起子进程时用的"能按进程组杀"的选项。
 *
 * POSIX 下只有 `detached: true` 才让子进程成为**进程组组长**，否则 `process.kill(-pid)` 会 ESRCH
 * —— 也就是"以为杀了整棵树、其实只杀了自己"。Windows 下无害（配合 `windowsHide` 不弹窗）。
 */
export function spawnOptsForGroupKill(
  cwd: string,
  platform: NodeJS.Platform = process.platform
): {
  cwd: string
  windowsHide: true
  detached: boolean
} {
  return {
    cwd,
    windowsHide: true,
    detached: platform !== 'win32'
  }
}
