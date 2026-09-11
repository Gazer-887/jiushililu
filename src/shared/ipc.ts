// 主 / 渲染进程共享的 IPC 通道定义与类型 —— 两边类型都从这里引用，唯一来源。

import type { UIPrefs } from './splitter'
import type { TodoItem } from './todo'
import type { SubagentJobEvent } from './agent'
import type { BackgroundTask } from './background'
import type { FsListResult, FsReadResult } from './fs-tree'

export type ProviderType = 'openai-compatible' | 'anthropic'

/**
 * 思考强度（统一词表，适配层翻译成各厂商方言）：
 * DeepSeek V4 → reasoning_effort low/high/max（官方示例与 thinking 开关成对）
 * OpenAI o 系 → reasoning_effort low/medium/high
 * Anthropic   → thinking budget_tokens（按强度映射预算）
 */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'max'

export interface ModelSettings {
  providerType: ProviderType
  baseURL: string
  model: string
  /**
   * 采样三兄弟（Trae 式"留空即最佳"）：null = 不发送该参数，跟随厂商默认。
   * temperature 随机性 0~2；topP 核采样 0~1；topK 只看前 K 个候选词 1~200。
   * 注意 Anthropic 规定 temperature 与 top_p 互斥，适配层已处理（top_p 优先）。
   */
  temperature: number | null
  topP: number | null
  topK: number | null
  maxTokens: number
  timeoutMs: number
  stream: boolean
  /** 上下文窗口（客户端元数据，不会发给模型）：历史裁剪 / 压缩决策与成本估算的依据 */
  contextWindow: number
  /** 思考强度；default = 跟随厂商默认（不发任何相关字段） */
  reasoningEffort: ReasoningEffort
  /** 工具调用轮数上限（客户端元数据，P1 主循环用它防死循环烧钱） */
  maxToolRounds: number
  /** 是否支持图片输入（客户端元数据，多模态模型才勾，如 deepseek-v4-flash-vision-exp） */
  supportsImages: boolean
}

/** 设置页看到的视图：Key 永远不明文回传，只给掩码 */
export interface SettingsView extends ModelSettings {
  hasApiKey: boolean
  apiKeyMasked: string
}

