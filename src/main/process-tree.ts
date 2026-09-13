import { spawn } from 'node:child_process'

// 杀进程树 —— **全项目只有这一份实现**（plan14 C1 抽出来的）。
//
// ## 为什么不能只 `child.kill()`
//
// 命令是经 shell 起的（`shell: true`）。**杀掉 shell 并不杀掉它拉起的子进程** ——
// 那些会变成孤儿：端口继续占着、`ping` 继续吐输出（plan14 的实测里，父进程已死、
// 孙进程仍在跑）。所以必须**连带整棵树**。
//
// ## 为什么单独抽出来
//
// 原先只有 `background-tasks` 里有一份私有实现，而终端要杀的是**同一类东西**。
// 两处各写一套的下场，本项目刚在"mtime 判据写两遍"上吃过教训
// （reviewer 原话："两套判据迟早分岔"）。所以：一份实现，两处调用。
//
// ## 三条实测事实（写下来，免得后人踩）
//
// ① **退出码不可信**：`taskkill /F` 杀出来的子进程退出码是 **1**，
//    而 `Stop-Process -Force` 是 **4294967295** —— 后者还和"命令真的失败退出 1"撞车。
//    所以"被杀"这件事**必须由我们发起的 kill 动作置位**（调用方记 `status:'killed'`），
//    **不许**靠子进程退出码反推。
// ② `taskkill` 对**已经不存在**的 pid 返回 **128**（`ERROR: The process "x" not found.`）——
//    那是**幂等成功**，不是失败。调用方若要看结果，只许看这个退出码、**不许解析它的文本**
//    （`SUCCESS:` / `ERROR:` 会随系统语言本地化）。
// ③ **`/T` 不能省**：省了就留孤儿（实测）。
//    也**不许**用 `taskkill /IM <名字>`：那是按镜像名杀，会误杀用户自己开的同名进程。

/**
 * 只要能给个 pid 就够了 —— 这样 `ChildProcess` 与 node-pty 的 `IPty` **同一份实现都能用**。
 *
 * ⚠️ 刻意**不要** `kill` 方法：两种句柄的签名不一样（`NodeJS.Signals` vs `string`），
 * 收进来只会让类型打架；而 POSIX 兜底直接对 pid 发信号即可（`process.kill(pid)` 对任何 pid 都行）。
 */
export interface KillableLike {
  pid?: number | undefined
}

/**
 * 杀掉一棵进程树。
 *
 * ⚠️ **不管结果**：这是"尽力而为 + 幂等"的语义 ——
 * 进程可能已经自己退出了（那时 Windows 返回 128、POSIX 抛 ESRCH），
 * 那也算成功。调用方**不要**用它的返回值去判断"有没有真杀掉"。
 *
 * @param opts.spawnFn 注入用（测试验 Windows 分支时替换掉真 spawn）
 * @param opts.platform 注入用（默认 `process.platform`）
 */
export function killProcessTree(
  child: KillableLike,
  opts: {
    spawnFn?: typeof spawn
    platform?: NodeJS.Platform
    /** 注入用：POSIX 分支发信号。**必须可注入** —— 否则"负号（整组）"这件事
     *  在 Windows 开发机上永远验不到（本机发不出真信号），而它正是"留孤儿"的分水岭。 */
    killFn?: (pid: number, signal: NodeJS.Signals) => boolean
  } = {}
): void {
  const pid = child.pid
  if (pid === undefined) return
  const platform = opts.platform ?? process.platform

  if (platform === 'win32') {
    // 不经 shell 起 taskkill —— 因此**不受** Git Bash 那个 `/F` 被转成 `F:/` 的路径转换坑影响
    const doSpawn = opts.spawnFn ?? spawn
    const spawned = doSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    // ⚠️ **必须挂 `error`**：Node 的语义是"`error` 事件没有监听器就抛出" ——
    //    主进程里一个未捕获异常 = 整个应用没了。而这里本来就只是"尽力而为"，
    //    taskkill 拉不起来（PATH 异常 / EPERM / 句柄耗尽）不该升级成崩溃。
    if (spawned && typeof spawned.on === 'function') spawned.on('error', () => {})
    return
  }

  // POSIX：负号 = 整个进程组。**前提是子进程以 `detached: true` 起**（那样它才是组长）；
  // 不是组长时会抛 ESRCH —— 那种情况退化成只杀它自己（至少不留主进程）。
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
 * POSIX 下只有 `detached: true` 才让子进程成为**进程组组长**，
 * 否则 `process.kill(-pid)` 会 ESRCH —— 也就是"以为杀了整棵树、其实只杀了自己"。
 * Windows 下它无害（配合 `windowsHide` 不会弹新窗口）。
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
