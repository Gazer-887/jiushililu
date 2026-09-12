import { describe, expect, it } from 'vitest'
import {
  DIRTY_MAX_LEN,
  KEEPALIVE_MAX,
  PANE_ABS_MIN,
  PANE_DEFAULT,
  PANE_GAP,
  PANE_MAX_COUNT,
  PANE_MIN,
  TAB_MAX_COUNT,
  WORKBENCH_SCHEMA_VERSION,
  activateTab,
  addPane,
  allocate,
  baseName,
  clampPaneWidth,
  closeTab,
  dropTargetIndex,
  emptyLayout,
  evenWidths,
  findTab,
  movePane,
  moveTab,
  nextPaneId,
  nextTabId,
  normalizeSizes,
  openInFilePane,
  openTab,
  removePane,
  sanitizeLayout,
  sanitizeSizes,
  sameContent,
  titleForContent,
  toggleCollapse,
  type BuiltinType,
  type FileMode,
  type PaneContent,
  type WorkbenchLayout
} from '@shared/workbench'

// 工作台分栏引擎纯逻辑（plan9 W1）
//
// 这一层是整个工作台的地基，所以要盯的是**边界**而不是正常路径：
// · 关掉最后一个页签/最后一栏会不会塌
// · 同一内容重复打开会不会开出一堆重复栏
// · 窗口窄到放不下时有没有确定的降级行为（而不是"未定义"）
// · 坏存档进来会不会变成半个畸形布局
//
// 拖拽的坐标换算**验不了真实鼠标**（Chrome 会把真实 mousemove 也发过来覆盖合成坐标），
// 所以落点/宽度一律走这些纯函数，界面只验结构 —— 这是本项目已验证的既定做法。

const bi = (type: BuiltinType): PaneContent => ({ kind: 'builtin', type })
const fi = (path: string, mode: FileMode = 'preview'): PaneContent => ({ kind: 'file', path, mode })

function layoutWith(...contents: PaneContent[]): WorkbenchLayout {
  let l = emptyLayout()
  for (const c of contents) l = addPane(l, c)
  return l
}

describe('baseName / titleForContent', () => {
  it('取路径最后一段（两种分隔符都要认）', () => {
    expect(baseName('src/main/index.ts')).toBe('index.ts')
    expect(baseName('src\\main\\index.ts')).toBe('index.ts')
    expect(baseName('README.md')).toBe('README.md')
  })

  it('拿不到文件名时退回整串（不返回空字符串）', () => {
    expect(baseName('///')).toBe('///')
    expect(baseName('')).toBe('')
  })

  it('内置面板用中文名，文件用文件名', () => {
    expect(titleForContent(bi('explorer'))).toBe('资源管理器')
    expect(titleForContent(bi('browser'))).toBe('浏览器')
    expect(titleForContent(fi('PLAN/plan9.md'))).toBe('plan9.md')
  })
})

describe('id 生成（纯函数，不用时间戳）', () => {
  it('空布局从 1 开始', () => {
    expect(nextPaneId(emptyLayout())).toBe('p1')
    expect(nextTabId(emptyLayout())).toBe('t1')
  })

  it('取现有最大序号 +1 —— 参照实现用时间戳，同毫秒连开会撞号', () => {
    const l = layoutWith(bi('explorer'), bi('browser'))
    expect(nextPaneId(l)).toBe('p3')
  })

  it('页签 id 跨栏统一编号（不会两栏各出 t1）', () => {
    let l = layoutWith(bi('explorer'))
    l = openTab(l, l.panes[0].id, fi('a.ts'))
    expect(nextTabId(l)).toBe('t3') // t1 是 explorer，t2 是 a.ts
  })
})

