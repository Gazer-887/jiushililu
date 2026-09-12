import { create } from 'zustand'
import type { ChatMessage, ConversationCreateInput, ConversationMeta, SettingsView } from '@shared/ipc'
import type { SubagentJobEvent, ToolEvent } from '@shared/agent'
import type { BackgroundTask } from '@shared/background'
import type { TodoItem } from '@shared/todo'
import { estimateMessageTokens } from '@shared/tokens'
import {
  DOCK_DEFAULT,
  DOCK_MAX,
  DOCK_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampWidth,
  sanitizeTheme,
  type ThemeName,
  type UIPrefs
} from '@shared/splitter'
import {
  activateTab,
  addPane,
  closeTab,
  emptyLayout,
  emptySizes,
  normalizeSizes,
  openTab,
  removePane,
  toggleCollapse,
  type PaneContent,
  type WorkbenchLayout,
  type WorkbenchSizes
} from '@shared/workbench'

// 渲染进程状态：界面数据只放这里，真正的模型请求全部走 IPC 由主进程执行。

export type AppView = 'new' | 'chat' | 'settings'

/**
 * 工作台落盘的**合并窗口**（plan9 §W5 提交点表）：切页签、拖宽这类高频动作
 * 只在停下来之后写一次盘 —— 参照实现每帧同步写盘，是它自己被标注的卡顿源。
 */
const WB_PERSIST_DEBOUNCE_MS = 300
let wbPersistTimer: ReturnType<typeof setTimeout> | null = null

interface AppState {
  view: AppView
  setView: (view: AppView) => void

  // ── 抽屉宽度（plan7 批 A0，可拖拽 + 持久化）───────────
  sidebarWidth: number
  dockWidth: number
  /** 主题（plan7：设置里可切换；切换即写 html[data-theme]，持久化到 ui-prefs） */
  theme: ThemeName
  setTheme: (t: ThemeName) => void
  /** 拖动过程中实时改（不落盘） */
  setSidebarWidth: (w: number) => void
  setDockWidth: (w: number) => void
  /** 松手 / 复位时落盘 */
  persistUIPrefs: (patch: Partial<UIPrefs>) => Promise<void>
  resetUIPrefs: () => Promise<void>
  loadUIPrefs: () => Promise<void>

  // ── 工作台分栏布局（plan9 W2）───────────
  /**
   * 分栏布局。**渲染端是唯一写入源。**
   *
   * ⚠️ 落盘回显**不允许覆盖它** —— 主进程返回的是盘上那份（可能比内存旧），
   * 拿它 set 回去会把界面上"刚开的栏"打回原状。这条是两份独立审查都点到的真问题，
   * 所以下面的 persistUIPrefs 只回显宽度与主题，**故意不回显 workbench**。
   */
  workbench: WorkbenchLayout
  workbenchSizes: WorkbenchSizes
  /** 只改内存（拖拽中 / 连续操作时调），不落盘 */
  setWorkbench: (layout: WorkbenchLayout, sizes?: WorkbenchSizes) => void
  /** 显式落盘（**结构变更**走这条：开栏/关栏/换位/开页签/关页签/折叠） */
  persistWorkbench: () => Promise<void>
  /** 合并落盘（**高频动作**走这条：切页签、拖宽 —— 见 plan9 §W5 提交点表） */
  persistWorkbenchSoon: () => void

  // ── 工作台结构操作（plan9 W3）──
  // 全部只是"纯函数 + 内存 + 落盘"的胶水；模型运算一律在 src/shared/workbench.ts
  wbOpenTab: (paneId: string | null, content: PaneContent) => void
  wbCloseTab: (paneId: string, tabId: string) => void
  wbActivateTab: (paneId: string, index: number) => void
  wbAddPane: () => void
  wbRemovePane: (paneId: string) => void
  wbToggleCollapse: (paneId: string) => void

  // ── 抽屉侧栏（面板显隐）───────────
  /** 左侧栏（会话记录 / 设置）是否展开 */
  sidebarOpen: boolean
  toggleSidebar: () => void
  /** 右侧工作台是否展开（plan9 W3 起：展开后显示的是**多栏**工作台） */
  dockOpen: boolean
  toggleDock: () => void

