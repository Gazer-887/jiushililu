/**
 * 系统集成（plan7 批 F1）—— 纯逻辑：不 import electron、不碰 IO，可被单测直接覆盖。
 *
 * 两项设置：① 锁屏与熄屏后继续运行 ② 开机自启。
 * ⚠️ **意图**（设置里写着什么）与**生效**（系统层真在做什么）必须分开报：
 * blocker 可能起不来、自启项可能写失败，只报意图会让界面显示"已开"而系统照睡
 * —— 那正是 plan7 点名的"以为在后台跑、其实被挂起了"。
 */

/** 持久化的意图（缺字段 = 老配置 → `false`，与省 token 档位同一口径：回落默认、不写回盘） */
export interface SystemSettings {
  keepRunning: boolean
  openAtLogin: boolean
}

/** 给界面的完整状态：意图 + 生效 + 不支持/失败的原因 */
export interface SystemView extends SystemSettings {
  /**
   * **我们持有的那份"别睡"请求还在**（`powerSaveBlocker.isStarted`）。
   * ⚠️ 它**不等于"系统此刻真的没睡"**：合盖 / 手动睡眠会立刻撤销所有请求，Linux 上还可能
   * "进程拿到了 id，而会话总线那边根本没人应答"。界面文案别越过这条边界去承诺。
   */
  keepRunningActive: boolean
  keepRunningError: string | null
  /**
   * 系统里读回的自启真值 —— **"登录时会不会真的拉起本应用"**，不是"启动项写没写进去"。
   * ⚠️ Windows 上这两件事会分开：任务管理器里停用后，注册表项还在（`openAtLogin` 仍 true）而
   * `executableWillLaunchAtLogin` 变 false。只看前者，界面会显示"已开启"而机器根本不会拉起它。
   */
  openAtLoginActive: boolean
  openAtLoginSupported: boolean
  openAtLoginReason: string | null
  openAtLoginError: string | null
}

/**
 * blocker 只保「系统不睡」，不保「屏幕常亮」—— 用户 2026-09-13 定调：
 * **屏幕可以关，后台任务要继续跑**。`prevent-display-sleep` 会让屏幕被迫常亮，不是要的行为。
 */
export const BLOCKER_TYPE = 'prevent-app-suspension'

/**
 * 幂等调度：当前 blocker 有 id 吗 + 想不想开 → 该做什么。
 * ⚠️ 判空一律 `=== null`：真机第一个 blocker id **就是 0**，`if (!id)` 会把它当成"没有 id"。
 * 重复 `start` 会漏掉旧 id（id 不复用 → 那一个请求再也没人撤得掉）。
 */
export function blockerAction(current: number | null, wanted: boolean): 'start' | 'stop' | 'none' {
  if (wanted) return current === null ? 'start' : 'none'
  return current === null ? 'none' : 'stop'
}

export interface LoginItemSupport {
  supported: boolean
  reason: string | null
}

/**
 * 开机自启的可用性判定。
 * ⚠️ **开发态必须拦住**：`setLoginItemSettings` 写进注册表的是 `electron.exe` 的路径 ——
 * 那不是本应用，用户会在系统的启动项里看到一个指向 Electron 的条目。Linux 未实现该接口。
 */
export function loginItemSupport(packaged: boolean, platform: string): LoginItemSupport {
  if (!packaged) {
    return { supported: false, reason: '开发态写入的启动项指向 Electron 而非本应用，仅安装版可用。' }
  }
  if (platform === 'linux') {
    return { supported: false, reason: '当前系统不支持登录项接口。' }
  }
  return { supported: true, reason: null }
}

/** 一项开关的界面文案（与省 token 档位同一口径：影响什么 + 代价） */
export interface SystemToggleInfo {
  key: keyof SystemSettings
  label: string
  note: string
}

export const SYSTEM_TOGGLES: readonly SystemToggleInfo[] = [
  {
    key: 'keepRunning',
    label: '锁屏与熄屏后继续运行',
    // ⚠️ 只承诺"阻止**空闲**自动睡眠"：Electron 33 走 Chromium WakeLock（Windows 侧是
    // `PowerRequestExecutionRequired`），合盖 / 手动睡眠会立刻撤销请求，用电池的 Modern Standby
    // 机型还会在睡眠超时后数分钟失效 —— 写成"系统绝不睡眠"是兑现不了的承诺。
    note: '阻止系统因空闲自动睡眠（需应用保持运行）。合盖或手动睡眠仍会中断；代价是功耗与电池消耗增加。'
  },
  {
    key: 'openAtLogin',
    label: '开机自启',
    note: '登录系统后自动启动本应用。尚未提供托盘，启动时会直接显示主窗口；关闭主窗口即退出应用，后台任务与终端一并终止。'
  }
]
