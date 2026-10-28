import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_DEFAULT, type UIPrefs } from '@shared/splitter'

/**
 * 界面偏好的 IPC 把关层（`ipc.ts` 的 `uiPrefsSet`）与存储层。
 * S89-01 起会话速度覆盖已移除：本文件保留其余偏好的形状/落盘/广播契约，并证明旧档案字段被忽略。
 */

// 编译期钉住"这份清单 == UIPrefs 的全部键"：UIPrefs 加字段而这里没跟上 → typecheck 直接红
const UI_PREF_KEYS: Record<keyof UIPrefs, true> = {
  sidebarWidth: true,
  dockWidth: true,
  theme: true,
  fontScale: true,
  uiFont: true,
  locale: true,
  workbench: true,
  workbenchSizes: true
}

/** uiPrefsSet 的 zod 层现覆盖的键 */
const IPC_SCHEMA_KEYS: ReadonlyArray<keyof UIPrefs> = [
  'sidebarWidth',
  'dockWidth',
  'theme',
  'fontScale',
  'uiFont',
  'locale',
  'workbench',
  'workbenchSizes'
]

/** 尚未接进 uiPrefsSet 的键：必须显式登记，接线后从这里移出（下方守卫会强制对账） */
const IPC_PENDING_KEYS: ReadonlyArray<keyof UIPrefs> = []

const fixture = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  settingsChanged: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (!fixture.root) throw new Error('测试数据根未设置')
      return fixture.root
    }
  },
  ipcMain: {
    handle: (key: string, fn: (event: unknown, payload: unknown) => unknown) => {
      fixture.handlers.set(key, fn)
    }
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', async () => {
  const { default: Conf } = await import('conf')
  return {
    default: class extends Conf {
      constructor(options: { name: string }) {
        if (!fixture.root) throw new Error('必须先指定隔离数据根')
        super({
          cwd: fixture.root,
          configName: options.name,
          projectName: 's89-01-ui-prefs',
          projectVersion: '0.0.0'
        })
      }
    }
  }
})

