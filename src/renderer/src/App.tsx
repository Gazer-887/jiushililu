import { useEffect } from 'react'
import { useAppStore } from './store'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import Workbench from './components/Workbench'
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

/**
 * **流式订阅挂在这一层，不挂在 ChatView 里**（2026-09-12 修）。
 *
 * 原来它挂在 `ChatView` 的 effect 上，而 `App` rendering 主区域用的是**条件渲染**
 * （`view === 'chat' && <ChatView />`）—— 于是**切到设置页就等于把订阅全解绑**
 *（`ChatView.tsx` 原 79-99 行）。后果有两条，第二条是会卡死人的：
 *
 *   ① 在设置页期间流式吐出来的字**永远看不到**（没人接）；
 *   ② 如果流在那一刻**跑完**了，`chat:done` 就丢了 → `streaming` 永远停在 true
 *      → 回到对话页之后发送键一直是「停止」，**点它也没用**（`stopStreaming` 当时也不清这个标志）。
 *
 * 挂在 App 上之后，订阅的生命周期 = 应用的生命周期，与"正在看哪一页"无关 ——
 * 这也正是流式事件本该有的归属：**它属于这个窗口，不属于某个视图**。
 * （plan11「多会话并发」还要在后面给它加上"按会话分流"，那一步只改这里的落点。）
 */
function useStreamSubscriptions(): void {
  useEffect(() => {
    const s = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()
    const offChunk = window.api.onChatChunk((t) => s().appendChunk(t))
    const offReasoning = window.api.onChatReasoning((d) => s().appendReasoning(d))
    const offDone = window.api.onChatDone(() => s().markDone())
    const offError = window.api.onChatError((m) => s().markError(m))
    const offTool = window.api.onChatTool((evt) => s().pushToolEvent(evt))
    const offTodos = window.api.onTodoChanged((todos) => s().setTodos(todos))
    // 补拉一次：待办清单存在主进程，界面挂载时不该是空的
    void window.api.getTodos().then((todos) => s().setTodos(todos))
    return () => {
      offChunk()
      offDone()
      offError()
      offTool()
      offTodos()
      offReasoning()
    }
  }, [])
}

export default function App() {
  useStreamSubscriptions()
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
        <Workbench />
      </div>
      {/* 危险操作确认（plan8 R5）：全局只挂一个，主进程推请求即弹出 */}
      <ConfirmDialog />
    </div>
  )
}
