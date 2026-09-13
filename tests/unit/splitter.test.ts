import { describe, expect, it } from 'vitest'
import {
  DOCK_DEFAULT,
  DOCK_MAX,
  DOCK_MIN,
  FONT_SCALE_DEFAULT,
  FONT_SCALES,
  MAIN_RESERVE,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  UI_FONT_MAX,
  clampWidth,
  computeWidth,
  fontScalePercent,
  sanitizeFontScale,
  sanitizeStoredWidth,
  sanitizeUiFont
} from '@shared/splitter'

// 分隔条纯逻辑（plan7 批 A0）
// ⚠️ 风险不在抽屉自己被拖坏，而在**窄窗口下把主区域挤没** —— 故上限还要受 MAIN_RESERVE 约束。

describe('clampWidth（夹到合法区间）', () => {
  it('在区间的原样返回', () => {
    expect(clampWidth(300, 180, 420)).toBe(300)
  })

  it('低于下限取下限', () => {
    expect(clampWidth(50, 180, 420)).toBe(180)
  })

  it('高于上限取上限', () => {
    expect(clampWidth(9999, 180, 420)).toBe(420)
  })

  it('非有限值回落到下限（NaN / Infinity 不该把布局搞坏）', () => {
    expect(clampWidth(Number.NaN, 180, 420)).toBe(180)
    expect(clampWidth(Number.POSITIVE_INFINITY, 180, 420)).toBe(180)
    expect(clampWidth(Number.NEGATIVE_INFINITY, 180, 420)).toBe(180)
  })

  it('小数取整', () => {
    expect(clampWidth(300.6, 180, 420)).toBe(301)
  })

  it('容器太窄（max < min）时优先保下限', () => {
    expect(clampWidth(300, 180, 100)).toBe(180)
  })
})

describe('computeWidth（按鼠标位置算宽度）', () => {
  const box = { containerLeft: 0, containerRight: 1200 }

  it('左抽屉：宽度 = 指针 x − 容器左边', () => {
    expect(computeWidth({ ...box, pointerX: 300, side: 'left', min: 180, max: 420 })).toBe(300)
  })

  it('右抽屉：宽度 = 容器右边 − 指针 x', () => {
    expect(computeWidth({ ...box, pointerX: 900, side: 'right', min: 280, max: 640 })).toBe(300)
  })

  it('左抽屉拖过头 → 夹到下限', () => {
    expect(computeWidth({ ...box, pointerX: 10, side: 'left', min: 180, max: 420 })).toBe(180)
  })

  it('右抽屉拖过头 → 夹到下限', () => {
    expect(computeWidth({ ...box, pointerX: 1195, side: 'right', min: 280, max: 640 })).toBe(280)
  })

  it('左抽屉拖太宽 → 夹到自身上限（窗口够宽时）', () => {
    expect(computeWidth({ ...box, pointerX: 800, side: 'left', min: 180, max: 420 })).toBe(420)
  })
})

describe('computeWidth 的窄窗保护（重点）', () => {
  it('**窗口变窄时，抽屉上限随之缩小** —— 主区域至少留 MAIN_RESERVE', () => {
    // 窗口 800：右抽屉自身上限 640，但主区域要留 320 → 上限只能是 480
    const w = computeWidth({
      pointerX: 0, // 往最左拖（想拖到最宽）
      containerLeft: 0,
      containerRight: 800,
      side: 'right',
      min: DOCK_MIN,
      max: DOCK_MAX
    })
    expect(w).toBe(480)
    expect(800 - w).toBe(MAIN_RESERVE)
  })

  it('窗口极窄（连下限都放不下）时仍返回下限，不返回负数', () => {
    const w = computeWidth({
      pointerX: 300,
      containerLeft: 0,
      containerRight: 400, // 比 min(280) + reserve(320) 还小
      side: 'right',
      min: DOCK_MIN,
      max: DOCK_MAX
    })
    expect(w).toBe(DOCK_MIN) // 下限优先，绝不出现 0 或负数
    expect(w).toBeGreaterThan(0)
  })

  it('窗口够宽时走抽屉自身上限（主区域约束不生效）', () => {
    const w = computeWidth({
      pointerX: 900,
      containerLeft: 0,
      containerRight: 900,
      side: 'left',
      min: SIDEBAR_MIN,
      max: SIDEBAR_MAX
    })
    // maxByMain = 900 - 320 = 580 > 自身上限 420 → 取 420
    expect(w).toBe(SIDEBAR_MAX)
  })

  it('窗口变窄后，左抽屉上限被主区域约束压下来', () => {
    const w = computeWidth({
      pointerX: 900,
      containerLeft: 0,
      containerRight: 600,
      side: 'left',
      min: SIDEBAR_MIN,
      max: SIDEBAR_MAX
    })
    // maxByMain = 600 - 320 = 280 < 自身上限 420 → 被压到 280
    expect(w).toBe(280)
    expect(600 - w).toBe(MAIN_RESERVE)
  })

  it('主区域保底值恒定：任何拖拽结果都不会吃光主区域', () => {
    for (const containerRight of [700, 900, 1200, 1600]) {
      for (const pointerX of [0, 200, 500, 900, 1500]) {
        const w = computeWidth({
          pointerX,
          containerLeft: 0,
          containerRight,
          side: 'right',
          min: DOCK_MIN,
          max: DOCK_MAX
        })
        // 要么命中下限（窗口实在太窄），要么主区域还留得下 MAIN_RESERVE
        expect(w === DOCK_MIN || containerRight - w >= MAIN_RESERVE).toBe(true)
      }
    }
  })
})

