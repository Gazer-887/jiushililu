import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SubagentJobEvent, ToolEvent } from '@shared/agent'
import type { ChatDonePayload, StreamEnvelope } from '@shared/ipc'
import type { RevertHunkInput } from '@shared/checkpoint'
import type { ModelSaveInput } from '@shared/models'
import type { GoalAction } from '@shared/goal'
import type { BackgroundTask } from '@shared/background'
import type { TodoItem } from '@shared/todo'
import type { TokenUsage } from '@shared/usage'
import type { TokenSaverTier } from '@shared/token-tier'
import type { SystemSettings } from '@shared/system'
import type { TerminalDataPayload } from '@shared/terminal'
import {
  IPC,
  type AgentRunRequest,
  type ApiBridge,
  type AskRequest,
  type AskResult,
  type BrowserBounds,
  type BrowserState,
  type ChatMessage,
  type ConversationCreateInput,
  type PermissionPreset,
  type SettingsSaveInput,
  type ToolConfirmRequest
} from '@shared/ipc'

// preload 是渲染进程唯一能碰系统能力的通道：只暴露白名单方法，页面代码摸不到 ipcRenderer 本体。

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
  onChatDone: (cb) => subscribe(IPC.chatDone, (e) => cb(e as StreamEnvelope<ChatDonePayload>)),
  onChatError: (cb) => subscribe(IPC.chatError, (e) => cb(e as StreamEnvelope<string>)),
  onChatTool: (cb) => subscribe(IPC.chatTool, (e) => cb(e as StreamEnvelope<ToolEvent>)),
  runAgent: (request: AgentRunRequest) => ipcRenderer.invoke(IPC.agentRun, request),
  setModel: (model: string) => ipcRenderer.invoke(IPC.settingsSetModel, model),
  listModels: () => ipcRenderer.invoke(IPC.modelsList),
  saveModel: (input: ModelSaveInput) => ipcRenderer.invoke(IPC.modelsSave, input),
  deleteModel: (id: string) => ipcRenderer.invoke(IPC.modelsDelete, id),
  setActiveModel: (id: string) => ipcRenderer.invoke(IPC.modelsSetActive, id),
  testModel: (id: string) => ipcRenderer.invoke(IPC.modelsTest, id),
  listAvailableModels: (id: string) => ipcRenderer.invoke(IPC.modelsAvailable, id),
  setActiveModelEntry: (profileId: string, entryId: string) =>
    ipcRenderer.invoke(IPC.modelsSetEntry, { profileId, entryId }),
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
  saveConversation: (
    id: string,
    messages: ChatMessage[],
    stats?: { usage?: TokenUsage; avoidedTokens?: number; tokenTier?: TokenSaverTier }
  ) => ipcRenderer.invoke(IPC.convSave, stats ? { id, messages, ...stats } : { id, messages }),
  renameConversation: (id: string, title: string) => ipcRenderer.invoke(IPC.convRename, { id, title }),
  deleteConversation: (id: string) => ipcRenderer.invoke(IPC.convDelete, id),
  rollbackConversation: (id: string, toIndex: number) =>
    ipcRenderer.invoke(IPC.convRollback, { id, toIndex }),
  undoRollbackConversation: (id: string) => ipcRenderer.invoke(IPC.convUndoRollback, id),
  listSkills: () => ipcRenderer.invoke(IPC.skillsList),
  getPermission: () => ipcRenderer.invoke(IPC.permissionGet),
  setPermission: (preset: PermissionPreset) => ipcRenderer.invoke(IPC.permissionSet, preset),
  getTokenTier: () => ipcRenderer.invoke(IPC.tokenTierGet),
  setTokenTier: (tier: TokenSaverTier) => ipcRenderer.invoke(IPC.tokenTierSet, tier),
  getSystem: () => ipcRenderer.invoke(IPC.systemGet),
  setSystem: (patch: Partial<SystemSettings>) => ipcRenderer.invoke(IPC.systemSet, patch),
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
  listCheckpoints: () => ipcRenderer.invoke(IPC.checkpointList),
  getCheckpoint: (runId: string) => ipcRenderer.invoke(IPC.checkpointGet, runId),
  getCheckpointSides: (runId: string, rel: string) =>
    ipcRenderer.invoke(IPC.checkpointSides, { runId, rel }),
  revertCheckpointHunk: (input: RevertHunkInput) =>
    ipcRenderer.invoke(IPC.checkpointRevertHunk, input),
  rollbackCheckpoint: (runId: string, rel?: string) =>
    ipcRenderer.invoke(IPC.checkpointRollback, rel === undefined ? { runId } : { runId, rel }),
  onCheckpointChanged: (cb) => subscribe(IPC.checkpointChanged, (e) => cb(e as StreamEnvelope<string>)),
  onToolConfirmRequest: (cb) =>
    subscribe(IPC.confirmRequest, (req) => cb(req as ToolConfirmRequest & { conversationId: string })),
  respondToolConfirm: (result) => ipcRenderer.invoke(IPC.confirmRespond, result),
  // 提问（Agent 向用户要主意）：载荷**不走信封**（本来就没有 payload 包装），会话身份在 `AskRequest` 字段里
  onAskRequest: (cb) => subscribe(IPC.askRequest, (req) => cb(req as AskRequest)),
  respondAsk: (result: AskResult) => ipcRenderer.invoke(IPC.askRespond, result),
  getUIPrefs: () => ipcRenderer.invoke(IPC.uiPrefsGet),
  setUIPrefs: (patch) => ipcRenderer.invoke(IPC.uiPrefsSet, patch),
  resetUIPrefs: () => ipcRenderer.invoke(IPC.uiPrefsReset),
  listWorkspaceDir: (rel) => ipcRenderer.invoke(IPC.fsList, rel),
  readWorkspaceFile: (rel) => ipcRenderer.invoke(IPC.fsRead, rel),
  readWorkspaceBinary: (rel) => ipcRenderer.invoke(IPC.fsReadBinary, rel),
  // 写操作全部走统一写入服务（留检查点、可回滚）
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
  getTodos: (conversationId: string) => ipcRenderer.invoke(IPC.todoGet, conversationId),
  onTodoChanged: (cb) =>
    subscribe(IPC.todoChanged, (e) => cb(e as StreamEnvelope<TodoItem[]>)),
  getSubagents: (conversationId: string) => ipcRenderer.invoke(IPC.subagentGet, conversationId),
  onSubagentChanged: (cb) =>
    subscribe(IPC.subagentChanged, (e) => cb(e as StreamEnvelope<SubagentJobEvent[]>)),
  onFlushRequest: (cb) => subscribe(IPC.flushRequest, () => cb()),
  flushDone: () => ipcRenderer.invoke(IPC.flushDone),
  listBackgroundTasks: () => ipcRenderer.invoke(IPC.bgList),
  killBackgroundTask: (id) => ipcRenderer.invoke(IPC.bgKill, id),
  onBackgroundChanged: (cb) => subscribe(IPC.bgChanged, (list) => cb(list as BackgroundTask[])),
  terminalStart: (size) => ipcRenderer.invoke(IPC.terminalStart, size),
  terminalWrite: (data: string) => ipcRenderer.invoke(IPC.terminalWrite, data),
  terminalResize: (cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.terminalResize, { cols, rows }),
  terminalKill: () => ipcRenderer.invoke(IPC.terminalKill),
  // 背压回执：告诉主进程"这一段已经解析完了"（未回执字符数是它暂停/恢复 pty 的依据）
  terminalAck: (sessionId: string, chars: number) =>
    ipcRenderer.invoke(IPC.terminalAck, { sessionId, chars }),
  terminalResync: (sessionId: string) => ipcRenderer.invoke(IPC.terminalResync, { sessionId }),
  terminalRestart: () => ipcRenderer.invoke(IPC.terminalRestart),
  terminalSnapshot: () => ipcRenderer.invoke(IPC.terminalSnapshot),
  // ⚠️ 终端输出是**进程级**通道（不经会话信封）—— 见 `@shared/ipc.ts` 里那段注释的理由。
  //    载荷里带 `sessionId`，界面靠它区分"这帧属于哪条会话"。
  onTerminalData: (cb) =>
    subscribe(IPC.terminalData, (payload) => cb(payload as TerminalDataPayload)),
  onTerminalState: (cb) => subscribe(IPC.terminalState, (sessionId) => cb(sessionId as string))
}

contextBridge.exposeInMainWorld('api', api)