import { create } from 'zustand'
import type { ChatMessage, ConversationCreateInput, ConversationMeta, SettingsView } from '@shared/ipc'
import type { ToolEvent } from '@shared/agent'
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

// 渲染进程状态：界面数据只放这里，真正的模型请求全部走 IPC 由主进程执行。

export type AppView = 'new' | 'chat' | 'settings'

/** 右侧工作台（抽屉）的页签——D-034 六项，面板实现按批次逐个填 */
export type DockTab = 'explorer' | 'changes' | 'scm' | 'terminal' | 'browser' | 'tasks'

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

  // ── 抽屉侧栏（面板显隐）───────────
  /** 左侧栏（会话记录 / 设置）是否展开 */
  sidebarOpen: boolean
  toggleSidebar: () => void
  /** 右侧工作台（资源管理器 / 终端 / 浏览器）是否展开 */
  dockOpen: boolean
  toggleDock: () => void
  dockTab: DockTab
  setDockTab: (tab: DockTab) => void

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
  clearToolEvents: () => void
  pushToolEvent: (evt: ToolEvent) => void
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
    try {
      const next = await window.api.resetUIPrefs()
      set({
        sidebarWidth: next.sidebarWidth,
        dockWidth: next.dockWidth,
        theme: sanitizeTheme(next.theme)
      })
    } catch {
      set({ sidebarWidth: SIDEBAR_DEFAULT, dockWidth: DOCK_DEFAULT, theme: 'classic' })
    }
  },
  loadUIPrefs: async () => {
    try {
      const prefs = await window.api.getUIPrefs()
      set({
        sidebarWidth: prefs.sidebarWidth,
        dockWidth: prefs.dockWidth,
        theme: sanitizeTheme(prefs.theme)
      })
      // 启动即应用主题（否则刷新/重开会闪回默认主题）
      document.documentElement.dataset.theme = sanitizeTheme(prefs.theme)
    } catch {
      // 保持默认值
    }
  },

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  dockOpen: false,
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  dockTab: 'explorer',
  setDockTab: (dockTab) => set({ dockTab, dockOpen: true }),

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
    set({ activeId: id, messages: conv.messages, view: 'chat', streamError: null, streaming: false, toolEvents: [] })
  },

  newSession: () =>
    set({ view: 'new', activeId: null, messages: [], streamError: null, toolEvents: [] }),

  createConversation: async (input) => {
    const conv = await window.api.createConversation(input)
    await get().loadConversations()
    set({ activeId: conv.id, messages: conv.messages, view: 'chat', streamError: null })
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

  clearToolEvents: () => set({ toolEvents: [] }),

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
      toolEvents: [] // 新一轮，清掉上一轮的工具活动
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
