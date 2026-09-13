// 布局分隔条（plan7 批 A0）—— 纯逻辑层。
// 抽出来是为了能单测：CI 无 Electron 二进制，碰 electron 的代码测不了（与 checkpoint.ts 同思路）。

import type { WorkbenchLayout, WorkbenchSizes } from './workbench'

/** 左抽屉（会话列表）宽度范围与默认值 */
export const SIDEBAR_DEFAULT = 248
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 420

/** 右抽屉（工作台）宽度范围与默认值 */
export const DOCK_DEFAULT = 360
export const DOCK_MIN = 280
export const DOCK_MAX = 640

/** 主区域保底宽度：别让对话区被拖没 */
export const MAIN_RESERVE = 320

export type ThemeName = 'classic' | 'ink'

export const THEMES: Array<{ id: ThemeName; label: string; desc: string }> = [
  { id: 'classic', label: '经典', desc: '蓝白配色（默认）' },
  { id: 'ink', label: '水墨', desc: '黑白灰 + 朱砂红' }
]

/**
 * 界面布局偏好（主进程与渲染进程共用同一口径）。
 * 工作台**分栏布局**的模型与运算都在 `workbench.ts`，本文件只管「**单个**抽屉的宽度」——别把多栏逻辑往这儿塞（plan9 §二 已定归属）。
 */
export interface UIPrefs {
  sidebarWidth: number
  dockWidth: number
  theme: ThemeName
  /**
   * **界面字号档**（plan7 批 F3）。实现是根元素 `font-size` 缩放（87.5%–125%）——
   * 全站的 `--fs-*` token 是 rem 基，改根字号一处生效全局；**别去逐个改 token**（plan7 原话）。
   */
  fontScale: FontScale
  /**
   * **界面字体**（family 名，空串 = 用默认栈）。主进程从系统枚举（Windows 读注册表）。
   * ⚠️ 存的是**一个 family 名**而不是整串 font-family —— 拼接回退栈是渲染端的活，存整串等于
   * 让盘上数据拥有注入 CSS 的能力。
   */
  uiFont: string
  /** 工作台分栏布局（plan9）。`panes` 为空 = 工作台收起 */
  workbench: WorkbenchLayout
  /** 栏宽**期望值**；长度恒等于 `panes.length − 1`（末栏吃余量，不存） */
  workbenchSizes: WorkbenchSizes
}

/** 存档/入参都可能被改坏 */
export function sanitizeTheme(t: unknown): ThemeName {
  return t === 'ink' ? 'ink' : 'classic'
}

// ── 界面字号（plan7 批 F3）────────────────────────────────────────────
// 四档百分比以"标准 = 100%"为中心对称；87.5% 这类 16 基的分数值保证换算成像素是整数
// （14px 正文 → 小档 12.25px 会发虚，故小档用 87.5% 而不是 85%）。

/** 档位键做成常量元组：zod 的 `z.enum()` 要的是数组字面量，类型从它派生就不会两处各写一遍 */
export const FONT_SCALE_KEYS = ['sm', 'md', 'lg', 'xl'] as const

export type FontScale = (typeof FONT_SCALE_KEYS)[number]

export const FONT_SCALE_DEFAULT: FontScale = 'md'

export interface FontScaleInfo {
  key: FontScale
  label: string
  /** 写进根元素的 `font-size` 百分比 */
  percent: number
  desc: string
}

export const FONT_SCALES: readonly FontScaleInfo[] = [
  { key: 'sm', label: '小', percent: 87.5, desc: '一屏多放些内容；密集表格更好读' },
  { key: 'md', label: '标准', percent: 100, desc: '默认大小' },
  { key: 'lg', label: '大', percent: 112.5, desc: '正文更醒目，长时间阅读更省力' },
  { key: 'xl', label: '特大', percent: 125, desc: '投影 / 高分屏 / 视力吃力时用' }
]

export function sanitizeFontScale(v: unknown): FontScale {
  return FONT_SCALES.some((s) => s.key === v) ? (v as FontScale) : FONT_SCALE_DEFAULT
}

/** 档位 → 根元素 `font-size` 值（如 `'112.5%'`）。渲染端唯一的换算入口，别在别处再写一遍百分数 */
export function fontScalePercent(scale: FontScale): number {
  return (FONT_SCALES.find((s) => s.key === scale) ?? { percent: 100 }).percent
}

// ── 界面字体（plan7 批 F3）────────────────────────────────────────────

/** uiFont 的长度上限：一个 family 名不该长到这份上，超了基本是粘了整串 font-family */
export const UI_FONT_MAX = 80

/**
 * 清洗界面字体名：只认**字面**（字母/数字/空格/CJK/连字符/下划线），其余一律剥掉。
 * ⚠️ 这是**安全边界**而不只是格式化：这个值最终会被拼进 `--font-ui` 写进 CSS，
 *    引号、分号、反斜杠都是注入面（比如 `"a; } body { display:none"`）—— 与其转义不如白名单。
 */
export function sanitizeUiFont(v: unknown): string {
  if (typeof v !== 'string') return ''
  const cleaned = v.replace(/[^\w\s一-鿿-]/g, '').trim()
  return cleaned.length > UI_FONT_MAX ? '' : cleaned
}

/** 非有限值（NaN / Infinity，鼠标事件偶尔会给）一律回落到 min，避免把布局搞坏 */
export function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min
  if (max < min) return min // 容器太窄时的兜底：优先保证下限可用
  return Math.min(Math.max(Math.round(width), min), max)
}

/**
 * 按鼠标位置算新宽度：左抽屉 = 指针 x − 容器左边，右抽屉 = 容器右边 − 指针 x。
 * 上限不能只按抽屉自身的 max 夹，否则窄窗口下会把主区域挤没 —— 真正的上限是 `min(自身 max, 容器宽 − MAIN_RESERVE)`。
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

/** 存档可能被手改坏，或跨版本换了范围 */
export function sanitizeStoredWidth(
  stored: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (stored === undefined) return fallback
  return clampWidth(stored, min, max)
}

// 注：旧的「文件预览区高度拖拽」（PREVIEW_MIN/MAX/DEFAULT、resizePreview）已删——
// 它只服务于"预览压在文件树底下、拖手柄调高"的旧形态；plan9 W6 预览改成右侧独立成栏后手柄不存在了，
// 栏宽改由 workbench.ts 的 allocate / clampPaneWidth（横向）负责。