describe('sanitizeStoredWidth（读回存档也要夹一次）', () => {
  it('undefined → 用默认值', () => {
    expect(sanitizeStoredWidth(undefined, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(
      SIDEBAR_DEFAULT
    )
  })

  it('合法值原样返回', () => {
    expect(sanitizeStoredWidth(300, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(300)
  })

  it('被手改成离谱值的存档会被夹回（防布局被搞坏）', () => {
    expect(sanitizeStoredWidth(99999, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX)).toBe(DOCK_MAX)
    expect(sanitizeStoredWidth(-5, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX)).toBe(DOCK_MIN)
    expect(sanitizeStoredWidth(0, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX)).toBe(DOCK_MIN)
  })
})

describe('常量自身的合理性（防止以后改坏）', () => {
  it('下限 < 默认值 < 上限', () => {
    expect(SIDEBAR_MIN).toBeLessThan(SIDEBAR_DEFAULT)
    expect(SIDEBAR_DEFAULT).toBeLessThan(SIDEBAR_MAX)
    expect(DOCK_MIN).toBeLessThan(DOCK_DEFAULT)
    expect(DOCK_DEFAULT).toBeLessThan(DOCK_MAX)
  })

  it('默认值与当前 CSS 一致（改 CSS 忘了改常量会导致首次显示跳变）', () => {
    expect(SIDEBAR_DEFAULT).toBe(248)
    expect(DOCK_DEFAULT).toBe(360)
  })

  it('主区域保底为正数', () => {
    expect(MAIN_RESERVE).toBeGreaterThan(0)
  })
})

// ── 界面字号档（plan7 批 F3）────────────────────────────────────────

describe('sanitizeFontScale（坏值回落默认档）', () => {
  it('四档合法值原样返回', () => {
    for (const key of ['sm', 'md', 'lg', 'xl']) {
      expect(sanitizeFontScale(key)).toBe(key)
    }
  })

  it('非法值回落默认档', () => {
    expect(sanitizeFontScale('huge')).toBe(FONT_SCALE_DEFAULT)
    expect(sanitizeFontScale(125)).toBe(FONT_SCALE_DEFAULT)
    expect(sanitizeFontScale(null)).toBe(FONT_SCALE_DEFAULT)
    expect(sanitizeFontScale(undefined)).toBe(FONT_SCALE_DEFAULT)
  })
})

describe('fontScalePercent（档位 → 根元素百分比）', () => {
  it('标准档是 100', () => {
    expect(fontScalePercent('md')).toBe(100)
    expect(fontScalePercent(FONT_SCALE_DEFAULT)).toBe(100)
  })

  it('四档百分比单调递增且对称分布', () => {
    const percents = FONT_SCALES.map((s) => s.percent)
    expect(percents).toEqual([87.5, 100, 112.5, 125])
  })

  it('未知档位不炸，回落 100', () => {
    expect(fontScalePercent('nope' as never)).toBe(100)
  })
})

// ── 界面字体名清洗（plan7 批 F3）────────────────────────────────────

describe('sanitizeUiFont（白名单清洗，这是 CSS 注入的防线）', () => {
  it('普通字体名原样保留', () => {
    expect(sanitizeUiFont('Microsoft YaHei')).toBe('Microsoft YaHei')
    expect(sanitizeUiFont('Segoe-UI_Variable')).toBe('Segoe-UI_Variable')
    expect(sanitizeUiFont('思源黑体')).toBe('思源黑体')
  })

  it('剥掉引号/分号/花括号等注入字符', () => {
    // CSS 注入的最小样本：值最终会被拼进 --font-ui 写进 style；剥完只剩字面与空白
    expect(sanitizeUiFont("a'; } body { display:none")).toBe('a  body  displaynone')
  })

  it('剥掉反斜杠与 @import', () => {
    expect(sanitizeUiFont('x\'; @import url(evil)')).not.toMatch(/[\;@'()]/)
  })

  it('超长值整串拒绝（贴整串 font-family 的防呆）', () => {
    expect(sanitizeUiFont('a'.repeat(UI_FONT_MAX + 1))).toBe('')
    expect(sanitizeUiFont('a'.repeat(UI_FONT_MAX))).toBe('a'.repeat(UI_FONT_MAX))
  })

  it('非字符串一律空串（= 恢复默认栈）', () => {
    expect(sanitizeUiFont(null)).toBe('')
    expect(sanitizeUiFont(42)).toBe('')
    expect(sanitizeUiFont(undefined)).toBe('')
  })

  it('首尾空白裁掉', () => {
    expect(sanitizeUiFont('  Arial  ')).toBe('Arial')
  })
})
