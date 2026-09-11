import { useAppStore } from '../store'

// 顶栏（P2）：两个面板切换图标 + 当前位置标题。
// 图标语义（对齐用户给的参考图）：左图＝侧栏（会话记录/设置），右图＝工作台（资源管理器/终端/浏览器）。
// 有了它，两侧面板都可收可展，主区域永远保留给对话。

function SidebarIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6.8" y1="4" x2="6.8" y2="16" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function DockIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="13.2" y1="4" x2="13.2" y2="16" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export default function TopBar(): JSX.Element {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const dockOpen = useAppStore((s) => s.dockOpen)
  const toggleDock = useAppStore((s) => s.toggleDock)

  const title =
    view === 'settings'
      ? '设置'
      : view === 'new'
        ? '' // 新建任务页不显示标题（用户 2026-09-12：页面中间已有文案，顶栏再标一次是重复）
        : (conversations.find((c) => c.id === activeId)?.title ?? '会话')

  return (
    <header className="topbar">
      <button
        className={`panel-btn ${sidebarOpen ? 'on' : ''}`}
        title={sidebarOpen ? '收起侧栏' : '展开侧栏（会话记录 / 设置）'}
        onClick={toggleSidebar}
      >
        <SidebarIcon />
      </button>

      <span className="topbar-brand">九十里路</span>
      {/* 标题为空时连分隔符一起不渲染 —— 否则会留下一个孤零零的「·」 */}
      {title && (
        <>
          <span className="topbar-sep">·</span>
          <span className="topbar-title" title={title}>
            {title}
          </span>
        </>
      )}

      <button
        className={`panel-btn ${dockOpen ? 'on' : ''}`}
        title={dockOpen ? '收起工作台' : '展开工作台（资源管理器 / 终端 / 浏览器）'}
        onClick={toggleDock}
      >
        <DockIcon />
      </button>
    </header>
  )
}
