import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react'
import type { BuiltinType, Pane as PaneModel, PaneTab } from '@shared/workbench'
import { useAppStore } from '../store'
import BrowserPanel from './BrowserPanel'
import ChangesPanel from './ChangesPanel'
import ExplorerPanel from './ExplorerPanel'
import FilePreviewPane from './FilePreviewPane'
import PaneChooser from './PaneChooser'
import TasksPanel from './TasksPanel'

// 工作台的**一栏**（plan9 W3）：标题栏 + 栏内页签条 + 内容。
//
// 两条关键语义（plan9 §W3，都是审查后定死的）：
//
// ① **切换页签 = 卸载**（不是隐藏）。参照实现在页签级也不保活，
//    而"隐藏不卸载"对我们的浏览器面板是**危险的**：`BrowserPanel` 只在
//    **卸载时**才调 `setBrowserVisible(false)` 摘掉主进程的原生视图；
//    用 display:none"保活"会让 getBoundingClientRect() 归零、却不触发摘视图，
//    原生 WebContentsView 就留在窗口上遮挡界面（实锤风险）。
//    草稿不靠组件保活 —— 它存在 tab 模型的 `content` 里（`mode` / `dirty`）。
//
// ② **折叠 = 隐藏标题栏与页签条、内容占满，宽度不变**（照抄参照实现的语义）。
//    不是"把栏收成一条窄条"。

/** 内置面板 → 组件 */
function builtinBody(type: BuiltinType): JSX.Element {
  switch (type) {
    case 'explorer':
      return <ExplorerPanel />
    case 'changes':
      return <ChangesPanel />
    case 'browser':
      return <BrowserPanel />
    case 'tasks':
      return <TasksPanel />
    case 'scm':
    case 'terminal':
      // 属 plan7 批 B / 批 C —— 「＋」里留位置，但**明说是待做**，不摆假界面糊弄
      return (
        <div className="dock-placeholder">
          <div className="dock-ph-title">{type === 'scm' ? '源代码管理' : '终端'}</div>
          <div className="dock-ph-desc">
            {type === 'scm'
              ? '分支、改动状态与差异视图。与输入框的分支显示同源。'
              : '在当前工作区内运行命令，输出流式回显。'}
          </div>
          <div className="dock-ph-badge">{type === 'scm' ? '待做 · plan7 批 D' : '待做 · plan7 批 C'}</div>
        </div>
      )
  }
}

function tabBody(tab: PaneTab): JSX.Element {
  const c = tab.content
  if (c.kind === 'builtin') return builtinBody(c.type)
  // 文件页签：路径是**工作区相对路径**（与 ipc 的 readWorkspaceFile(rel) 同一口径）
  return <FilePreviewPane rel={c.path} mode={c.mode} />
}

/** 浏览器面板要贴边（原生视图铺满），其余面板留内边距 */
function isFlush(tab: PaneTab | undefined): boolean {
  return tab?.content.kind === 'builtin' && tab.content.type === 'browser'
}

export interface PaneProps {
  pane: PaneModel
  width: number
  /** 本栏下标（换位要用） */
  index: number
  /** 当前是否有别的栏正被拖到本栏上方（高亮落点） */
  dropOn: boolean
  onDragStart: (index: number, e: ReactDragEvent) => void
  onDragOver: (index: number, e: ReactDragEvent) => void
  onDrop: (index: number, e: ReactDragEvent) => void
  onDragEnd: () => void
}

