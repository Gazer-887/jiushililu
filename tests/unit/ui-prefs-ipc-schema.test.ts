import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_DEFAULT, type UIPrefs } from '@shared/splitter'

/**
 * 界面偏好的 IPC 把关层（`ipc.ts` 的 `uiPrefsSet`）+ 会话级 FAST 覆盖的共享类型与有界存储。
 * IPC 层跑在真主进程里，单测起不来，真渲染门禁用的又是隔离桩 —— 所以那一层退一档查源码。
 * 存储层则用**真实 conf 后端 + 私有临时目录**（同 request-policy.test.ts 范式）验落盘，不读真实用户配置。
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
  workbenchSizes: true,
  // S3-20B1：会话级 FAST 覆盖走独立通道，本卡只做类型与存储，IPC 接线留给 S3-20B2
  conversationSpeedOverrides: true
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
  'workbenchSizes',
  // S3-20B2：会话级 FAST 覆盖接进既有通用桥，不新增第二通道
  'conversationSpeedOverrides'
]

/** 尚未接进 uiPrefsSet 的键：必须显式登记，接线后从这里移出（下方守卫会强制对账） */
const IPC_PENDING_KEYS: ReadonlyArray<keyof UIPrefs> = []

const fixture = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  settingsChanged: [] as string[]
}))

// 落盘跳用真实 electron-store 后端 conf + 临时目录，不读真实用户配置
// S3-20B2 起还要真注册 ipc.ts 的 handler（行为级验收），故 electron 桩补齐 ipcMain / app
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
          projectName: 's3-20b1-ui-prefs',
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
    // 互斥：接线了却还挂在待接线清单里 → 红（S3-20B2 接线后应把该键移出）
    expect(IPC_PENDING_KEYS.filter((k) => wired.includes(k))).toEqual([])
    // 全覆盖：新字段既不接线也不登记 → 红（杜绝"漏了就静默被剥掉"）
    expect([...wired, ...IPC_PENDING_KEYS].sort()).toEqual(Object.keys(UI_PREF_KEYS).sort())
  })

  it('落盘后要广播，否则另一个窗口停在旧值（主题是文档级属性，一边新一边旧）', () => {
    const src = readFileSync('src/main/ipc.ts', 'utf8')
    const at = src.indexOf('IPC.uiPrefsSet')
    const end = src.indexOf('IPC.uiPrefsReset', at)
    expect(src.slice(at, end)).toContain("onSettingsChanged?.('ui-prefs')")
  })
})

// ── 会话级 FAST 覆盖：共享类型与有界存储（S3-20B1）─────────────────────
// 新 API 用动态导入取用，红态才能逐条落点（而不是整文件链接失败、把既有判据一起拖红）。

type SplitterModule = typeof import('@shared/splitter')

async function splitterApi(): Promise<SplitterModule> {
  return await import('@shared/splitter')
}

const MAX_KEY_LEN = 128
const TOO_LONG_KEY = 'x'.repeat(MAX_KEY_LEN + 1)
const CONTROL_KEY = 'bad\u0007key'
const C1_CONTROL_KEY = 'bad\u009c'

/** 合法三值 —— 断言只引用类型层面允许的枚举，不额外发明第四档 */
const SPEED_OVERRIDE_VALUES = ['inherit', 'normal', 'fast'] as const

describe('S3-20B1 ① 缺字段 / 脏容器 → 空映射（旧档案行为不变）', () => {
  const NON_RECORD_INPUTS: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['数字 0', 0],
    ['字符串 fast', 'fast'],
    ['布尔 true', true],
    ['空数组', []],
    ['对象数组', [{ id: 'a' }]]
  ]

  it.each(NON_RECORD_INPUTS)('%s 不是纯对象 → 空映射', async (_label, bad) => {
    const { sanitizeConversationSpeedOverrides } = await splitterApi()
    expect(sanitizeConversationSpeedOverrides(bad)).toEqual({})
  })
})

describe('S3-20B1 ② 合法三值原样保留并按写入次序排列', () => {
  it('inherit / normal / fast 都读得回来', async () => {
    const { sanitizeConversationSpeedOverrides } = await splitterApi()
    const input = { s1: 'inherit', s2: 'normal', s3: 'fast' }
    const clean = sanitizeConversationSpeedOverrides(input)
    expect(clean).toEqual(input)
    expect(Object.keys(clean)).toEqual(['s1', 's2', 's3'])
  })

  it('清洗幂等：洗过的表再洗一次逐字节相同', async () => {
    const { sanitizeConversationSpeedOverrides } = await splitterApi()
    const once = sanitizeConversationSpeedOverrides({ a: 'fast', b: 'inherit' })
    expect(sanitizeConversationSpeedOverrides(once)).toEqual(once)
  })

  it('长度为 1 与 128 的键都算合法（边界内收）', async () => {
    const { sanitizeConversationSpeedOverrides } = await splitterApi()
    const edge = { '7': 'fast', ['y'.repeat(MAX_KEY_LEN)]: 'normal' }
    expect(sanitizeConversationSpeedOverrides(edge)).toEqual(edge)
  })
})

describe('S3-20B1 ③ 非法键 / 非法值逐项丢弃，不因一条坏值丢整张表', () => {
  it('空键、超长键、控制字符键与非法取值全部丢掉，合法项照旧留下', async () => {
    const { sanitizeConversationSpeedOverrides } = await splitterApi()
    const dirty: Record<string, unknown> = {
      good: 'fast',
      keep: 'inherit',
      '': 'normal',
      [TOO_LONG_KEY]: 'normal',
      [CONTROL_KEY]: 'normal',
      [C1_CONTROL_KEY]: 'normal',
      'bad-value': 'turbo',
      'numeric-value': 1,
      'null-value': null,
      'object-value': { mode: 'fast' }
    }
    expect(sanitizeConversationSpeedOverrides(dirty)).toEqual({ good: 'fast', keep: 'inherit' })
  })

  it('输入不是对象时不会把调用方的原表清空（返回新空表，不改入参）', async () => {
    const { sanitizeConversationSpeedOverrides } = await splitterApi()
    const source = { a: 'fast' }
    sanitizeConversationSpeedOverrides('nonsense')
    expect(source).toEqual({ a: 'fast' })
  })
})

