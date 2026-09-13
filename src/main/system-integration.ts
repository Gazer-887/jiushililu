/**
 * 系统集成（plan7 批 F1）—— 主进程侧状态机：把落盘的**意图**翻成真实的系统调用。
 *
 * ⚠️ 本文件**不 import electron**（依赖全部注入）：架构守卫 `tests/unit/architecture.test.ts` 禁止
 * 单测 import 图里出现 electron / electron-store，而 `store/settings.ts` 恰好依赖 electron-store
 * —— 故 store 也以 `{read, write}` 注入，真实装配留在 `src/main/index.ts`（组合根）。
 */

import {
  BLOCKER_TYPE,
  blockerAction,
  loginItemSupport,
  type SystemSettings,
  type SystemView
} from '@shared/system'

export interface PowerBlockerLike {
  start(type: string): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface LoginItemLike {
  set(settings: { openAtLogin: boolean; path: string }): void
  /**
   * `app.getLoginItemSettings()`。⚠️ **必须把 `executableWillLaunchAtLogin` 一起读出来**：
   * 只有它说的是"登录时会不会真的拉起"；任务管理器里被停用时 `openAtLogin` 仍是 true。
   * ⚠️ 也要**传与 `set` 同一个 path**：Electron 只在两边参数一致时才认得出那条启动项。
   */
  get(settings?: { path: string }): {
    openAtLogin: boolean
    executableWillLaunchAtLogin?: boolean
  }
}

export interface SystemStoreLike {
  read(): SystemSettings
  write(patch: Partial<SystemSettings>): void
}

export interface SystemIntegrationDeps {
  /** `app.isPackaged` —— 开发态不给写自启项（见 `@shared/system` 的 `loginItemSupport`） */
  packaged: boolean
  /** `process.platform` */
  platform: string
  /** `process.execPath`：写进启动项的必须是**本应用**的可执行文件 */
  execPath: string
  powerSaveBlocker: PowerBlockerLike
  loginItem: LoginItemLike
  store: SystemStoreLike
  log?: (message: string, extra?: Record<string, unknown>) => void
}

export interface SystemIntegration {
  view(): SystemView
  set(patch: Partial<SystemSettings>): SystemView
  /** `app.whenReady` 里应用一次落盘意图（重启后仍生效靠这一步） */
  applyStored(): SystemView
  dispose(): void
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createSystemIntegration(deps: SystemIntegrationDeps): SystemIntegration {
  const support = loginItemSupport(deps.packaged, deps.platform)
  /** blocker id 是**唯一真值**：Electron 只有拿着它才能 stop，丢了就是"开了关不掉" */
  let blockerId: number | null = null
  let keepRunningError: string | null = null
  let openAtLoginError: string | null = null

  const log = (message: string, extra?: Record<string, unknown>): void => deps.log?.(message, extra)

  function applyKeepRunning(wanted: boolean): void {
    const action = blockerAction(blockerId, wanted)
    if (action === 'none') {
      // 已经在想要的状态上：清掉上一次的失败原因 —— 否则用户把开关关掉后，底下还挂着一句已过期的报错
      keepRunningError = null
      return
    }
    if (action === 'stop') {
      const id = blockerId
      try {
        if (id !== null) deps.powerSaveBlocker.stop(id)
        // 停成功才清 id：抛错还留着 id，才能重试、也才对得上 `isStarted` 的真值
        blockerId = null
        keepRunningError = null
        log('后台运行已关闭')
      } catch (err) {
        // 关不掉也要说出来：系统仍在被我们按着不休眠，静默会让人以为已经放开了
        keepRunningError = reasonOf(err)
        log('关闭后台运行失败', { reason: keepRunningError })
      }
      return
    }
    try {
      blockerId = deps.powerSaveBlocker.start(BLOCKER_TYPE)
      keepRunningError = null
      log('后台运行已生效', { blockerId })
    } catch (err) {
      // 起不来**不许抛**：设置项已落盘，这次没生效只影响本次运行，下次启动会重试
      keepRunningError = reasonOf(err)
      log('后台运行未能生效', { reason: keepRunningError })
    }
  }

  /** 系统层的两件事分开读：**启动项写没写**（`openAtLogin`）与**登录时会不会真拉起**（`willLaunch`） */
  function readLoginState(): { registered: boolean; willLaunch: boolean } {
    if (!support.supported) return { registered: false, willLaunch: false }
    try {
      const s = deps.loginItem.get({ path: deps.execPath })
      const registered = s.openAtLogin === true
      const willLaunch =
        typeof s.executableWillLaunchAtLogin === 'boolean' ? s.executableWillLaunchAtLogin : registered
      return { registered, willLaunch }
    } catch (err) {
      log('读取开机自启状态失败', { reason: reasonOf(err) })
      return { registered: false, willLaunch: false }
    }
  }

  function view(): SystemView {
    const stored = deps.store.read()
    return {
      keepRunning: stored.keepRunning,
      keepRunningActive: blockerId !== null && deps.powerSaveBlocker.isStarted(blockerId),
      keepRunningError,
      openAtLogin: stored.openAtLogin,
      openAtLoginActive: readLoginState().willLaunch,
      openAtLoginSupported: support.supported,
      openAtLoginReason: support.reason,
      openAtLoginError
    }
  }

  /** 落盘失败要**说出来**（现在没有"保存失败"这种字段，就用对应开关自己的错误位），并且不继续假装已应用 */
  function writeOrFail(patch: Partial<SystemSettings>, field: 'keepRunning' | 'openAtLogin'): boolean {
    try {
      deps.store.write(patch)
      return true
    } catch (err) {
      const message = `设置保存失败：${reasonOf(err)}`
      if (field === 'keepRunning') keepRunningError = message
      else openAtLoginError = message
      log('设置保存失败', { field, reason: reasonOf(err) })
      return false
    }
  }

  function set(patch: Partial<SystemSettings>): SystemView {
    if (patch.keepRunning !== undefined) {
      if (writeOrFail({ keepRunning: patch.keepRunning }, 'keepRunning')) {
        applyKeepRunning(patch.keepRunning)
      }
    }
    // 不支持时**不写盘也不碰系统**：留着"设置里开着、启动项里没有"的假象比没有这个开关更坏
    if (patch.openAtLogin !== undefined && support.supported) {
      try {
        deps.loginItem.set({ openAtLogin: patch.openAtLogin, path: deps.execPath })
        openAtLoginError = null
        writeOrFail({ openAtLogin: patch.openAtLogin }, 'openAtLogin')
      } catch (err) {
        openAtLoginError = reasonOf(err)
        log('写入开机自启失败', { reason: openAtLoginError })
      }
    }
    return view()
  }

  function applyStored(): SystemView {
    const stored = deps.store.read()
    applyKeepRunning(stored.keepRunning)
    if (support.supported) {
      const state = readLoginState()
      if (state.willLaunch !== stored.openAtLogin) {
        if (stored.openAtLogin && !state.willLaunch && !state.registered) {
          // 启动项**根本不在** = 路径失效（换了安装目录、portable 版每次解压到不同临时目录），
          // **不是**"用户关掉了"：按用户意图补写一次，不许把意图静默抹成关
          try {
            deps.loginItem.set({ openAtLogin: true, path: deps.execPath })
            log('自启项缺失或指向旧路径，已按意图补写', { path: deps.execPath })
          } catch (err) {
            openAtLoginError = reasonOf(err)
            log('补写自启项失败', { reason: openAtLoginError })
          }
        } else {
          // 项在却被系统停用（任务管理器里关了），或系统里开着而我们记的是关 → **以系统为准**写回。
          // 不静默改回去：那是用户的决定。
          writeOrFail({ openAtLogin: state.willLaunch }, 'openAtLogin')
          log('开机自启与系统不一致，以系统为准', {
            stored: stored.openAtLogin,
            system: state.willLaunch,
            registered: state.registered
          })
        }
      }
    }
    return view()
  }

  function dispose(): void {
    // 只收系统请求，**不碰落盘意图** —— 退出是收尾，不是"用户把它关了"
    applyKeepRunning(false)
  }

  return { view, set, applyStored, dispose }
}