describe('addPane / removePane', () => {
  it('新栏默认带着内容，标题自动编号', () => {
    const l = addPane(emptyLayout(), bi('explorer'))
    expect(l.panes).toHaveLength(1)
    expect(l.panes[0].tabs[0].content).toEqual(bi('explorer'))
    expect(l.panes[0].active).toBe(0)
    expect(l.panes[0].collapsed).toBe(false)
  })

  it('可以开"未指派"的空栏（tabs 为空，界面显示 ＋ 选择器）', () => {
    const l = addPane(emptyLayout(), null)
    expect(l.panes[0].tabs).toHaveLength(0)
  })

  it('at 越界夹回，不会插到数组外面', () => {
    let l = layoutWith(bi('explorer'), bi('browser'))
    l = addPane(l, bi('tasks'), 99)
    expect(l.panes).toHaveLength(3)
    expect(l.panes[2].tabs[0].content).toEqual(bi('tasks'))
    l = addPane(l, bi('scm'), -5)
    expect(l.panes[0].tabs[0].content).toEqual(bi('scm'))
  })

  it('栏数到上限就原样返回（不报错、不崩溃）', () => {
    let l = emptyLayout()
    for (let i = 0; i < PANE_MAX_COUNT; i++) l = addPane(l, bi('tasks'))
    expect(l.panes).toHaveLength(PANE_MAX_COUNT)
    expect(addPane(l, bi('scm'))).toBe(l)
  })

  it('关掉最后一栏得到空布局 —— 不是崩溃，也不"自动再建一栏"', () => {
    const l = layoutWith(bi('explorer'))
    const closed = removePane(l, l.panes[0].id)
    expect(closed.panes).toHaveLength(0)
    expect(closed.schemaVersion).toBe(WORKBENCH_SCHEMA_VERSION)
  })

  it('关不存在的栏 = 原样返回（同引用，界面不会白重渲染）', () => {
    const l = layoutWith(bi('explorer'))
    expect(removePane(l, 'nope')).toBe(l)
  })
})

describe('movePane（整栏换位）', () => {
  it('前移与后移都对', () => {
    const l = layoutWith(bi('explorer'), bi('browser'), bi('tasks'))
    expect(movePane(l, 0, 2).panes.map((p) => p.tabs[0].content)).toEqual([
      bi('browser'),
      bi('tasks'),
      bi('explorer')
    ])
    expect(movePane(l, 2, 0).panes.map((p) => p.tabs[0].content)).toEqual([
      bi('tasks'),
      bi('explorer'),
      bi('browser')
    ])
  })

  it('越界夹回，不抛异常', () => {
    const l = layoutWith(bi('explorer'), bi('browser'))
    expect(movePane(l, -3, 99).panes.map((p) => p.tabs[0].content)).toEqual([
      bi('browser'),
      bi('explorer')
    ])
  })

  it('单栏 / 同位 / 非数字都原样返回', () => {
    const one = layoutWith(bi('explorer'))
    expect(movePane(one, 0, 0)).toBe(one)
    const two = layoutWith(bi('explorer'), bi('browser'))
    expect(movePane(two, 1, 1)).toBe(two)
    expect(movePane(two, Number.NaN, 0)).toBe(two)
  })
})

describe('toggleCollapse（折叠 = 隐藏标题与页签条，宽度不变）', () => {
  it('来回切两下回到原状', () => {
    const l = layoutWith(bi('explorer'))
    const id = l.panes[0].id
    const on = toggleCollapse(l, id)
    expect(on.panes[0].collapsed).toBe(true)
    expect(toggleCollapse(on, id).panes[0].collapsed).toBe(false)
  })

  it('折叠不碰页签内容（折叠是"腾地方"，不是"关掉"）', () => {
    const l = layoutWith(bi('explorer'))
    const on = toggleCollapse(l, l.panes[0].id)
    expect(on.panes[0].tabs).toEqual(l.panes[0].tabs)
  })
})