describe('S3-20B1 ④ 重写已有键视作最近使用（挪到队尾）', () => {
  it('改值后该键排到最后，其余次序原样', async () => {
    const { setConversationSpeedOverride } = await splitterApi()
    const next = setConversationSpeedOverride({ a: 'normal', b: 'fast', c: 'inherit' }, 'a', 'fast')
    expect(Object.keys(next)).toEqual(['b', 'c', 'a'])
    expect(next).toEqual({ b: 'fast', c: 'inherit', a: 'fast' })
  })

  it('同值重写也算一次最近使用', async () => {
    const { setConversationSpeedOverride } = await splitterApi()
    const next = setConversationSpeedOverride({ a: 'normal', b: 'fast', c: 'inherit' }, 'b', 'fast')
    expect(Object.keys(next)).toEqual(['a', 'c', 'b'])
  })

  it('新增键追加到队尾', async () => {
    const { setConversationSpeedOverride } = await splitterApi()
    const next = setConversationSpeedOverride({ a: 'normal' }, 'fresh', 'inherit')
    expect(Object.keys(next)).toEqual(['a', 'fresh'])
  })

  it('非法会话 id 或非法取值不写入，原表原样返回', async () => {
    const { setConversationSpeedOverride } = await splitterApi()
    const base = { a: 'fast', b: 'normal' }
    expect(setConversationSpeedOverride(base, '', 'fast')).toEqual(base)
    expect(setConversationSpeedOverride(base, TOO_LONG_KEY, 'fast')).toEqual(base)
    expect(setConversationSpeedOverride(base, CONTROL_KEY, 'fast')).toEqual(base)
    expect(setConversationSpeedOverride(base, 'a', 'turbo')).toEqual(base)
    expect(setConversationSpeedOverride(base, 'a', null)).toEqual(base)
  })
})

describe('S3-20B1 ⑤ 超上限裁掉最旧，保留最近写入的', () => {
  it('上限常量固定为 200', async () => {
    const { CONVERSATION_SPEED_OVERRIDES_MAX } = await splitterApi()
    expect(CONVERSATION_SPEED_OVERRIDES_MAX).toBe(200)
  })

  it('205 条清洗后只剩最近 200 条，最旧的 5 条被裁掉', async () => {
    const { CONVERSATION_SPEED_OVERRIDES_MAX, sanitizeConversationSpeedOverrides } =
      await splitterApi()
    const input: Record<string, string> = {}
    for (let i = 0; i < CONVERSATION_SPEED_OVERRIDES_MAX + 5; i += 1) input[`c${i}`] = 'fast'
    const clean = sanitizeConversationSpeedOverrides(input)
    const keys = Object.keys(clean)
    expect(keys).toHaveLength(CONVERSATION_SPEED_OVERRIDES_MAX)
    expect(keys[0]).toBe('c5')
    expect(keys[keys.length - 1]).toBe('c204')
    expect(clean.c4).toBeUndefined()
  })

  it('满表后再 set 新键：最旧的一条被挤掉，新键在队尾', async () => {
    const { CONVERSATION_SPEED_OVERRIDES_MAX, setConversationSpeedOverride } = await splitterApi()
    const full: Record<string, string> = {}
    for (let i = 0; i < CONVERSATION_SPEED_OVERRIDES_MAX; i += 1) full[`c${i}`] = 'normal'
    const next = setConversationSpeedOverride(full, 'newest', 'fast')
    const keys = Object.keys(next)
    expect(keys).toHaveLength(CONVERSATION_SPEED_OVERRIDES_MAX)
    expect(next.c0).toBeUndefined()
    expect(keys[keys.length - 1]).toBe('newest')
  })
})

describe('S3-20B1 ⑥ delete 精确清理', () => {
  it('只删目标键，其余键与次序不变', async () => {
    const { deleteConversationSpeedOverride } = await splitterApi()
    const next = deleteConversationSpeedOverride({ a: 'fast', b: 'normal', c: 'inherit' }, 'b')
    expect(next).toEqual({ a: 'fast', c: 'inherit' })
    expect(Object.keys(next)).toEqual(['a', 'c'])
  })

  it('删不存在的键 / 非法键 → 原表原样返回', async () => {
    const { deleteConversationSpeedOverride } = await splitterApi()
    const base = { a: 'fast', b: 'normal' }
    expect(deleteConversationSpeedOverride(base, 'nope')).toEqual(base)
    expect(deleteConversationSpeedOverride(base, '')).toEqual(base)
    expect(deleteConversationSpeedOverride(base, CONTROL_KEY)).toEqual(base)
  })

  it('delete 前先清洗：坏值不会随删操作留在结果里', async () => {
    const { deleteConversationSpeedOverride } = await splitterApi()
    const next = deleteConversationSpeedOverride({ a: 'fast', bad: 'turbo' }, 'a')
    expect(next).toEqual({})
  })
})

describe('S3-20B1 ⑦ 单会话查询，缺省 inherit', () => {
  it('命中返回盘上取值，缺键 / 坏值 / 非法 id 一律 inherit', async () => {
    const { getConversationSpeedOverride } = await splitterApi()
    const map = { fastOne: 'fast', normalOne: 'normal', inheritOne: 'inherit', bad: 'turbo' }
    expect(getConversationSpeedOverride(map, 'fastOne')).toBe('fast')
    expect(getConversationSpeedOverride(map, 'normalOne')).toBe('normal')
    expect(getConversationSpeedOverride(map, 'inheritOne')).toBe('inherit')
    expect(getConversationSpeedOverride(map, 'missing')).toBe('inherit')
    expect(getConversationSpeedOverride(map, 'bad')).toBe('inherit')
    expect(getConversationSpeedOverride(map, '')).toBe('inherit')
    expect(getConversationSpeedOverride(map, TOO_LONG_KEY)).toBe('inherit')
    expect(getConversationSpeedOverride(undefined, 'fastOne')).toBe('inherit')
    expect(getConversationSpeedOverride('nonsense', 'fastOne')).toBe('inherit')
  })

  it('三值覆盖即 SPEED_OVERRIDE_VALUES 全集，且默认档为 inherit', async () => {
    const { sanitizeConversationSpeedOverrides, getConversationSpeedOverride } = await splitterApi()
    // 每个枚举值都要能穿过清洗并原样查回 —— 少一档就说明白名单写窄了
    for (const value of SPEED_OVERRIDE_VALUES) {
      const map = sanitizeConversationSpeedOverrides({ probe: value })
      expect(getConversationSpeedOverride(map, 'probe'), `${value} 被清洗吃掉了`).toBe(value)
    }
    expect(getConversationSpeedOverride({}, 'anything')).toBe('inherit')
    expect(getConversationSpeedOverride({ probe: 'inherit' }, 'probe')).toBe('inherit')
  })
})