function uiPrefsSetHandler(): string {
  const src = readFileSync('src/main/ipc.ts', 'utf8')
  const at = src.indexOf('IPC.uiPrefsSet')
  expect(at, 'ipc.ts 里找不到 uiPrefsSet 通道 —— 判据的锚点要重新对').toBeGreaterThan(-1)
  const end = src.indexOf('.parse(raw)', at)
  expect(end, 'uiPrefsSet 的参数校验不再是 .parse(raw) 形状').toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('uiPrefsSet：已接线的界面偏好字段都要过 zod', () => {
  it.each(IPC_SCHEMA_KEYS)('%s 在校验层有一行（漏了就静默被剥掉）', (key) => {
    expect(uiPrefsSetHandler(), `校验层没有 ${key}，渲染端发过来会被 zod 丢掉`).toContain(`${key}:`)
  })

  it('未接线的键必须登记在 IPC_PENDING_KEYS，且两头并集覆盖 UIPrefs 全部键', () => {
    const handler = uiPrefsSetHandler()
    const wired = (Object.keys(UI_PREF_KEYS) as Array<keyof UIPrefs>).filter((k) =>
      handler.includes(`${k}:`)
    )
    expect(IPC_PENDING_KEYS.filter((k) => wired.includes(k))).toEqual([])
    expect([...wired, ...IPC_PENDING_KEYS].sort()).toEqual(Object.keys(UI_PREF_KEYS).sort())
  })

  it('已移除的会话速度覆盖不再出现在校验层', () => {
    const handler = uiPrefsSetHandler()
    expect(handler).not.toContain('conversationSpeedOverrides')
    expect(handler).not.toContain('SPEED_OVERRIDES')
  })

  it('落盘后要广播，否则另一个窗口停在旧值（主题是文档级属性，一边新一边旧）', () => {
    const src = readFileSync('src/main/ipc.ts', 'utf8')
    const at = src.indexOf('IPC.uiPrefsSet')
    const end = src.indexOf('IPC.uiPrefsReset', at)
    expect(src.slice(at, end)).toContain("onSettingsChanged?.('ui-prefs')")
  })
})

describe('S89-01 旧档案兼容：会话速度覆盖字段读时忽略、不报错', () => {
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'jsl-s89-01-ui-'))
    vi.resetModules()
  })

  afterEach(() => {
    if (fixture.root) rmSync(fixture.root, { recursive: true, force: true })
    fixture.root = ''
  })

  it('盘上带 conversationSpeedOverrides 的旧档案可正常读回，其余偏好不受影响', async () => {
    writeFileSync(
      join(fixture.root, 'ui-prefs.json'),
      JSON.stringify({
        sidebarWidth: 301,
        theme: 'yemeng',
        conversationSpeedOverrides: { 'conv-a': 'fast', 'conv-b': 'normal' }
      }),
      'utf8'
    )
    const store = await import('@main/store/ui-prefs')
    const prefs = store.getUIPrefs()
    expect(prefs.sidebarWidth).toBe(301)
    expect(prefs.theme).toBe('yemeng')
    expect('conversationSpeedOverrides' in prefs).toBe(false)
  })

  it('旧档案缺字段时一切回到既有默认值', async () => {
    const store = await import('@main/store/ui-prefs')
    const prefs = store.getUIPrefs()
    expect(prefs.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect(prefs.theme).toBe('qingkong')
  })

  it('setUIPref 写入其它偏好时不报错，也不会新产生覆盖字段', async () => {
    const store = await import('@main/store/ui-prefs')
    const next = store.setUIPref({ sidebarWidth: 260, theme: 'qingkong' })
    expect(next.sidebarWidth).toBe(260)
    expect('conversationSpeedOverrides' in next).toBe(false)
    const disk = existsSync(join(fixture.root, 'ui-prefs.json'))
      ? (JSON.parse(readFileSync(join(fixture.root, 'ui-prefs.json'), 'utf8')) as Record<string, unknown>)
      : {}
    expect(disk.sidebarWidth).toBe(260)
    expect('conversationSpeedOverrides' in disk).toBe(false)
  })

  it('resetUIPrefs 不报错，且不再返回覆盖字段', async () => {
    const store = await import('@main/store/ui-prefs')
    const next = store.resetUIPrefs()
    expect(next.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect('conversationSpeedOverrides' in next).toBe(false)
  })
})

// ── S3-20B2 零改动守卫（共享类型 / preload 通用桥）───────────────────

describe('S3-20B2 零改动守卫：共享类型与 preload 仍是既有通用桥', () => {
  it('shared/ipc.ts 保留 uiPrefsSet 通道与 setUIPrefs(patch) 签名，且没有会话级专用通道', () => {
    const src = readFileSync('src/shared/ipc.ts', 'utf8')
    expect(src).toContain("uiPrefsSet: 'ui-prefs:set'")
    expect(src).toMatch(/setUIPrefs\(patch: Partial<UIPrefs>\): Promise<UIPrefs>/)
    expect(src).not.toMatch(/speedOverride/i)
  })

  it('preload/index.ts 仍把整份 patch 原样交给 IPC.uiPrefsSet，不特判覆盖字段', () => {
    const src = readFileSync('src/preload/index.ts', 'utf8')
    expect(src).toContain('setUIPrefs: (patch) => ipcRenderer.invoke(IPC.uiPrefsSet, patch)')
    expect(src).not.toMatch(/speedOverride/i)
  })
})

// ── 真 IPC handler 行为（形状 + 删除顺序）────────────────────────────

function convDeleteHandlerSource(): string {
  const src = readFileSync('src/main/ipc.ts', 'utf8')
  const at = src.indexOf('ipcMain.handle(IPC.convDelete')
  expect(at, 'ipc.ts 里找不到 convDelete 通道 —— 判据锚点要重新对').toBeGreaterThan(-1)
  const end = src.indexOf('\n  })', at)
  expect(end, 'convDelete 的 handler 结构变了，窗口取不到 body').toBeGreaterThan(at)
  return src.slice(at, end)
}

