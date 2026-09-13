import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOCKER_TYPE, blockerAction, loginItemSupport, SYSTEM_TOGGLES, type SystemSettings } from '@shared/system'
import {
  createSystemIntegration,
  type LoginItemLike,
  type PowerBlockerLike,
  type SystemIntegration,
  type SystemStoreLike
} from '@main/system-integration'

// 系统集成（plan7 批 F1）单测：全部靠注入的替身，**证明不了**真实 Electron API 被调到的效果
// （那是 `scripts/probe-main-system.cjs` 与实机验收的事）—— 这里盯的是**可判定的逻辑**：
// 幂等、不支持的拦截、"设了却没生效"要能报出来、失败不崩、以系统真值为准。
//
// ⚠️ 假 blocker 的 id **从 0 起**：真 Electron 33 实测首个 id 就是 0（`powerSaveBlocker.start` 返回 0、
// `isStarted(0) === true`）。从 1 起的替身会让 `if (!id)` 这类写法永远测不出来。

function fakeBlocker(options: { failStart?: boolean; failStop?: boolean } = {}): {
  blocker: PowerBlockerLike
  starts: string[]
  stops: number[]
} {
  const starts: string[] = []
  const stops: number[] = []
  const live = new Set<number>()
  let seq = 0
  return {
    starts,
    stops,
    blocker: {
      start(type) {
        if (options.failStart) throw new Error('系统拒绝了执行状态请求')
        starts.push(type)
        const id = seq++
        live.add(id)
        return id
      },
      stop(id) {
        stops.push(id)
        if (options.failStop) throw new Error('释放执行状态失败')
        live.delete(id)
      },
      isStarted: (id) => live.has(id)
    }
  }
}

function fakeLogin(options: { failSet?: boolean; failGet?: boolean; omitWillLaunch?: boolean } = {}): {
  loginItem: LoginItemLike
  sets: Array<{ openAtLogin: boolean; path: string }>
  /** 直接改"系统里的真值"，模拟用户在系统设置 / 任务管理器里动了它 */
  force: (state: { openAtLogin?: boolean; willLaunch?: boolean }) => void
} {
  const sets: Array<{ openAtLogin: boolean; path: string }> = []
  let registered = false
  let willLaunch = false
  return {
    sets,
    force: (state) => {
      if (state.openAtLogin !== undefined) registered = state.openAtLogin
      if (state.willLaunch !== undefined) willLaunch = state.willLaunch
    },
    loginItem: {
      set(input) {
        if (options.failSet) throw new Error('注册表写入被拒绝')
        sets.push(input)
        registered = input.openAtLogin
        willLaunch = input.openAtLogin
      },
      get() {
        if (options.failGet) throw new Error('读取启动项失败')
        // `omitWillLaunch` 模拟不上报该字段的平台（macOS 就没有这一项）
        return options.omitWillLaunch
          ? { openAtLogin: registered }
          : { openAtLogin: registered, executableWillLaunchAtLogin: willLaunch }
      }
    }
  }
}

function fakeStore(initial: Partial<SystemSettings> = {}, options: { failWrite?: boolean } = {}): {
  store: SystemStoreLike
  writes: Array<Partial<SystemSettings>>
  value: () => SystemSettings
} {
  let value: SystemSettings = { keepRunning: false, openAtLogin: false, ...initial }
  const writes: Array<Partial<SystemSettings>> = []
  return {
    writes,
    value: () => ({ ...value }),
    store: {
      read: () => ({ ...value }),
      write: (patch) => {
        if (options.failWrite) throw new Error('磁盘写入失败')
        writes.push({ ...patch })
        value = { ...value, ...patch }
      }
    }
  }
}