describe('S3-20B1 ⑧⑨ 真实落盘：写入 / 读回 / 坏档案 / 有界 / 重置', () => {
  beforeEach(() => {
    fixture.root = mkdtempSync(join(tmpdir(), 'jsl-s3-20b1-'))
    vi.resetModules()
  })
  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true })
    fixture.root = ''
  })

  /** 直接读 ui-prefs.json：证明数据真的落在盘上，而不是只活在返回值里 */
  function diskPrefs(): Record<string, unknown> {
    const path = join(fixture.root, 'ui-prefs.json')
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
  }

  it('旧档案缺该字段 → 空映射，其余偏好仍是旧默认值（行为不变）', async () => {
    const store = await import('@main/store/ui-prefs')
    const prefs = store.getUIPrefs()
    expect(prefs.conversationSpeedOverrides).toEqual({})
    expect(prefs.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect(prefs.theme).toBe('qingkong')
  })

  it('setUIPref 落盘三种取值，模块重载后读回一致', async () => {
    const store = await import('@main/store/ui-prefs')
    const next = store.setUIPref({
      conversationSpeedOverrides: { s1: 'inherit', s2: 'normal', s3: 'fast' }
    })
    expect(next.conversationSpeedOverrides).toEqual({ s1: 'inherit', s2: 'normal', s3: 'fast' })
    expect(diskPrefs().conversationSpeedOverrides).toEqual({
      s1: 'inherit',
      s2: 'normal',
      s3: 'fast'
    })
    // 模拟重启：清模块缓存后从同一份 ui-prefs.json 重新读
    vi.resetModules()
    const restarted = await import('@main/store/ui-prefs')
    expect(restarted.getUIPrefs().conversationSpeedOverrides).toEqual({
      s1: 'inherit',
      s2: 'normal',
      s3: 'fast'
    })
  })

  it('盘上混入坏键坏值时逐项丢弃，合法条目照旧读出（不丢整张表）', async () => {
    writeFileSync(
      join(fixture.root, 'ui-prefs.json'),
      JSON.stringify({
        conversationSpeedOverrides: {
          good: 'fast',
          keep: 'inherit',
          badValue: 'turbo',
          '': 'normal',
          [TOO_LONG_KEY]: 'normal',
          [CONTROL_KEY]: 'normal'
        }
      }),
      'utf8'
    )
    const store = await import('@main/store/ui-prefs')
    expect(store.getUIPrefs().conversationSpeedOverrides).toEqual({ good: 'fast', keep: 'inherit' })
  })

  it('盘上超过上限的旧档案：getUIPrefs 只返回最近 200 条', async () => {
    const legacy: Record<string, string> = {}
    for (let i = 0; i < 230; i += 1) legacy[`c${i}`] = 'normal'
    writeFileSync(
      join(fixture.root, 'ui-prefs.json'),
      JSON.stringify({ conversationSpeedOverrides: legacy }),
      'utf8'
    )
    const store = await import('@main/store/ui-prefs')
    const clean = store.getUIPrefs().conversationSpeedOverrides
    expect(Object.keys(clean)).toHaveLength(200)
    expect(clean.c29).toBeUndefined()
    expect(clean.c30).toBe('normal')
  })

  it('写入超上限的整表后，盘上不留越界数据（≤200 条且取值全部合法）', async () => {
    const store = await import('@main/store/ui-prefs')
    const big: Record<string, 'fast'> = {}
    for (let i = 0; i < 260; i += 1) big[`c${i}`] = 'fast'
    store.setUIPref({ conversationSpeedOverrides: big })
    const onDisk = diskPrefs().conversationSpeedOverrides as Record<string, string>
    expect(Object.keys(onDisk)).toHaveLength(200)
    expect(onDisk.c59).toBeUndefined()
    expect(onDisk.c60).toBe('fast')
    expect(
      Object.values(onDisk).every((v) => (SPEED_OVERRIDE_VALUES as readonly string[]).includes(v))
    ).toBe(true)
  })

  it('改值后该键挪到队尾并落盘，其余次序保留', async () => {
    const store = await import('@main/store/ui-prefs')
    store.setUIPref({ conversationSpeedOverrides: { a: 'normal', b: 'fast', c: 'inherit' } })
    const next = store.setUIPref({
      conversationSpeedOverrides: { a: 'fast', b: 'fast', c: 'inherit' }
    })
    expect(Object.keys(next.conversationSpeedOverrides)).toEqual(['b', 'c', 'a'])
    expect(Object.keys(diskPrefs().conversationSpeedOverrides as Record<string, string>)).toEqual([
      'b',
      'c',
      'a'
    ])
  })

  it('纯函数同值 touch 出的次序，经 setUIPref 落盘后不被旧序覆盖（S3-20B2 边界）', async () => {
    const store = await import('@main/store/ui-prefs')
    const { setConversationSpeedOverride } = await splitterApi()
    store.setUIPref({ conversationSpeedOverrides: { a: 'normal', b: 'fast', c: 'inherit' } })
    // 同值 touch b：纯函数已把 b 挪到队尾，整表次序 a,c,b
    const touched = setConversationSpeedOverride(
      store.getUIPrefs().conversationSpeedOverrides,
      'b',
      'fast'
    )
    expect(Object.keys(touched)).toEqual(['a', 'c', 'b'])
    // 旧实现会按盘上旧序把 a,b,c 放回，同值 touch 的最近使用信息丢失
    store.setUIPref({ conversationSpeedOverrides: touched })
    expect(Object.keys(store.getUIPrefs().conversationSpeedOverrides)).toEqual(['a', 'c', 'b'])
    expect(Object.keys(diskPrefs().conversationSpeedOverrides as Record<string, string>)).toEqual([
      'a',
      'c',
      'b'
    ])
  })

  it('入参是整张表：缺席的键被删除', async () => {
    const store = await import('@main/store/ui-prefs')
    store.setUIPref({ conversationSpeedOverrides: { a: 'fast', b: 'normal' } })
    const next = store.setUIPref({ conversationSpeedOverrides: { a: 'fast' } })
    expect(next.conversationSpeedOverrides).toEqual({ a: 'fast' })
    expect(diskPrefs().conversationSpeedOverrides).toEqual({ a: 'fast' })
  })

  it('非对象入参被忽略：一次脏调用不能等价于清空整张表', async () => {
    const store = await import('@main/store/ui-prefs')
    store.setUIPref({ conversationSpeedOverrides: { a: 'fast' } })
    const dirty = 'nonsense' as unknown as Record<string, 'fast'>
    const next = store.setUIPref({ conversationSpeedOverrides: dirty })
    expect(next.conversationSpeedOverrides).toEqual({ a: 'fast' })
    expect(diskPrefs().conversationSpeedOverrides).toEqual({ a: 'fast' })
  })

  it('resetUIPrefs 清空该字段并落盘', async () => {
    const store = await import('@main/store/ui-prefs')
    store.setUIPref({ conversationSpeedOverrides: { a: 'fast', b: 'normal' } })
    const next = store.resetUIPrefs()
    expect(next.conversationSpeedOverrides).toEqual({})
    expect(diskPrefs().conversationSpeedOverrides).toEqual({})
    vi.resetModules()
    const restarted = await import('@main/store/ui-prefs')
    expect(restarted.getUIPrefs().conversationSpeedOverrides).toEqual({})
  })

  it('不改动其它偏好字段：写入覆盖表不影响宽度 / 主题 / 布局', async () => {
    const store = await import('@main/store/ui-prefs')
    const before = store.getUIPrefs()
    const next = store.setUIPref({ conversationSpeedOverrides: { a: 'fast' } })
    expect(next.sidebarWidth).toBe(before.sidebarWidth)
    expect(next.dockWidth).toBe(before.dockWidth)
    expect(next.theme).toBe(before.theme)
    expect(next.workbench).toEqual(before.workbench)
    expect(next.workbenchSizes).toEqual(before.workbenchSizes)
  })
})

