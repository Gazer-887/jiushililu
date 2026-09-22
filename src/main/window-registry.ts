import { BrowserWindow } from 'electron'
import { createLogger } from './log'

/*
 * 窗口登记处（2026-09-13 立）。
 *
 * **为什么要有这个文件**：本应用从"只有一个窗口"变成"主窗口 + 设置窗口（将来还有更多子窗口）"——
 * 而在此之前，主进程里到处是 `BrowserWindow.getAllWindows()[0]`（共 5 处），
 * 它们**全都默认"唯一那个窗口就是主窗口"**。多开一个窗口后这个前提就假了，后果不是报错而是**行为错位**：
 *
 *   - 危险操作确认框可能弹到**设置窗口**上（用户在设置里改着东西，突然冒出"是否允许执行 rm -rf"）；
 *   - 主窗口关闭时，`finishClose` 回调指向的可能是设置窗口 → **落错盘 / 关不掉**；
 *   - 未捕获异常的错误框弹到设置窗口上，而用户盯着的是主窗口；
 *   - 「第二个实例启动 → 把已有窗口叫到前面」把**设置窗口**叫到前面，用户以为主窗口丢了。
 *
 * 这类 bug 的特点是**不崩、不报错、只是发生在错的窗口上**，门禁与单测都抓不到。
 * 所以这里用**登记制**取代"数组第 0 个"：谁建的窗口谁登记**用途**，取窗口一律按用途取。
 *
 * ⚠️ 纪律：主进程**不再允许出现 `getAllWindows()[0]`**。
 *    需要"找那个该收消息的窗口"→ 用本模块；需要"广播给所有窗口"→ 用 `sendToAll`。
 */

/** 窗口用途。新增一种用途就在这里加一个 —— 别用"猜"的方式取窗口。 */
export type WindowRole = 'main' | 'settings'

interface Entry {
  role: WindowRole
  win: BrowserWindow
}

const entries: Entry[] = []
const log = createLogger('window')

/** 建窗口后立刻登记。重复角色会覆盖（同一用途只保留最新一个，旧的通常已在关闭路上）。 */
export function registerWindow(role: WindowRole, win: BrowserWindow): void {
  // 先清掉同角色的陈旧登记（window 已销毁但 'closed' 还没派发到的窗口，属于竞态残留）
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === role && entries[i].win.isDestroyed()) entries.splice(i, 1)
  }
  entries.push({ role, win })
  log.info('窗口已登记', { role, total: entries.length })
  win.on('closed', () => {
    const idx = entries.findIndex((e) => e.win === win)
    if (idx >= 0) entries.splice(idx, 1)
    log.info('窗口已注销', { role, total: entries.length })
  })
}

/**
 * 按用途取窗口。**取不到就返回 null** —— 调用方必须处理"这个窗口现在不在"。
 *
 * ⚠️ 不要在这里"取不到就退回到任意一个窗口"：那正是 `[0]` 的老毛病换了个写法。
 *    确认框取不到主窗口时，正确行为是**报失败让上层走拒绝路径**，而不是弹到设置窗口上。
 */
export function getWindow(role: WindowRole): BrowserWindow | null {
  const hit = entries.find((e) => e.role === role && !e.win.isDestroyed())
  return hit ? hit.win : null
}

/** 主窗口便捷取法（用得最多） */
export function getMainWindow(): BrowserWindow | null {
  return getWindow('main')
}

/** 该用途的窗口是否还开着 —— 用来做"已开就聚焦、不开才新建"的幂等判断 */
export function isWindowOpen(role: WindowRole): boolean {
  return getWindow(role) !== null
}

/** 广播给**所有**活着窗口。有窗口在关闭路上（isDestroyed）时会被跳过。 */
export function sendToAll(channel: string, payload?: unknown): number {
  let n = 0
  for (const e of entries) {
    if (e.win.isDestroyed() || e.win.webContents.isDestroyed()) continue
    try {
      if (payload === undefined) e.win.webContents.send(channel)
      else e.win.webContents.send(channel, payload)
      n += 1
    } catch {
      // 单个窗口发失败不该影响其余窗口（典型场景：窗口正在销毁）
    }
  }
  return n
}

// 「有没有任何窗口」这类判断**刻意不提供**（plan54 #5）：2026-09-13 起判据是
// 「**主窗口**在不在」（`getMainWindow()`）—— 设置窗浮着而主窗被关时，按"有任何窗口"
// 会不再建主窗，macOS 上就是"点 Dock 没反应"的假死观感。