describe('openTab：去重与浏览器单例', () => {
  it('本栏已有同内容 → 只激活，不重复追加', () => {
    const l = layoutWith(bi('explorer'))
    const again = openTab(l, l.panes[0].id, bi('explorer'))
    expect(again.panes[0].tabs).toHaveLength(1)
    expect(again.panes[0].active).toBe(0)
  })

  it('文件按路径去重（点两次同一个文件不该开两个页签）', () => {
    // 用一个**空栏**（未指派）来测，页签数才等于"开过的文件数"；
    // 若用 layoutWith(bi('explorer'))，那一栏里本来就有一个 explorer 页签，会把计数搅浑
    const l = addPane(emptyLayout(), null)
    const id = l.panes[0].id
    let next = openTab(l, id, fi('a.ts'))
    next = openTab(next, id, fi('b.ts'))
    next = openTab(next, id, fi('a.ts'))
    expect(next.panes[0].tabs).toHaveLength(2)
    expect(next.panes[0].active).toBe(0) // 回到了 a.ts 那一页
  })

  it('同一文件在预览/编辑之间切换**只占一个页签**（一个文件一个页签，VS Code 的做法）', () => {
    const l = addPane(emptyLayout(), null)
    const id = l.panes[0].id
    let next = openTab(l, id, fi('a.ts', 'preview'))
    expect(next.panes[0].tabs).toHaveLength(1)
    expect((next.panes[0].tabs[0].content as { mode: string }).mode).toBe('preview')

    next = openTab(next, id, fi('a.ts', 'edit'))
    expect(next.panes[0].tabs).toHaveLength(1) // 没有开出第二页
    expect((next.panes[0].tabs[0].content as { mode: string }).mode).toBe('edit') // 而是切了 mode
  })

  it('**浏览器是全工作台单例** —— 主进程只有一个 WebContentsView，跨栏也不许开第二份', () => {
    let l = layoutWith(bi('explorer'), bi('tasks'))
    const [p1, p2] = [l.panes[0].id, l.panes[1].id]
    l = openTab(l, p2, bi('browser')) // 开在第二栏
    expect(l.panes[1].tabs).toHaveLength(2)

    const again = openTab(l, p1, bi('browser')) // 又从第一栏点开浏览器
    expect(again.panes[0].tabs).toHaveLength(1) // 第一栏**没有**新增
    expect(again.panes[1].tabs).toHaveLength(2) // 第二栏也没多
    expect(again.panes[1].active).toBe(1) // 而是把第二栏那个激活了
  })

  it('普通内置面板**不是**单例（两个资源管理器栏是允许的）', () => {
    let l = layoutWith(bi('explorer'), bi('explorer'))
    expect(l.panes[1].tabs).toHaveLength(1)
    l = openTab(l, l.panes[1].id, bi('explorer'))
    expect(l.panes[1].tabs).toHaveLength(1) // 同栏内仍然是去重的
  })

  it('目标栏不存在（或传 null）→ 自动新建一栏来放它', () => {
    const a = openTab(emptyLayout(), null, fi('a.ts'))
    expect(a.panes).toHaveLength(1)
    const b = openTab(a, 'ghost', bi('tasks'))
    expect(b.panes).toHaveLength(2)
  })

  it('栏数到上限时不会硬塞（原样返回）', () => {
    let l = emptyLayout()
    for (let i = 0; i < PANE_MAX_COUNT; i++) l = addPane(l, bi('tasks'))
    expect(openTab(l, 'ghost', bi('explorer'))).toBe(l)
  })

  it('往收起状态的栏开页签会自动展开（否则用户看不到）', () => {
    const l = layoutWith(bi('explorer'))
    const collapsed = toggleCollapse(l, l.panes[0].id)
    const next = openTab(collapsed, l.panes[0].id, fi('a.ts'))
    expect(next.panes[0].collapsed).toBe(false)
  })
})