/** 保存入参：apiKey 为空串表示"保留已存 Key 不变" */
export interface SettingsSaveInput extends ModelSettings {
  apiKey: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/** Agent 模式派发入参：task 必填；agentName 缺省 = 内核默认全工具执行 */
export interface AgentRunRequest {
  task: string
  agentName?: string
}

/** 工作区信息（P2）：Agent 可读写的边界目录，由用户显式选择 */
export interface WorkspaceInfo {
  path: string
  /** 是否为用户自定义（false = 内置默认 userData/agent-workspace） */
  custom: boolean
}

/**
 * 访问权限档（D-032：能力归模型，**权限归人**）——唯一由用户决定的档位。
 * 决定模型"能碰什么"，接的是 P1 的白名单门控。
 */
export type PermissionPreset = 'read-only' | 'write' | 'full-access'

/** 附件（输入框 chip）：引用工作区文件进上下文 */
export interface Attachment {
  /** 展示名（文件名） */
  name: string
  /** 相对/绝对路径 */
  path: string
  /** 已读取的文本内容（过长会被截断） */
  content: string
  /** 内容是否被截断 */
  truncated: boolean
}

/** 当前 Git 分支信息（输入框分支显示） */
export interface GitInfo {
  branch: string
  /** 是否有未提交改动 */
  dirty: boolean
}

/** 内置浏览器状态（右抽屉「浏览器」页签） */
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 浏览器视图在窗口内的显示区域（CSS 像素，相对内容区左上角） */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 日志信息（plan8 R2：排查入口） */
export interface LogsInfo {
  dir: string | null
  files: string[]
}

// ── 检查点与回滚（plan8 R4）──
// 类型定义在 @shared/checkpoint（纯逻辑层，主进程与界面共用同一口径）
import type { CheckpointRun, CheckpointRunMeta, RollbackReport } from './checkpoint'
export type {
  ChangeKind,
  CheckpointRun,
  CheckpointRunMeta,
  FileChange,
  RollbackAction,
  RollbackReport
} from './checkpoint'

/** Agent 模式执行结果（plan6：独立上下文 + 单次报告返回） */
export interface AgentRunResult {
  ok: boolean
  output: string
  rounds: number
  /** error = 调度/配置层失败（未真正执行） */
  stopReason: 'completed' | 'max-rounds' | 'error'
  /** 派发目标（内核默认 或 自定义 Agent 名） */
  agent: string
  error?: string
}

// ── 会话（P2 侧边栏）：一个「任务」= 一条会话，绑定到某个工作区 ──────────

/** 会话元信息（侧边栏列表用，不含消息体，避免列表加载拖大） */
export interface ConversationMeta {
  id: string
  title: string
  /** 创建时绑定的工作区路径——侧边栏按它分组 */
  workspace: string
  /** 该会话使用的模型（创建时快照，可单独切换） */
  model: string
  /** 勾选启用的内置技能（agent 定义名） */
  skills: string[]
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[]
}

export interface ConversationCreateInput {
  workspace: string
  model: string
  skills: string[]
  /** 首个输入（用于生成标题；可为空） */
  firstMessage?: string
}

/** 侧边栏里的一项技能（来自内置 + 用户自定义的 Agent 定义） */
export interface SkillInfo {
  name: string
  description: string
  /** builtin = 随应用分发；user = 用户自建 */
  source: 'builtin' | 'user'
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsTest: 'settings:test',
  settingsSetModel: 'settings:set-model',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatChunk: 'chat:chunk',
  chatDone: 'chat:done',
  chatError: 'chat:error',
  /** 工具执行生命周期（D-032：界面显示"正在读 xx / 完成 / 失败"） */
  chatTool: 'chat:tool',
  agentRun: 'agent:run',
  workspaceGet: 'workspace:get',
  workspacePick: 'workspace:pick',
  workspaceSetKnown: 'workspace:set-known',
  workspaceReveal: 'workspace:reveal',
  convList: 'conv:list',
  convGet: 'conv:get',
  convCreate: 'conv:create',
  convSave: 'conv:save',
  convRename: 'conv:rename',
  convDelete: 'conv:delete',
  skillsList: 'skills:list',
  /** 访问权限档（只读 / 可写 / 完全访问） */
  permissionGet: 'permission:get',
  permissionSet: 'permission:set',
  /** 当前工作区的 Git 分支 */
  gitInfo: 'git:info',
  /** 选择文件作为上下文附件（读入内容） */
  attachFile: 'attach:file',
  /** 提示词优化（一次额外模型调用改写输入） */
  promptPolish: 'prompt:polish',
  // ── 内置浏览器（真浏览器，Agent 可操控）──
  browserState: 'browser:state',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSetVisible: 'browser:set-visible',
  browserSetBounds: 'browser:set-bounds',
  /** 状态变化推送（地址/标题/加载中/前进后退可用性） */
  browserChanged: 'browser:changed',
  /** 日志（排查入口） */
  logsOpen: 'logs:open',
  logsInfo: 'logs:info',
  // ── 检查点与回滚（plan8 R4）──
  checkpointList: 'checkpoint:list',
  checkpointGet: 'checkpoint:get',
  checkpointRollback: 'checkpoint:rollback',
  /** 一轮运行结束后推送（界面据此刷新"文件变更"页签） */
  checkpointChanged: 'checkpoint:changed',
  // ── 危险操作逐次确认（plan8 R5）──
  /** 主进程 → 界面：请求确认某次危险操作 */
  confirmRequest: 'confirm:request',
  /** 界面 → 主进程：回传答复 */
  confirmRespond: 'confirm:respond',
  // ── 界面布局偏好（plan7 批 A0）──
  uiPrefsGet: 'ui-prefs:get',
  uiPrefsSet: 'ui-prefs:set',
  uiPrefsReset: 'ui-prefs:reset',
  // ── 待办清单（plan7 批 D 提前落地）──
  /** 主进程 → 界面：Agent 更新了清单 */
  todoChanged: 'todo:changed',
  /** 界面 → 主进程：组件挂载时拉一次当前清单 */
  todoGet: 'todo:get',
  // ── 子代理运行（plan7 批 D：右栏「任务」页签）──
  /** 主进程 → 界面：子代理批次状态变化（谁在跑、跑了几轮、结果如何） */
  subagentChanged: 'subagent:changed',
  /** 界面 → 主进程：挂载时拉一次 */
  subagentGet: 'subagent:get',
  // ── 工作区文件树（plan7 批 A，只读）──
  fsList: 'fs:list',
  fsRead: 'fs:read',
  // ── 工作区写操作（plan7 批 A2）：全部走统一写入服务 + 各开一个检查点轮次 ──
  fsWrite: 'fs:write',
  fsMkdir: 'fs:mkdir',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',
  /** 把工作区外的文件导入进来（拖拽上传） */
  fsImport: 'fs:import',
  /** 在系统文件管理器中定位条目 */
  fsReveal: 'fs:reveal',
  // ── 后台任务（plan7 批 D）──
  /** 列出后台任务（含累积输出） */
  bgList: 'bg:list',
  /** 终止一条后台任务 */
  bgKill: 'bg:kill',
  /** 主进程 → 界面：任务状态或输出变化 */
  bgChanged: 'bg:changed'
} as const

/** 界面布局偏好（左右抽屉宽度，plan7 批 A0）—— 定义见 @shared/splitter */
export type { UIPrefs } from './splitter'

/** 工作区文件树（plan7 批 A）—— 定义见 @shared/fs-tree */
export type { FsEntry, FsListResult, FsReadResult } from './fs-tree'

/**
 * 工作区写操作结果（plan7 批 A2）——
 * 失败也**用人话回**、不抛异常：界面直接拿去显示，不必再翻译一遍
 */
export interface FsOpResult {
  ok: boolean
  message: string
}

/** 待办清单（plan7 批 D 提前落地）—— 定义见 @shared/todo */
export type { TodoItem, TodoStatus, TodoStats } from './todo'

/** 子代理运行事件（plan7 批 D）—— 定义见 @shared/agent */
export type { SubagentJobEvent } from './agent'

/** 后台任务（plan7 批 D）—— 定义见 @shared/background */
export type { BackgroundTask } from './background'

/**
 * 危险操作确认请求（plan8 R5）。
 *
 * 说明：权限档管"能碰什么"（粗粒度、事先设定），本机制管"这一次要不要"（细粒度、当场决定）。
 * 两者是互补关系，不是替代关系。
 */
export interface ToolConfirmRequest {
  /** 唯一 id，用于配对答复 */
  id: string
  /** 工具名（如 run_command） */
  tool: string
  /** 给人看的关键内容（如要执行的命令原文） */
  detail: string
  /** 发起方（内核默认 / 子代理名） */
  agent: string
  /** 会影响的位置（如工作区路径） */
  where: string
}

export interface ToolConfirmResult {
  id: string
  allowed: boolean
}

/** preload 暴露给渲染进程的受控桥（contextIsolation 下唯一的系统通道） */
export interface ApiBridge {
  getSettings(): Promise<SettingsView>
  saveSettings(input: SettingsSaveInput): Promise<SettingsView>
  testConnection(input: SettingsSaveInput): Promise<TestResult>
  setModel(model: string): Promise<SettingsView>
  chatSend(messages: ChatMessage[]): Promise<void>
  chatAbort(): Promise<void>
  onChatChunk(cb: (text: string) => void): () => void
  onChatDone(cb: () => void): () => void
  onChatError(cb: (message: string) => void): () => void
  onChatTool(cb: (evt: import('./agent').ToolEvent) => void): () => void
  runAgent(request: AgentRunRequest): Promise<AgentRunResult>
  getWorkspace(): Promise<WorkspaceInfo>
  pickWorkspace(): Promise<WorkspaceInfo | null>
  /** 切换到"已知工作区"（历史会话用过的路径）——不接受任意路径，收紧权限面 */
  setKnownWorkspace(path: string): Promise<WorkspaceInfo | null>
  /** 在系统文件管理器中打开某目录 */
  revealWorkspace(path: string): Promise<void>
  listConversations(): Promise<ConversationMeta[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(input: ConversationCreateInput): Promise<Conversation>
  saveConversation(id: string, messages: ChatMessage[]): Promise<ConversationMeta | null>
  renameConversation(id: string, title: string): Promise<ConversationMeta | null>
  deleteConversation(id: string): Promise<void>
  listSkills(): Promise<SkillInfo[]>
  getPermission(): Promise<PermissionPreset>
  setPermission(preset: PermissionPreset): Promise<PermissionPreset>
  getGitInfo(): Promise<GitInfo | null>
  /** 弹文件选择器并读入内容作为附件（只接受工作区内文件） */
  attachFile(): Promise<Attachment | null>
  /** 提示词优化：把草稿改写成更清晰的指令 */
  polishPrompt(text: string): Promise<string>
  // ── 内置浏览器 ──
  getBrowserState(): Promise<BrowserState>
  browserNavigate(url: string): Promise<BrowserState>
  browserBack(): Promise<BrowserState>
  browserForward(): Promise<BrowserState>
  browserReload(): Promise<BrowserState>
  /** 显隐（只在可见时把原生视图挂上窗口，避免挡住界面） */
  setBrowserVisible(visible: boolean): Promise<void>
  /** 同步显示区域（渲染进程用 ResizeObserver 算好再传） */
  setBrowserBounds(bounds: BrowserBounds): Promise<void>
  onBrowserChanged(cb: (s: BrowserState) => void): () => void
  /** 在系统文件管理器中打开日志目录（排查用） */
  openLogsDir(): Promise<boolean>
  getLogsInfo(): Promise<LogsInfo>
  // ── 检查点与回滚（plan8 R4）──
  /** 列出所有 Agent 运行轮次（新→旧） */
  listCheckpoints(): Promise<CheckpointRunMeta[]>
  /** 读某一轮改了哪些文件 */
  getCheckpoint(runId: string): Promise<CheckpointRun | null>
  /** 回滚：不传 rel 即整轮回滚 */
  rollbackCheckpoint(runId: string, rel?: string): Promise<RollbackReport>
  /** 一轮运行结束后触发（界面刷新用） */
  onCheckpointChanged(cb: (runId: string) => void): () => void
  // ── 危险操作逐次确认（plan8 R5）──
  /** 收到确认请求（界面弹对话框） */
  onToolConfirmRequest(cb: (req: ToolConfirmRequest) => void): () => void
  /** 回传用户答复；无人应答时主进程超时按拒绝处理 */
  respondToolConfirm(result: ToolConfirmResult): Promise<void>
  // ── 界面布局偏好（plan7 批 A0）──
  getUIPrefs(): Promise<UIPrefs>
  setUIPrefs(patch: Partial<UIPrefs>): Promise<UIPrefs>
  /** 双击分隔条复位为默认宽度 */
  resetUIPrefs(): Promise<UIPrefs>
  // ── 工作区文件树（plan7 批 A，只读）──
  /** 列一层目录（懒加载：展开哪个查哪个） */
  listWorkspaceDir(rel: string): Promise<FsListResult>
  /** 读文件内容用于预览（限 256KB，超限截断并告知） */
  readWorkspaceFile(rel: string): Promise<FsReadResult>
  // ── 工作区写操作（plan7 批 A2）──
  // 全部经**统一写入服务**：留检查点快照 → 操作同样出现在「文件变更记录」里、同样退得回
  writeWorkspaceFile(rel: string, content: string): Promise<FsOpResult>
  createWorkspaceDir(rel: string): Promise<FsOpResult>
  renameWorkspacePath(rel: string, nextRel: string): Promise<FsOpResult>
  /** 删除到**回收站**（不是硬删 —— 误删还能自己捞回来） */
  deleteWorkspacePath(rel: string): Promise<FsOpResult>
  /** 把工作区**外**的文件导入进来（拖拽上传） */
  importIntoWorkspace(sourceAbs: string, rel: string): Promise<FsOpResult>
  /** 在系统文件管理器中定位该条目 */
  revealWorkspaceEntry(rel: string): Promise<void>
  // ── 后台任务（plan7 批 D）──
  /** 列出后台任务（挂载时拉一次，之后靠推送） */
  listBackgroundTasks(): Promise<BackgroundTask[]>
  /** 终止一条后台任务（连带它的子进程） */
  killBackgroundTask(id: string): Promise<boolean>
  onBackgroundChanged(cb: (list: BackgroundTask[]) => void): () => void
  /**
   * 拖入的文件对象 → 磁盘绝对路径（拖拽上传用）。
   * Electron 32+ 起 `File.path` 已移除，必须走 preload 的 `webUtils.getPathForFile`。
   * 参数写成结构化类型而非 DOM 的 `File`：本文件同时被主进程引入，而主进程 tsconfig
   * 没有 DOM lib（用 `File` 会直接编译不过）。
   */
  getPathForFile(file: { name: string }): string
  // ── 待办清单（plan7 批 D 提前落地）──
  /** 当前清单：组件挂载时拉一次，之后靠 onTodoChanged 推送 */
  getTodos(): Promise<TodoItem[]>
  onTodoChanged(cb: (todos: TodoItem[]) => void): () => void
  // ── 子代理运行（plan7 批 D：右栏「任务」页签）──
  /** 最近一批子代理的运行事件（挂载时拉一次，之后靠推送） */
  getSubagents(): Promise<SubagentJobEvent[]>
  onSubagentChanged(cb: (list: SubagentJobEvent[]) => void): () => void
}
