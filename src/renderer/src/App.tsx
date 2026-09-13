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

// 三段式布局（P2）：顶栏 + 左抽屉（会话/设置） + 主区域（对话） + 右抽屉（工作台）——
// 主区域只负责"对话"，新增能力一律往两侧抽屉挂。

/**
 * 流式订阅必须挂这一层、不许挂 `ChatView`：主区域是条件渲染，挂那儿 = 切到设置页就解绑 ——
 * ① 那期间吐出的字没人接，永远看不到；② 若流恰在那时跑完，`chat:done` 丢失 → `streaming` 停在 true，
 * 回到对话页后发送键一直是「停止」且**点它也没用**。订阅生命周期 = 应用生命周期，与看哪一页无关。
 */
function useStreamSubscriptions(): void {
  useEffect(() => {
    const s = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()
    // plan11：订阅**原样收信封**，落点由 store 按 `conversationId` 分流 ——
    // 不许在这一层"猜"事件属于哪条会话（以前默认当前显示那条，于是切会话就串台）
    const offChunk = window.api.onChatChunk((e) => s().appendChunk(e))
    const offReasoning = window.api.onChatReasoning((e) => s().appendReasoning(e))
    const offDone = window.api.onChatDone((e) => s().markDone(e))
    const offError = window.api.onChatError((e) => s().markError(e))
    const offTool = window.api.onChatTool((e) => s().pushToolEvent(e))
    const offTodos = window.api.onTodoChanged((e) => s().setTodos(e))
    const offSubagents = window.api.onSubagentChanged((e) => s().setSubagents(e))
    // 提问（带选项）：与流式同理挂在**这一层** —— 面板在条件渲染的 ChatView 里，订阅挂那儿就会在
    // 切到设置页期间把提问丢掉，而主进程不会重发（那条 Agent 只能白等到超时）
    const offAsk = window.api.onAskRequest((req) => s().pushAsk(req))
    // 补拉一次：todos/subagents 存在主进程，界面挂载时不该是空的
    const pull = (): void => {
      const activeId = s().activeId
      if (!activeId) return
      void window.api.getTodos(activeId).then((todos) => s().setTodos({ conversationId: activeId, payload: todos }))
      void window.api
        .getSubagents(activeId)
        .then((list) => s().setSubagents({ conversationId: activeId, payload: list }))
    }
    pull()

    /**
     * 关窗口前的落盘握手（plan11 P0-2）：主进程拦下关闭 → 请这里落盘 → 回执后才真关。
     * 必须等落盘**全部结束**再回执，否则窗口先关、内容照样丢。
     */
    const offFlush = window.api.onFlushRequest(() => {
      void s()
        .flushAll()
        .finally(() => void window.api.flushDone())
    })

    return () => {
      offChunk()
      offDone()
      offError()
      offTool()
      offTodos()
      offSubagents()
      offReasoning()
      offAsk()
      offFlush()
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
  const flushAll = useAppStore((s) => s.flushAll)

  useEffect(() => {
    void loadSettings()
    void loadConversations()
    void loadUIPrefs()
  }, [loadSettings, loadConversations, loadUIPrefs])

  /** 松手才落盘：拖动过程中只改内存，不写盘 */
  const commit = (patch: Partial<UIPrefs>): void => {
    void persistUIPrefs(patch)
  }

  // 关窗口时**全部**会话落盘（plan11 P0-2）。两条路都留：① 主进程的 flush 握手（可靠，但等不到回执即超时）；
  // ② `beforeunload` 这里再兜一次。只留 ② 是不够的 —— `beforeunload` 里的异步 IPC **不保证发得出去**
  // （进程即将销毁），那正是"关了窗口发现最后一段没了"的经典成因。
  useEffect(() => {
    const onBeforeUnload = (): void => {
      void flushAll()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushAll])

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
      {/* 危险操作确认（plan8 R5）：全局只挂一个 —— 主进程推请求即弹出 */}
      <ConfirmDialog />
    </div>
  )
}