// ── S3-20B2：零改动守卫（共享类型 / preload 通用桥）───────────────────
// 本卡刻意不新增第二通道：渲染端仍走 setUIPrefs(patch) 通用桥，字段在 patch 里。

describe('S3-20B2 零改动守卫：共享类型与 preload 仍是既有通用桥', () => {
  it('shared/ipc.ts 保留 uiPrefsSet 通道与 setUIPrefs(patch) 签名，且没有会话级专用通道', () => {
    const src = readFileSync('src/shared/ipc.ts', 'utf8')
    expect(src).toContain("uiPrefsSet: 'ui-prefs:set'")
    expect(src).toMatch(/setUIPrefs\(patch: Partial<UIPrefs>\): Promise<UIPrefs>/)
    // 第二通道会让「谁负责清洗」分叉；本卡不允许出现 speed 专用入口
    expect(src).not.toMatch(/speedOverride/i)
  })

  it('preload/index.ts 仍把整份 patch 原样交给 IPC.uiPrefsSet，不特判覆盖字段', () => {
    const src = readFileSync('src/preload/index.ts', 'utf8')
    expect(src).toContain('setUIPrefs: (patch) => ipcRenderer.invoke(IPC.uiPrefsSet, patch)')
    expect(src).not.toMatch(/speedOverride/i)
  })
})

// ── S3-20B2：真 IPC handler 行为（形状 + 删除清理）────────────────────
// 与 architecture-ipc-wiring.test.ts 同范式：真 registerIpcHandlers，只替换 Electron / 落盘目录。
// 这样 zod 形状、广播条件和删除清理都跑**产品源码本身**，而不是在测试里复写一份规则。

function convDeleteHandlerSource(): string {
  const src = readFileSync('src/main/ipc.ts', 'utf8')
  const at = src.indexOf('ipcMain.handle(IPC.convDelete')
  expect(at, 'ipc.ts 里找不到 convDelete 通道 —— 判据锚点要重新对').toBeGreaterThan(-1)
  const end = src.indexOf('\n  })', at)
  expect(end, 'convDelete 的 handler 结构变了，窗口取不到 body').toBeGreaterThan(at)
  return src.slice(at, end)
}

/**
 * 真 `registerIpcHandlers` + 最小依赖桩：只替换 Electron 与落盘目录，其余走产品源码。
 * S3-20B2（偏好形状 / 删除清理）与 S3-20C（模型默认速度保存链）共用同一套接线，
 * 各自在独立临时目录里重置模块，互不污染。
 */
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