  settings: SettingsView | null
  settingsLoaded: boolean
  loadSettings: () => Promise<void>

  // ── 会话（侧边栏）───────────────
  conversations: ConversationMeta[]
  activeId: string | null
  /** 当前生效的工作区路径（供分支显示等零件感知切换） */
  workspacePath: string
  setWorkspacePath: (path: string) => void
  loadConversations: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  newSession: () => void
  createConversation: (input: ConversationCreateInput) => Promise<string>
  renameConversation: (id: string, title: string) => Promise<void>
  removeConversation: (id: string) => Promise<void>
  /** 把当前消息体落盘（发送完成 / 流结束 / 切走时调用） */
  persistActive: () => Promise<void>

  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  /** 工具执行活动（D-032：界面显示"正在读 xx / 完成 / 失败"）——仅当前轮 */
  toolEvents: ToolEvent[]
  /**
   * 思考流（DeepSeek 系 `reasoning_content`）—— 与正文**分开**存：
   * 它是过程不是回答，用户要看得到"它在想什么"，但不该混进消息内容里。
   * 新一轮开始时清空（见 sendMessage）。
   */
  reasoning: string
  appendReasoning: (delta: string) => void
  clearToolEvents: () => void
  pushToolEvent: (evt: ToolEvent) => void
  /** 待办清单（plan7 批 D）：Agent 用 update_todos 维护，界面显示在输入框上方 */
  todos: TodoItem[]
  setTodos: (todos: TodoItem[]) => void
  /** 最近一批子代理运行事件（plan7 批 D：右栏「任务」页签） */
  subagents: SubagentJobEvent[]
  setSubagents: (list: SubagentJobEvent[]) => void
  /** 后台任务（plan7 批 D）：右栏「任务」页签的"后台任务"区 */
  backgroundTasks: BackgroundTask[]
  setBackgroundTasks: (list: BackgroundTask[]) => void
  appendChunk: (text: string) => void
  markDone: () => void
  markError: (message: string) => void
  sendMessage: (text: string) => Promise<void>
  stopStreaming: () => Promise<void>
}

/** 当前上下文用量估算（口径与主进程一致，见 @shared/tokens） */
export function usedTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m.content), 0)
}

