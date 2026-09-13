import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { allocate, clampPaneWidth, movePane, PANE_DEFAULT, type WorkbenchLayout, type WorkbenchSizes } from '@shared/workbench'
import { useAppStore } from '../store'
import Pane from './Pane'
import PaneChooser from './PaneChooser'

// 工作台（plan9 W3 多栏渲染 → W5 拖拽）：`panes` 是水平栏数组，栏内各有页签列表。
//
// 宽度分配走 `allocate()` 纯函数（三级收缩见 plan9 §W5）：前 n−1 栏用存下来的**期望宽**，
// **末栏吃余量**；算出来的宽度**只用于渲染、绝不写回**（写回会让"窗口缩小再放大"不可逆）。
// ⚠️ 保留 `.dock` / `.dock-body` 两个类名：验证脚本按前者量宽度、按后者量滚动，改名必须同时改脚本。

/** 栏与栏之间留的缝，**必须等于** workbench.ts 的 PANE_GAP（分配时算进去了） */
const GAP_PX = 4

/**
 * 栏间分隔条：夹在第 `index` 与 `index+1` 栏之间，**控制第 index 栏**。
 * 只有 n−1 条 —— 宽度数组也只存 n−1 个（末栏吃余量）。最外那条边（对话｜工作台）
 * 由 App 原有的 Splitter 管，它调的是**总宽**。
 */
function PaneDivider({
  index,
  layout,
  sizes,
  widths,
  available
}: {
  index: number
  layout: WorkbenchLayout
  sizes: WorkbenchSizes
  /** **屏幕上真实渲染出来的**宽度 —— 拖拽必须基于它，不能基于存下来的期望宽 */
  widths: number[]
  available: number
}): JSX.Element {
  const setWorkbench = useAppStore((s) => s.setWorkbench)
  const persistSoon = useAppStore((s) => s.persistWorkbenchSoon)
  const ref = useRef<HTMLDivElement>(null)

  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const el = ref.current
    if (!el) return
    // Pointer capture：监听挂在手柄**自身**上，鼠标再快也不丢事件，不必往 document 上挂全局监听（plan9 §W0-A7）。
    // 用 try 包住：合成事件里 pointerId 不对应真实指针时这里会抛 NotFoundError，
    // 而"拖不动"比"抓不到指针"严重得多 —— 抓不到也要让后面的监听照常工作。
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 拿不到捕获也继续，监听仍在 el 上 */
    }
    const startX = e.clientX
    /**
     * ⚠️ 起点必须是**渲染宽度**，不是 `sizes.paneWidths[index]`：期望宽是新栏的默认值，
     * 实测常被 `allocate` 压小一大截。若用期望宽当起点，用户拖一点点栏就**跳** —— 手感完全错位。
     */
    const startW = widths[index] ?? PANE_DEFAULT
    const mins = layout.panes.map((p) => p.min)
    let applied = startW

    const onMove = (ev: PointerEvent): void => {
      const w = clampPaneWidth({
        desired: sizes.paneWidths,
        mins,
        count: layout.panes.length,
        available,
        index,
        width: startW + (ev.clientX - startX)
      })
      if (w === applied) return
      applied = w
      const paneWidths = [...sizes.paneWidths]
      paneWidths[index] = w
      // 拖拽过程中**只改内存**（不落盘）—— 每帧写盘是参照实现自己标注的卡顿源
      setWorkbench(layout, { paneWidths })
    }
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      persistSoon() // 松手后才写盘（plan9 §W5 提交点表）
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      ref={ref}
      className="wb-divider"
      style={{ width: GAP_PX }}
      title="拖动调整左右两栏的宽度"
      onPointerDown={onDown}
    />
  )
}

export default function Workbench(): JSX.Element | null {
  const dockOpen = useAppStore((s) => s.dockOpen)
  const dockWidth = useAppStore((s) => s.dockWidth)
  const layout = useAppStore((s) => s.workbench)
  const sizes = useAppStore((s) => s.workbenchSizes)
  const setWorkbench = useAppStore((s) => s.setWorkbench)
  const persistWorkbench = useAppStore((s) => s.persistWorkbench)
  const wbOpenTab = useAppStore((s) => s.wbOpenTab)
  const setWbRowWidth = useAppStore((s) => s.setWbRowWidth)

  // 换位拖拽态进组件 state，**不学**参照实现的模块级变量（中途重渲染会让它残留，plan9 §W0-B5）
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const rowRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState(dockWidth)

  // 量**真实的可用宽**，不用 dockWidth：`.dock` 有 1px 左边框，按 dockWidth 分配会让
  // 栏宽之和比容器多 1px，被 `overflow:hidden` 悄悄裁掉 —— 用户看不出，但几何断言会失真。
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const sync = (): void => {
      const w = el.getBoundingClientRect().width
      setRowWidth(w)
      setWbRowWidth(w) // 回报给 store：栏数变化时要靠它算"与容器相称的均分默认"
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dockOpen])

  // 收起时整块不渲染 —— 必须在**所有 hook 之后**（否则违反 hook 调用顺序）
  if (!dockOpen) return null

  const count = layout.panes.length
  const fit = allocate({
    desired: sizes.paneWidths,
    mins: layout.panes.map((p) => p.min),
    count,
    available: rowWidth
  })

  const onDragStart = (index: number, e: ReactDragEvent): void => {
    setDragFrom(index)
    // 用 dataTransfer 捎带下标，不依赖模块级变量
    e.dataTransfer.setData('text/plain', String(index))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (index: number, e: ReactDragEvent): void => {
    if (dragFrom === null) return
    e.preventDefault() // 不 preventDefault 就不触发 drop
    e.dataTransfer.dropEffect = 'move'
    setDropAt(index)
  }
  const onDrop = (index: number, e: ReactDragEvent): void => {
    e.preventDefault()
    const raw = Number(e.dataTransfer.getData('text/plain'))
    const from = Number.isFinite(raw) ? raw : dragFrom
    setDragFrom(null)
    setDropAt(null)
    if (from === null || from === index) return
    // 换位：**宽度留在列上、内容跟着走**（有意与参照实现不同，它连宽度一起换）：
    // 我们的栏宽数组只存前 n−1 栏、末栏吃余量，长度与"栏"不一一对应，做不到"宽度跟着内容"；
    // 而"列宽不变、内容换过去"也更贴"我把这栏挪到那边"的直觉。
    setWorkbench(movePane(layout, from, index), sizes)
    void persistWorkbench()
  }
  const onDragEnd = (): void => {
    setDragFrom(null)
    setDropAt(null)
  }

  return (
    <aside className="dock open" style={{ width: dockWidth }}>
      <div ref={rowRef} className={`wb-row ${fit.overflow ? 'wb-overflow' : ''}`}>
        {count === 0 ? (
          // 空工作台：展开后直接给开窗菜单，**不**悄悄塞一个资源管理器（默认布局本就是空的）
          <div className="wb-empty">
            <div className="wb-empty-title">工作台为空</div>
            <PaneChooser onPick={(t) => wbOpenTab(null, { kind: 'builtin', type: t })} />
          </div>
        ) : (
          layout.panes.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && (
                <PaneDivider
                  index={i - 1}
                  layout={layout}
                  sizes={sizes}
                  widths={fit.widths}
                  available={rowWidth}
                />
              )}
              <Pane
                pane={p}
                index={i}
                width={fit.widths[i]}
                dropOn={dropAt === i && dragFrom !== null && dragFrom !== i}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              />
            </Fragment>
          ))
        )}
      </div>
    </aside>
  )
}