function harness(
  options: {
    packaged?: boolean
    platform?: string
    failStart?: boolean
    failStop?: boolean
    failSet?: boolean
    failGet?: boolean
    failWrite?: boolean
    omitWillLaunch?: boolean
    stored?: Partial<SystemSettings>
  } = {}
): {
  sys: SystemIntegration
  starts: string[]
  stops: number[]
  sets: Array<{ openAtLogin: boolean; path: string }>
  writes: Array<Partial<SystemSettings>>
  stored: () => SystemSettings
  forceSystem: (state: { openAtLogin?: boolean; willLaunch?: boolean }) => void
  logs: string[]
} {
  const b = fakeBlocker({
    ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
    ...(options.failStop !== undefined ? { failStop: options.failStop } : {})
  })
  const l = fakeLogin({
    ...(options.failSet !== undefined ? { failSet: options.failSet } : {}),
    ...(options.failGet !== undefined ? { failGet: options.failGet } : {}),
    ...(options.omitWillLaunch !== undefined ? { omitWillLaunch: options.omitWillLaunch } : {})
  })
  const s = fakeStore(options.stored ?? {}, {
    ...(options.failWrite !== undefined ? { failWrite: options.failWrite } : {})
  })
  const logs: string[] = []
  const sys = createSystemIntegration({
    packaged: options.packaged ?? true,
    platform: options.platform ?? 'win32',
    execPath: 'C:\\app\\jiushililu.exe',
    powerSaveBlocker: b.blocker,
    loginItem: l.loginItem,
    store: s.store,
    log: (message) => logs.push(message)
  })
  return {
    sys,
    starts: b.starts,
    stops: b.stops,
    sets: l.sets,
    writes: s.writes,
    stored: s.value,
    forceSystem: l.force,
    logs
  }
}

describe('blockerAction：幂等调度', () => {
  it('没有 id + 想开 → start；有 id + 想开 → 不动（重复 start 会漏掉旧 id，永远关不掉）', () => {
    expect(blockerAction(null, true)).toBe('start')
    expect(blockerAction(7, true)).toBe('none')
  })

  it('有 id + 想关 → stop；没有 id + 想关 → 不动', () => {
    expect(blockerAction(7, false)).toBe('stop')
    expect(blockerAction(null, false)).toBe('none')
  })

  it('⚠️ id 就是 0 也算"有"（判空只能 `=== null`）', () => {
    expect(blockerAction(0, true)).toBe('none')
    expect(blockerAction(0, false)).toBe('stop')
  })
})

describe('loginItemSupport：开发态与平台拦截', () => {
  it('打包版 Windows / macOS → 支持', () => {
    expect(loginItemSupport(true, 'win32').supported).toBe(true)
    expect(loginItemSupport(true, 'darwin').supported).toBe(true)
    expect(loginItemSupport(true, 'win32').reason).toBeNull()
  })

  it('⚠️ 开发态 → 不支持，且给出原因（写进去的是 electron.exe 的路径，不是本应用）', () => {
    const dev = loginItemSupport(false, 'win32')
    expect(dev.supported).toBe(false)
    expect(dev.reason).toContain('仅安装版可用')
  })

  it('Linux → 不支持（Electron 未实现登录项接口）', () => {
    expect(loginItemSupport(true, 'linux').supported).toBe(false)
  })
})

describe('createSystemIntegration：后台运行（blocker）', () => {
  it('开 → 用 prevent-app-suspension 起一次，界面看到"生效"，意图落盘', () => {
    const h = harness()
    const view = h.sys.set({ keepRunning: true })
    expect(h.starts).toEqual([BLOCKER_TYPE])
    expect(view.keepRunning).toBe(true)
    expect(view.keepRunningActive).toBe(true)
    expect(h.stored().keepRunning).toBe(true)
  })

  it('id 为 0 时也认得出"已生效"（真值就是 0）', () => {
    const h = harness()
    expect(h.starts).toHaveLength(0)
    const view = h.sys.set({ keepRunning: true })
    expect(view.keepRunningActive).toBe(true)
  })

  it('重复开 → 不再 start（幂等）', () => {
    const h = harness()
    h.sys.set({ keepRunning: true })
    h.sys.set({ keepRunning: true })
    expect(h.starts).toHaveLength(1)
  })

  it('关 → stop 掉那个 id，界面看到"未生效"', () => {
    const h = harness()
    h.sys.set({ keepRunning: true })
    const view = h.sys.set({ keepRunning: false })
    expect(h.stops).toHaveLength(1)
    expect(view.keepRunningActive).toBe(false)
    expect(h.stored().keepRunning).toBe(false)
  })

  it('start 抛错 → 不崩，给出原因，且**意图照样落盘**（下次启动重试；不写成"没开"是防丢用户的选择）', () => {
    const h = harness({ failStart: true })
    const view = h.sys.set({ keepRunning: true })
    expect(view.keepRunning).toBe(true)
    expect(view.keepRunningActive).toBe(false)
    expect(view.keepRunningError).toBeTruthy()
    expect(h.stored().keepRunning).toBe(true)
  })

  it('⚠️ stop 抛错 → 必须报出来（系统仍被按着不休眠），且 id 留着以便重试；随后再打开会清掉这条过期报错', () => {
    const h = harness({ failStop: true })
    h.sys.set({ keepRunning: true })
    const view = h.sys.set({ keepRunning: false })
    expect(view.keepRunningError).toBeTruthy()
    expect(view.keepRunningActive).toBe(true)
    const again = h.sys.set({ keepRunning: true })
    expect(again.keepRunningError).toBeNull()
  })

  it('落盘失败 → 报"保存失败"且**不假装已应用**（意图仍是旧值）', () => {
    const h = harness({ failWrite: true })
    const view = h.sys.set({ keepRunning: true })
    expect(view.keepRunning).toBe(false)
    expect(view.keepRunningError).toContain('保存失败')
    expect(h.starts).toHaveLength(0)
  })

  it('起不来之后又把开关关掉 → 那条失败原因要跟着消失（否则已关掉的开关底下挂着过期报错）', () => {
    const h = harness({ failStart: true })
    h.sys.set({ keepRunning: true })
    const off = h.sys.set({ keepRunning: false })
    expect(off.keepRunningError).toBeNull()
  })
})

