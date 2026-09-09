import { useAppStore } from './store'
import ChatView from './views/ChatView'
import SettingsView from './views/SettingsView'

export default function App() {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">九十里路</div>
          <div className="brand-sub">Jiushililu · P0 骨架</div>
        </div>
        <nav>
          <button
            className={view === 'chat' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('chat')}
          >
            对话
          </button>
          <button
            className={view === 'settings' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('settings')}
          >
            设置
          </button>
        </nav>
        <div className="sidebar-foot">会自己长经验的工作台</div>
      </aside>
      <main className="content">{view === 'chat' ? <ChatView /> : <SettingsView />}</main>
    </div>
  )
}
