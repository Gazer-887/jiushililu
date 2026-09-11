import { useEffect } from 'react'
import { useAppStore } from './store'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import RightDock from './components/RightDock'
import ConfirmDialog from './components/ConfirmDialog'
import Splitter from './components/Splitter'
import {
  DOCK_MAX,
  DOCK_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  type UIPrefs
} from '@shared/splitter'
import ChatView from './views/ChatView'
import NewSessionView from './views/NewSessionView'
import SettingsView from './views/SettingsView'

// 三段式布局（P2）：顶栏（面板开关） + 左抽屉（会话/设置） + 主区域（对话） + 右抽屉（工作台）。
// 主区域永远只负责"对话"，新增能力一律往两侧抽屉挂。

export default function App() {
  const view = useAppStore((s) => s.view)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const dockOpen = useAppStore((s) => s.dockOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const dockWidth = useAppStore((s) => s.dockWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const setDockWidth = useAppStore((s) => s.setDockWidth)
  const persistUIPrefs = useAppStore((s) => s.persistUIPrefs)
  const resetUIPrefs = useAppStore((s) => s.resetUIPrefs)
  const loadUIPrefs = useAppStore((s) => s.loadUIPrefs)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const loadConversations = useAppStore((s) => s.loadConversations)
  const persistActive = useAppStore((s) => s.persistActive)

  useEffect(() => {
    void loadSettings()
    void loadConversations()
    void loadUIPrefs() // 抽屉宽度（plan7 批 A0）
  }, [loadSettings, loadConversations, loadUIPrefs])

  /** 松手时落盘（拖动过程中只改内存，不写盘） */
  const commit = (patch: Partial<UIPrefs>): void => {
    void persistUIPrefs(patch)
  }

  // 关窗前把当前会话落盘（防丢最后几轮）
  useEffect(() => {
    const onBeforeUnload = (): void => {
      void persistActive()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [persistActive])

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <Sidebar open={sidebarOpen} width={sidebarWidth} />
        {sidebarOpen && (
          <Splitter
            side="left"
            width={sidebarWidth}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            label="调整左侧栏宽度"
            onResize={setSidebarWidth}
            onCommit={commit}
            onReset={() => void resetUIPrefs()}
          />
        )}
        <main className="content">
          {view === 'new' && <NewSessionView />}
          {view === 'chat' && <ChatView />}
          {view === 'settings' && <SettingsView />}
        </main>
        {dockOpen && (
          <Splitter
            side="right"
            width={dockWidth}
            min={DOCK_MIN}
            max={DOCK_MAX}
            label="调整右侧工作台宽度"
            onResize={setDockWidth}
            onCommit={commit}
            onReset={() => void resetUIPrefs()}
          />
        )}
        <RightDock width={dockWidth} />
      </div>
      {/* 危险操作确认（plan8 R5）：全局只挂一个，主进程推请求即弹出 */}
      <ConfirmDialog />
    </div>
  )
}