describe('createSystemIntegration：开机自启', () => {
  it('不支持时：不写系统、不落盘，且把原因带回去（不留"设置里开着、启动项里没有"的假象）', () => {
    const h = harness({ packaged: false })
    const view = h.sys.set({ openAtLogin: true })
    expect(h.sets).toHaveLength(0)
    expect(h.writes).toHaveLength(0)
    expect(view.openAtLogin).toBe(false)
    expect(view.openAtLoginSupported).toBe(false)
    expect(view.openAtLoginReason).toBeTruthy()
  })

  it('支持时：用**应用自己的**可执行文件路径写入，并落盘', () => {
    const h = harness({ packaged: true })
    const view = h.sys.set({ openAtLogin: true })
    expect(h.sets).toEqual([{ openAtLogin: true, path: 'C:\\app\\jiushililu.exe' }])
    expect(view.openAtLogin).toBe(true)
    expect(view.openAtLoginActive).toBe(true)
    expect(h.stored().openAtLogin).toBe(true)
  })

  it('关掉 → 系统接口收到 false，落盘同步', () => {
    const h = harness({ packaged: true, stored: { openAtLogin: true } })
    const view = h.sys.set({ openAtLogin: false })
    expect(h.sets).toEqual([{ openAtLogin: false, path: 'C:\\app\\jiushililu.exe' }])
    expect(view.openAtLogin).toBe(false)
  })

  it('写系统失败 → 不崩、给出原因、**不落盘**（落盘会变成假的"已开"）', () => {
    const h = harness({ packaged: true, failSet: true })
    const view = h.sys.set({ openAtLogin: true })
    expect(view.openAtLogin).toBe(false)
    expect(view.openAtLoginError).toBeTruthy()
    expect(h.writes).toHaveLength(0)
  })

  it('读回失败 → 报"未生效"而不是崩（读不到就算没生效，不猜）', () => {
    const h = harness({ packaged: true, failGet: true })
    expect(h.sys.view().openAtLoginActive).toBe(false)
  })

  it('⚠️ **启动项在、但被系统停用**（任务管理器里关了）→ `openAtLoginActive` 必须是 false', () => {
    const h = harness({ packaged: true })
    h.sys.set({ openAtLogin: true })
    h.forceSystem({ openAtLogin: true, willLaunch: false })
    const view = h.sys.view()
    expect(view.openAtLogin).toBe(true)
    expect(view.openAtLoginActive).toBe(false)
  })

  it('平台不上报 `executableWillLaunchAtLogin` 时 → 回落到 `openAtLogin`（macOS 就没有这一项）', () => {
    const h = harness({ packaged: true, omitWillLaunch: true })
    const view = h.sys.set({ openAtLogin: true })
    expect(view.openAtLoginActive).toBe(true)
  })
})

