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

// 界面布局偏好持久化（plan7 批 A0）：左右抽屉的宽度。
//
// 为什么单独一个 store 而不是塞进 settings：
//   ① settings 的 schema 是模型配置（BaseURL/Key/温度…），掺进布局字段会让它职责变模糊
//   ② settings 有 zod 校验与"测试连接"等逻辑，布局偏好不该被那套流程牵连
//   ③ 布局偏好写入频繁（拖拽结束才写一次，但仍比设置频繁），分开存互不干扰

interface StoredPrefs {
  sidebarWidth?: number
  dockWidth?: number
  theme?: ThemeName
}

const store = new Store<StoredPrefs>({ name: 'ui-prefs' })

/** 读回时一律夹回合法区间 —— 存档可能被手改坏，或跨版本改过宽度范围 */
export function getUIPrefs(): UIPrefs {
  return {
    sidebarWidth: sanitizeStoredWidth(
      store.store.sidebarWidth,
      SIDEBAR_DEFAULT,
      SIDEBAR_MIN,
      SIDEBAR_MAX
    ),
    dockWidth: sanitizeStoredWidth(store.store.dockWidth, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX),
    theme: sanitizeTheme(store.store.theme)
  }
}

/** 只接受数值/合法主题；非法值忽略（不让坏数据进盘） */
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
  return next
}

/** 恢复默认（供"双击手柄复位"用） */
export function resetUIPrefs(): UIPrefs {
  store.set('sidebarWidth', SIDEBAR_DEFAULT)
  store.set('dockWidth', DOCK_DEFAULT)
  store.set('theme', 'classic')
  return { sidebarWidth: SIDEBAR_DEFAULT, dockWidth: DOCK_DEFAULT, theme: 'classic' }
}
