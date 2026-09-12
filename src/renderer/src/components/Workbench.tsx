import { Fragment, useEffect, useRef, useState } from 'react'
import { allocate } from '@shared/workbench'
import { useAppStore } from '../store'
import Pane from './Pane'
import PaneChooser from './PaneChooser'

// 工作台（plan9 W3）—— 取代改造前的 RightDock（单活跃页签）。
//
// 布局模型：`panes` 是一个**水平栏数组**，栏内各自还有页签列表。
// 宽度分配走 `allocate()` 纯函数（三级收缩见 plan9 §W5）：
//   · 前 n−1 栏用存下来的**期望宽**，**末栏吃余量**
//   · 总宽就是外层分隔条控制的 `dockWidth` —— 所以拖最外面那条边就是调整整体
//   · 算出来的宽度**只用于渲染，绝不写回**（写回会让"窗口缩小再放大"不可逆）
//
// 保留 `.dock` / `.dock-body` 两个类名：前者是容器（视觉验证脚本按它量宽度），
// 后者是栏内容区（脚本按它量滚动）—— 改名就得同时改验证脚本，这是本项目的既有教训。

/** 栏与栏之间留的缝，**必须等于** workbench.ts 的 PANE_GAP（分配时算进去了） */
const GAP_PX = 4

export default function Workbench(): JSX.Element | null {
  const dockOpen = useAppStore((s) => s.dockOpen)
  const dockWidth = useAppStore((s) => s.dockWidth)
  const layout = useAppStore((s) => s.workbench)
  const sizes = useAppStore((s) => s.workbenchSizes)
  const wbAddPane = useAppStore((s) => s.wbAddPane)
  const wbOpenTab = useAppStore((s) => s.wbOpenTab)
  const toggleDock = useAppStore((s) => s.toggleDock)

  // 收起时**整块不渲染**（此前是渲染一个 0 宽的 aside）：
  // 这样 `.dock` 存在 ⟺ 工作台展开，验证脚本与样式都少一个状态要判断。
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState(dockWidth)

  // 量**真实的可用宽**，而不是直接用 dockWidth。
  // 原因：`.dock` 有 1px 左边框，按 dockWidth 分配会让栏宽之和比容器多 1px，
  // 被 `overflow:hidden` 悄悄裁掉 —— 少 1px 用户看不出来，但几何断言会失真。
  // 量真实宽度还顺带免疫以后改边框/内边距 —— 比写死一个"chrome 常量"稳。
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const sync = (): void => setRowWidth(el.getBoundingClientRect().width)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dockOpen])

  // 收起时整块不渲染 —— 注意这行必须在**所有 hook 之后**（否则违反 hook 调用顺序）
  if (!dockOpen) return null

  const count = layout.panes.length
  const fit = allocate({
    desired: sizes.paneWidths,
    mins: layout.panes.map((p) => p.min),
    count,
    available: rowWidth
  })

  return (
    <aside className="dock open" style={{ width: dockWidth }}>
      <div className="dock-head">
        <span className="wb-title">工作台</span>
        <button className="wb-add" title="新建一栏" onClick={wbAddPane}>
          ＋
        </button>
        <button className="dock-close" title="收起工作台" onClick={toggleDock}>
          ✕
        </button>
      </div>

      <div ref={rowRef} className={`wb-row ${fit.overflow ? 'wb-overflow' : ''}`}>
        {count === 0 ? (
          // 空工作台：默认布局就是空的（与"工作台默认收起"一致），
          // 展开后直接给开窗菜单，而不是悄悄塞一个资源管理器
          <div className="wb-empty">
            <div className="wb-empty-title">工作台是空的</div>
            <div className="wb-empty-desc">选一个面板打开，之后可以再 ＋ 开新的一栏。</div>
            <PaneChooser onPick={(t) => wbOpenTab(null, { kind: 'builtin', type: t })} />
          </div>
        ) : (
          layout.panes.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && <div className="wb-gap" style={{ width: GAP_PX }} />}
              <Pane pane={p} width={fit.widths[i]} />
            </Fragment>
          ))
        )}
      </div>
    </aside>
  )
}