describe('closeTab', () => {
  it('**关掉本栏最后一个页签 → 栏还在，只是变成"未指派"**（关标签≠关栏）', () => {
    const l = layoutWith(bi('explorer'))
    const closed = closeTab(l, l.panes[0].id, l.panes[0].tabs[0].id)
    expect(closed.panes).toHaveLength(1)
    expect(closed.panes[0].tabs).toHaveLength(0)
    expect(closed.panes[0].active).toBe(0)
  })

  it('关中间那个，激活下标不会指到界外', () => {
    const l = layoutWith(bi('explorer'))
    const id = l.panes[0].id
    let next = openTab(l, id, fi('a.ts'))
    next = openTab(next, id, fi('b.ts')) // active = 2
    const tabs = next.panes[0].tabs
    const closed = closeTab(next, id, tabs[2].id)
    expect(closed.panes[0].tabs).toHaveLength(2)
    expect(closed.panes[0].active).toBeLessThan(2)
  })

  it('关不存在的页签 = 内容不变', () => {
    const l = layoutWith(bi('explorer'))
    const closed = closeTab(l, l.panes[0].id, 'ghost')
    expect(closed.panes[0].tabs).toEqual(l.panes[0].tabs)
  })
})

describe('moveTab（拖页签到别的栏）', () => {
  it('摘出来放进目标栏并激活', () => {
    let l = layoutWith(bi('explorer'), bi('tasks'))
    l = openTab(l, l.panes[0].id, fi('a.ts'))
    const moved = moveTab(l, l.panes[0].id, l.panes[0].tabs[1].id, l.panes[1].id)
    expect(moved.panes[0].tabs).toHaveLength(1)
    expect(moved.panes[1].tabs).toHaveLength(2)
    expect(moved.panes[1].active).toBe(1)
  })

  it('目标栏已有同内容 → 只激活，不重复放（源栏的那个被关掉）', () => {
    let l = layoutWith(bi('explorer'), bi('tasks'))
    l = openTab(l, l.panes[0].id, fi('a.ts'))
    l = openTab(l, l.panes[1].id, fi('a.ts'))
    const moved = moveTab(l, l.panes[0].id, l.panes[0].tabs[1].id, l.panes[1].id)
    expect(moved.panes[0].tabs).toHaveLength(1)
    expect(moved.panes[1].tabs).toHaveLength(2)
  })

  it('同一栏内拖 = 原样返回', () => {
    const l = layoutWith(bi('explorer'))
    expect(moveTab(l, l.panes[0].id, l.panes[0].tabs[0].id, l.panes[0].id)).toBe(l)
  })
})

describe('openInFilePane（点文件 → 右侧独立成栏）', () => {
  it('空工作台 → 建一栏放文件', () => {
    const l = openInFilePane(emptyLayout(), 'src/a.ts')
    expect(l.panes).toHaveLength(1)
    expect(l.panes[0].tabs[0].content).toEqual(fi('src/a.ts'))
  })

  it('最后一栏是纯文件栏 → 复用（不每点一个文件就多一栏）', () => {
    let l = openInFilePane(emptyLayout(), 'src/a.ts')
    l = openInFilePane(l, 'src/b.ts')
    expect(l.panes).toHaveLength(1)
    expect(l.panes[0].tabs).toHaveLength(2)
  })

  it('最后一栏是资源管理器 → 新开一栏，不塞进资源管理器', () => {
    const l = openInFilePane(layoutWith(bi('explorer')), 'src/a.ts')
    expect(l.panes).toHaveLength(2)
    expect(l.panes[0].tabs[0].content).toEqual(bi('explorer'))
    expect(l.panes[1].tabs[0].content).toEqual(fi('src/a.ts'))
  })

  it('栏数到上限时不硬塞（原样返回，界面该给提示）', () => {
    let l = emptyLayout()
    for (let i = 0; i < PANE_MAX_COUNT; i++) l = addPane(l, bi('tasks'))
    expect(openInFilePane(l, 'src/a.ts')).toBe(l)
  })
})

