import { app, dialog } from 'electron'
import { createLogger } from './log'
import { getMainWindow } from './window-registry'

// 异常兜底（plan8 R1）：**主进程崩了不能就这么消失**。
// 在此之前任何未捕获异常都让应用直接退出，用户只看到"软件没了"，排查拿不到任何线索。
// 三层兜底：uncaughtException（同步异常）/ unhandledRejection（Promise 拒绝）/
// render-process-gone（渲染进程崩溃，可自动重载）。

const log = createLogger('crash')

/** 防止异常处理本身陷入循环（同一时刻只处理一次） */
let handling = false

/** 渲染进程重载限流：持续崩溃时不能无限重载（那会变成死循环，比崩一次更糟） */
const RELOAD_WINDOW_MS = 30_000
const MAX_RELOADS = 2
let reloadTimes: number[] = []

function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack ?? '(无堆栈)' }
  if (typeof err === 'string') return { message: err, stack: '(字符串异常)' }
  try {
    return { message: JSON.stringify(err), stack: '(非 Error 对象)' }
  } catch {
    return { message: String(err), stack: '(无法序列化)' }
  }
}

/** 应用就绪后调用：装三层兜底 */
export function installCrashGuards(): void {
  process.on('uncaughtException', (err) => {
    const { message, stack } = describe(err)
    log.error('主进程未捕获异常', { message })
    // 堆栈单独一行写，便于阅读
    log.error('异常堆栈', { stack })

    if (handling) return
    handling = true

    // 告知用户（尽量给，给不出也不能因此再崩）
    try {
      // ⚠️ 挂到**主窗口**上（2026-09-13）：错误框该出现在用户正在干活的那个窗口上。
      //    取任意窗口的话，主窗口好好的人却在设置窗口里被弹一个"程序遇到错误"，指向性全丢。
      const win = getMainWindow()
      const detail = `${message}\n\n详细堆栈已写入日志（设置 → 故障排查 → 打开日志文件夹）。`
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'error',
          title: '九十里路遇到异常',
          message: '程序遇到未预期的错误，已记录日志，未退出。',
          detail
        })
      } else {
        // 主窗口不在（用户只开着设置窗口，或全都关了）→ **不能因此丢掉这条告警**：
        // 用无父窗口的对话框，它仍会显示在系统里（只是不依附某个窗口）
        void dialog.showMessageBox({
          type: 'error',
          title: '九十里路遇到异常',
          message: '程序遇到未预期的错误，已记录日志，未退出。',
          detail
        })
      }
    } catch {
      // 提示失败不影响继续运行
    } finally {
      handling = false
    }
    // 注意：**不退出**。宁可带着伤痕继续跑，也比静默消失好——用户至少能看到状态并保存工作。
  })

  process.on('unhandledRejection', (reason) => {
    const { message, stack } = describe(reason)
    log.error('未处理的 Promise 拒绝', { message, stack })
    // 不弹窗（Promise 拒绝常为可恢复的操作失败，弹窗会骚扰）
  })

  app.on('render-process-gone', (_e, webContents, details) => {
    log.error('渲染进程异常退出', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL()
    })

    // 限流：30 秒内最多自动重载 2 次。超过说明是稳定复现的崩溃，再重载只会无限循环 ——
    // 此时停下来告知用户，比死循环体面。
    const now = Date.now()
    reloadTimes = reloadTimes.filter((t) => now - t < RELOAD_WINDOW_MS)
    if (reloadTimes.length >= MAX_RELOADS) {
      log.error('渲染进程反复崩溃，已停止自动重载', { attempts: reloadTimes.length })
      try {
        // 同上：告警挂主窗口，主窗口不在就给无父窗口的（别把告警吞了）
        const win = getMainWindow()
        const box = {
          type: 'error' as const,
          title: '界面反复崩溃',
          message: '界面连续异常退出，已停止自动重载，以免陷入循环。',
          detail:
            '详细堆栈已写入日志（设置 → 故障排查 → 打开日志文件夹）。请重启应用；若持续出现，请将日志提供给开发者。'
        }
        if (win) void dialog.showMessageBox(win, box)
        else void dialog.showMessageBox(box)
      } catch {
        // 提示失败不影响主进程存活
      }
      return
    }

    reloadTimes.push(now)
    try {
      if (!webContents.isDestroyed()) webContents.reload()
    } catch {
      // 忽略
    }
  })

  app.on('child-process-gone', (_e, details) => {
    log.error('子进程异常退出', { type: details.type, reason: details.reason })
  })

  log.info('异常兜底已装载（uncaughtException / unhandledRejection / render-process-gone）')
}
