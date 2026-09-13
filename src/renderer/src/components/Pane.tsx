import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react'
import type { BuiltinType, FileMode, Pane as PaneModel, PaneTab } from '@shared/workbench'
import { useAppStore } from '../store'
import BrowserPanel from './BrowserPanel'
import ChangesPanel from './ChangesPanel'
import ExplorerPanel from './ExplorerPanel'
import FilePreviewPane from './FilePreviewPane'
import PaneChooser from './PaneChooser'
import TasksPanel from './TasksPanel'
import TerminalPanel from './TerminalPanel'

// 工作台的一栏（plan9 W3）：标题栏 + 栏内页签条 + 内容。
//
// ⚠️ ① **切换页签 = 卸载**，不许用 display:none 保活：`BrowserPanel` 只在**卸载时**才调
//    `setBrowserVisible(false)` 摘掉主进程的原生视图；保活会让 getBoundingClientRect() 归零
//    却不摘视图 → 原生 WebContentsView 留在窗口上遮挡界面。草稿存在 tab 模型的 `content` 里，不靠组件保活。
// ② **折叠 = 隐藏标题栏与页签条、内容占满，宽度不变**（照抄参照实现的语义），不是"收成一条窄条"。

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
    case 'terminal':
      // 真 PTY 终端：会话活在主进程，这个组件是可丢弃的视图（plan7 批 C）
      return <TerminalPanel />
    case 'scm':
      // 「＋」里留位置但**明说是待做**，不摆假界面糊弄（plan7 批 D）
      return (
        <div className="dock-placeholder">
          <div className="dock-ph-title">源代码管理</div>
          <div className="dock-ph-badge">尚未实现</div>
        </div>
      )
  }
}

function tabBody(
  tab: PaneTab,
  fileProps: {
    onModeChange: (mode: FileMode) => void
    onDirtyChange: (dirty: string | undefined) => void
  }
): JSX.Element {
  const c = tab.content
  if (c.kind === 'builtin') return builtinBody(c.type)
  // 路径是**工作区相对路径**（与 ipc 的 readWorkspaceFile(rel) 同一口径）
  return (
    <FilePreviewPane
      rel={c.path}
      mode={c.mode}
      {...(c.dirty !== undefined ? { dirty: c.dirty } : {})}
      onModeChange={fileProps.onModeChange}
      onDirtyChange={fileProps.onDirtyChange}
    />
  )
}

/** 浏览器面板要贴边（原生视图铺满），其余面板留内边距 */
function isFlush(tab: PaneTab | undefined): boolean {
  return tab?.content.kind === 'builtin' && tab.content.type === 'browser'
}

export interface PaneProps {
  pane: PaneModel
  width: number
  index: number
  /** 有别的栏正被拖到本栏上方（高亮落点） */
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
   * 页签右键菜单（plan9 形态修订）：**多栏的唯一入口** —— 多窗格不是默认形态（"不方便看"），
   * 常驻的「＋ 新建一栏」已随工作台标题栏去掉，避免误开出一堆栏。
   */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const wbOpenTab = useAppStore((s) => s.wbOpenTab)
  const wbCloseTab = useAppStore((s) => s.wbCloseTab)
  const wbActivateTab = useAppStore((s) => s.wbActivateTab)
  const wbToggleCollapse = useAppStore((s) => s.wbToggleCollapse)
  const wbRemovePane = useAppStore((s) => s.wbRemovePane)
  const wbSplitRight = useAppStore((s) => s.wbSplitRight)
  const wbSetFileMode = useAppStore((s) => s.wbSetFileMode)
  const wbSetFileDirty = useAppStore((s) => s.wbSetFileDirty)

  /**
   * 有没保存的草稿时**不许静默丢**（plan7 批 A3 边界①）：拦的不是"关不掉"，是"关之前问一句"。
   */
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const requestClose = (tabId: string): void => {
    const t = pane.tabs.find((x) => x.id === tabId)
    if (t?.content.kind === 'file' && t.content.dirty !== undefined) {
      setPendingClose(tabId)
      return
    }
    wbCloseTab(pane.id, tabId)
  }

  // 点空白 / Esc 关菜单（与资源管理器右键菜单同一套习惯）
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
          title="展开本栏"
          onClick={() => wbToggleCollapse(pane.id)}
        >
          ⌄
        </button>
      ) : (
        <>
          {/* 标题栏 = 拖拽换位手柄（HTML5 DnD 落点可合成、验得了）；不拖页签条 —— 它会和栏内滚动打架 */}
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
              title="折叠本栏"
              onClick={() => wbToggleCollapse(pane.id)}
            >
              ⌃
            </button>
            <button className="pane-btn" title="关闭本栏" onClick={() => wbRemovePane(pane.id)}>
              ✕
            </button>
          </div>
          <div className="pane-tabs">
            {/* 页签在**可滚动的内层**，＋ 钉在外层 —— 否则窄栏滚动会把 ＋ 一起滚走，点不到"在本栏开面板" */}
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
                  {/* 脏标记要在**页签上可见** —— 否则开着好几个页签时不知道脏的是哪个 */}
                  {t.content.kind === 'file' && t.content.dirty !== undefined && (
                    <span className="pane-tab-dirty" title="有未保存的修改">
                      ●
                    </span>
                  )}
                  <button className="pane-tab-x" title="关闭标签页" onClick={() => requestClose(t.id)}>
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

      {/* 有草稿时在这儿问一句，而不是静默丢掉 */}
      {pendingClose && (
        <div className="pane-guard">
          <span className="pg-text">该文件有未保存的修改</span>
          <button className="pg-btn" onClick={() => setPendingClose(null)}>
            取消
          </button>
          <button
            className="pg-btn"
            onClick={() => {
              wbSetFileDirty(pane.id, pendingClose, undefined) // 先清草稿，免得它跟着页签留在盘上
              wbCloseTab(pane.id, pendingClose)
              setPendingClose(null)
            }}
          >
            放弃修改并关闭
          </button>
        </div>
      )}

      <div className={`dock-body ${isFlush(active) ? 'dock-body-flush' : ''}`}>
        {active ? (
          tabBody(active, {
            onModeChange: (m) => wbSetFileMode(pane.id, active.id, m),
            onDirtyChange: (d) => wbSetFileDirty(pane.id, active.id, d)
          })
        ) : (
          // 关掉最后一个页签 → 就地给选择器，不把栏一起收掉
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
          // 别让"点空白关闭"的 document 监听抢在 click 之前把菜单关掉
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