describe('allocate（宽度分配 —— 三级收缩）', () => {
  it('两栏：末栏吃余量，总和精确等于预算', () => {
    const r = allocate({ desired: [400], mins: [], count: 2, available: 1000 })
    expect(r.widths).toEqual([400, 1000 - PANE_GAP - 400])
    expect(r.overflow).toBe(false)
  })

  it('单栏吃满', () => {
    expect(allocate({ desired: [], mins: [], count: 1, available: 500 }).widths).toEqual([500])
  })

  it('零栏返回空（关掉所有栏的那一帧）', () => {
    expect(allocate({ desired: [], mins: [], count: 0, available: 500 })).toEqual({
      widths: [],
      overflow: false
    })
  })

  it('期望宽过大时**前面让出**，保证末栏不被压穿**绝对下限**', () => {
    const r = allocate({ desired: [900], mins: [], count: 2, available: 600 })
    const budget = 600 - PANE_GAP
    expect(r.widths.reduce((a, b) => a + b, 0)).toBe(budget)
    // 末栏可以让到**绝对**下限（120）——它的 `min`(200) 是软目标，不是硬约束
    expect(r.widths[1]).toBeGreaterThanOrEqual(PANE_ABS_MIN)
  })

  it('**宽工作台**下拖出来的宽度不会被缩回（真机验收抓到的回归，必留）', () => {
    // 用户机器实测：工作台 515px、两栏。
    // 原来第②步坚持把末栏喂到它的 min(200)，于是第一栏被死锁在 515−200=315 ——
    // **往右拖没反应、往左拖有用**。这条专门盯那一档（窄工作台那档恰好不冲突，验不出它）。
    const dragged = 360
    const r = allocate({ desired: [dragged], mins: [200, 200], count: 2, available: 515 })
    expect(r.widths[0]).toBe(dragged)
    expect(r.widths[1]).toBe(515 - PANE_GAP - dragged)
  })

  it('与 clampPaneWidth 的**上限一致**（同一个约束只许有一处定义）', () => {
    const available = 515
    const hi = clampPaneWidth({ desired: [], mins: [200, 200], count: 2, available, index: 0, width: 9999 })
    const r = allocate({ desired: [hi], mins: [200, 200], count: 2, available })
    // 拖到上限时，allocate 必须**原样接受**，不许缩回
    expect(r.widths[0]).toBe(hi)
  })

  it('三栏预算充裕：各拿期望，末栏补满', () => {
    const r = allocate({ desired: [300, 300], mins: [], count: 3, available: 1200 })
    expect(r.widths).toEqual([300, 300, 1200 - 2 * PANE_GAP - 600])
  })

  it('**二级收缩**：预算连 min 都放不下（492 < 3×200）→ 收到绝对下限之间，不溢出', () => {
    const r = allocate({ desired: [], mins: [], count: 3, available: 500 })
    const budget = 500 - 2 * PANE_GAP
    expect(r.widths.reduce((a, b) => a + b, 0)).toBe(budget)
    expect(r.widths.every((w) => w >= PANE_ABS_MIN)).toBe(true)
    expect(r.overflow).toBe(false)
  })

  it('**三级收缩**：连绝对下限都放不下（292 < 3×120）→ 报溢出，界面该出横向滚动', () => {
    const r = allocate({ desired: [], mins: [], count: 3, available: 300 })
    expect(r.overflow).toBe(true)
    expect(r.widths).toEqual([PANE_ABS_MIN, PANE_ABS_MIN, PANE_ABS_MIN])
  })

  it('available 是 NaN / Infinity 时不漏进算式', () => {
    expect(allocate({ desired: [], mins: [], count: 2, available: Number.NaN }).overflow).toBe(true)
    const inf = allocate({ desired: [], mins: [], count: 2, available: Number.POSITIVE_INFINITY })
    expect(inf.widths.every((w) => Number.isFinite(w))).toBe(true)
  })

  it('任何情况下都不出现 0 宽或负宽（几何断言与渲染都受不了）', () => {
    for (const available of [0, 1, 100, 300, 800, 2000]) {
      for (const count of [1, 2, 3, 6]) {
        const r = allocate({ desired: [], mins: [], count, available })
        expect(r.widths).toHaveLength(count)
        expect(r.widths.every((w) => w >= PANE_ABS_MIN)).toBe(true)
      }
    }
  })

  it('分隔条宽度计入总量（漏了会让多栏几何断言整体偏 (n−1)×间隙）', () => {
    const r = allocate({ desired: [300, 300], mins: [], count: 3, available: 1000 })
    const used = r.widths.reduce((a, b) => a + b, 0) + 2 * PANE_GAP
    expect(used).toBe(1000)
  })
})

