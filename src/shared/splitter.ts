// 布局分隔条（plan7 批 A0）—— 纯逻辑层
//
// 为什么抽出来：拖拽涉及「怎么算新宽度」和「能拖到多宽」两件事，
// 都是纯计算，抽出来就能单测（CI 无 Electron 二进制，碰 electron 的代码测不了）。
// 与 checkpoint.ts 同样的分层思路。

import type { WorkbenchLayout, WorkbenchSizes } from './workbench'

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

/** 主题（当前两套：经典蓝 / 水墨黑白灰+红） */
export type ThemeName = 'classic' | 'ink'

export const THEMES: Array<{ id: ThemeName; label: string; desc: string }> = [
  { id: 'classic', label: '经典', desc: '蓝白配色（默认）' },
  { id: 'ink', label: '水墨', desc: '黑白灰 + 朱砂红' }
]

/**
 * 界面布局偏好（主进程与渲染进程共用同一口径）。
 *
 * 注：工作台的**分栏布局**也挂在这里（同属"界面偏好"、同一个存档文件），
 * 但它的模型与全部运算都在 `workbench.ts` —— 本文件仍然只管「**单个**抽屉的宽度」。
 * 别把多栏逻辑往这儿塞（plan9 §二 已把归属定死）。
 */
export interface UIPrefs {
  sidebarWidth: number
  dockWidth: number
  theme: ThemeName
  /** 工作台分栏布局（plan9）。`panes` 为空 = 工作台收起 */
  workbench: WorkbenchLayout
  /** 栏宽**期望值**；长度恒等于 `panes.length − 1`（末栏吃余量，不存） */
  workbenchSizes: WorkbenchSizes
}

/** 主题合法性校验（存档/入参都可能被改坏） */
export function sanitizeTheme(t: unknown): ThemeName {
  return t === 'ink' ? 'ink' : 'classic'
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

/** 资源管理器「文件预览」区的高度范围（plan7 批 A2 验收反馈：预览太小） */
export const PREVIEW_MIN = 120
export const PREVIEW_MAX = 620
export const PREVIEW_DEFAULT = 280

/**
 * 预览区拖拽后的新高度。
 *
 * 手柄在预览区**顶部**，所以「往上拖 = 变高」：`delta = startY − currentY`。
 * 非有限值（鼠标事件偶尔给出 NaN / Infinity）一律回落到下限，别把布局搞坏。
 *
 * 抽成纯函数的原因：**合成事件验不了真实拖拽**（实测 Chrome 会把真实鼠标位置的
 * mousemove 也发过来，把合成坐标覆盖掉）—— 所以逻辑靠单测保证，界面只验结构。
 */
export function resizePreview(startH: number, startY: number, currentY: number): number {
  const delta = startY - currentY
  if (!Number.isFinite(delta)) return PREVIEW_MIN
  return Math.min(Math.max(Math.round(startH + delta), PREVIEW_MIN), PREVIEW_MAX)
}
