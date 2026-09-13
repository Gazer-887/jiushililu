// 工作台分栏引擎（plan9 W1）—— **纯逻辑层**：渲染进程要用它，而 CI 里没有 Electron 二进制，故一律不许碰 electron。
// 与 splitter.ts 的分工：那个只管**单个**抽屉的宽度（一维），本文件管「**多栏 × 每栏多页签**」整个模型。
// 取舍（照抄与偏离参照实现 DSH `dsh-worktable/split.tsx` 各哪几条）见 PLAN/plan9 §W0。


export const WORKBENCH_SCHEMA_VERSION = 1

/** 一栏的理想下限（低于它标题栏+页签条就挤成一团） */
export const PANE_MIN = 200

/** 一栏的**绝对**下限，三级收缩的最后一级（plan9 §W5）：`PANE_MIN × 栏数 + 对话区保底` 在窄窗下**必然不可满足**，降级行为必须确定 */
export const PANE_ABS_MIN = 120

export const PANE_DEFAULT = 320

/** 分隔条**占据的布局宽度**（热区 4px，可见细线 1px 画在中缝）。⚠️ 必须计入宽度分配，否则多栏几何断言会整体偏 `(n−1) × 这个值` */
export const PANE_GAP = 4

export const PANE_MAX_COUNT = 6

export const TAB_MAX_COUNT = 20

export const PATH_MAX_LEN = 512

export const DIRTY_MAX_LEN = 64 * 1024

export const KEEPALIVE_MAX = 3


export const BUILTIN_TYPES = [
  'explorer',
  'changes',
  'scm',
  'terminal',
  'browser',
  'tasks'
] as const

export type BuiltinType = (typeof BUILTIN_TYPES)[number]

export const BUILTIN_LABELS: Record<BuiltinType, string> = {
  explorer: '资源管理器',
  changes: '文件变更',
  scm: '源代码管理',
  terminal: '终端',
  browser: '浏览器',
  tasks: '任务管理'
}

export type FileMode = 'preview' | 'edit'

export type PaneContent =
  | { kind: 'builtin'; type: BuiltinType }
  | { kind: 'file'; path: string; mode: FileMode; dirty?: string }

export interface PaneTab {
  id: string
  title: string
  content: PaneContent
  /** 保活白名单，只给「状态活在渲染进程里」的内容用（终端、编辑器草稿）；⚠️ **不给 browser 用** —— 它的真身是主进程 WebContentsView，display:none 式"保活"会让 `getBoundingClientRect()` 归零却不摘视图，原生视图带着 0×0 尺寸留在窗口上遮挡界面（plan9 §W3，实锤风险） */
  keepAlive?: boolean
}

export interface Pane {
  id: string
  title: string
  /** 本栏下限；拖拽上限由「othersMin 反推」得到，不存 max（参照实现的 max 是死配置） */
  min: number
  tabs: PaneTab[]
  active: number
  collapsed: boolean
}

export interface WorkbenchLayout {
  schemaVersion: number
  panes: Pane[]
}

/** 栏宽 —— 随「拖拽结束」落盘。只存**前 n−1 栏**的期望宽度：末栏永远吃余量，故 `paneWidths.length` 必须恒等于 `panes.length − 1` */
export interface WorkbenchSizes {
  paneWidths: number[]
}


export function emptyLayout(): WorkbenchLayout {
  return { schemaVersion: WORKBENCH_SCHEMA_VERSION, panes: [] }
}

export function emptySizes(): WorkbenchSizes {
  return { paneWidths: [] }
}

function withPanes(layout: WorkbenchLayout, panes: Pane[]): WorkbenchLayout {
  return { ...layout, panes }
}

// 不用参照实现的时间戳 id（`'t' + Date.now().toString(36)` 同毫秒连开会撞号）：改成扫一遍现有 id 取最大序号 + 1，纯函数、可测、重载后也不重复。