describe('clampPaneWidth（拖拽调宽）', () => {
  it('上限由「其他栏已占 + 末栏的**绝对**下限」反推 —— 不重分配其他栏', () => {
    // 预算 996；拖第 0 栏时，别处至少留 PANE_ABS_MIN(120)。
    // 用绝对下限而不是末栏的 min —— 否则预算紧张时上限会小于本栏 min，拖拽直接失效
    expect(
      clampPaneWidth({ desired: [], mins: [], count: 2, available: 1000, index: 0, width: 9999 })
    ).toBe(1000 - PANE_GAP - PANE_ABS_MIN)
  })

  it('拖第 0 栏时会扣掉其他栏**已占**的期望宽（而不是只扣它们的 min）', () => {
    const w = clampPaneWidth({
      desired: [300, 300],
      mins: [],
      count: 3,
      available: 1200,
      index: 0,
      width: 9999
    })
    expect(w).toBe(1200 - 2 * PANE_GAP - 300 - PANE_ABS_MIN)
  })

  it('**预算紧张时仍然拖得动**（回归：曾经上限被算成 min，怎么拖都没反应）', () => {
    // 两栏、工作台只有 359px：两边都到不了各自的 min(200)，
    // 但用户仍应该能在 200..235 之间调配
    const w = clampPaneWidth({
      desired: [320],
      mins: [200, 200],
      count: 2,
      available: 359,
      index: 0,
      width: 235
    })
    expect(w).toBe(235)
  })

  it('预算紧张时 allocate 也**不会把拖出来的宽度悄悄收回**', () => {
    const r = allocate({ desired: [235], mins: [200, 200], count: 2, available: 359 })
    expect(r.widths).toEqual([235, 359 - PANE_GAP - 235])
  })

  it('evenWidths 给出与容器相称的**均分**默认（不是拍一个固定像素值）', () => {
    // 515px 开两栏：均分 ≈ 256/255，而不是"第一栏 320、末栏 195"那种一宽一窄
    const sizes = evenWidths(2, 515)
    const r = allocate({ desired: sizes.paneWidths, mins: [200, 200], count: 2, available: 515 })
    expect(Math.abs(r.widths[0] - r.widths[1])).toBeLessThanOrEqual(2)
  })

  it('容器窄到不允许均分时**承认它**、各自保底（不再假装能均分）', () => {
    // 359px 装两栏：各 200 都放不下（400 > 355）→ 落成 [200,155]。
    // 关键是总和恰好等于预算、且谁都不低于绝对下限
    const sizes = evenWidths(2, 359)
    const r = allocate({ desired: sizes.paneWidths, mins: [200, 200], count: 2, available: 359 })
    expect(r.widths.reduce((a, b) => a + b, 0)).toBe(359 - PANE_GAP)
    expect(r.widths.every((w) => w >= PANE_ABS_MIN)).toBe(true)
  })

  it('不会小于该栏自己的 min', () => {
    expect(
      clampPaneWidth({ desired: [], mins: [], count: 2, available: 1000, index: 0, width: 10 })
    ).toBe(PANE_MIN)
  })

  it('只有一栏时没有分隔条（返回默认值，不抛异常）', () => {
    expect(
      clampPaneWidth({ desired: [], mins: [], count: 1, available: 1000, index: 0, width: 500 })
    ).toBe(PANE_DEFAULT)
  })

  it('非有限宽度回落到下限，不把布局搞坏', () => {
    expect(
      clampPaneWidth({ desired: [], mins: [], count: 2, available: 1000, index: 0, width: Number.NaN })
    ).toBe(PANE_MIN)
  })
})

