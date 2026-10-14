// 切片 1 · 原生浏览器设置迁移 —— 缺省/旧 false/坏值/显式关闭/显式开启五态（先红后绿）。
// 用 hoisted 引用直写底层 store，真实 import 主进程 settings 判定（不复制逻辑）。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))
vi.mock('electron-store', () => ({
  default: class {
    store = f.store
    get(key: string) {
      return f.store[key]
    }
    set(key: string, value: unknown) {
      f.store[key] = value
    }
  }
}))

const { getNativeBrowserEnabled, setNativeBrowserEnabled, getBrowserControlEnabled } = await import(
  '@main/store/settings'
)

describe('原生浏览器开关（nativeBrowserEnabled）迁移与判定', () => {
  beforeEach(() => {
    delete f.store['nativeBrowserEnabled']
    delete f.store['browserControlEnabled']
  })

  it('缺字段（新配置）→ 默认开', () => {
    expect(getNativeBrowserEnabled()).toBe(true)
  })

  it('旧配置缺字段 + 旧总开关显式 false → 保守保留关闭（无法区分历史默认与主动关闭）', () => {
    f.store['browserControlEnabled'] = false
    expect(getNativeBrowserEnabled()).toBe(false)
  })

  it('旧总开关为 true / 坏值 → 缺字段按开处理（旧 true 延续；坏值按未显式关闭）', () => {
    f.store['browserControlEnabled'] = true
    expect(getNativeBrowserEnabled()).toBe(true)
    delete f.store['browserControlEnabled']
    f.store['browserControlEnabled'] = 'yes'
    expect(getNativeBrowserEnabled()).toBe(true)
  })

  it('新开关坏值不当 true（写坏值的字段 → 拒绝当作开启）', () => {
    f.store['nativeBrowserEnabled'] = 'yes'
    expect(getNativeBrowserEnabled()).toBe(false)
  })

  it('显式 false 保留关闭；显式 true 保持开启', () => {
    setNativeBrowserEnabled(false)
    expect(getNativeBrowserEnabled()).toBe(false)
    setNativeBrowserEnabled(true)
    expect(getNativeBrowserEnabled()).toBe(true)
  })

  it('原生默认开不得顺带打开外部 MCP 旧总开关（隔离）', () => {
    expect(getNativeBrowserEnabled()).toBe(true)
    expect(getBrowserControlEnabled(), '旧总开关缺字段仍=false').toBe(false)
  })
})
