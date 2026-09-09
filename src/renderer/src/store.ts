import { create } from 'zustand'
import type { ChatMessage, SettingsView } from '@shared/ipc'

// 渲染进程状态：界面数据只放这里，真正的模型请求全部走 IPC 由主进程执行。

interface AppState {
  view: 'chat' | 'settings'
  setView: (view: 'chat' | 'settings') => void

  settings: SettingsView | null
  settingsLoaded: boolean
  loadSettings: () => Promise<void>

  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  appendChunk: (text: string) => void
  markDone: () => void
  markError: (message: string) => void
  sendMessage: (text: string) => Promise<void>
  stopStreaming: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  view: 'chat',
  setView: (view) => set({ view }),

  settings: null,
  settingsLoaded: false,
  loadSettings: async () => {
    const settings = await window.api.getSettings()
    set({ settings, settingsLoaded: true })
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

  markDone: () => set({ streaming: false }),

  markError: (message) => set({ streaming: false, streamError: message }),

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
  }
}))
