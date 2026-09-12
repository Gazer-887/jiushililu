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
    // plan11：订阅**原样收信封**，落点由 store 按 `conversationId` 分流 ——
    // 这一层不再"猜"事件属于哪条会话（以前默认就是当前显示的那条，于是切会话就串台）
    const offChunk = window.api.onChatChunk((e) => s().appendChunk(e))
    const offReasoning = window.api.onChatReasoning((e) => s().appendReasoning(e))
    const offDone = window.api.onChatDone((e) => s().markDone(e))
    const offError = window.api.onChatError((e) => s().markError(e))
    const offTool = window.api.onChatTool((e) => s().pushToolEvent(e))
    const offTodos = window.api.onTodoChanged((e) => s().setTodos(e))
    const offSubagents = window.api.onSubagentChanged((e) => s().setSubagents(e))
    // 补拉一次：这两份状态存在主进程，界面挂载时不该是空的
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
     * `await` 必须等落盘**全部结束**再回执，否则窗口先关、内容照样丢。
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
    void loadUIPrefs() // 抽屉宽度（plan7 批 A0）
  }, [loadSettings, loadConversations, loadUIPrefs])

  /** 松手时落盘（拖动过程中只改内存，不写盘） */
  const commit = (patch: Partial<UIPrefs>): void => {
    void persistUIPrefs(patch)
  }

  // 关窗口时**全部**会话落盘（plan11 P0-2）。
  //
  // 两条路都留：① 主进程的 flush 握手（可靠，但它等不到回执就 2 秒超时）；
  // ② `beforeunload` 这里再兜一次（握手超时/异常时的最后一道）。
  // 只留 ② 是不够的：`beforeunload` 里的异步 IPC **不保证发得出去**（进程即将销毁），
  // 那正是"关了窗口发现最后一段没了"的经典成因。
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
      {/* 危险操作确认（plan8 R5）：全局只挂一个，主进程推请求即弹出 */}
      <ConfirmDialog />
    </div>
  )
}