async function registerTestIpc(root: string): Promise<void> {
  fixture.root = root
  vi.resetModules()
  const { registerIpcHandlers } = await import('@main/ipc')
  const { createMemoryStore } = await import('@main/store/memory-store')
  registerIpcHandlers({
    userDataDir: root,
    memory: createMemoryStore(root),
    playbook: {} as never,
    agent: {
      getWorkspaceRoot: () => root,
      builtinAgentsDir: join(root, 'builtin'),
      userAgentsDir: join(root, 'agents'),
      checkpoints: {}
    } as never,
    trash: async () => {},
    confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: {
      ask: async () => ({ answered: false as const, reason: 'no-window' as const }),
      respond: () => false,
      abortAll: () => {}
    },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} },
    terminal: {} as never,
    system: { getBlockers: () => [] } as never,
    execEventSink: { record: () => {} } as never,
    network: {} as never,
    onSettingsChanged: (kind: string) => fixture.settingsChanged.push(kind)
  })
}

describe('S89-01 IPC 接线：uiPrefsSet 形状 + convDelete 顺序', () => {
  type Handler = (event: unknown, payload: unknown) => unknown
  let ipcRoot = ''
  let setPrefs!: Handler
  let resetPrefs!: Handler
  let delConv!: Handler

  beforeAll(async () => {
    ipcRoot = mkdtempSync(join(tmpdir(), 'jsl-s89-01-ipc-'))
    await registerTestIpc(ipcRoot)
    const { IPC } = await import('@shared/ipc')
    setPrefs = fixture.handlers.get(IPC.uiPrefsSet)!
    resetPrefs = fixture.handlers.get(IPC.uiPrefsReset)!
    delConv = fixture.handlers.get(IPC.convDelete)!
    expect(setPrefs, 'uiPrefsSet handler 未注册').toBeTypeOf('function')
    expect(resetPrefs, 'uiPrefsReset handler 未注册').toBeTypeOf('function')
    expect(delConv, 'convDelete handler 未注册').toBeTypeOf('function')
  })

  afterAll(() => {
    rmSync(ipcRoot, { recursive: true, force: true })
    fixture.root = ''
    fixture.handlers.clear()
  })

  beforeEach(() => {
    resetPrefs({}, undefined)
    fixture.settingsChanged.length = 0
  })

  function diskPrefsAtIpc(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(ipcRoot, 'ui-prefs.json'), 'utf8')) as Record<string, unknown>
  }

  it('既有偏好字段原样通过并落盘', () => {
    const next = setPrefs({}, { sidebarWidth: 321, theme: 'yemeng' }) as UIPrefs
    expect(next.sidebarWidth).toBe(321)
    expect(next.theme).toBe('yemeng')
    expect(diskPrefsAtIpc().sidebarWidth).toBe(321)
    expect(diskPrefsAtIpc().theme).toBe('yemeng')
  })

  it('旧渲染端夹带 conversationSpeedOverrides：不报错，按未知键剥掉', () => {
    const next = setPrefs({}, {
      sidebarWidth: 300,
      conversationSpeedOverrides: { s1: 'fast' }
    }) as UIPrefs
    expect(next.sidebarWidth).toBe(300)
    expect('conversationSpeedOverrides' in next).toBe(false)
  })

  it('删除会话仍先 abort → 删会话 → 清目标，不再做速度覆盖清理', () => {
    const body = convDeleteHandlerSource()
    const ordered = ['chatGate.abort(id)', 'deleteConversation(id)', 'removeGoalsOf(id)']
    const positions = ordered.map((needle) => body.indexOf(needle))
    expect(positions.every((p) => p > -1), `缺少步骤：${JSON.stringify(positions)}`).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(body).not.toContain('deleteConversationSpeedOverride')
  })

  it('删除会话不影响其他 UIPrefs 字段', () => {
    setPrefs({}, { sidebarWidth: 322, theme: 'yemeng' })
    delConv({}, 'any-session')
    const onDisk = diskPrefsAtIpc()
    expect(onDisk.sidebarWidth).toBe(322)
    expect(onDisk.theme).toBe('yemeng')
  })
})
