import { contextBridge, ipcRenderer } from 'electron'
import type { ToolEvent } from '@shared/agent'
import {
  IPC,
  type AgentRunRequest,
  type ApiBridge,
  type BrowserBounds,
  type BrowserState,
  type ChatMessage,
  type ConversationCreateInput,
  type PermissionPreset,
  type SettingsSaveInput
} from '@shared/ipc'

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
  onChatTool: (cb) => subscribe(IPC.chatTool, (evt) => cb(evt as ToolEvent)),
  runAgent: (request: AgentRunRequest) => ipcRenderer.invoke(IPC.agentRun, request),
  setModel: (model: string) => ipcRenderer.invoke(IPC.settingsSetModel, model),
  getWorkspace: () => ipcRenderer.invoke(IPC.workspaceGet),
  pickWorkspace: () => ipcRenderer.invoke(IPC.workspacePick),
  setKnownWorkspace: (path: string) => ipcRenderer.invoke(IPC.workspaceSetKnown, path),
  revealWorkspace: (path: string) => ipcRenderer.invoke(IPC.workspaceReveal, path),
  listConversations: () => ipcRenderer.invoke(IPC.convList),
  getConversation: (id: string) => ipcRenderer.invoke(IPC.convGet, id),
  createConversation: (input: ConversationCreateInput) => ipcRenderer.invoke(IPC.convCreate, input),
  saveConversation: (id: string, messages: ChatMessage[]) =>
    ipcRenderer.invoke(IPC.convSave, { id, messages }),
  renameConversation: (id: string, title: string) => ipcRenderer.invoke(IPC.convRename, { id, title }),
  deleteConversation: (id: string) => ipcRenderer.invoke(IPC.convDelete, id),
  listSkills: () => ipcRenderer.invoke(IPC.skillsList),
  getPermission: () => ipcRenderer.invoke(IPC.permissionGet),
  setPermission: (preset: PermissionPreset) => ipcRenderer.invoke(IPC.permissionSet, preset),
  getGitInfo: () => ipcRenderer.invoke(IPC.gitInfo),
  attachFile: () => ipcRenderer.invoke(IPC.attachFile),
  polishPrompt: (text: string) => ipcRenderer.invoke(IPC.promptPolish, text),
  getBrowserState: () => ipcRenderer.invoke(IPC.browserState),
  browserNavigate: (url: string) => ipcRenderer.invoke(IPC.browserNavigate, url),
  browserBack: () => ipcRenderer.invoke(IPC.browserBack),
  browserForward: () => ipcRenderer.invoke(IPC.browserForward),
  browserReload: () => ipcRenderer.invoke(IPC.browserReload),
  setBrowserVisible: (visible: boolean) => ipcRenderer.invoke(IPC.browserSetVisible, visible),
  setBrowserBounds: (bounds: BrowserBounds) => ipcRenderer.invoke(IPC.browserSetBounds, bounds),
  onBrowserChanged: (cb) => subscribe(IPC.browserChanged, (s) => cb(s as BrowserState)),
  openLogsDir: () => ipcRenderer.invoke(IPC.logsOpen),
  getLogsInfo: () => ipcRenderer.invoke(IPC.logsInfo)
}

contextBridge.exposeInMainWorld('api', api)
