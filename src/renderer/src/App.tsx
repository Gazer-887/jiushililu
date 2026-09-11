import { useEffect } from 'react'
import { useAppStore } from './store'
import Sidebar from './components/Sidebar'
import ChatView from './views/ChatView'
import NewTaskView from './views/NewTaskView'
import SettingsView from './views/SettingsView'

export default function App() {
  const view = useAppStore((s) => s.view)
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
      <Sidebar />
      <main className="content">
        {view === 'new' && <NewTaskView />}
        {view === 'chat' && <ChatView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
