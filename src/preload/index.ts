import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SubagentJobEvent, ToolEvent } from '@shared/agent'
import type { AgentSaveInput } from '@shared/agents'
import type { MemoryNoticeEvent, MemorySaveInput } from '@shared/memory'
import type { PlaybookSaveInput } from '@shared/playbook'
import type { ChatDonePayload, SettingsChangedKind, StreamEnvelope } from '@shared/ipc'
import type { RevertHunkInput } from '@shared/checkpoint'
import type { FetchAvailableInput, ModelSaveInput } from '@shared/models'
import type { Goal, GoalAction } from '@shared/goal'
import type { BackgroundTask } from '@shared/background'
import type { TodoItem } from '@shared/todo'
import type { TokenUsage } from '@shared/usage'
import type { TokenSaverTier } from '@shared/token-tier'
import type { SystemSettings } from '@shared/system'
import type { NetworkPatch } from '@shared/network'
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
  type McpServerConfig,
  type PermissionPreset,
  type PlanApprovalRequest,
  type PlanApprovalResult,
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
  getVoiceConfig: () => ipcRenderer.invoke(IPC.voiceGetConfig),
  setVoiceConfig: (patch: unknown) => ipcRenderer.invoke(IPC.voiceSetConfig, patch),
  transcribeVoice: (audio: ArrayBuffer, mime: string) => ipcRenderer.invoke(IPC.voiceTranscribe, audio, mime),
  testVoiceEndpoint: () => ipcRenderer.invoke(IPC.voiceTest),
  detectRuntimes: (force?: boolean) => ipcRenderer.invoke(IPC.devEnvDetect, force === true),
  selectRuntime: (language: string, path: string | null) =>
    ipcRenderer.invoke(IPC.devEnvSelect, language, path),
  /** plan43 S3：当前**生效**的运行环境（事实，非意向） */
  getActiveRuntimes: () => ipcRenderer.invoke(IPC.devEnvActive),
  chatSend: (input: { conversationId: string; messages: ChatMessage[]; agentName?: string }) =>
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
  fetchAvailableModels: (input: FetchAvailableInput) => ipcRenderer.invoke(IPC.modelsFetchAvailable, input),
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
  resetWorkspace: () => ipcRenderer.invoke(IPC.workspaceReset),
  revealWorkspace: (path: string) => ipcRenderer.invoke(IPC.workspaceReveal, path),
  // 存储位置（plan10 C 批）
  getStorageLocation: () => ipcRenderer.invoke(IPC.storageGet),
  pickStorageDir: () => ipcRenderer.invoke(IPC.storagePick),
  resetStorageLocation: () => ipcRenderer.invoke(IPC.storageReset),
  undoStoragePending: () => ipcRenderer.invoke(IPC.storageUndoPending),
  listConversations: () => ipcRenderer.invoke(IPC.convList),
  getConversation: (id: string) => ipcRenderer.invoke(IPC.convGet, id),
  createConversation: (input: ConversationCreateInput) => ipcRenderer.invoke(IPC.convCreate, input),
  saveConversation: (
    id: string,
    messages: ChatMessage[],
    stats?: { usage?: TokenUsage; avoidedTokens?: number; tokenTier?: TokenSaverTier; agentName?: string }
  ) => ipcRenderer.invoke(IPC.convSave, stats ? { id, messages, ...stats } : { id, messages }),
  switchConversation: (prevId: string | null, nextId: string | null) =>
    ipcRenderer.invoke(IPC.convSwitch, { prevId, nextId }),
  renameConversation: (id: string, title: string) => ipcRenderer.invoke(IPC.convRename, { id, title }),
  deleteConversation: (id: string) => ipcRenderer.invoke(IPC.convDelete, id),
  rollbackConversation: (id: string, toIndex: number) =>
    ipcRenderer.invoke(IPC.convRollback, { id, toIndex }),
  undoRollbackConversation: (id: string) => ipcRenderer.invoke(IPC.convUndoRollback, id),
  listSkills: () => ipcRenderer.invoke(IPC.skillsList),
  // ── MCP 客户端（plan23）──
  mcpListServers: () => ipcRenderer.invoke(IPC.mcpList),
  mcpSaveServer: (config: McpServerConfig) => ipcRenderer.invoke(IPC.mcpSave, config),
  mcpDeleteServer: (name: string) => ipcRenderer.invoke(IPC.mcpDelete, name),
  mcpReconnect: (name: string) => ipcRenderer.invoke(IPC.mcpReconnect, name),
  onMcpChanged: (cb: () => void) => subscribe(IPC.mcpChanged, () => cb()),
  // ── 子 Agent 管理（plan17）──
  listAgents: () => ipcRenderer.invoke(IPC.agentsList),
  readAgent: (file: string) => ipcRenderer.invoke(IPC.agentsRead, file),
  saveAgent: (input: AgentSaveInput) => ipcRenderer.invoke(IPC.agentsSave, input),
  deleteAgent: (file: string) => ipcRenderer.invoke(IPC.agentsDelete, file),
  onAgentsChanged: (cb) => subscribe(IPC.agentsChanged, () => cb()),
  onConversationsChanged: (cb) => subscribe(IPC.convChanged, () => cb()),
  // ── 记忆（plan19 批 1）──
  listMemory: () => ipcRenderer.invoke(IPC.memoryList),
  readMemory: (file: string) => ipcRenderer.invoke(IPC.memoryRead, file),
  saveMemory: (input: MemorySaveInput) => ipcRenderer.invoke(IPC.memorySave, input),
  deleteMemory: (file: string) => ipcRenderer.invoke(IPC.memoryDelete, file),
  // plan53 片 1：自动遗忘已改成可逆归档，这里是"取回来"那条路
  restoreMemory: (file: string) => ipcRenderer.invoke(IPC.memoryRestore, file),
  clearArchivedMemory: () => ipcRenderer.invoke(IPC.memoryClearArchive),
  // plan33 问题四：合并疑似重复对（方向主进程重判）
  mergeMemory: (olderFile: string, newerFile: string) =>
    ipcRenderer.invoke(IPC.memoryMerge, { olderFile, newerFile }),
  onMemoryChanged: (cb) => subscribe(IPC.memoryChanged, () => cb()),
  /** 护栏 2（D-043）：本轮写入痕迹 —— 只推"刚发生的事实"，全量巡检在右抽屉 */
  onMemoryNotice: (cb) => subscribe(IPC.memoryNotice, (payload) => cb(payload as MemoryNoticeEvent)),
  // 记忆开关（批 1）：只管通路 A
  getMemorySwitch: () => ipcRenderer.invoke(IPC.memoryGetSwitch),
  setMemorySwitch: (enabled: boolean) => ipcRenderer.invoke(IPC.memorySetSwitch, enabled),
  readMcpArtifact: (name: string) => ipcRenderer.invoke(IPC.mcpArtifactRead, name),
  getMemoryApprovalGate: () => ipcRenderer.invoke(IPC.memoryGetApprovalGate),
  setMemoryApprovalGate: (enabled: boolean) => ipcRenderer.invoke(IPC.memorySetApprovalGate, enabled),
  // ── 记忆批 2：候选批准/拒绝 + 统计 + 会话切换通知 ──
  approveMemory: (file: string) => ipcRenderer.invoke(IPC.memoryApprove, file),
  rejectMemory: (file: string) => ipcRenderer.invoke(IPC.memoryReject, file),
  /** 候选区预筛（plan55 片④-a）：手动触发，返回这次的结果报告 */
  prescreenMemory: () => ipcRenderer.invoke(IPC.memoryPrescreen),
  getMemoryStats: () => ipcRenderer.invoke(IPC.memoryStats),
  flagMemory: (name: string) => ipcRenderer.invoke(IPC.memoryFlag, name),
  dismissMemoryReview: (name: string) => ipcRenderer.invoke(IPC.memoryDismissReview, name),
  dismissAllMemoryReview: () => ipcRenderer.invoke(IPC.memoryDismissAllReview),
  rejectUnclusteredMemory: (files) => ipcRenderer.invoke(IPC.memoryRejectUnclustered, files),
  restoreRejectedMemory: (file) => ipcRenderer.invoke(IPC.memoryRestoreRejected, file),
  clearRejectedMemory: () => ipcRenderer.invoke(IPC.memoryClearRejected),
  getMemoryAuto: () => ipcRenderer.invoke(IPC.memoryGetAuto),
  setMemoryAuto: (patch) => ipcRenderer.invoke(IPC.memorySetAuto, patch),
  // ── Playbook（plan19 批 3，会做线）──
  listPlaybook: () => ipcRenderer.invoke(IPC.playbookList),
  savePlaybook: (input: PlaybookSaveInput) => ipcRenderer.invoke(IPC.playbookSave, input),
  deletePlaybook: (file: string) => ipcRenderer.invoke(IPC.playbookDelete, file),
  onPlaybookChanged: (cb) => subscribe(IPC.playbookChanged, () => cb()),
  // ── 执行事件流（plan26 D-077）──
  listExecEvents: (query) => ipcRenderer.invoke(IPC.execEventsList, query),
  // 电脑控制开关（plan44 门控）/ E5 终端 profile 开关（默认关）
  getComputerControl: () => ipcRenderer.invoke(IPC.computerControlGet),
  setComputerControl: (enabled: boolean) => ipcRenderer.invoke(IPC.computerControlSet, enabled),
  getTerminalProfile: () => ipcRenderer.invoke(IPC.terminalProfileGet),
  setTerminalProfile: (enabled: boolean) => ipcRenderer.invoke(IPC.terminalProfileSet, enabled),
  // plan34 S2a：技能禁用名单（设置页开关用）。MCP 开关走 mcpSaveServer（cfg.enabled）
  getSkillsDisabled: () => ipcRenderer.invoke(IPC.skillsDisabledGet),
  setSkillsDisabled: (names: string[]) => ipcRenderer.invoke(IPC.skillsDisabledSet, names),
  // plan34 S2b：技能写路径（创建/更新/删除，只落用户层）
  skillSave: (input) => ipcRenderer.invoke(IPC.skillSave, input),
  skillDelete: (name: string) => ipcRenderer.invoke(IPC.skillDelete, name),
  onSkillsChanged: (cb: () => void) => subscribe(IPC.skillsChanged, () => cb()),
  getPermission: () => ipcRenderer.invoke(IPC.permissionGet),
  setPermission: (preset: PermissionPreset) => ipcRenderer.invoke(IPC.permissionSet, preset),
  getTokenTier: () => ipcRenderer.invoke(IPC.tokenTierGet),
  setTokenTier: (tier: TokenSaverTier) => ipcRenderer.invoke(IPC.tokenTierSet, tier),
  getSystem: () => ipcRenderer.invoke(IPC.systemGet),
  setSystem: (patch: Partial<SystemSettings>) => ipcRenderer.invoke(IPC.systemSet, patch),
  // ── 网络代理（plan7 批 F2）──
  getNetwork: () => ipcRenderer.invoke(IPC.netProxyGet),
  listFonts: () => ipcRenderer.invoke(IPC.fontsList),
  setNetwork: (patch: NetworkPatch) => ipcRenderer.invoke(IPC.netProxySet, patch),
  // Firecrawl（plan32）：Key 只进不出，读回只有 hasKey
  getFirecrawl: () => ipcRenderer.invoke(IPC.firecrawlGet),
  setFirecrawl: (key: string | null) => ipcRenderer.invoke(IPC.firecrawlSet, key),
  getGitInfo: () => ipcRenderer.invoke(IPC.gitInfo),
  // ── 源代码管理（plan16）──
  getGitStatus: () => ipcRenderer.invoke(IPC.gitStatus),
  getGitDiff: (rel: string) => ipcRenderer.invoke(IPC.gitDiff, rel),
  gitStage: (rels: string[]) => ipcRenderer.invoke(IPC.gitStage, rels),
  gitUnstage: (rels: string[]) => ipcRenderer.invoke(IPC.gitUnstage, rels),
  gitCommit: (message: string) => ipcRenderer.invoke(IPC.gitCommit, message),
  onGitChanged: (cb) => subscribe(IPC.gitChanged, () => cb()),
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
  // 计划批准（plan27）：写法同 ask —— 载荷**不走信封包装**，会话身份在 `PlanApprovalRequest` 自己的字段里
  onPlanApprovalRequest: (cb) => subscribe(IPC.planApprovalRequest, (req) => cb(req as PlanApprovalRequest)),
  respondPlanApproval: (result: PlanApprovalResult) =>
    ipcRenderer.invoke(IPC.planApprovalRespond, result),
  getUIPrefs: () => ipcRenderer.invoke(IPC.uiPrefsGet),
  setUIPrefs: (patch) => ipcRenderer.invoke(IPC.uiPrefsSet, patch),
  resetUIPrefs: () => ipcRenderer.invoke(IPC.uiPrefsReset),
  // ── 设置独立窗口（2026-09-13）──────────────────────────────
  // 开窗/关窗都走主进程：渲染端不 import electron（架构守卫），拿不到 BrowserWindow
  openSettingsWindow: () => ipcRenderer.invoke(IPC.settingsOpenWindow),
  closeSettingsWindow: () => ipcRenderer.invoke(IPC.settingsCloseWindow),
  /** 设置变更广播：主窗口与设置窗口是**两个渲染进程**，store 不共享 —— 一处改了另一处据此重读。
   *  ⚠️ 不带会话信封（进程级通道，同终端/后台任务），故直接收 kind 而不是 StreamEnvelope。 */
  onSettingsChanged: (cb) =>
    subscribe(IPC.settingsChanged, (kind) => cb(kind as SettingsChangedKind)),
  listWorkspaceDir: (rel) => ipcRenderer.invoke(IPC.fsList, rel),
  readWorkspaceFile: (rel) => ipcRenderer.invoke(IPC.fsRead, rel),
  readWorkspaceBinary: (rel) => ipcRenderer.invoke(IPC.fsReadBinary, rel),
  // Office 内嵌预览：主进程解析，渲染端只拿沙箱 URL（不拿 HTML 本体）
  previewOffice: (rel) => ipcRenderer.invoke(IPC.officePreview, rel),
  openWorkspacePathInSystem: (rel) => ipcRenderer.invoke(IPC.fsOpenInSystem, rel),
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
  onGoalChanged: (cb) => subscribe(IPC.goalChanged, (e) => cb(e as StreamEnvelope<Goal>)),
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