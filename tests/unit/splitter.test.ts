import { describe, expect, it } from 'vitest'
import {
  DOCK_DEFAULT,
  DOCK_MAX,
  DOCK_MIN,
  MAIN_RESERVE,
  PREVIEW_DEFAULT,
  PREVIEW_MAX,
  PREVIEW_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampWidth,
  computeWidth,
  resizePreview,
  sanitizeStoredWidth
} from '@shared/splitter'

// 分隔条纯逻辑（plan7 批 A0）
//
// 要盯的是「拖到极限会不会把界面搞坏」：
// 抽屉自身有 min/max，但**窄窗口下真正的风险是把主区域挤没** ——
// 所以上限还要受 MAIN_RESERVE 约束。这组测试主要钉这个。

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
      pointerX: 900, // 往最右拖
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
      pointerX: 900, // 往最右拖
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

describe('resizePreview（预览区高度拖拽，plan7 批 A2 验收反馈）', () => {
  it('往上拖变高、往下拖变矮', () => {
    expect(resizePreview(280, 400, 300)).toBe(380) // 往上 100
    expect(resizePreview(280, 400, 500)).toBe(180) // 往下 100
  })

  it('夹在下限与上限之间', () => {
    expect(resizePreview(280, 400, 10000)).toBe(PREVIEW_MIN)
    expect(resizePreview(280, 400, -10000)).toBe(PREVIEW_MAX)
  })

  it('非有限值一律回落到下限（鼠标事件偶尔给 NaN / Infinity）', () => {
    expect(resizePreview(280, 400, NaN)).toBe(PREVIEW_MIN)
    expect(resizePreview(280, 400, Infinity)).toBe(PREVIEW_MIN)
  })

  it('默认值本身落在合法区间内', () => {
    expect(PREVIEW_DEFAULT).toBeGreaterThanOrEqual(PREVIEW_MIN)
    expect(PREVIEW_DEFAULT).toBeLessThanOrEqual(PREVIEW_MAX)
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