function nextSeq(ids: string[], prefix: string): number {
  let max = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const n = Number.parseInt(id.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

export function nextPaneId(layout: WorkbenchLayout): string {
  return `p${nextSeq(layout.panes.map((p) => p.id), 'p')}`
}

export function nextTabId(layout: WorkbenchLayout): string {
  const ids = layout.panes.flatMap((p) => p.tabs.map((t) => t.id))
  return `t${nextSeq(ids, 't')}`
}

// ── 标题 ─────────────────────────────────────────────────────────────

export function baseName(rel: string): string {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : rel
}

export function titleForContent(content: PaneContent): string {
  return content.kind === 'builtin' ? BUILTIN_LABELS[content.type] : baseName(content.path)
}

// `builtin` 比 type、`file` 比 path —— 于是「点两次同一个文件」只会**激活**已有的，不会开出两栏来。

export function sameContent(a: PaneContent, b: PaneContent): boolean {
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.type === b.type
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  return false
}

export function findTab(
  layout: WorkbenchLayout,
  content: PaneContent
): { paneId: string; tabId: string } | null {
  for (const pane of layout.panes) {
    for (const tab of pane.tabs) {
      if (sameContent(tab.content, content)) return { paneId: pane.id, tabId: tab.id }
    }
  }
  return null
}


export function findPane(layout: WorkbenchLayout, paneId: string): Pane | undefined {
  return layout.panes.find((p) => p.id === paneId)
}

function makePane(id: string, title: string, content: PaneContent | null): Pane {
  const tabs: PaneTab[] = content
    ? [{ id: 't1', title: titleForContent(content), content }]
    : []
  return { id, title, min: PANE_MIN, tabs, active: 0, collapsed: false }
}

/** 新增一栏：`at` 省略则追加到最右、越界夹回；栏数到上限就原样返回（不报错、不崩溃） */
export function addPane(
  layout: WorkbenchLayout,
  content: PaneContent | null = null,
  at?: number
): WorkbenchLayout {
  if (layout.panes.length >= PANE_MAX_COUNT) return layout
  const id = nextPaneId(layout)
  const n = layout.panes.length + 1
  const pane = makePane(id, `窗格 ${n}`, content)
  const index =
    at === undefined || !Number.isFinite(at)
      ? layout.panes.length
      : Math.min(Math.max(Math.trunc(at), 0), layout.panes.length)
  const panes = [...layout.panes]
  panes.splice(index, 0, pane)
  return withPanes(layout, panes)
}

/** 关掉一栏；关掉最后一栏得到空布局 —— **不是**崩溃，也不是"自动再建一栏" */
export function removePane(layout: WorkbenchLayout, paneId: string): WorkbenchLayout {
  const panes = layout.panes.filter((p) => p.id !== paneId)
  if (panes.length === layout.panes.length) return layout
  return withPanes(layout, panes)
}

/** 整栏互换；宽度随栏走但**不在这里改**，由 sizes 的调用方对齐 */
export function movePane(layout: WorkbenchLayout, from: number, to: number): WorkbenchLayout {
  const n = layout.panes.length
  if (n < 2) return layout
  if (!Number.isFinite(from) || !Number.isFinite(to)) return layout
  const a = Math.min(Math.max(Math.trunc(from), 0), n - 1)
  const b = Math.min(Math.max(Math.trunc(to), 0), n - 1)
  if (a === b) return layout
  const panes = [...layout.panes]
  const [moved] = panes.splice(a, 1)
  panes.splice(b, 0, moved)
  return withPanes(layout, panes)
}

export function toggleCollapse(layout: WorkbenchLayout, paneId: string): WorkbenchLayout {
  return withPanes(
    layout,
    layout.panes.map((p) => (p.id === paneId ? { ...p, collapsed: !p.collapsed } : p))
  )
}

export function activateTab(layout: WorkbenchLayout, paneId: string, index: number): WorkbenchLayout {
  return withPanes(
    layout,
    layout.panes.map((p) => {
      if (p.id !== paneId || p.tabs.length === 0) return p
      const i = Number.isFinite(index) ? Math.trunc(index) : 0
      return { ...p, active: Math.min(Math.max(i, 0), p.tabs.length - 1) }
    })
  )
}

/** 往指定栏打开一个内容：`paneId` 指向不存在（或为 null）的栏时自动新建一栏来放它；⚠️ **浏览器是全工作台单例** —— 主进程只有一个 WebContentsView，跨栏也不许开第二份 */
export function openTab(
  layout: WorkbenchLayout,
  paneId: string | null,
  content: PaneContent
): WorkbenchLayout {
  if (content.kind === 'builtin' && content.type === 'browser') {
    const hit = findTab(layout, content)
    if (hit) {
      return activateTab(
        layout,
        hit.paneId,
        findPane(layout, hit.paneId)?.tabs.findIndex((t) => t.id === hit.tabId) ?? 0
      )
    }
  }

  const pane = paneId ? findPane(layout, paneId) : undefined
  if (!pane) {
    const next = addPane(layout, content)
    if (next === layout) return layout
    const newPane = next.panes[next.panes.length - 1]
    return activateTab(next, newPane.id, 0)
  }

  // ② 本栏已有同内容 → 只激活；若是**同一个文件的另一种 mode**，顺便切过去 ——
  //    一个文件只该占一个页签（预览与编辑是同一份文档的两种看法，开两页会各自显示不同内容）。
  const existing = pane.tabs.findIndex((t) => sameContent(t.content, content))
  if (existing >= 0) {
    const activated = activateTab(layout, pane.id, existing)
    if (content.kind !== 'file') return activated
    return withPanes(
      activated,
      activated.panes.map((p) =>
        p.id !== pane.id
          ? p
          : {
              ...p,
              tabs: p.tabs.map((t, i) =>
                i === existing && t.content.kind === 'file'
                  ? { ...t, content: { ...t.content, mode: content.mode } }
                  : t
              )
            }
      )
    )
  }

  if (pane.tabs.length >= TAB_MAX_COUNT) return layout
  const tab: PaneTab = { id: nextTabId(layout), title: titleForContent(content), content }
  return withPanes(
    layout,
    layout.panes.map((p) =>
      p.id !== pane.id
        ? p
        : { ...p, tabs: [...p.tabs, tab], active: p.tabs.length, collapsed: false }
    )
  )
}

/** 关掉本栏最后一个页签 → 该栏变"未指派"（显示 ＋ 选择器）但**不删栏** —— 删栏是另一个动作（`removePane`），两件事分开用户才不会"关个标签栏就没了" */
function mapFileTab(
  layout: WorkbenchLayout,
  paneId: string,
  tabId: string,
  fn: (c: Extract<PaneContent, { kind: 'file' }>) => PaneContent
): WorkbenchLayout {
  return withPanes(
    layout,
    layout.panes.map((p) =>
      p.id !== paneId
        ? p
        : {
            ...p,
            tabs: p.tabs.map((t) =>
              t.id === tabId && t.content.kind === 'file' ? { ...t, content: fn(t.content) } : t
            )
          }
    )
  )
}

/** 切「预览 / 编辑」，**草稿不动**（切走再切回来，没保存的内容还在）。草稿住这一层而不是组件里：切页签会让编辑组件**卸载**、组件内的状态当场没了，而 `file.dirty` 随布局持久化，连重启都在 */
export function setFileTabMode(
  layout: WorkbenchLayout,
  paneId: string,
  tabId: string,
  mode: FileMode
): WorkbenchLayout {
  return mapFileTab(layout, paneId, tabId, (c) => ({ ...c, mode }))
}

/** 存 / 清草稿。`undefined` = **清掉**（表示"没改"或"已保存"）；⚠️ 清的时候要把 `dirty` 这个键**整个去掉**、不许留一个 `undefined` —— 否则它会被序列化进 ui-prefs，读回来时 sanitize 又得再剥一遍（两处规则迟早分叉） */
export function setFileTabDirty(
  layout: WorkbenchLayout,
  paneId: string,
  tabId: string,
  dirty: string | undefined
): WorkbenchLayout {
  return mapFileTab(layout, paneId, tabId, (c) =>
    dirty === undefined
      ? { kind: 'file', path: c.path, mode: c.mode }
      : { kind: 'file', path: c.path, mode: c.mode, dirty }
  )
}

export function closeTab(layout: WorkbenchLayout, paneId: string, tabId: string): WorkbenchLayout {
  return withPanes(
    layout,
    layout.panes.map((p) => {
      if (p.id !== paneId) return p
      const tabs = p.tabs.filter((t) => t.id !== tabId)
      if (tabs.length === p.tabs.length) return p
      return { ...p, tabs, active: Math.min(p.active, Math.max(tabs.length - 1, 0)) }
    })
  )
}

export function moveTab(
  layout: WorkbenchLayout,
  fromPaneId: string,
  tabId: string,
  toPaneId: string
): WorkbenchLayout {
  const from = findPane(layout, fromPaneId)
  const to = findPane(layout, toPaneId)
  if (!from || !to || from.id === to.id) return layout
  const tab = from.tabs.find((t) => t.id === tabId)
  if (!tab) return layout
  if (to.tabs.length >= TAB_MAX_COUNT) return layout
  if (to.tabs.some((t) => sameContent(t.content, tab.content))) {
    const next = closeTab(layout, fromPaneId, tabId)
    const hit = findTab(next, tab.content)
    return hit ? activateTab(next, hit.paneId, next.panes.find((p) => p.id === hit.paneId)!.tabs.findIndex((t) => t.id === hit.tabId)) : next
  }
  const closed = closeTab(layout, fromPaneId, tabId)
  return withPanes(
    closed,
    closed.panes.map((p) =>
      p.id !== toPaneId ? p : { ...p, tabs: [...p.tabs, tab], active: p.tabs.length }
    )
  )
}

/** 打开文件到「预览栏」：优先复用**纯文件栏**的最后一栏，没有就在最右新建一栏（plan9 W6 入口）；⚠️ 点文件树必须**独立成栏**，不许塞进资源管理器那一栏（改造前的旧形态） */
export function openInFilePane(
  layout: WorkbenchLayout,
  path: string,
  mode: FileMode = 'preview'
): WorkbenchLayout {
  const last = layout.panes[layout.panes.length - 1]
  const lastIsFilePane =
    last !== undefined && last.tabs.length > 0 && last.tabs.every((t) => t.content.kind === 'file')
  if (lastIsFilePane) return openTab(layout, last.id, { kind: 'file', path, mode })
  const next = addPane(layout, { kind: 'file', path, mode })
  return next === layout ? layout : next
}


export interface AllocateInput {
  desired: number[]
  mins: number[]
  count: number
  /** **可用宽**：容器宽已扣掉左抽屉与对话区保底（MAIN_RESERVE） */
  available: number
}

export interface AllocateResult {
  /** n 个宽度（不含分隔条宽度；分隔条由渲染层按 PANE_GAP 画） */
  widths: number[]
  /** 连 PANE_ABS_MIN 都放不下 → 渲染层要出横向滚动（三级收缩的最后一级） */
  overflow: boolean
}

function pick(list: number[], i: number, fallback: number): number {
  const v = list[i]
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback
}

/** 把 `widths` 按「离 floor 的余量」等比缩到**总和恰为 budget**（整数、精确，用最大余数法）；floor 之和已超 budget 时返回 `floor`，由调用方判断降级。⚠️ 不许用 `round` 逐项减：残差会让吃余量的末栏悄悄掉到自己的 `min` 以下，整个布局的几何断言全部对不上。 */
function shrinkTo(widths: number[], floors: number[], budget: number): number[] {
  const n = widths.length
  const sumFloor = floors.reduce((a, b) => a + b, 0)
  if (sumFloor >= budget) return [...floors]

  const slack = widths.map((w, i) => Math.max(0, w - floors[i]))
  const totalSlack = slack.reduce((a, b) => a + b, 0)
  if (totalSlack <= 0) return [...floors]

  const want = Math.min(budget - sumFloor, totalSlack)
  const exact = slack.map((s) => (want * s) / totalSlack)
  const base = exact.map((e) => Math.floor(e))
  const rem = want - base.reduce((a, b) => a + b, 0)

  // 余数按小数部分从大到小发；同分按下标（保证确定性 —— 单测才不会随机翻车）
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const extra = new Array<number>(n).fill(0)
  for (let k = 0; k < rem && k < order.length; k++) extra[order[k].i] += 1

  return floors.map((f, i) => f + base[i] + extra[i])
}

/** 分栏宽度分配（纯函数，plan9 §W5）：前 n−1 栏取期望宽、**末栏吃余量**；放不下时三级收缩（各栏 `min` → `PANE_ABS_MIN` → 溢出滚动）。
 *  ⚠️ 算出来的只是"这一帧该多宽"，调用方**绝不能**把它写回 `WorkbenchSizes`（窗口缩小再放大会不可逆）。
 *  ⚠️ 收缩顺序不可颠倒 —— **对话区保底是硬约束，栏 min 是软目标**。 */
export function allocate(input: AllocateInput): AllocateResult {
  const count = Math.max(0, Math.trunc(input.count))
  if (count === 0) return { widths: [], overflow: false }

  const gaps = (count - 1) * PANE_GAP
  const avail = Number.isFinite(input.available) ? Math.round(input.available) : 0
  const budget = Math.max(0, avail - gaps)

  const mins: number[] = []
  for (let i = 0; i < count; i++) {
    const m = pick(input.mins, i, PANE_MIN)
    mins.push(Math.max(PANE_ABS_MIN, Math.min(m, PANE_DEFAULT)))
  }

  if (budget < PANE_ABS_MIN * count) {
    return { widths: mins.map(() => PANE_ABS_MIN), overflow: true }
  }

  const head: number[] = []
  for (let i = 0; i < count - 1; i++) head.push(Math.max(pick(input.desired, i, PANE_DEFAULT), mins[i]))
  let last = budget - head.reduce((a, b) => a + b, 0)

  // ② 末栏被压到低于**绝对下限**时 → 前面按余量等比让出。这里用的是 `PANE_ABS_MIN`，不是末栏自己的 `min`
  //    （真机验收抓到的 bug：按 `min` 反推会把被拖的那一栏**缩回去**，表现是「往右拖没反应、往左拖有用」）。
  //    同一个约束只许有一处定义 —— 这里是它唯一的定义处，`clampPaneWidth` 与它对齐。
  if (last < PANE_ABS_MIN && count > 1) {
    const target = budget - PANE_ABS_MIN
    const headFloor = mins.slice(0, -1).reduce((a, b) => a + b, 0)
    if (headFloor < target) {
      const shrunk = shrinkTo(head, mins.slice(0, -1), target)
      for (let i = 0; i < count - 1; i++) head[i] = shrunk[i]
      last = budget - head.reduce((a, b) => a + b, 0)
    }
  }

  const widths = [...head, last]

  /** ⚠️ 顺序很关键：**先把所有栏抬到绝对下限，再判总量** —— 反过来（先判总量再抬下限）会漏掉"末栏被抬到下限、抬上去的那截没从别的栏扣"这种情况，总和就悄悄超了预算 */
  for (let i = 0; i < count; i++) widths[i] = Math.max(widths[i], PANE_ABS_MIN)

  let overflow = false
  if (widths.reduce((a, b) => a + b, 0) > budget) {
    const tier1 = shrinkTo(widths, mins, budget)
    if (tier1.reduce((a, b) => a + b, 0) <= budget) {
      for (let i = 0; i < count; i++) widths[i] = tier1[i]
    } else {
      const abs = mins.map(() => PANE_ABS_MIN)
      const tier2 = shrinkTo(mins, abs, budget)
      if (tier2.reduce((a, b) => a + b, 0) <= budget) {
        for (let i = 0; i < count; i++) widths[i] = tier2[i]
      } else {
        for (let i = 0; i < count; i++) widths[i] = PANE_ABS_MIN
        overflow = true
      }
    }
  }

  for (let i = 0; i < count; i++) widths[i] = Math.max(PANE_ABS_MIN, Math.round(widths[i]))
  return { widths, overflow }
}

export function normalizeSizes(sizes: WorkbenchSizes, paneCount: number): WorkbenchSizes {
  const want = Math.max(0, paneCount - 1)
  const src = Array.isArray(sizes.paneWidths) ? sizes.paneWidths : []
  const paneWidths: number[] = []
  for (let i = 0; i < want; i++) paneWidths.push(pick(src, i, PANE_DEFAULT))
  return { paneWidths }
}

/** 「均分」的期望宽 —— 栏数变化时用它当默认值，而不是给每栏拍一个固定像素（`PANE_DEFAULT` 是**与容器无关**的常数，窄窗里开两栏会一宽一窄像随手拍的）。
 *  @param available 工作台区的**可用宽**（渲染端实测，已扣掉外框） */
export function evenWidths(count: number, available: number): WorkbenchSizes {
  const n = Math.max(0, Math.trunc(count))
  if (n < 2) return { paneWidths: [] }
  const avail = Number.isFinite(available) ? available : 0
  const each = Math.max(PANE_ABS_MIN, Math.round((avail - (n - 1) * PANE_GAP) / n))
  return { paneWidths: new Array(n - 1).fill(each) }
}

/** 拖拽调宽：只改被拖那一栏的期望宽，**上限在「拖拽源」上解**（= `预算 − 其他栏已占的宽 − 末栏**绝对**下限）—— 不重分配、无反馈回路。
 *  ⚠️ 末栏这里用 `PANE_ABS_MIN` 而非它的 `min`（plan9 W5 修）：预算紧张时按 `min` 反推会让上限小于本栏 `min`，**拖拽直接失效**。
 *  ⚠️ 只有前 n−1 栏可拖 —— 第 i 条分隔条夹在第 i 与第 i+1 栏之间，控制**第 i 栏**。@returns 新的期望宽（已夹到合法区间） */
export function clampPaneWidth(input: {
  desired: number[]
  mins: number[]
  count: number
  available: number
  index: number
  width: number
}): number {
  const count = Math.max(1, Math.trunc(input.count))
  const index = Math.min(Math.max(Math.trunc(input.index), 0), count - 2)
  if (index < 0) return PANE_DEFAULT

  const gaps = (count - 1) * PANE_GAP
  const avail = Number.isFinite(input.available) ? Math.round(input.available) : 0
  const budget = Math.max(0, avail - gaps)
  const mins: number[] = []
  for (let i = 0; i < count; i++) mins.push(pick(input.mins, i, PANE_MIN))

  let others = 0
  for (let i = 0; i < count - 1; i++) {
    if (i !== index) others += Math.max(pick(input.desired, i, PANE_DEFAULT), mins[i])
  }
  const lo = mins[index]
  const hi = Math.max(lo, budget - others - PANE_ABS_MIN)
  // 鼠标事件偶尔给 NaN / Infinity —— `Math.max(min, NaN)` 会得到 NaN，一旦写进 layout 就是满屏 0 宽，所以先兜住有限性
  const want = Number.isFinite(input.width) ? Math.round(input.width) : lo
  return Math.max(lo, Math.min(want, hi))
}

/** 换位落点：指针落在第几栏上（-1 = 在所有栏之外）。抽成纯函数是因为**合成事件验不了真实拖拽**（Chrome 会把真实鼠标的 mousemove 也发过来、覆盖合成坐标）—— 判定逻辑只能靠单测保证 */
export function dropTargetIndex(widths: number[], pointerX: number): number {
  if (!Number.isFinite(pointerX) || widths.length === 0) return -1
  let acc = 0
  for (let i = 0; i < widths.length; i++) {
    const w = Math.max(0, Math.round(widths[i] ?? 0))
    if (pointerX >= acc && pointerX < acc + w) return i
    acc += w + PANE_GAP
  }
  return -1
}


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function sanitizeContent(raw: unknown): PaneContent | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'builtin') {
    const t = raw.type
    if (typeof t !== 'string' || !(BUILTIN_TYPES as readonly string[]).includes(t)) return null
    return { kind: 'builtin', type: t as BuiltinType }
  }
  if (raw.kind === 'file') {
    const p = str(raw.path).slice(0, PATH_MAX_LEN)
    if (!p) return null
    const mode: FileMode = raw.mode === 'edit' ? 'edit' : 'preview'
    const dirty = typeof raw.dirty === 'string' ? raw.dirty.slice(0, DIRTY_MAX_LEN) : undefined
    return dirty === undefined
      ? { kind: 'file', path: p, mode }
      : { kind: 'file', path: p, mode, dirty }
  }
  return null
}