describe('S3-20B2 IPC 接线：uiPrefsSet 形状 + convDelete 精确清理', () => {
  type Handler = (event: unknown, payload: unknown) => unknown
  let ipcRoot = ''
  let setPrefs!: Handler
  let resetPrefs!: Handler
  let delConv!: Handler
  /** 与 handler 共用同一个模块实例：用于把前置状态直接种进 store（不经 IPC 形状层） */
  let storeApi!: typeof import('@main/store/ui-prefs')

  beforeAll(async () => {
    ipcRoot = mkdtempSync(join(tmpdir(), 'jsl-s3-20b2-ipc-'))
    await registerTestIpc(ipcRoot)
    const { IPC } = await import('@shared/ipc')
    storeApi = await import('@main/store/ui-prefs')
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

  it('conversationSpeedOverrides 不再被 zod 剥掉：三种取值原样通过并落盘', () => {
    const next = setPrefs({}, {
      conversationSpeedOverrides: { s1: 'inherit', s2: 'normal', s3: 'fast' }
    }) as UIPrefs
    expect(next.conversationSpeedOverrides).toEqual({
      s1: 'inherit',
      s2: 'normal',
      s3: 'fast'
    })
    expect(diskPrefsAtIpc().conversationSpeedOverrides).toEqual({
      s1: 'inherit',
      s2: 'normal',
      s3: 'fast'
    })
  })

  it('空 key / 超长 key / 第四种取值被 IPC 形状拒绝（不是静默剥掉）', () => {
    expect(() => setPrefs({}, { conversationSpeedOverrides: { '': 'fast' } })).toThrow()
    expect(() =>
      setPrefs({}, { conversationSpeedOverrides: { [TOO_LONG_KEY]: 'fast' } })
    ).toThrow()
    expect(() => setPrefs({}, { conversationSpeedOverrides: { s1: 'turbo' } })).toThrow()
    // 128 字符边界仍合法（与存储层同一把尺）
    const edge = { ['y'.repeat(MAX_KEY_LEN)]: 'normal' }
    expect(
      (setPrefs({}, { conversationSpeedOverrides: edge }) as UIPrefs).conversationSpeedOverrides
    ).toEqual(edge)
  })

  it('删除会话只删目标 id：其他会话覆盖与次序不变', () => {
    storeApi.setUIPref({ conversationSpeedOverrides: { a: 'normal', b: 'fast', c: 'inherit' } })
    delConv({}, 'b')
    const onDisk = diskPrefsAtIpc().conversationSpeedOverrides as Record<string, string>
    expect(onDisk).toEqual({ a: 'normal', c: 'inherit' })
    expect(Object.keys(onDisk)).toEqual(['a', 'c'])
  })

  it('删除目标不存在：其他值不变且不误广播', () => {
    storeApi.setUIPref({ conversationSpeedOverrides: { a: 'fast' } })
    fixture.settingsChanged.length = 0
    delConv({}, 'missing')
    expect(diskPrefsAtIpc().conversationSpeedOverrides).toEqual({ a: 'fast' })
    expect(fixture.settingsChanged).not.toContain('ui-prefs')
  })

  it('删除命中后广播 ui-prefs（另一个窗口才会重读）', () => {
    storeApi.setUIPref({ conversationSpeedOverrides: { a: 'fast' } })
    fixture.settingsChanged.length = 0
    delConv({}, 'a')
    expect(diskPrefsAtIpc().conversationSpeedOverrides).toEqual({})
    expect(fixture.settingsChanged.filter((k) => k === 'ui-prefs')).toHaveLength(1)
  })

  it('删除会话不碰其他 UIPrefs 字段', () => {
    storeApi.setUIPref({
      sidebarWidth: 321,
      theme: 'yemeng',
      conversationSpeedOverrides: { a: 'fast' }
    })
    delConv({}, 'a')
    const onDisk = diskPrefsAtIpc()
    expect(onDisk.sidebarWidth).toBe(321)
    expect(onDisk.theme).toBe('yemeng')
    expect(onDisk.conversationSpeedOverrides).toEqual({})
  })

  it('convDelete 仍先 abort → 删会话 → 清目标，再清覆盖（顺序不可倒）', () => {
    const body = convDeleteHandlerSource()
    const ordered = [
      'chatGate.abort(id)',
      'deleteConversation(id)',
      'removeGoalsOf(id)',
      'deleteConversationSpeedOverride'
    ]
    const positions = ordered.map((needle) => body.indexOf(needle))
    expect(positions.every((p) => p > -1), `缺少步骤：${JSON.stringify(positions)}`).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('convDelete 段同时包含精确清理调用与条件广播', () => {
    const body = convDeleteHandlerSource()
    expect(body).toContain('getUIPrefs()')
    expect(body).toContain('deleteConversationSpeedOverride')
    expect(body).toContain("onSettingsChanged?.('ui-prefs')")
  })
})

// ══ S3-20C：模型默认速度（模型编辑页）+ 会话速度覆盖（输入区）══════════════
// 三层验收：
//   ① 纯合同：解析 / 回落 / 会话隔离 / LRU 次序 —— 直接跑 shared 与组件导出的纯函数；
//   ② 渲染端状态：真 zustand store + 假 preload 桥（加载 / 回显 / reset / 广播重读）；
//   ③ 组件与样式：IPC 与渲染进程起不来，退一档查源码（与 S3-20B2 同口径）；
//      模型默认的保存 / 读回另用**真 IPC handler** 验（跑产品源码，不在测试里复写规则）。

type Handler = (event: unknown, payload: unknown) => unknown

/** 组件导出的纯解析入口（动态导入：红态逐条落点，而不是整文件解析失败） */
async function speedIntentApi(): Promise<
  typeof import('../../src/renderer/src/components/InputConsole')
> {
  return await import('../../src/renderer/src/components/InputConsole')
}

function readSrc(rel: string): string {
  return readFileSync(rel, 'utf8')
}

/** 剥注释后再做"不许出现 X"的判据：解释性注释不参与判定（同 no-dead-wiring 的口径） */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at >= 0 ? line.slice(0, at) : line
    })
    .join('\n')
}

/** 从源码里切一段函数体（锚点 + 首个行首两空格的闭括号） */
function functionBodyOf(src: string, anchor: string): string {
  const at = src.indexOf(anchor)
  expect(at, `源码里找不到锚点：${anchor}`).toBeGreaterThan(-1)
  const end = src.indexOf('\n  }\n', at)
  expect(end, `${anchor} 的函数体没有按预期收尾`).toBeGreaterThan(at)
  return src.slice(at, end + 4)
}

/** 从源码里切一段区间（JSX 区块 / CSS 区块共用） */
function sliceBetween(src: string, start: string, end: string): string {
  const at = src.indexOf(start)
  expect(at, `源码里找不到区间起点：${start}`).toBeGreaterThan(-1)
  const stop = src.indexOf(end, at)
  expect(stop, `源码里找不到区间终点：${end}`).toBeGreaterThan(at)
  return src.slice(at, stop)
}

/** 用户可见文字与代码里都不许出现 emoji（emoji 由设计规范禁止，图标一律走 SVG） */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

const INPUT_CONSOLE_SRC = 'src/renderer/src/components/InputConsole.tsx'
const SETTINGS_VIEW_SRC = 'src/renderer/src/views/SettingsView.tsx'
const STYLES_SRC = 'src/renderer/src/styles.css'

/** 输入区"选择速度"的唯一写入动作：源码断言都锚在这一段上 */
function chooseSpeedBody(): string {
  return functionBodyOf(readSrc(INPUT_CONSOLE_SRC), 'const chooseSpeed = (')
}

/** 设置页"写模型默认速度"的唯一写入动作 */
function patchSpeedBody(): string {
  return functionBodyOf(readSrc(SETTINGS_VIEW_SRC), 'const patchDraftSpeedMode = (')
}

describe('S3-20C ① 缺字段旧档案与非法值：一律回普通', () => {
  it('旧档案条目没有 speedMode：有效档 normal，来源是模型默认', async () => {
    const { resolveSpeedIntent } = await speedIntentApi()
    const legacy: { id: string; model: string; speedMode?: unknown } = {
      id: 'm-legacy',
      model: 'legacy-model'
    }
    expect('speedMode' in legacy, '这个用例的前提是旧档案没有该字段').toBe(false)
    expect(
      resolveSpeedIntent({ modelSpeedMode: legacy.speedMode, override: 'inherit', hasSession: true })
    ).toEqual({ override: 'inherit', mode: 'normal', source: 'model' })
  }, 15_000)

  it.each([
    ['字符串 turbo', 'turbo'],
    ['大写 FAST', 'FAST'],
    ['空串', ''],
    ['数字 1', 1],
    ['布尔 true', true],
    ['null', null],
    ['对象', { mode: 'fast' }],
    ['undefined', undefined]
  ])('非法模型默认（%s）→ normal，绝不悄悄升成 fast', async (_label, bad) => {
    const { resolveSpeedIntent } = await speedIntentApi()
    expect(resolveSpeedIntent({ modelSpeedMode: bad, override: 'inherit', hasSession: true })).toEqual(
      { override: 'inherit', mode: 'normal', source: 'model' }
    )
  })

  it.each([
    ['字符串 turbo', 'turbo'],
    ['大写 FAST', 'FAST'],
    ['空串', ''],
    ['数字 1', 1],
    ['null', null],
    ['对象', { value: 'fast' }]
  ])('非法会话覆盖（%s）→ inherit：不冒充显式覆盖', async (_label, bad) => {
    const { resolveSpeedIntent } = await speedIntentApi()
    expect(resolveSpeedIntent({ modelSpeedMode: 'fast', override: bad, hasSession: true })).toEqual({
      override: 'inherit',
      mode: 'fast',
      source: 'model'
    })
  })

  it('模型目录空（没有活动条目）→ 不崩溃；显式 fast 仍按会话覆盖生效', async () => {
    const { resolveSpeedIntent } = await speedIntentApi()
    const { activeEntry, activeProfile } = await import('@shared/models')
    expect(activeProfile([], 'p-missing')).toBeNull()
    expect(activeProfile([], null)).toBeNull()
    const profile = activeProfile([], null)
    const entry = profile ? activeEntry(profile) : null
    expect(entry).toBeNull()
    expect(
      resolveSpeedIntent({ modelSpeedMode: entry?.speedMode, override: 'fast', hasSession: true })
    ).toEqual({ override: 'fast', mode: 'fast', source: 'session' })
    // 目录读不到时模型默认一律 normal（不补 FAST）
    expect(resolveSpeedIntent({ modelSpeedMode: entry?.speedMode, override: 'inherit', hasSession: true })).toEqual(
      { override: 'inherit', mode: 'normal', source: 'model' }
    )
  })
})

describe('S3-20C ② inherit / normal / fast 三态解析与会话隔离', () => {
  it('inherit 取模型默认；显式 normal / FAST 会话优先（两个方向都验）', async () => {
    const { resolveSpeedIntent } = await speedIntentApi()
    expect(resolveSpeedIntent({ modelSpeedMode: 'fast', override: 'inherit', hasSession: true })).toEqual({
      override: 'inherit',
      mode: 'fast',
      source: 'model'
    })
    expect(resolveSpeedIntent({ modelSpeedMode: 'normal', override: 'fast', hasSession: true })).toEqual({
      override: 'fast',
      mode: 'fast',
      source: 'session'
    })
    expect(resolveSpeedIntent({ modelSpeedMode: 'fast', override: 'normal', hasSession: true })).toEqual({
      override: 'normal',
      mode: 'normal',
      source: 'session'
    })
  })

  it('无活动会话：忽略任何残留覆盖，只显示模型默认（不伪造会话覆盖）', async () => {
    const { resolveSpeedIntent } = await speedIntentApi()
    expect(resolveSpeedIntent({ modelSpeedMode: 'fast', override: 'normal', hasSession: false })).toEqual({
      override: 'inherit',
      mode: 'fast',
      source: 'model'
    })
    expect(resolveSpeedIntent({ modelSpeedMode: 'normal', override: 'fast' })).toEqual({
      override: 'inherit',
      mode: 'normal',
      source: 'model'
    })
  })

  it('两个会话的覆盖互相独立：写 A 不影响 B，删 A 不碰 B', async () => {
    const { setConversationSpeedOverride, deleteConversationSpeedOverride, getConversationSpeedOverride } =
      await splitterApi()
    const map = setConversationSpeedOverride(
      setConversationSpeedOverride({}, 'conv-a', 'fast'),
      'conv-b',
      'normal'
    )
    expect(getConversationSpeedOverride(map, 'conv-a')).toBe('fast')
    expect(getConversationSpeedOverride(map, 'conv-b')).toBe('normal')
    expect(map).toEqual({ 'conv-a': 'fast', 'conv-b': 'normal' })
    const afterDelete = deleteConversationSpeedOverride(map, 'conv-a')
    expect(getConversationSpeedOverride(afterDelete, 'conv-a')).toBe('inherit')
    expect(getConversationSpeedOverride(afterDelete, 'conv-b')).toBe('normal')
  })

  it('同值再次选择也算最近使用：键挪到队尾（次序只由纯函数产出）', async () => {
    const { setConversationSpeedOverride } = await splitterApi()
    let map = setConversationSpeedOverride({}, 'a', 'normal')
    map = setConversationSpeedOverride(map, 'b', 'fast')
    map = setConversationSpeedOverride(map, 'c', 'inherit')
    expect(Object.keys(map)).toEqual(['a', 'b', 'c'])
    const touched = setConversationSpeedOverride(map, 'b', 'fast')
    expect(Object.keys(touched)).toEqual(['a', 'c', 'b'])
    expect(touched.b).toBe('fast')
  })
})

describe('S3-20C ③ 渲染端 store：加载 / 回显 / reset 都处理覆盖表', () => {
  type Prefs = Record<string, unknown>
  const FULL_PREFS: Prefs = {
    sidebarWidth: 300,
    dockWidth: 420,
    theme: 'qingkong',
    fontScale: 'md',
    uiFont: '',
    locale: 'zh',
    workbench: { panes: [] },
    workbenchSizes: [],
    conversationSpeedOverrides: {}
  }

  let prefsFromMain: Prefs
  let setPrefsCalls: Prefs[]
  let resetImpl: () => Promise<Prefs>
  let listeners: Array<(kind: string) => void>
  let store!: typeof import('../../src/renderer/src/store')
  let initialOverrides: unknown

  beforeAll(async () => {
    vi.stubGlobal('document', {
      documentElement: {
        dataset: {},
        lang: '',
        style: { fontSize: '', setProperty: () => {}, removeProperty: () => {} }
      }
    })
    vi.stubGlobal('window', {
      innerWidth: 1280,
      api: {
        getUIPrefs: async () => prefsFromMain,
        setUIPrefs: async (patch: Prefs) => {
          setPrefsCalls.push(patch)
          return prefsFromMain
        },
        resetUIPrefs: async () => await resetImpl(),
        onSettingsChanged: (cb: (kind: string) => void) => {
          listeners.push(cb)
          return () => {
            listeners = listeners.filter((one) => one !== cb)
          }
        }
      }
    })
    store = await import('../../src/renderer/src/store')
    // 初值必须在任何 setState 之前取：下面的 beforeEach 会重置成 {}，测不出"漏了初值"
    initialOverrides = store.useAppStore.getState().conversationSpeedOverrides
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    prefsFromMain = { ...FULL_PREFS, workbench: { panes: [] }, workbenchSizes: [] }
    setPrefsCalls = []
    listeners = []
    resetImpl = async () => prefsFromMain
    store.useAppStore.setState({
      conversationSpeedOverrides: {},
      workbench: { panes: [] } as never,
      workbenchSizes: [] as never
    })
  })

  it('AppState 初值是空映射（不是 undefined）', () => {
    expect(initialOverrides).toEqual({})
  })

  it('loadUIPrefs 读取并清洗覆盖表：坏键坏值丢掉，合法项留下', async () => {
    prefsFromMain = {
      ...prefsFromMain,
      conversationSpeedOverrides: {
        good: 'fast',
        keep: 'inherit',
        badValue: 'turbo',
        '': 'normal',
        [TOO_LONG_KEY]: 'normal',
        [CONTROL_KEY]: 'normal'
      }
    }
    await store.useAppStore.getState().loadUIPrefs()
    expect(store.useAppStore.getState().conversationSpeedOverrides).toEqual({
      good: 'fast',
      keep: 'inherit'
    })
  })

  it('persistUIPrefs 回显主进程返回的清洗值（不是乐观值，也不手工重排）', async () => {
    // 主进程返回值必须与 patch **不同**：否则"回显"与"把 patch 原样写回"无法区分
    prefsFromMain = {
      ...prefsFromMain,
      conversationSpeedOverrides: { a: 'fast', b: 'inherit', dirty: 'turbo' }
    }
    await store.useAppStore.getState().persistUIPrefs({ conversationSpeedOverrides: { a: 'fast' } })
    // 发出去的 patch 是调用方给的整表（清洗与 LRU 由主进程 + 纯函数负责）
    expect(setPrefsCalls).toHaveLength(1)
    expect(setPrefsCalls[0].conversationSpeedOverrides).toEqual({ a: 'fast' })
    // b 只存在于主进程返回里：乐观回写拿不到它，清洗会把 dirty 丢掉
    expect(store.useAppStore.getState().conversationSpeedOverrides).toEqual({
      a: 'fast',
      b: 'inherit'
    })
  })

  it('persistUIPrefs 仍不回显 workbench：内存里的新布局不被盘上旧值打回', async () => {
    const inMemory = {
      panes: [
        {
          id: 'pane-1',
          tabs: [{ id: 't1', content: { kind: 'builtin', type: 'memory' } }],
          activeTab: 0
        }
      ]
    }
    store.useAppStore.setState({ workbench: inMemory as never, workbenchSizes: [320] as never })
    prefsFromMain = { ...prefsFromMain, workbench: { panes: [] }, workbenchSizes: [] }
    await store.useAppStore
      .getState()
      .persistUIPrefs({ conversationSpeedOverrides: { a: 'fast' } })
    expect(store.useAppStore.getState().workbench).toEqual(inMemory)
    expect(store.useAppStore.getState().workbenchSizes).toEqual([320])
  })

  it('resetUIPrefs 清空覆盖表（成功路径）', async () => {
    store.useAppStore.setState({ conversationSpeedOverrides: { a: 'fast', b: 'normal' } })
    prefsFromMain = { ...prefsFromMain, conversationSpeedOverrides: {} }
    await store.useAppStore.getState().resetUIPrefs()
    expect(store.useAppStore.getState().conversationSpeedOverrides).toEqual({})
  })

  it('resetUIPrefs 失败时同样清空覆盖表（回落默认，不留幽灵覆盖）', async () => {
    store.useAppStore.setState({ conversationSpeedOverrides: { a: 'fast' } })
    resetImpl = async () => {
      throw new Error('主进程不可用')
    }
    await store.useAppStore.getState().resetUIPrefs()
    expect(store.useAppStore.getState().conversationSpeedOverrides).toEqual({})
  })

  it('ui-prefs 广播重读后覆盖表跟着变（两窗口 / 两会话界面靠这条同步）', async () => {
    const off = store.useAppStore.getState().subscribeSettingsChanged()
    expect(listeners).toHaveLength(1)
    prefsFromMain = {
      ...prefsFromMain,
      conversationSpeedOverrides: { 'conv-b': 'normal' }
    }
    listeners[0]('ui-prefs')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.useAppStore.getState().conversationSpeedOverrides).toEqual({ 'conv-b': 'normal' })
    off()
    expect(listeners).toHaveLength(0)
  })
})

