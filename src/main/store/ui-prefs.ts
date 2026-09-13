import Store from 'electron-store'
import {
  DOCK_DEFAULT,
  DOCK_MAX,
  DOCK_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  sanitizeStoredWidth,
  sanitizeTheme,
  type ThemeName,
  type UIPrefs
} from '@shared/splitter'
import { emptyLayout, emptySizes, sanitizeLayout, sanitizeSizes } from '@shared/workbench'

// 界面布局偏好持久化（plan7 批 A0）：左右抽屉的宽度；plan9 起再加**工作台分栏布局**。
// 为什么单独一个 store：① settings 的 schema 是模型配置，掺进布局字段会让职责变模糊；② settings 有 zod 校验与
// "测试连接"那套流程，布局偏好不该被牵连；③ 布局偏好写入更频繁（拖拽结束写一次），分开存互不干扰。
// ⚠️ plan9 §W2：本文件是**三层校验的最后一层**，也是**手改 config.json 的唯一防线** —— 渲染端与 IPC 都可能被
// 绕过（直接改盘上文件），所以读回来的东西一律重新 sanitize。

interface StoredPrefs {
  sidebarWidth?: number
  dockWidth?: number
  theme?: ThemeName
  /** 盘上是**不可信**的 —— 读出来一律过 sanitizeLayout */
  workbench?: unknown
  workbenchSizes?: unknown
}

const store = new Store<StoredPrefs>({ name: 'ui-prefs' })

/**
 * 读回时一律夹回合法区间 / 过一遍 sanitize —— 存档可能被手改坏，也可能跨版本（宽度范围改过、布局格式改过）。
 * 分栏布局与栏宽**必须同源**：栏宽数组的长度要等于 `panes.length − 1`，对不上就整组回默认（workbench.ts 的自愈不变量）。
 */
export function getUIPrefs(): UIPrefs {
  const workbench = sanitizeLayout(store.store.workbench)
  return {
    sidebarWidth: sanitizeStoredWidth(
      store.store.sidebarWidth,
      SIDEBAR_DEFAULT,
      SIDEBAR_MIN,
      SIDEBAR_MAX
    ),
    dockWidth: sanitizeStoredWidth(store.store.dockWidth, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX),
    theme: sanitizeTheme(store.store.theme),
    workbench,
    workbenchSizes: sanitizeSizes(store.store.workbenchSizes, workbench.panes.length)
  }
}

/**
 * 只接受合法值；非法值忽略（不让坏数据进盘）。分栏布局走 `sanitizeLayout` **再**落盘 —— 不是"原样存、读时再修"：
 * 存的时候就清洗，盘上永远只有合法数据，出问题时少一层怀疑对象。
 */
export function setUIPref(patch: Partial<UIPrefs>): UIPrefs {
  const next = { ...getUIPrefs() }
  if (typeof patch.sidebarWidth === 'number' && Number.isFinite(patch.sidebarWidth)) {
    store.set('sidebarWidth', Math.round(patch.sidebarWidth))
    next.sidebarWidth = store.store.sidebarWidth!
  }
  if (typeof patch.dockWidth === 'number' && Number.isFinite(patch.dockWidth)) {
    store.set('dockWidth', Math.round(patch.dockWidth))
    next.dockWidth = store.store.dockWidth!
  }
  if (patch.theme !== undefined) {
    const theme = sanitizeTheme(patch.theme)
    store.set('theme', theme)
    next.theme = theme
  }
  if (patch.workbench !== undefined) {
    const clean = sanitizeLayout(patch.workbench)
    store.set('workbench', clean)
    next.workbench = clean
    // 栏数变了 → 栏宽数组必须跟着重新对齐，否则下一次读盘就会因"长度不同源"整组回默认
    next.workbenchSizes = sanitizeSizes(patch.workbenchSizes ?? next.workbenchSizes, clean.panes.length)
    store.set('workbenchSizes', next.workbenchSizes)
  } else if (patch.workbenchSizes !== undefined) {
    next.workbenchSizes = sanitizeSizes(patch.workbenchSizes, next.workbench.panes.length)
    store.set('workbenchSizes', next.workbenchSizes)
  }
  return next
}

/**
 * 恢复默认（供"恢复默认布局"按钮与双击分隔条复位用）。plan9 §W2：**必须把分栏布局一并复位** —— 否则这个按钮
 * 对工作台是空操作、用户点了没反应（两份独立审查都点了这一条）。默认布局 = **空**（不自动开栏），与现状一致。
 */
export function resetUIPrefs(): UIPrefs {
  store.set('sidebarWidth', SIDEBAR_DEFAULT)
  store.set('dockWidth', DOCK_DEFAULT)
  store.set('theme', 'classic')
  store.set('workbench', emptyLayout())
  store.set('workbenchSizes', emptySizes())
  return {
    sidebarWidth: SIDEBAR_DEFAULT,
    dockWidth: DOCK_DEFAULT,
    theme: 'classic',
    workbench: emptyLayout(),
    workbenchSizes: emptySizes()
  }
}
