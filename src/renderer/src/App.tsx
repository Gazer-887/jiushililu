import { useEffect } from 'react'
import { useAppStore } from './store'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import RightDock from './components/RightDock'
import ConfirmDialog from './components/ConfirmDialog'
import ChatView from './views/ChatView'
import NewSessionView from './views/NewSessionView'
import SettingsView from './views/SettingsView'

// 三段式布局（P2）：顶栏（面板开关） + 左抽屉（会话/设置） + 主区域（对话） + 右抽屉（工作台）。
// 主区域永远只负责"对话"，新增能力一律往两侧抽屉挂。

export default function App() {
  const view = useAppStore((s) => s.view)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const loadConversations = useAppStore((s) => s.loadConversations)
  const persistActive = useAppStore((s) => s.persistActive)

  useEffect(() => {
    void loadSettings()
    void loadConversations()
  }, [loadSettings, loadConversations])

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
        <Sidebar open={sidebarOpen} />
        <main className="content">
          {view === 'new' && <NewSessionView />}
          {view === 'chat' && <ChatView />}
          {view === 'settings' && <SettingsView />}
        </main>
        <RightDock />
      </div>
      {/* 危险操作确认（plan8 R5）：全局只挂一个，主进程推请求即弹出 */}
      <ConfirmDialog />
    </div>
  )
}
