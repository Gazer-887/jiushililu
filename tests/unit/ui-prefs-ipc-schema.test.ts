import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { UIPrefs } from '@shared/splitter'

/**
 * 界面偏好的 IPC 把关层（`ipc.ts` 的 `uiPrefsSet`）—— 这层没有行为测试可写：
 * 它跑在真主进程里，单测起不来，真渲染门禁用的又是**隔离桩**（桩不过 zod，见 `verify-shot.cjs` 的
 * `ui-prefs:set`）。所以退一档查源码，判据挡的是"改着改着又漏掉"，不替代行为测试。
 *
 * 漏字段的坏法很不显眼：zod 默认**丢弃未知键**，于是渲染端发了 `locale` 却静默收不到，
 * 表现成"设置里点了语言没反应"—— 不报错、不变红、日志也没有。
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

function uiPrefsSetHandler(): string {
  const src = readFileSync('src/main/ipc.ts', 'utf8')
  const at = src.indexOf('IPC.uiPrefsSet')
  expect(at, 'ipc.ts 里找不到 uiPrefsSet 通道 —— 判据的锚点要重新对').toBeGreaterThan(-1)
  const end = src.indexOf('.parse(raw)', at)
  expect(end, 'uiPrefsSet 的参数校验不再是 .parse(raw) 形状').toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('uiPrefsSet：每个界面偏好字段都要过 zod', () => {
  it.each(Object.keys(UI_PREF_KEYS))('%s 在校验层有一行（漏了就静默被剥掉）', (key) => {
    expect(uiPrefsSetHandler(), `校验层没有 ${key}，渲染端发过来会被 zod 丢掉`).toContain(`${key}:`)
  })

  it('落盘后要广播，否则另一个窗口停在旧值（主题是文档级属性，一边新一边旧）', () => {
    const src = readFileSync('src/main/ipc.ts', 'utf8')
    const at = src.indexOf('IPC.uiPrefsSet')
    const end = src.indexOf('IPC.uiPrefsReset', at)
    expect(src.slice(at, end)).toContain("onSettingsChanged?.('ui-prefs')")
  })
})