/** 坏存档兜底 —— **唯一入口**，三层校验都调它（渲染端装载 / IPC / 主进程读盘）；策略「要么全好、要么回默认」：逐字段挣扎只会得到半畸形布局，比空布局更难排查。
 *  单条不合法的内容会被丢掉，但**整份布局仍在**（用户开的其他栏不该被一条坏数据连坐）。 */
export function sanitizeLayout(raw: unknown): WorkbenchLayout {
  if (!isRecord(raw)) return emptyLayout()
  const rawPanes = Array.isArray(raw.panes) ? raw.panes : []

  const usedIds = new Set<string>()
  let keepAliveLeft = KEEPALIVE_MAX
  const panes: Pane[] = []

  for (const rp of rawPanes.slice(0, PANE_MAX_COUNT)) {
    if (!isRecord(rp)) continue
    let id = str(rp.id)
    if (!id || usedIds.has(id)) id = `p${panes.length + 1}`
    usedIds.add(id)

    const tabs: PaneTab[] = []
    for (const rt of (Array.isArray(rp.tabs) ? rp.tabs : []).slice(0, TAB_MAX_COUNT)) {
      if (!isRecord(rt)) continue
      const content = sanitizeContent(rt.content)
      if (!content) continue
      const keepAlive = rt.keepAlive === true && keepAliveLeft > 0
      if (keepAlive) keepAliveLeft--
      tabs.push({
        id: str(rt.id) || `t${tabs.length + 1}`,
        title: str(rt.title) || titleForContent(content),
        content,
        ...(keepAlive ? { keepAlive: true } : {})
      })
    }

    const minRaw = Number(rp.min)
    const min = Number.isFinite(minRaw)
      ? Math.min(Math.max(Math.round(minRaw), PANE_ABS_MIN), PANE_DEFAULT)
      : PANE_MIN
    const activeRaw = Number(rp.active)
    const active = tabs.length === 0
      ? 0
      : Math.min(Math.max(Number.isFinite(activeRaw) ? Math.trunc(activeRaw) : 0, 0), tabs.length - 1)

    panes.push({
      id,
      title: str(rp.title) || `窗格 ${panes.length + 1}`,
      min,
      tabs,
      active,
      collapsed: rp.collapsed === true
    })
  }

  return { schemaVersion: WORKBENCH_SCHEMA_VERSION, panes }
}

/** 栏宽兜底。**长度必须等于 `paneCount − 1`**，对不上就整组回默认 —— 尺寸数组与当前栏数不同源时，宁可全丢也不要错位。 */
export function sanitizeSizes(raw: unknown, paneCount: number): WorkbenchSizes {
  const want = Math.max(0, paneCount - 1)
  if (!isRecord(raw)) return { paneWidths: new Array(want).fill(PANE_DEFAULT) }
  const arr = Array.isArray(raw.paneWidths) ? raw.paneWidths : null
  if (!arr || arr.length !== want) return { paneWidths: new Array(want).fill(PANE_DEFAULT) }
  const paneWidths: number[] = []
  for (let i = 0; i < want; i++) {
    const v = Number(arr[i])
    paneWidths.push(Number.isFinite(v) ? Math.max(PANE_ABS_MIN, Math.round(v)) : PANE_DEFAULT)
  }
  return { paneWidths }
}
