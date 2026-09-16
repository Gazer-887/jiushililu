import { memo, useEffect, useState, type DragEvent as ReactDragEvent } from 'react'
import type { BuiltinType, FileMode, Pane as PaneModel, PaneTab } from '@shared/workbench'
import { useAppStore } from '../store'
import BrowserPanel from './BrowserPanel'
import ChangesPanel from './ChangesPanel'
import ExplorerPanel from './ExplorerPanel'
import FilePreviewPane from './FilePreviewPane'
import MemoryManager from './MemoryManager'
import PlaybookManager from './PlaybookManager'
import PaneChooser from './PaneChooser'
import ScmPanel from './ScmPanel'
import TasksPanel from './TasksPanel'
import TerminalPanel from './TerminalPanel'
import TimelinePanel from './TimelinePanel'

// 内置面板全部**无 props**（数据自己订阅 store）→ memo 后父级（Pane）任意重渲染都到不了它们，
// 各面板只在自己的订阅切片变化时才渲染（plan30：Pane 因拖拽/折叠/页签条等本地面部状态频繁重渲染）。
// 保活（注释①）之后 Pane 重渲染也不再卸载面板，memo 让"常驻"进一步等于"常静"。
const MemoBrowser = memo(BrowserPanel)
const MemoChanges = memo(ChangesPanel)
const MemoExplorer = memo(ExplorerPanel)
const MemoMemory = memo(MemoryManager)
const MemoPlaybook = memo(PlaybookManager)
const MemoScm = memo(ScmPanel)
const MemoTasks = memo(TasksPanel)
const MemoTerminal = memo(TerminalPanel)
const MemoTimeline = memo(TimelinePanel)

// 工作台的一栏（plan9 W3）：标题栏 + 栏内页签条 + 内容。
//
// ⚠️ ① **页签保活（plan30）**：失活页签**隐藏不卸载**（xterm/Monaco 重建一次几十上百 ms，
//    plan29 S4 量测定案渲染层占切换卡顿 97%）。**唯一例外是 browser 页签**：`BrowserPanel`
//    只在**卸载时**才调 `setBrowserVisible(false)` 摘掉主进程的原生视图；保活会让
//    getBoundingClientRect() 归零却不摘视图 → 原生 WebContentsView 留在窗口上遮挡界面
//    （plan9 的血泪，见 git 历史）。故 browser 页签失活即卸载，其余页签常驻。
//    隐藏期 ResizeObserver 报 0 尺寸、重新显示时再触发 → xterm fit / monaco layout 自愈。
// ② **折叠 = 隐藏标题栏与页签条、内容占满，宽度不变**（照抄参照实现的语义），不是"收成一条窄条"。

function builtinBody(type: BuiltinType): JSX.Element {
  switch (type) {
    case 'explorer':
      return <MemoExplorer />
    case 'changes':
      return <MemoChanges />
    case 'browser':
      return <MemoBrowser />
    case 'tasks':
      return <MemoTasks />
    case 'terminal':
      // 真 PTY 终端：会话活在主进程，这个组件是可丢弃的视图（plan7 批 C）
      return <MemoTerminal />
    case 'scm':
      // 源代码管理（plan16）：变更列表 → 勾选暂存 → 写消息 → 提交
      return <MemoScm />
    case 'memory':
      // 记忆（plan19 批 1）：查看 / 编辑 / 删除 + 「本次新增」巡检区。落在这里而不是设置页 ——
      // 巡检是**高频**动作，放独立窗口等于把兜底做成装饰（plan19 §十）
      return <MemoMemory />
    case 'playbook':
      // Playbook（plan19 批 3）：会做线 —— 同类任务的经验手册。同样落右抽屉（复用上面的理由）
      return <MemoPlaybook />
    case 'timeline':
      // 时间线（plan26 S2）：执行事件流回放 —— 工具/审批/裁剪的**结构化痕迹**
      // （比对话流里的工具卡片多一层：跨轮次、按时间排、可跨会话过滤）
      return <MemoTimeline />
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
          // 保活渲染（plan30，注释①）：每个页签常驻，失活只隐藏；browser 页签例外（失活即卸载）
          // ⚠️ 激活页签的包装层必须 `display: contents`（plan30 第二批返工）：包装 div 若参与布局，
          //    会把 .dock-body（高度 definite）和 .fp（height:100%）之间的高度链打断 ——
          //    docx 预览"卡在旧窗口大小"就是这么来的（0.13.50 用户实测，与 2026-09-15 的塌高同型）。
          //    contents = 包装层不生成盒子，子元素布局与"直接是 .dock-body 子级"完全等价；
          //    失活页签照常 display:none（hidden 属性）。
          pane.tabs.map((t) => {
            const isActive = t === active
            // fileProps 按**各自页签**闭包 —— 保活后失活页签如果共用 active.id 的闭包，会拿到错的回调
            const props = {
              onModeChange: (m: FileMode) => wbSetFileMode(pane.id, t.id, m),
              onDirtyChange: (d: string | undefined) => wbSetFileDirty(pane.id, t.id, d)
            }
            if (t.content.kind === 'builtin' && t.content.type === 'browser') {
              return isActive ? (
                <div key={t.id} data-active="1" style={{ display: 'contents' }}>
                  {tabBody(t, props)}
                </div>
              ) : null
            }
            return (
              <div
                key={t.id}
                hidden={!isActive}
                aria-hidden={!isActive}
                // 保活后失活页签只是隐藏不卸载 —— 门禁探针必须限定在激活页签内查
                // （data-active 是探针的稳定契约，verify-shot activeTabRoot 依赖它，改名要同步）
                data-active={isActive ? '1' : undefined}
                style={isActive ? { display: 'contents' } : undefined}
              >
                {tabBody(t, props)}
              </div>
            )
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