describe('createSystemIntegration：启动时应用与收尾', () => {
  it('applyStored：按落盘意图起 blocker（重启后仍生效靠这一步）', () => {
    const h = harness({ stored: { keepRunning: true } })
    const view = h.sys.applyStored()
    expect(h.starts).toEqual([BLOCKER_TYPE])
    expect(view.keepRunningActive).toBe(true)
  })

  it('applyStored：落盘值没开 → 不起 blocker', () => {
    const h = harness()
    h.sys.applyStored()
    expect(h.starts).toHaveLength(0)
  })

  it('⚠️ 系统真值与落盘不一致 → 以系统为准写回，**不反过来覆盖系统**（用户在系统里关掉是他的决定）', () => {
    const h = harness({ stored: { openAtLogin: true } })
    h.forceSystem({ openAtLogin: true, willLaunch: false })
    const view = h.sys.applyStored()
    expect(h.sets).toHaveLength(0)
    expect(view.openAtLogin).toBe(false)
    expect(h.stored().openAtLogin).toBe(false)
  })

  it('系统真值与落盘一致 → 不做多余的写（免得每次启动都写一次配置）', () => {
    const h = harness({ stored: { openAtLogin: true } })
    h.forceSystem({ openAtLogin: true, willLaunch: true })
    h.sys.applyStored()
    expect(h.writes).toHaveLength(0)
  })

  it('⚠️ 启动项**根本不在**（换了安装目录 / portable 每次解压到临时目录）→ 按意图**补写**，不把意图抹成关', () => {
    const h = harness({ stored: { openAtLogin: true } })
    h.forceSystem({ openAtLogin: false, willLaunch: false })
    const view = h.sys.applyStored()
    expect(h.sets).toEqual([{ openAtLogin: true, path: 'C:\\app\\jiushililu.exe' }])
    expect(h.writes).toHaveLength(0)
    expect(view.openAtLogin).toBe(true)
  })

  it('系统里开着而落盘记的是关 → 采纳系统真值（以系统为准的另一半）', () => {
    const h = harness({ stored: { openAtLogin: false } })
    h.forceSystem({ openAtLogin: true, willLaunch: true })
    const view = h.sys.applyStored()
    expect(h.sets).toHaveLength(0)
    expect(view.openAtLogin).toBe(true)
    expect(h.stored().openAtLogin).toBe(true)
  })

  it('dispose：停掉 blocker，但**不改落盘意图**（退出是收尾，不是"用户把它关了"）；重复调用安全', () => {
    const h = harness({ stored: { keepRunning: true } })
    h.sys.applyStored()
    h.sys.dispose()
    h.sys.dispose()
    expect(h.stops).toHaveLength(1)
    expect(h.stored().keepRunning).toBe(true)
    expect(h.writes).toHaveLength(0)
  })
})

describe('接线守卫：这两个开关必须真的接上（防"配置里看着有、实际没人读"）', () => {
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

  it('组合根在 ready 时应用一次、退出时收尾，并把实例交给 IPC 层', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('createSystemIntegration(')
    expect(main).toContain('.applyStored()')
    expect(main).toContain('system.dispose()')
    expect(main).toContain('system,')
  })

  it('通道、preload、handler 三处都在（少一处就是"界面点了没反应"）', () => {
    expect(read('src/shared/ipc.ts')).toContain("systemGet: 'system:get'")
    expect(read('src/shared/ipc.ts')).toContain("systemSet: 'system:set'")
    expect(read('src/preload/index.ts')).toContain('IPC.systemGet')
    expect(read('src/preload/index.ts')).toContain('IPC.systemSet')
    expect(read('src/main/ipc.ts')).toContain('IPC.systemGet')
    expect(read('src/main/ipc.ts')).toContain('IPC.systemSet')
  })

  it('主进程读自启状态时**带上了** `executableWillLaunchAtLogin`，且 get 传的 path 与 set 相同', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('getLoginItemSettings(input)')
    const impl = read('src/main/system-integration.ts')
    expect(impl).toContain('executableWillLaunchAtLogin')
    expect(impl).toContain('deps.loginItem.get({ path: deps.execPath })')
  })
})

describe('文案真源：这两句由 shared 提供，界面不自己编一份（与 TOKEN_TIER_LIST 同口径）', () => {
  it('两项开关的 key / label / note 都在 shared 里，界面只引用', () => {
    expect(SYSTEM_TOGGLES.map((t) => t.key)).toEqual(['keepRunning', 'openAtLogin'])
    expect(SYSTEM_TOGGLES.map((t) => t.label)).toEqual(['锁屏与熄屏后继续运行', '开机自启'])
    for (const t of SYSTEM_TOGGLES) expect(t.note.length).toBeGreaterThan(20)
    const ui = readFileSync(join(process.cwd(), 'src/renderer/src/views/SettingsView.tsx'), 'utf8')
    expect(ui).toContain('SYSTEM_TOGGLES')
    expect(ui).not.toContain('锁屏与熄屏后继续运行')
  })
})
