import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SubagentJobEvent, ToolEvent } from '@shared/agent'
import type { StreamEnvelope } from '@shared/ipc'
import type { ModelSaveInput } from '@shared/models'
import type { GoalAction } from '@shared/goal'
import type { BackgroundTask } from '@shared/background'
import type { TodoItem } from '@shared/todo'
import {
  IPC,
  type AgentRunRequest,
  type ApiBridge,
  type BrowserBounds,
  type BrowserState,
  type ChatMessage,
  type ConversationCreateInput,
  type PermissionPreset,
  type SettingsSaveInput,
  type ToolConfirmRequest
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
  chatSend: (input: { conversationId: string; messages: ChatMessage[] }) =>
    ipcRenderer.invoke(IPC.chatSend, input),
  chatAbort: (conversationId: string) => ipcRenderer.invoke(IPC.chatAbort, conversationId),
  // ⚠️ 流式订阅**必须原样透传信封**（plan11 P0-5）：以前这里写的是 `cb(text as string)`，
  //    主进程就算带了会话身份，也会在**这一行**被悄悄丢掉 —— 而"看起来一切正常"。
  onChatChunk: (cb) => subscribe(IPC.chatChunk, (e) => cb(e as StreamEnvelope<string>)),
  onChatReasoning: (cb) => subscribe(IPC.chatReasoning, (e) => cb(e as StreamEnvelope<string>)),
  onChatDone: (cb) => subscribe(IPC.chatDone, (e) => cb(e as StreamEnvelope<null>)),
  onChatError: (cb) => subscribe(IPC.chatError, (e) => cb(e as StreamEnvelope<string>)),
  onChatTool: (cb) => subscribe(IPC.chatTool, (e) => cb(e as StreamEnvelope<ToolEvent>)),
  runAgent: (request: AgentRunRequest) => ipcRenderer.invoke(IPC.agentRun, request),
  setModel: (model: string) => ipcRenderer.invoke(IPC.settingsSetModel, model),
  // ── 多模型管理（plan7 F5）──
  listModels: () => ipcRenderer.invoke(IPC.modelsList),
  saveModel: (input: ModelSaveInput) => ipcRenderer.invoke(IPC.modelsSave, input),
  deleteModel: (id: string) => ipcRenderer.invoke(IPC.modelsDelete, id),
  setActiveModel: (id: string) => ipcRenderer.invoke(IPC.modelsSetActive, id),
  testModel: (id: string) => ipcRenderer.invoke(IPC.modelsTest, id),
  listAvailableModels: (id: string) => ipcRenderer.invoke(IPC.modelsAvailable, id),
  setActiveModelEntry: (profileId: string, entryId: string) =>
    ipcRenderer.invoke(IPC.modelsSetEntry, { profileId, entryId }),
  // ── 目标（plan12）──
  listGoals: (conversationId: string) => ipcRenderer.invoke(IPC.goalList, conversationId),
  createGoal: (input: { conversationId: string; text: string; doneWhen?: string }) =>
    ipcRenderer.invoke(IPC.goalCreate, input),
  actOnGoal: (id: string, action: GoalAction, patch?: { text?: string; doneWhen?: string }) =>
    ipcRenderer.invoke(IPC.goalAction, { id, action, patch }),
  deleteGoal: (id: string) => ipcRenderer.invoke(IPC.goalDelete, id),
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
  rollbackConversation: (id: string, toIndex: number) =>
    ipcRenderer.invoke(IPC.convRollback, { id, toIndex }),
  undoRollbackConversation: (id: string) => ipcRenderer.invoke(IPC.convUndoRollback, id),
  listSkills: () => ipcRenderer.invoke(IPC.skillsList),
  getPermission: () => ipcRenderer.invoke(IPC.permissionGet),
  setPermission: (preset: PermissionPreset) => ipcRenderer.invoke(IPC.permissionSet, preset),
  getGitInfo: () => ipcRenderer.invoke(IPC.gitInfo),
  attachFile: () => ipcRenderer.invoke(IPC.attachFile),
  attachPath: (pathOrRel) => ipcRenderer.invoke(IPC.attachPath, pathOrRel),
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
  getLogsInfo: () => ipcRenderer.invoke(IPC.logsInfo),
  // ── 检查点与回滚（plan8 R4）──
  listCheckpoints: () => ipcRenderer.invoke(IPC.checkpointList),
  getCheckpoint: (runId: string) => ipcRenderer.invoke(IPC.checkpointGet, runId),
  rollbackCheckpoint: (runId: string, rel?: string) =>
    ipcRenderer.invoke(IPC.checkpointRollback, rel === undefined ? { runId } : { runId, rel }),
  onCheckpointChanged: (cb) => subscribe(IPC.checkpointChanged, (e) => cb(e as StreamEnvelope<string>)),
  // ── 危险操作逐次确认（plan8 R5）──
  onToolConfirmRequest: (cb) =>
    subscribe(IPC.confirmRequest, (req) => cb(req as ToolConfirmRequest & { conversationId: string })),
  respondToolConfirm: (result) => ipcRenderer.invoke(IPC.confirmRespond, result),
  // ── 界面布局偏好（plan7 批 A0）──
  getUIPrefs: () => ipcRenderer.invoke(IPC.uiPrefsGet),
  setUIPrefs: (patch) => ipcRenderer.invoke(IPC.uiPrefsSet, patch),
  resetUIPrefs: () => ipcRenderer.invoke(IPC.uiPrefsReset),
  // ── 工作区文件树（plan7 批 A，只读）──
  listWorkspaceDir: (rel) => ipcRenderer.invoke(IPC.fsList, rel),
  readWorkspaceFile: (rel) => ipcRenderer.invoke(IPC.fsRead, rel),
  readWorkspaceBinary: (rel) => ipcRenderer.invoke(IPC.fsReadBinary, rel),
  // ── 工作区写操作（plan7 批 A2）：全部走统一写入服务（留检查点、可回滚）──
  writeWorkspaceFile: (rel, content, expectedMtimeMs) =>
    ipcRenderer.invoke(IPC.fsWrite, {
      rel,
      content,
      ...(expectedMtimeMs === undefined ? {} : { expectedMtimeMs })
    }),
  createWorkspaceDir: (rel) => ipcRenderer.invoke(IPC.fsMkdir, { rel }),
  renameWorkspacePath: (rel, nextRel) => ipcRenderer.invoke(IPC.fsRename, { rel, nextRel }),
  deleteWorkspacePath: (rel) => ipcRenderer.invoke(IPC.fsDelete, { rel }),
  importIntoWorkspace: (sourceAbs, rel) => ipcRenderer.invoke(IPC.fsImport, { sourceAbs, rel }),
  revealWorkspaceEntry: (rel) => ipcRenderer.invoke(IPC.fsReveal, { rel }),
  // 拖入的文件对象 → 磁盘绝对路径。Electron 32+ 起 File.path 已移除，
  // 只能在 preload 里用 webUtils（渲染进程够不到这个能力）
  getPathForFile: (file) => webUtils.getPathForFile(file as File),
  // ── 待办清单（plan7 批 D 提前落地）──
  getTodos: (conversationId: string) => ipcRenderer.invoke(IPC.todoGet, conversationId),
  onTodoChanged: (cb) =>
    subscribe(IPC.todoChanged, (e) => cb(e as StreamEnvelope<TodoItem[]>)),
  // ── 子代理运行（plan7 批 D）──
  getSubagents: (conversationId: string) => ipcRenderer.invoke(IPC.subagentGet, conversationId),
  onSubagentChanged: (cb) =>
    subscribe(IPC.subagentChanged, (e) => cb(e as StreamEnvelope<SubagentJobEvent[]>)),
  // ── 关窗口前的会话落盘（plan11 P0-2）──
  onFlushRequest: (cb) => subscribe(IPC.flushRequest, () => cb()),
  flushDone: () => ipcRenderer.invoke(IPC.flushDone),
  // ── 后台任务（plan7 批 D）──
  listBackgroundTasks: () => ipcRenderer.invoke(IPC.bgList),
  killBackgroundTask: (id) => ipcRenderer.invoke(IPC.bgKill, id),
  onBackgroundChanged: (cb) => subscribe(IPC.bgChanged, (list) => cb(list as BackgroundTask[]))
}

contextBridge.exposeInMainWorld('api', api)