describe('dropTargetIndex（换位落点）', () => {
  it('落点落在第几栏上就算第几栏', () => {
    expect(dropTargetIndex([100, 100, 100], 50)).toBe(0)
    expect(dropTargetIndex([100, 100, 100], 100 + PANE_GAP + 10)).toBe(1)
    expect(dropTargetIndex([100, 100, 100], 100 + PANE_GAP + 100 + PANE_GAP + 10)).toBe(2)
  })

  it('落在所有栏之外返回 -1（界面据此不高亮）', () => {
    expect(dropTargetIndex([100, 100], 9999)).toBe(-1)
    expect(dropTargetIndex([], 10)).toBe(-1)
  })

  it('非有限坐标返回 -1', () => {
    expect(dropTargetIndex([100], Number.NaN)).toBe(-1)
  })
})

describe('sanitizeLayout（坏存档兜底）', () => {
  it('不是对象 → 空布局（而且带正确的 schemaVersion）', () => {
    expect(sanitizeLayout(null)).toEqual({
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      panes: []
    })
    expect(sanitizeLayout('nonsense').panes).toEqual([])
    expect(sanitizeLayout({ panes: 'nope' }).panes).toEqual([])
  })

  it('不认识的内容被丢掉，但**整份布局还在**（不连坐其他栏）', () => {
    const l = sanitizeLayout({
      panes: [
        { id: 'p1', tabs: [{ id: 't1', content: { kind: 'builtin', type: 'explorer' } }] },
        { id: 'p2', tabs: [{ id: 't2', content: { kind: 'iframe', url: 'x' } }] }
      ]
    })
    expect(l.panes).toHaveLength(2)
    expect(l.panes[1].tabs).toHaveLength(0)
  })

  it('非法文件名 / 缺 path 的文件内容被丢掉', () => {
    const l = sanitizeLayout({
      panes: [{ id: 'p1', tabs: [{ id: 't1', content: { kind: 'file' } }] }]
    })
    expect(l.panes[0].tabs).toHaveLength(0)
  })

  it('超长路径被截断（不让坏数据把内存撑爆）', () => {
    const long = 'a'.repeat(2000)
    const l = sanitizeLayout({
      panes: [{ id: 'p1', tabs: [{ id: 't1', content: { kind: 'file', path: long } }] }]
    })
    expect((l.panes[0].tabs[0].content as { path: string }).path.length).toBeLessThanOrEqual(512)
  })

  it('草稿超长被截断', () => {
    const l = sanitizeLayout({
      panes: [
        {
          id: 'p1',
          tabs: [{ id: 't1', content: { kind: 'file', path: 'a.ts', dirty: 'x'.repeat(999999) } }]
        }
      ]
    })
    const c = l.panes[0].tabs[0].content as { dirty?: string }
    expect(c.dirty!.length).toBeLessThanOrEqual(DIRTY_MAX_LEN)
  })

  it('active 越界夹回，指向不存在的页签不会崩', () => {
    const l = sanitizeLayout({
      panes: [
        { id: 'p1', active: 99, tabs: [{ id: 't1', content: { kind: 'builtin', type: 'tasks' } }] }
      ]
    })
    expect(l.panes[0].active).toBe(0)
  })

  it('栏数与页签数封顶', () => {
    const many = {
      panes: Array.from({ length: 20 }, (_, i) => ({
        id: `x${i}`,
        tabs: Array.from({ length: 50 }, (_, j) => ({
          id: `t${i}-${j}`,
          content: { kind: 'builtin', type: 'tasks' }
        }))
      }))
    }
    const l = sanitizeLayout(many)
    expect(l.panes).toHaveLength(PANE_MAX_COUNT)
    expect(l.panes[0].tabs).toHaveLength(TAB_MAX_COUNT)
  })

  it('重复 id 会被重编（否则 React key 与激活判定全会错位）', () => {
    const l = sanitizeLayout({
      panes: [
        { id: 'same', tabs: [{ id: 't1', content: { kind: 'builtin', type: 'tasks' } }] },
        { id: 'same', tabs: [{ id: 't1', content: { kind: 'builtin', type: 'scm' } }] }
      ]
    })
    expect(l.panes[0].id).not.toBe(l.panes[1].id)
  })

  it('保活页签封顶（不设上限的话启动会重建一屋子实例）', () => {
    const l = sanitizeLayout({
      panes: [
        {
          id: 'p1',
          tabs: Array.from({ length: 8 }, (_, j) => ({
            id: `t${j}`,
            keepAlive: true,
            content: { kind: 'builtin', type: 'tasks' }
          }))
        }
      ]
    })
    expect(l.panes[0].tabs.filter((t) => t.keepAlive === true)).toHaveLength(KEEPALIVE_MAX)
  })

  it('min 被夹进合法区间', () => {
    const l = sanitizeLayout({
      panes: [{ id: 'p1', min: 99999, tabs: [], collapsed: 'yes' }]
    })
    expect(l.panes[0].min).toBeLessThanOrEqual(PANE_DEFAULT)
    expect(l.panes[0].collapsed).toBe(false) // 非布尔值不算 true
  })
})

