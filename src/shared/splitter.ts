// 布局分隔条（plan7 批 A0）—— 纯逻辑层
//
// 为什么抽出来：拖拽涉及「怎么算新宽度」和「能拖到多宽」两件事，
// 都是纯计算，抽出来就能单测（CI 无 Electron 二进制，碰 electron 的代码测不了）。
// 与 checkpoint.ts 同样的分层思路。

/** 左抽屉（会话列表）宽度范围与默认值 */
export const SIDEBAR_DEFAULT = 248
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 420

/** 右抽屉（工作台）宽度范围与默认值 */
export const DOCK_DEFAULT = 360
export const DOCK_MIN = 280
export const DOCK_MAX = 640

/** 主区域无论如何都要留下的最小宽度（保底，别让对话区被拖没） */
export const MAIN_RESERVE = 320

/** 界面布局偏好（主进程与渲染进程共用同一口径） */
export interface UIPrefs {
  sidebarWidth: number
  dockWidth: number
}

/**
 * 把宽度夹到 [min, max] 区间内。
 * 非有限值（NaN / Infinity，鼠标事件偶尔会给出）一律回落到 min，避免把布局搞坏。
 */
export function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min
  if (max < min) return min // 容器太窄时的兜底：优先保证下限可用
  return Math.min(Math.max(Math.round(width), min), max)
}

/**
 * 按鼠标位置算新宽度。
 *
 * - 左抽屉：宽度 = 指针 x − 容器左边
 * - 右抽屉：宽度 = 容器右边 − 指针 x
 *
 * **上限还要看主区域**：不能只按抽屉自身的 max 夹，否则窄窗口下会把主区域挤没。
 * 所以真正的上限是 `min(抽屉自身 max, 容器宽 − MAIN_RESERVE)`。
 */
export function computeWidth(opts: {
  pointerX: number
  containerLeft: number
  containerRight: number
  side: 'left' | 'right'
  min: number
  max: number
  reserveMain?: number
}): number {
  const { pointerX, containerLeft, containerRight, side, min, max } = opts
  const reserve = opts.reserveMain ?? MAIN_RESERVE

  const raw =
    side === 'left' ? pointerX - containerLeft : containerRight - pointerX

  // 容器越窄，抽屉能占的上限越小 —— 但下限优先（至少 min 可用）
  const containerWidth = containerRight - containerLeft
  const maxByMain = containerWidth - reserve
  const effectiveMax = Math.max(min, Math.min(max, maxByMain))

  return clampWidth(raw, min, effectiveMax)
}

/** 从存储读回的宽度也要夹一次（存档可能被手改坏，或跨版本换了范围） */
export function sanitizeStoredWidth(
  stored: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (stored === undefined) return fallback
  return clampWidth(stored, min, max)
}