export const useAppStore = create<AppState>((set, get) => ({
  view: 'new',
  setView: (view) => set({ view }),

  // ── 抽屉宽度 + 主题（plan7 批 A0 / 外观自定义）──
  sidebarWidth: SIDEBAR_DEFAULT,
  dockWidth: DOCK_DEFAULT,
  theme: 'classic',
  setTheme: (t) => {
    const theme = sanitizeTheme(t)
    set({ theme })
    // 切换即时生效：写根元素的 data-theme（CSS 侧由 html[data-theme='ink'] 覆盖变量）
    document.documentElement.dataset.theme = theme
    void useAppStore.getState().persistUIPrefs({ theme })
  },
  setSidebarWidth: (w) => set({ sidebarWidth: clampWidth(w, SIDEBAR_MIN, SIDEBAR_MAX) }),
  setDockWidth: (w) => set({ dockWidth: clampWidth(w, DOCK_MIN, DOCK_MAX) }),
  persistUIPrefs: async (patch) => {
    // 落盘失败不影响界面（宽度已经改了，只是下次重开回到默认）
    try {
      const next = await window.api.setUIPrefs(patch)
      // theme 走 sanitizeTheme 保底：主进程万一返回缺 theme 的数据，
      // 不能让 UI 进入「两个主题都没选中」的死角（真实渲染验证抓到过）
      //
      // ⚠️ 这里**故意不回显 workbench / workbenchSizes**：主进程返回的是盘上那份，
      //    可能比内存旧；回显会把「刚开的栏」打回原状（plan9 §W2 明写的规则）。
      set({
        sidebarWidth: next.sidebarWidth,
        dockWidth: next.dockWidth,
        theme: sanitizeTheme(next.theme)
      })
    } catch {
      // 忽略：布局偏好不是关键数据
    }
  },
  resetUIPrefs: async () => {
    // 「恢复默认布局」—— 布局**要**跟着复位，否则这个按钮对工作台是空操作
    try {
      const next = await window.api.resetUIPrefs()
      set({
        sidebarWidth: next.sidebarWidth,
        dockWidth: next.dockWidth,
        theme: sanitizeTheme(next.theme),
        workbench: next.workbench,
        workbenchSizes: next.workbenchSizes
      })
    } catch {
      set({
        sidebarWidth: SIDEBAR_DEFAULT,
        dockWidth: DOCK_DEFAULT,
        theme: 'classic',
        workbench: emptyLayout(),
        workbenchSizes: emptySizes()
      })
    }
  },
  loadUIPrefs: async () => {
    try {
      const prefs = await window.api.getUIPrefs()
      set({
        sidebarWidth: prefs.sidebarWidth,
        dockWidth: prefs.dockWidth,
        theme: sanitizeTheme(prefs.theme),
        workbench: prefs.workbench,
        workbenchSizes: prefs.workbenchSizes
      })
      // 启动即应用主题（否则刷新/重开会闪回默认主题）
      document.documentElement.dataset.theme = sanitizeTheme(prefs.theme)
    } catch {
      // 保持默认值
    }
  },

  workbench: emptyLayout(),
  workbenchSizes: emptySizes(),
  setWorkbench: (layout, sizes) =>
    set((s) => ({
      workbench: layout,
      // 栏数变了就顺手把栏宽数组对齐 —— 长度恒等于 panes−1 是这条数据的不变量，
      // 交给调用方每次记得对齐太容易漏（漏了下一次读盘就会整组回默认）
      workbenchSizes: sizes ?? normalizeSizes(s.workbenchSizes, layout.panes.length)
    })),
  persistWorkbench: async () => {
    const { workbench, workbenchSizes } = get()
    await useAppStore.getState().persistUIPrefs({ workbench, workbenchSizes })
  },
  persistWorkbenchSoon: () => {
    if (wbPersistTimer !== null) clearTimeout(wbPersistTimer)
    wbPersistTimer = setTimeout(() => {
      wbPersistTimer = null
      void useAppStore.getState().persistWorkbench()
    }, WB_PERSIST_DEBOUNCE_MS)
  },

  wbOpenTab: (paneId, content) => {
    // 点了面板就必须看得见 —— 否则是"点了没反应"（默认布局是空的）
    set({ dockOpen: true })
    get().setWorkbench(openTab(get().workbench, paneId, content))
    void get().persistWorkbench()
  },
  wbCloseTab: (paneId, tabId) => {
    get().setWorkbench(closeTab(get().workbench, paneId, tabId))
    void get().persistWorkbench()
  },
  wbActivateTab: (paneId, index) => {
    get().setWorkbench(activateTab(get().workbench, paneId, index))
    get().persistWorkbenchSoon() // 切页签是高频动作 → 合并落盘
  },
  wbAddPane: () => {
    set({ dockOpen: true })
    get().setWorkbench(addPane(get().workbench, null))
    void get().persistWorkbench()
  },
  wbRemovePane: (paneId) => {
    get().setWorkbench(removePane(get().workbench, paneId))
    void get().persistWorkbench()
  },
  wbToggleCollapse: (paneId) => {
    get().setWorkbench(toggleCollapse(get().workbench, paneId))
    void get().persistWorkbench()
  },

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  dockOpen: false,
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),

  settings: null,
  settingsLoaded: false,
  loadSettings: async () => {
    const settings = await window.api.getSettings()
    set({ settings, settingsLoaded: true })
  },

  conversations: [],
  activeId: null,
  workspacePath: '',
  setWorkspacePath: (workspacePath) => set({ workspacePath }),

  loadConversations: async () => {
    const conversations = await window.api.listConversations()
    set({ conversations })
  },

  openConversation: async (id) => {
    await get().persistActive() // 切走前先把当前会话存好
    const conv = await window.api.getConversation(id)
    if (!conv) {
      await get().loadConversations()
      return
    }
    // 会话绑定的工作区若与当前不同，一并切过去（历史按工作区分组的自然结果）
    await window.api.setKnownWorkspace(conv.workspace)
    set({ workspacePath: conv.workspace })
    if (conv.model !== get().settings?.model) {
      await window.api.setModel(conv.model)
      await get().loadSettings()
    }
    set({
      activeId: id,
      messages: conv.messages,
      view: 'chat',
      streamError: null,
      streaming: false,
      toolEvents: [],
      // 思考流也要清：它是**当前轮**的过程，切会话还留着就成了"上一个任务的幽灵"
      reasoning: ''
    })
  },

  newSession: () =>
    set({
      view: 'new',
      activeId: null,
      messages: [],
      streamError: null,
      toolEvents: [],
      reasoning: ''
    }),

  createConversation: async (input) => {
    const conv = await window.api.createConversation(input)
    await get().loadConversations()
    // **这一处原本漏了**：新建任务不清过程状态 → 上一轮的工具卡片与思考残留在新会话里，
    // 把界面占满、报告反倒看不见（用户实测反馈的真凶）
    set({
      activeId: conv.id,
      messages: conv.messages,
      view: 'chat',
      streamError: null,
      toolEvents: [],
      reasoning: ''
    })
    return conv.id
  },

  renameConversation: async (id, title) => {
    await window.api.renameConversation(id, title)
    await get().loadConversations()
  },

  removeConversation: async (id) => {
    await window.api.deleteConversation(id)
    if (get().activeId === id) {
      set({ activeId: null, messages: [], view: 'new' })
    }
    await get().loadConversations()
  },

  persistActive: async () => {
    const { activeId, messages, conversations } = get()
    if (!activeId || messages.length === 0) return
    const updated = await window.api.saveConversation(activeId, messages)
    if (updated) {
      // 就地更新列表项（避免整表重拉），标题可能已被自动补上
      const next = conversations.map((c) => (c.id === activeId ? updated : c))
      if (!next.some((c) => c.id === activeId)) next.push(updated)
      set({ conversations: next })
    }
  },

  messages: [],
  streaming: false,
  streamError: null,
  toolEvents: [],
  todos: [],
  subagents: [],
  backgroundTasks: [],
  reasoning: '',

  clearToolEvents: () => set({ toolEvents: [] }),

  appendReasoning: (delta) => set((s) => ({ reasoning: s.reasoning + delta })),

  setTodos: (todos) => set({ todos }),

  setSubagents: (list) => set({ subagents: list }),

  setBackgroundTasks: (list) => set({ backgroundTasks: list }),

  pushToolEvent: (evt) =>
    set((s) => {
      // 同一调用（id）的 start→end 就地更新，避免堆两条
      const idx = s.toolEvents.findIndex((e) => e.id === evt.id)
      if (idx >= 0) {
        const next = s.toolEvents.slice()
        next[idx] = evt
        return { toolEvents: next }
      }
      return { toolEvents: [...s.toolEvents, evt] }
    }),

  appendChunk: (text) =>
    set((s) => {
      const messages = s.messages.slice()
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: last.content + text }
      }
      return { messages }
    }),

  markDone: () => {
    set({ streaming: false })
    void get().persistActive()
  },

  markError: (message) => {
    set({ streaming: false, streamError: message })
    void get().persistActive()
  },

  sendMessage: async (text) => {
    const content = text.trim()
    if (!content || get().streaming) return
    const history = get().messages.filter((m) => m.content.trim().length > 0)
    const payload = [...history, { role: 'user' as const, content }]
    set({
      messages: [...payload, { role: 'assistant', content: '' }],
      streaming: true,
      streamError: null,
      toolEvents: [], // 新一轮，清掉上一轮的工具活动
      reasoning: '' // 思考流同样新一轮重来
    })
    try {
      await window.api.chatSend(payload)
    } catch {
      // 主进程入参校验失败等；常规错误已通过 chatError 事件送达
      get().markError('发送失败：请求被主进程拒绝（参数校验未通过）')
    }
  },

  stopStreaming: async () => {
    await window.api.chatAbort()
    await get().persistActive()
  }
}))