describe('sanitizeSizes / normalizeSizes（尺寸与栏数必须同源）', () => {
  it('长度对不上 → 整组回默认（宁可全丢也不要错位）', () => {
    expect(sanitizeSizes({ paneWidths: [100, 200] }, 4).paneWidths).toEqual([
      PANE_DEFAULT,
      PANE_DEFAULT,
      PANE_DEFAULT
    ])
  })

  it('长度正好时逐项夹到绝对下限', () => {
    expect(sanitizeSizes({ paneWidths: [10, 400] }, 3).paneWidths).toEqual([PANE_ABS_MIN, 400])
  })

  it('非数字项回落到默认宽', () => {
    expect(sanitizeSizes({ paneWidths: [Number.NaN, 400] }, 3).paneWidths).toEqual([
      PANE_DEFAULT,
      400
    ])
  })

  it('垃圾输入给默认宽数组', () => {
    expect(sanitizeSizes(null, 3).paneWidths).toEqual([PANE_DEFAULT, PANE_DEFAULT])
  })

  it('normalizeSizes：栏数变化后长度跟着变（多退少补）', () => {
    expect(normalizeSizes({ paneWidths: [100, 200, 300] }, 2).paneWidths).toEqual([100])
    expect(normalizeSizes({ paneWidths: [] }, 4).paneWidths).toEqual([
      PANE_DEFAULT,
      PANE_DEFAULT,
      PANE_DEFAULT
    ])
  })

  it('单栏 / 零栏 → 没有分隔条宽度要存', () => {
    expect(normalizeSizes({ paneWidths: [100] }, 1).paneWidths).toEqual([])
    expect(normalizeSizes({ paneWidths: [100] }, 0).paneWidths).toEqual([])
  })
})

describe('sameContent / findTab', () => {
  it('内置比 type、文件比 path', () => {
    expect(sameContent(bi('explorer'), bi('explorer'))).toBe(true)
    expect(sameContent(bi('explorer'), bi('browser'))).toBe(false)
    expect(sameContent(fi('a.ts'), fi('a.ts'))).toBe(true)
    expect(sameContent(bi('explorer'), fi('a.ts'))).toBe(false)
  })

  it('findTab 跨栏找得到', () => {
    let l = layoutWith(bi('explorer'), bi('tasks'))
    l = openTab(l, l.panes[1].id, fi('a.ts'))
    expect(findTab(l, bi('tasks'))?.paneId).toBe(l.panes[1].id)
    expect(findTab(l, bi('changes'))).toBeNull()
  })
})

describe('activateTab', () => {
  it('越界夹回合法区间', () => {
    let l = layoutWith(bi('explorer'))
    l = openTab(l, l.panes[0].id, fi('a.ts'))
    expect(activateTab(l, l.panes[0].id, 99).panes[0].active).toBe(1)
    expect(activateTab(l, l.panes[0].id, -5).panes[0].active).toBe(0)
  })

  it('空栏（未指派）不会把 active 设成 -1', () => {
    const l = addPane(emptyLayout(), null)
    expect(activateTab(l, l.panes[0].id, 0).panes[0].active).toBe(0)
  })
})
