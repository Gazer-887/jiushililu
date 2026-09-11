import { useAppStore, type DockTab } from '../store'
import BrowserPanel from './BrowserPanel'

// 右侧工作台（抽屉，P2）：六个面板都装在这里（D-034）。
// 已实现：浏览器（真浏览器，Agent 可操控）
// 待实现：资源管理器 / 文件变更记录 / 源代码管理 / 终端 / 任务管理
// 结构原则：主区域永远只负责"对话"，新增能力一律往两侧抽屉挂，不挤占对话空间。

const TABS: Array<{ id: DockTab; label: string; short: string }> = [
  { id: 'explorer', label: '资源管理器', short: '文件' },
  { id: 'changes', label: '文件变更记录', short: '变更' },
  { id: 'scm', label: '源代码管理', short: 'Git' },
  { id: 'terminal', label: '终端', short: '终端' },
  { id: 'browser', label: '浏览器', short: '网页' },
  { id: 'tasks', label: '任务管理', short: '任务' }
]

const PLACEHOLDER: Record<DockTab, { title: string; desc: string; dep: string }> = {
  explorer: {
    title: '资源管理器',
    desc: '工作区文件树，点击文件可打开编辑器与 Diff 审查。',
    dep: '依赖：文件系统桥'
  },
  changes: {
    title: '文件变更记录',
    desc: '本次会话改过哪些文件、每次改动的前后差异，支持回看与撤销。',
    dep: '依赖：工具写入留痕'
  },
  scm: {
    title: '源代码管理',
    desc: 'Git 分支、改动状态与差异视图（与输入框的分支显示同源）。',
    dep: '依赖：Git 工具层'
  },
  terminal: {
    title: '终端',
    desc: '在当前工作区内运行命令，输出流式回显。',
    dep: '依赖：命令执行桥'
  },
  browser: {
    title: '浏览器',
    desc: '真浏览器（支持 JS 渲染），Agent 可直接操控同一实例。',
    dep: '已实现'
  },
  tasks: {
    title: '任务管理',
    desc: '本轮 TODO 清单与子代理执行进度（谁在跑、跑了几轮、结果如何）。',
    dep: '依赖：任务模型'
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
              title={t.label}
              onClick={() => (dockTab === t.id && dockOpen ? toggleDock() : setDockTab(t.id))}
            >
              {t.short}
            </button>
          ))}
        </div>
        <button className="dock-close" title="收起工作台" onClick={toggleDock}>
          ✕
        </button>
      </div>

      <div className={`dock-body ${dockTab === 'browser' ? 'dock-body-flush' : ''}`}>
        {dockTab === 'browser' && dockOpen ? (
          <BrowserPanel />
        ) : (
          <div className="dock-placeholder">
            <div className="dock-ph-title">{info.title}</div>
            <div className="dock-ph-desc">{info.desc}</div>
            <div className="dock-ph-badge">{info.dep}</div>
          </div>
        )}
      </div>
    </aside>
  )
}