export default function Pane({
  pane,
  width,
  index,
  dropOn,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: PaneProps): JSX.Element {
  const [menu, setMenu] = useState(false)
  /**
   * 页签右键菜单（plan9 形态修订）：**多栏的唯一入口**。
   *
   * 真机验收后定的：多窗格不再是默认形态（"不方便看"），
   * 改成"右键页签才出现"的扩展功能 —— 所以原来那条常驻的「＋ 新建一栏」随
   * 工作台标题栏一起去掉了，避免误开出一堆栏。
   */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const wbOpenTab = useAppStore((s) => s.wbOpenTab)
  const wbCloseTab = useAppStore((s) => s.wbCloseTab)
  const wbActivateTab = useAppStore((s) => s.wbActivateTab)
  const wbToggleCollapse = useAppStore((s) => s.wbToggleCollapse)
  const wbRemovePane = useAppStore((s) => s.wbRemovePane)
  const wbSplitRight = useAppStore((s) => s.wbSplitRight)

  // 点空白 / Esc 关掉右键菜单（与资源管理器右键菜单同一套习惯）
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTabMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEsc)
    }
  }, [tabMenu])

  const active = pane.tabs[Math.min(pane.active, pane.tabs.length - 1)]

  const pick = (t: BuiltinType): void => {
    setMenu(false)
    wbOpenTab(pane.id, { kind: 'builtin', type: t })
  }

  return (
    <section
      className={`pane ${pane.collapsed ? 'pane-fold' : ''} ${dropOn ? 'pane-drop' : ''}`}
      style={{ width }}
    >
      {pane.collapsed ? (
        <button
          className="pane-unfold"
          title="展开本栏（显示标题栏与页签条）"
          onClick={() => wbToggleCollapse(pane.id)}
        >
          ⌄
        </button>
      ) : (
        <>
          {/* 标题栏 = 拖拽换位的手柄（HTML5 DnD：落点可合成、验得了；
              而"拖页签条"会和栏内滚动打架，所以只拖标题栏） */}
          <div
            className="pane-head"
            draggable
            onDragStart={(e) => onDragStart(index, e)}
            onDragOver={(e) => onDragOver(index, e)}
            onDrop={(e) => onDrop(index, e)}
            onDragEnd={onDragEnd}
          >
            <span className="pane-title" title={`${pane.title}（拖动可换位）`}>
              {pane.title}
            </span>
            <button
              className="pane-btn"
              title="折叠本栏（内容占满，宽度不变）"
              onClick={() => wbToggleCollapse(pane.id)}
            >
              ⌃
            </button>
            <button className="pane-btn" title="关闭本栏" onClick={() => wbRemovePane(pane.id)}>
              ✕
            </button>
          </div>
          <div className="pane-tabs">
            {/* 页签放在**可滚动的内层**里，＋ 钉在外层 ——
                否则窄栏时页签条横向滚动会把 ＋ 一起滚走，用户再也点不到"在本栏开面板" */}
            <div className="pane-tabs-scroll">
              {pane.tabs.map((t, i) => (
                <span
                  key={t.id}
                  className={`pane-tab ${t === active ? 'on' : ''}`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTabMenu({ x: e.clientX, y: e.clientY, tabId: t.id })
                  }}
                >
                  <button
                    className="pane-tab-name"
                    title={t.title}
                    onClick={() => wbActivateTab(pane.id, i)}
                  >
                    {t.title}
                  </button>
                  <button className="pane-tab-x" title="关闭标签页" onClick={() => wbCloseTab(pane.id, t.id)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <button className="pane-add" title="在本栏打开面板" onClick={() => setMenu((v) => !v)}>
              ＋
            </button>
          </div>
        </>
      )}

      <div className={`dock-body ${isFlush(active) ? 'dock-body-flush' : ''}`}>
        {active ? (
          tabBody(active)
        ) : (
          // 本栏空着（关掉了最后一个页签）→ 就地给选择器，而不是把栏一起收掉
          <PaneChooser onPick={pick} />
        )}
      </div>

      {menu && (
        <div className="pane-menu">
          <PaneChooser onPick={pick} />
        </div>
      )}

      {tabMenu && (
        <div
          className="wb-menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          // 别让"点空白关闭"的 document 监听在 click 之前先把菜单关掉
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="wb-pick"
            onClick={() => {
              wbSplitRight(pane.id, tabMenu.tabId)
              setTabMenu(null)
            }}
          >
            在右侧分栏
          </button>
          <button
            className="wb-pick"
            onClick={() => {
              wbCloseTab(pane.id, tabMenu.tabId)
              setTabMenu(null)
            }}
          >
            关闭标签页
          </button>
        </div>
      )}
    </section>
  )
}
