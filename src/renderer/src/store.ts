import { create } from 'zustand'
import type { ChatMessage, ConversationCreateInput, ConversationMeta, SettingsView } from '@shared/ipc'
import { estimateMessageTokens } from '@shared/tokens'

// 渲染进程状态：界面数据只放这里，真正的模型请求全部走 IPC 由主进程执行。

export type AppView = 'new' | 'chat' | 'settings'

/** 右侧工作台（抽屉）的页签——P2 先立骨架，后续逐个填实现 */
export type DockTab = 'explorer' | 'terminal' | 'browser'

interface AppState {
  view: AppView
  setView: (view: AppView) => void

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
    if (conv.model !== get().settings?.model) {
      await window.api.setModel(conv.model)
      await get().loadSettings()
    }
    set({ activeId: id, messages: conv.messages, view: 'chat', streamError: null, streaming: false })
  },

  newSession: () => set({ view: 'new', activeId: null, messages: [], streamError: null }),

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
      streamError: null
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
