import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AgentRunRequest, type ApiBridge, type ChatMessage, type SettingsSaveInput } from '@shared/ipc'

// preload 是渲染进程唯一能碰系统能力的通道（银行柜台模型，见 DIARY 术语词典）。
// 这里只暴露白名单方法，页面代码摸不到 ipcRenderer 本体。

function subscribe(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    cb(...args)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ApiBridge = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (input: SettingsSaveInput) => ipcRenderer.invoke(IPC.settingsSave, input),
  testConnection: (input: SettingsSaveInput) => ipcRenderer.invoke(IPC.settingsTest, input),
  chatSend: (messages: ChatMessage[]) => ipcRenderer.invoke(IPC.chatSend, messages),
  chatAbort: () => ipcRenderer.invoke(IPC.chatAbort),
  onChatChunk: (cb) => subscribe(IPC.chatChunk, (text) => cb(text as string)),
  onChatDone: (cb) => subscribe(IPC.chatDone, () => cb()),
  onChatError: (cb) => subscribe(IPC.chatError, (message) => cb(message as string)),
  runAgent: (request: AgentRunRequest) => ipcRenderer.invoke(IPC.agentRun, request),
  setModel: (model: string) => ipcRenderer.invoke(IPC.settingsSetModel, model),
  getWorkspace: () => ipcRenderer.invoke(IPC.workspaceGet),
  pickWorkspace: () => ipcRenderer.invoke(IPC.workspacePick)
}

contextBridge.exposeInMainWorld('api', api)
