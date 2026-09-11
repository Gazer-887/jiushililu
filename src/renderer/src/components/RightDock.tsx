import { useAppStore, type DockTab } from '../store'

// 右侧工作台（抽屉，P2 骨架）：资源管理器 / 终端 / 内置浏览器都装在这里。
// 本轮先把抽屉结构、页签切换、显隐控制做扎实——具体面板在后续批次逐个填实现。
// 设计意图：主区域永远只负责"对话"，新增能力一律往两侧抽屉挂，不挤占对话空间。

const TABS: Array<{ id: DockTab; label: string }> = [
  { id: 'explorer', label: '资源管理器' },
  { id: 'terminal', label: '终端' },
  { id: 'browser', label: '浏览器' }
]

const PLACEHOLDER: Record<DockTab, { title: string; desc: string }> = {
  explorer: {
    title: '资源管理器',
    desc: '将在此显示工作区的文件树，点击文件可打开编辑器与 Diff 审查。'
  },
  terminal: {
    title: '终端',
    desc: '将在此运行命令（cwd 锁定当前工作区），输出流式回显。'
  },
  browser: {
    title: '浏览器',
    desc: '将在此内置网页视图，供 Agent 抓取结果与页面预览使用。'
  }
}

export default function RightDock(): JSX.Element {
  const dockOpen = useAppStore((s) => s.dockOpen)
  const dockTab = useAppStore((s) => s.dockTab)
  const setDockTab = useAppStore((s) => s.setDockTab)
  const toggleDock = useAppStore((s) => s.toggleDock)

  const info = PLACEHOLDER[dockTab]

  return (
    <aside className={`dock ${dockOpen ? 'open' : ''}`}>
      <div className="dock-head">
        <div className="dock-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`dock-tab ${dockTab === t.id && dockOpen ? 'active' : ''}`}
              onClick={() => (dockTab === t.id && dockOpen ? toggleDock() : setDockTab(t.id))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="dock-close" title="收起工作台" onClick={toggleDock}>
          ✕
        </button>
      </div>

      <div className="dock-body">
        <div className="dock-placeholder">
          <div className="dock-ph-title">{info.title}</div>
          <div className="dock-ph-desc">{info.desc}</div>
          <div className="dock-ph-badge">待做 · 后续批次</div>
        </div>
      </div>
    </aside>
  )
}