describe('S3-20C ④ InputConsole：既有纯合同 + 通用桥落盘，不手工重排', () => {
  it('复用 @shared/request-policy 与 @shared/splitter 的既有函数（不新造第二套枚举）', () => {
    const src = readSrc(INPUT_CONSOLE_SRC)
    expect(src).toContain("from '@shared/request-policy'")
    for (const name of ['resolveSpeedMode', 'normalizeSpeedMode', 'normalizeSpeedOverride', 'DEFAULT_SPEED_MODE']) {
      expect(src, `InputConsole 没有用上 ${name}`).toContain(name)
    }
    expect(src).toContain("from '@shared/splitter'")
    for (const name of ['getConversationSpeedOverride', 'setConversationSpeedOverride']) {
      expect(src, `InputConsole 没有用上 ${name}`).toContain(name)
    }
  })

  it('选择后先由纯函数生成整表，再走 persistUIPrefs({ conversationSpeedOverrides })', () => {
    const body = chooseSpeedBody()
    expect(body).toContain('setConversationSpeedOverride(')
    expect(body).toContain('persistUIPrefs(')
    expect(body).toContain('conversationSpeedOverrides')
  })

  it('不手工拼对象改变 LRU 次序（键序只能由 B1 纯函数产出）', () => {
    const src = withoutComments(readSrc(INPUT_CONSOLE_SRC))
    expect(src).not.toMatch(/conversationSpeedOverrides:\s*\{\s*\.\.\./)
    expect(src).not.toContain('Object.fromEntries')
    expect(src).not.toContain('Object.assign')
    expect(src).not.toMatch(/\[activeId\]:/)
  })

  it('无活动会话（新建任务页）不写覆盖：守卫在写入之前', () => {
    const body = chooseSpeedBody()
    const guard = body.indexOf('if (!activeId)')
    const write = body.indexOf('setConversationSpeedOverride(')
    expect(guard, '缺少"无会话不写覆盖"的守卫').toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard)
  })

  it('只改偏好：不发请求、不清正文、不动运行中的 run', () => {
    const body = chooseSpeedBody()
    for (const forbidden of [
      'chatSend',
      'sendMessage',
      'onChange(',
      'setMessages',
      'streaming',
      'stopStreaming',
      'setState('
    ]) {
      expect(body, `选择速度不该碰 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('有效意图与来源可见；运行中有"下一轮生效"提示', () => {
    const src = readSrc(INPUT_CONSOLE_SRC)
    expect(src).toContain('SPEED_MODE_TEXT')
    expect(src).toContain('会话覆盖')
    expect(src).toContain('模型默认')
    expect(src).toContain('下一轮生效')
    // 提示必须挂在 busy 上（常驻就成了误导）
    expect(src).toMatch(/\{busy\s*&&[\s\S]{0,120}?下一轮生效/)
  })

  it('可聚焦与可读标题：select 带 aria-label / title，无会话时禁用', () => {
    const src = readSrc(INPUT_CONSOLE_SRC)
    const block = sliceBetween(src, 'const speedIntent =', '{busy &&')
    expect(block).toContain('aria-label')
    expect(block).toContain('title=')
    expect(block).toContain('disabled={activeId === null}')
    expect(block).toContain('模型默认')
    expect(block).toContain('会话覆盖')
  })

  it('模型目录读不到 / 没有 speedMode：回落普通，不补 FAST', () => {
    const src = readSrc(INPUT_CONSOLE_SRC)
    expect(src).toContain('.listModels()')
    expect(src).toContain('activeProfile(')
    expect(src).toContain('activeEntry(')
    expect(src).toContain('normalizeSpeedMode(')
    expect(src).toMatch(/catch\(\(\)\s*=>\s*\{[\s\S]{0,160}?DEFAULT_SPEED_MODE/)
  })

  it('文案不承诺实际加速：不出现"已加速"等既成表述', () => {
    const visible = withoutComments(readSrc(INPUT_CONSOLE_SRC))
    expect(visible).not.toContain('已加速')
    expect(visible).not.toMatch(/已经加速/)
  })

  it('切模型后重读默认档：用 settings 变化当重读信号（setModel 路径不广播 models）', () => {
    const src = readSrc(INPUT_CONSOLE_SRC)
    expect(src).toContain('useAppStore((s) => s.settings)')
    expect(src).toMatch(/\}, \[settingsRevision\]\)/)
  })
})

describe('S3-20C ⑤ SettingsView：逐条写 ModelEntry.speedMode，不碰 ModelSettings', () => {
  it('只改当前草稿条目：setDraftModels 里按 id 命中，其余条目原样', () => {
    const body = patchSpeedBody()
    expect(body).toContain('setDraftModels(')
    expect(body).toContain('speedMode')
    expect(body).toContain('m.id === entryId')
    expect(body, '模型默认速度不是 ModelSettings 的字段').not.toContain('settings')
  })

  it('ModelSettings 里没有第二份 speedMode（真源只有 ModelEntry）', () => {
    const ipc = readSrc('src/shared/ipc.ts')
    const at = ipc.indexOf('export interface ModelSettings')
    expect(at, 'ModelSettings 接口的锚点要重新对').toBeGreaterThan(-1)
    const end = ipc.indexOf('\n}', at)
    expect(end).toBeGreaterThan(at)
    expect(ipc.slice(at, end)).not.toContain('speedMode')
  })

  it('模型编辑页逐条渲染速度选择：写入当前草稿、初值与旧档案都显示 normal', () => {
    const src = readSrc(SETTINGS_VIEW_SRC)
    const block = sliceBetween(src, '模型默认速度（S3-20C）：逐条写', '模型默认速度（S3-20C）结束')
    expect(block).toContain('draftModels.map(')
    expect(block).toContain('normalizeSpeedMode(m.speedMode)')
    expect(block).toContain('patchDraftSpeedMode(')
    // 只允许 normal | fast 两个取值
    expect((block.match(/<option value=/g) ?? []).length).toBe(2)
    expect(block).toContain('value="normal"')
    expect(block).toContain('value="fast"')
  })

  it('文案说明"会话未覆盖时的模型默认值"，且 FAST 只是请求策略', () => {
    const src = readSrc(SETTINGS_VIEW_SRC)
    const block = withoutComments(
      sliceBetween(src, '模型默认速度（S3-20C）：逐条写', '模型默认速度（S3-20C）结束')
    )
    expect(block).toContain('会话未覆盖时使用')
    expect(block).toContain('FAST 仅为请求策略')
    expect(block).toContain('厂商能力声明与响应决定')
    // 不写价格门、不做效果承诺（注释里的设计理由不参与判定）
    for (const forbidden of ['折扣', '价格', '加速', '¥', '优惠']) {
      expect(block, `文案里不该出现 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('源码里没有把 speedMode 塞进 settings 对象', () => {
    const src = readSrc(SETTINGS_VIEW_SRC)
    expect(src).not.toMatch(/settings:\s*\{[^}]*speedMode/)
    expect(src).not.toMatch(/speedMode[^\n]*\bModelSettings\b/)
  })

  it('速度区块里没有 emoji', () => {
    const src = readSrc(SETTINGS_VIEW_SRC)
    expect(EMOJI_RE.test(sliceBetween(src, '模型默认速度（S3-20C）：逐条写', '模型默认速度（S3-20C）结束'))).toBe(false)
  })
})

describe('S3-20C ⑥ 样式：语义 token、可聚焦、窄窗不重叠', () => {
  it('速度控件样式成组存在，且只用既有语义 token（无裸色值）', () => {
    const css = readSrc(STYLES_SRC)
    const block = sliceBetween(css, '/* ══ 速度控件（S3-20C）', '/* ══ 速度控件（S3-20C）结束')
    for (const selector of [
      '.speed-chip',
      '.speed-select',
      '.speed-effective',
      '.speed-next',
      '.model-speed',
      '.model-speed-row',
      '.model-speed-name'
    ]) {
      expect(block, `缺少样式 ${selector}`).toContain(selector)
    }
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(block).not.toMatch(/\brgba?\(/)
    expect(block).toContain('var(--')
  })

  it('可聚焦：速度选择器有 focus-visible 反馈', () => {
    const css = readSrc(STYLES_SRC)
    const block = sliceBetween(css, '/* ══ 速度控件（S3-20C）', '/* ══ 速度控件（S3-20C）结束')
    expect(block).toContain(':focus-visible')
    expect(block).toContain('outline')
  })

  it('窄窗：允许换行 / 收缩，文本与控件不重叠', () => {
    const css = readSrc(STYLES_SRC)
    const block = sliceBetween(css, '/* ══ 速度控件（S3-20C）', '/* ══ 速度控件（S3-20C）结束')
    expect(block).toContain('flex-wrap: wrap')
    expect(block).toContain('min-width: 0')
    expect(block).toContain('@media (max-width: 560px)')
    // 设置页行必须压过 `.settings-view label`（0,1,1）的竖排，否则横排与省略号是死规则
    expect(block).toContain('.settings-view .model-speed-row')
    expect(block).toContain('flex-direction: row')
  })
})

// ── S3-20C ⑦ 真 IPC：模型默认速度保存链 ─────────────────────────────
// 走 `models:save` 产品 handler（含 modelSaveSchema 与 saveEndpoint），证明设置页写的
// `ModelEntry.speedMode` 真能随既有保存链落盘、读回，且不污染同档其他条目。

describe('S3-20C ⑦ 模型默认速度经真实保存链落盘并可读回', () => {
  let modelsRoot = ''
  let saveModel!: Handler

  /** 一次保存两份条目：e1 带 speedMode，e2 永远不带（用于验"不污染其他条目"） */
  function saveInput(speedMode?: unknown): Record<string, unknown> {
    return {
      id: 'p-s3-20c',
      name: 'S3-20C 端点',
      providerType: 'openai-compatible',
      baseURL: 'https://s3-20c.invalid',
      models: [
        { id: 'e1', model: 'model-a', ...(speedMode === undefined ? {} : { speedMode }) },
        { id: 'e2', model: 'model-b' }
      ],
      apiKey: ''
    }
  }

  beforeAll(async () => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'jsl-s3-20c-models-'))
    await registerTestIpc(modelsRoot)
    const { IPC } = await import('@shared/ipc')
    saveModel = fixture.handlers.get(IPC.modelsSave)!
    expect(saveModel, 'modelsSave handler 未注册').toBeTypeOf('function')
  })

  afterAll(() => {
    rmSync(modelsRoot, { recursive: true, force: true })
    fixture.root = ''
    fixture.handlers.clear()
  })

  function diskModels(): { profiles: Array<{ id: string; models: Array<Record<string, unknown>> }> } {
    return JSON.parse(readFileSync(join(modelsRoot, 'models.json'), 'utf8')) as {
      profiles: Array<{ id: string; models: Array<Record<string, unknown>> }>
    }
  }

  it('normal / fast 写入并读回；同档另一条目不被污染', () => {
    for (const mode of ['normal', 'fast'] as const) {
      const view = saveModel({}, saveInput(mode)) as {
        id: string
        models: Array<{ id: string; speedMode?: string }>
      }
      expect(view.models.find((m) => m.id === 'e1')?.speedMode).toBe(mode)
      expect('speedMode' in (view.models.find((m) => m.id === 'e2') ?? {})).toBe(false)

      const profile = diskModels().profiles.find((p) => p.id === 'p-s3-20c')
      expect(profile, '盘上没有这次保存的端点').toBeDefined()
      expect(profile!.models.find((m) => m.id === 'e1')?.speedMode).toBe(mode)
      expect('speedMode' in (profile!.models.find((m) => m.id === 'e2') ?? {})).toBe(false)
    }
  })

  it('缺字段保存（旧调用方）不补写该键：读回后有效值仍是 normal', async () => {
    const view = saveModel({}, saveInput()) as { models: Array<{ id: string; speedMode?: unknown }> }
    const entry = view.models.find((m) => m.id === 'e1')!
    expect('speedMode' in entry).toBe(false)
    const { normalizeSpeedMode } = await import('@shared/request-policy')
    expect(normalizeSpeedMode(entry.speedMode)).toBe('normal')
  })

  it('非法 speedMode 被 IPC 形状拒绝，不静默剥成普通', () => {
    for (const bad of ['turbo', 'FAST', '', 1, true]) {
      expect(() => saveModel({}, saveInput(bad)), `${String(bad)} 应被拒绝`).toThrow()
    }
  })
})
