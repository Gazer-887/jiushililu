// 主 / 渲染进程共用的 IPC 通道与类型 —— 通道名字面量只在这里写一次，主/渲染两侧都从这里取。

import type { UIPrefs } from './splitter'
import type { TodoItem } from './todo'
import type { TokenUsage } from './usage'
import type { TokenSaverTier } from './token-tier'
import type { SubagentJobEvent } from './agent'
import type { BackgroundTask } from './background'
import type { FsBinaryResult, FsListResult, FsReadResult } from './fs-tree'

export type ProviderType = 'openai-compatible' | 'anthropic'

/** 思考强度：统一词表，由适配层翻译成各厂商方言（reasoning_effort 档位 / Anthropic thinking 预算） */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'max'

export interface ModelSettings {
  providerType: ProviderType
  baseURL: string
  model: string
  /** 三个采样参数 null = 不发该字段、跟随厂商默认（与 0 不是一回事）。
   *  ⚠️ Anthropic 规定 temperature 与 top_p 互斥，适配层按 top_p 优先处理。 */
  temperature: number | null
  topP: number | null
  topK: number | null
  maxTokens: number
  timeoutMs: number
  stream: boolean
  /** 上下文窗口：仅客户端元数据（不发厂商），历史裁剪 / 压缩与成本估算的依据 */
  contextWindow: number
  /** 思考强度；default = 跟随厂商默认（不发任何相关字段） */
  reasoningEffort: ReasoningEffort
  /** 工具调用轮数上限（客户端元数据，P1 主循环用它防死循环烧钱） */
  maxToolRounds: number
  /** 是否支持图片输入：仅客户端元数据（多模态模型才勾） */
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
  /** 这轮跑属于哪条会话（plan11）；单次 Agent 调用本无对话上下文，故可选。
   *  缺省时主进程写一个明确哨兵值、不留空 —— 出事了要能查"这轮是谁跑的"。 */
  conversationId?: string
}

/** 工作区信息（P2）：Agent 可读写的边界目录，由用户显式选择 */
export interface WorkspaceInfo {
  path: string
  /** 是否为用户自定义（false = 内置默认 userData/agent-workspace） */
  custom: boolean
}

/** 访问权限档（D-032：能力归模型、**权限归人**）—— 唯一由用户定的档位，接 P1 白名单门控 */
export type PermissionPreset = 'read-only' | 'write' | 'full-access'

/** 附件（输入框 chip）：把工作区文件引用进上下文 */
export interface Attachment {
  name: string
  path: string
  content: string
  truncated: boolean
  /** 这个文件**不在当前工作区内**（主人从系统里明确拖/选进来的）：只影响界面标记、不影响能不能读。
   *  要标出来，是因为工作区是 Agent 的活动范围，用户有权知道上下文里混进了"外面的"文件；
   *  边界规则见 `workspace-fs.readAttachment`。 */
  outside?: boolean
}

/** 当前 Git 分支信息（输入框分支显示） */
export interface GitInfo {
  branch: string
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

// ── 检查点与回滚（plan8 R4）—— 类型定义见 @shared/checkpoint（纯逻辑层，主/界面共用口径）──
import type {
  CheckpointRun,
  CheckpointRunMeta,
  CheckpointSidesResult,
  RevertHunkInput,
  RevertHunkResult,
  RollbackReport
} from './checkpoint'
export type {
  ChangeKind,
  CheckpointRun,
  CheckpointRunMeta,
  CheckpointSides,
  CheckpointSidesResult,
  FileChange,
  RevertHunkInput,
  RevertHunkResult,
  RollbackAction,
  RollbackReport
} from './checkpoint'

// ── 内置终端（plan7 批 C）—— 类型定义见 @shared/terminal（纯类型，主/界面共用口径）──
import type { TerminalDataPayload, TerminalSessionSnapshot, TerminalStartResult } from './terminal'
export type { TerminalChunk, TerminalDataPayload, TerminalSessionSnapshot, TerminalStartResult } from './terminal'

/** Agent 模式执行结果（plan6：独立上下文 + 单次报告返回） */
export interface AgentRunResult {
  ok: boolean
  output: string
  rounds: number
  /** error = 调度/配置层失败（未真正执行） */
  stopReason: 'completed' | 'max-rounds' | 'error'
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
  /** 该会话绑定的**模型档案 id**（plan7 F5）：`model` 只是给人看/老数据里的模型名，
   *  只有它才能定位"用哪条连接 + 哪把 Key"。老会话缺字段 → 按名字找同名档案兜底，
   *  **不许因为升级丢掉会话或打不开会话**。 */
  modelProfileId?: string
  /** 勾选启用的内置技能（agent 定义名） */
  skills: string[]
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 这条会话的**真实用量累计**（plan8 R9），必须落盘：牌上写的是"本会话累计"，
   *  一重启就归零就是在骗人（用户拿它判断哪条会话烧得多）。
   *  缺字段 = 老数据 / 还没跑过 → 界面显示"暂无"，**不补 0**。 */
  usage?: TokenUsage
  /** 这条会话**省下**的估算 token（plan8 R9.1）：不是厂商账，故与 `usage` 分开存 —— 混算等于两笔账糊一起 */
  avoidedTokens?: number
  /** **最后一轮**用的省 token 档位（plan8 R9.1 §七②）：档位是全局设置、会话中途可换，
   *  所以它只代表最近一次 —— 逐轮比对是校准 harness 的事，不该由会话索引承担。 */
  tokenTier?: TokenSaverTier
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[]
}

export interface ConversationCreateInput {
  workspace: string
  model: string
  /** 绑定的模型档案 id（plan7 F5）：由主进程按"当前档案"补齐，渲染端不用管 */
  modelProfileId?: string
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
  // ── 多模型管理（plan7 F5）──
  modelsList: 'models:list',
  /** `apiKey` 空串 = 不动已存的 Key */
  modelsSave: 'models:save',
  /** 至少要留一个（护栏在主进程）；被会话引用时界面要给提示 */
  modelsDelete: 'models:delete',
  modelsSetActive: 'models:set-active',
  /** 测试某个模型的连通性（用它自己的 Key） */
  modelsTest: 'models:test',
  modelsAvailable: 'models:available',
  modelsSetEntry: 'models:set-entry',
  // ── 目标（plan12）：跨轮次存活的长期意图 ──
  goalList: 'goal:list',
  goalCreate: 'goal:create',
  goalAction: 'goal:action',
  /** 彻底删除；「放弃」留痕、它不留 —— 两者不是一回事 */
  goalDelete: 'goal:delete',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatChunk: 'chat:chunk',
  /** 思考增量（与正文分开走：它是**过程**，不是回答） */
  chatReasoning: 'chat:reasoning',
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
  permissionGet: 'permission:get',
  permissionSet: 'permission:set',
  /** 省 token 档位（plan8 R9.1 §七②）：全局一档，不做会话级覆盖 */
  tokenTierGet: 'token-tier:get',
  tokenTierSet: 'token-tier:set',
  gitInfo: 'git:info',
  attachFile: 'attach:file',
  /** 按**路径**取附件：文件树拖入 / 系统拖入共用这一条，只差"路径从哪来" */
  attachPath: 'attach:path',
  /** 提示词优化：一次额外模型调用改写输入（要花钱） */
  promptPolish: 'prompt:polish',
  // ── 内置浏览器（真浏览器，Agent 可操控）──
  browserState: 'browser:state',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSetVisible: 'browser:set-visible',
  browserSetBounds: 'browser:set-bounds',
  browserChanged: 'browser:changed',
  logsOpen: 'logs:open',
  logsInfo: 'logs:info',
  // ── 检查点与回滚（plan8 R4）──
  checkpointList: 'checkpoint:list',
  checkpointGet: 'checkpoint:get',
  checkpointSides: 'checkpoint:sides',
  checkpointRevertHunk: 'checkpoint:revert-hunk',
  checkpointRollback: 'checkpoint:rollback',
  /** 一轮运行结束后推送（界面据此刷新"文件变更"页签） */
  checkpointChanged: 'checkpoint:changed',
  // ── 危险操作逐次确认（plan8 R5）：请求带 `conversationId`，用户才知道在批谁的 ──
  confirmRequest: 'confirm:request',
  confirmRespond: 'confirm:respond',
  // ── 会话回滚（plan10 B 批 · ④）──
  /** 回到某条消息之前：**只移游标、不删数据**，所以天然可撤销 */
  convRollback: 'conv:rollback',
  convUndoRollback: 'conv:undo-rollback',
  // ── 界面布局偏好（plan7 批 A0）──
  uiPrefsGet: 'ui-prefs:get',
  uiPrefsSet: 'ui-prefs:set',
  uiPrefsReset: 'ui-prefs:reset',
  // ── 待办清单（plan7 批 D 提前落地）：变化靠推送，拉取只在挂载/切会话时补一次 ──
  todoChanged: 'todo:changed',
  todoGet: 'todo:get',
  // ── 子代理运行（plan7 批 D：右栏「任务」页签）──
  subagentChanged: 'subagent:changed',
  subagentGet: 'subagent:get',
  // ── 关窗口前的会话落盘（plan11 P0-2）：主进程收到回执才真关 ──
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done',
  // ── 工作区文件树（plan7 批 A，只读）──
  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsReadBinary: 'fs:read-binary',
  // ── 工作区写操作（plan7 批 A2）：全部走统一写入服务 + 各开一个检查点轮次 ──
  fsWrite: 'fs:write',
  fsMkdir: 'fs:mkdir',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',
  fsImport: 'fs:import',
  fsReveal: 'fs:reveal',
  // ── 后台任务（plan7 批 D）──
  bgList: 'bg:list',
  bgKill: 'bg:kill',
  bgChanged: 'bg:changed',
  // ── 内置终端（plan7 批 C）──
  // ⚠️ 下面几个是**进程级**通道（终端属于工作区、不属于任何一条会话），与 `bgChanged` 同类：
  //    它们**不在** `STREAM_CONSTS` 里，而是**显式登记**在 `tests/unit/stream-envelope.test.ts`
  //    的 `EXEMPT_CONSTS` 里并写明理由 —— 那条守卫要求「豁免要写明白，不许靠"扫不到"蒙混过去」。
  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  terminalAck: 'terminal:ack',
  terminalResync: 'terminal:resync',
  terminalRestart: 'terminal:restart',
  terminalSnapshot: 'terminal:snapshot',
  terminalData: 'terminal:data',
  terminalState: 'terminal:state'
} as const

export type { UIPrefs } from './splitter'

export type { FsEntry, FsBinaryResult, FsListResult, FsReadResult } from './fs-tree'

/** 工作区写操作结果：失败也**用人话回**、不抛异常（界面直接拿去显示，不必再翻译一遍） */
export interface FsOpResult {
  ok: boolean
  message: string
  /** **外部冲突**（打开之后、保存之前被改过）：这时**不写盘**，让用户在覆盖 / 重新载入里选 —— 不许静默覆盖 */
  conflict?: boolean
  /** 写成功后的新 mtime（毫秒），编辑器拿它当新的冲突基线 */
  mtimeMs?: number
}

export type { TodoItem, TodoStatus, TodoStats } from './todo'

export type { SubagentJobEvent } from './agent'

export type { BackgroundTask } from './background'

/** **流式事件信封**（plan11 §2.1）：流式/推送通道一律带 `conversationId`，
 *  界面切会话后仍知道每个字该落到哪条会话 —— 这也是并发的前提（没有身份就会互相串）。
 *  ⚠️ 主进程里**只有 `main/chat-emitter.ts` 能发流式事件**，它把 id 在构造时闭包捕获，
 *  所以漏带 id 在结构上不可能发生（守常见 `tests/unit/stream-envelope.test.ts`）。 */
/** `chat:done` 的信封负载（plan8 R9）：收尾事件带货，而不是另开一条 `usage:changed` ——
 *  用量就是"这一轮的总结"，与"跑完了"同一时刻到；分两条发会出现"done 到了、usage 还没到"的中间态。
 *  `usage: null` = **厂商没报**（不是 0）→ 界面显示占用估算，不假装知道精确值。 */
export interface ChatDonePayload {
  usage: TokenUsage | null
  /** 本轮省下的估算 token（plan8 R9.1）：与 `usage` 并列而不合并 —— 一个是**厂商真值**、
   *  一个是**本地估算**，混在一起就分不清哪个数字能信。它**不进**会话用量账本。 */
  avoided?: number
  /** 这一轮用的档位（plan8 R9.1 §七②）：不记档位，事后按档位比数字就说不清数是从哪跑出来的。
   *  缺字段 = 老主进程 / 还没选过 → 界面**不显示档位标签**，不替它编默认值。 */
  tier?: TokenSaverTier
}

export interface StreamEnvelope<T> {
  conversationId: string
  payload: T
}

/** 危险操作确认请求（plan8 R5）：权限档管"能碰什么"（事先、粗粒度），
 *  它管"这一次要不要"（当场、细粒度）—— 互补关系，不是替代关系。 */
export interface ToolConfirmRequest {
  id: string
  /** 工具名（如 run_command） */
  tool: string
  /** 给人看的要害（如要执行的命令原文） */
  detail: string
  agent: string
  /** 会影响的位置（如工作区路径） */
  where: string
  /** 哪条会话在问（plan11 P0-3）：不标出来，单槽确认框会把 A 的内容换成 B，
   *  而用户以为批的是他看过的那一条。 */
  conversationId: string
  /** 确认的种类，界面据此说**不同的话**：文件回滚与会话回滚是两件事，说同一句话
   *  用户会以为点一个两个都退 —— plan10 §六 第 6 条专门要求会话回滚的确认文案里
   *  **不许出现"文件"二字**。缺省视为 `'command'`（老调用方不用改）。 */
  kind?: 'command' | 'rollback-messages'
}

/** 会话回滚的结果 */
export interface ConversationRollbackResult {
  /** 回滚后的**权威**会话（含可见正文）。
   *  ⚠️ 渲染端**必须用它覆盖自己的内存** —— 否则下次保存会把已"回滚掉"的内容写回去，
   *  等于**回滚被自己的界面撤销**（这类功能最经典的事故）。 */
  conversation: Conversation
  /** 还能不能撤销：被裁掉的尾巴还在不在 */
  canUndo: boolean
  /** 完整日志长度（可见 + 被裁掉的） */
  total: number
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
  // ── 多模型管理（plan7 F5）──
  listModels(): Promise<import('./models').ModelsView>
  saveModel(input: import('./models').ModelSaveInput): Promise<import('./models').ModelProfileView>
  /** 删除一个模型；至少要留一个（护栏在主进程，拦下时抛出人话理由） */
  deleteModel(id: string): Promise<void>
  setActiveModel(id: string): Promise<import('./models').ModelsView>
  /** 测试某个模型的连通性 —— 用**它自己的** Key，不是当前那把 */
  testModel(id: string): Promise<TestResult>
  listAvailableModels(id: string): Promise<import('./models').AvailableModels>
  setActiveModelEntry(profileId: string, entryId: string): Promise<import('./models').ModelsView>
  // ── 目标（plan12）──
  listGoals(conversationId: string): Promise<import('./goal').Goal[]>
  createGoal(input: {
    conversationId: string
    text: string
    doneWhen?: string
  }): Promise<import('./goal').Goal>
  /** 非法转移会抛出人话理由（例如「这条目标已经结束了，要先重开」） */
  actOnGoal(
    id: string,
    action: import('./goal').GoalAction,
    patch?: { text?: string; doneWhen?: string }
  ): Promise<import('./goal').Goal>
  deleteGoal(id: string): Promise<void>
  chatSend(input: { conversationId: string; messages: ChatMessage[] }): Promise<void>
  /** 停止**指定会话**的生成（plan11）：并发时"停止"必须指名道姓，不指名就是停错会话 */
  chatAbort(conversationId: string): Promise<void>
  onChatChunk(cb: (e: StreamEnvelope<string>) => void): () => void
  /** 思考增量（DeepSeek 系 reasoning_content）—— 界面显示"思考过程" */
  onChatReasoning(cb: (e: StreamEnvelope<string>) => void): () => void
  onChatDone(cb: (e: StreamEnvelope<ChatDonePayload>) => void): () => void
  onChatError(cb: (e: StreamEnvelope<string>) => void): () => void
  onChatTool(cb: (e: StreamEnvelope<import('./agent').ToolEvent>) => void): () => void
  runAgent(request: AgentRunRequest): Promise<AgentRunResult>
  getWorkspace(): Promise<WorkspaceInfo>
  pickWorkspace(): Promise<WorkspaceInfo | null>
  /** 切换到"已知工作区"（历史会话用过的路径）——不接受任意路径，收紧权限面 */
  setKnownWorkspace(path: string): Promise<WorkspaceInfo | null>
  revealWorkspace(path: string): Promise<void>
  listConversations(): Promise<ConversationMeta[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(input: ConversationCreateInput): Promise<Conversation>
  saveConversation(
    id: string,
    messages: ChatMessage[],
    /** 会话统计（plan8 R9 / R9.1）：**给了才更新，不给就保持盘上原值**。
     *  用对象而非并列参数 —— 这类"账"以后还会加，加一项就改签名会波及所有调用点。 */
    stats?: { usage?: TokenUsage; avoidedTokens?: number }
  ): Promise<ConversationMeta | null>
  renameConversation(id: string, title: string): Promise<ConversationMeta | null>
  deleteConversation(id: string): Promise<void>
  listSkills(): Promise<SkillInfo[]>
  getPermission(): Promise<PermissionPreset>
  setPermission(preset: PermissionPreset): Promise<PermissionPreset>
  /** 省 token 档位（plan8 R9.1 §七②）：全局一档，与权限档同样"存在主进程、界面只是视图" */
  getTokenTier(): Promise<TokenSaverTier>
  setTokenTier(tier: TokenSaverTier): Promise<TokenSaverTier>
  getGitInfo(): Promise<GitInfo | null>
  /** **回到第 `toIndex` 条消息之前**（plan10 B 批 ④）：走 R5 确认桥，用户拒绝 → 返回 `null`。
   *  ⚠️ **正在生成回复时拒绝** —— 流式还没结束就回滚，等于在动的数据上做手术。 */
  rollbackConversation(id: string, toIndex: number): Promise<ConversationRollbackResult | null>
  /** 撤销上一次回滚（把被裁掉的尾巴接回来；不需要确认 —— 它是**恢复**，不是破坏） */
  undoRollbackConversation(id: string): Promise<ConversationRollbackResult | null>
  /** 弹文件选择器并读入内容作为附件（工作区外的文件也能选，会在界面上标出来） */
  attachFile(): Promise<Attachment | null>
  /** 按路径取附件 —— 与 `attachFile` **共用同一份读取与边界规则**（只差"路径从哪来"）；
   *  边界规则见 `workspace-fs.readAttachment`。 */
  attachPath(pathOrRel: string): Promise<Attachment>
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
  openLogsDir(): Promise<boolean>
  getLogsInfo(): Promise<LogsInfo>
  // ── 检查点与回滚（plan8 R4）──
  /** 列出所有 Agent 运行轮次（新→旧） */
  listCheckpoints(): Promise<CheckpointRunMeta[]>
  getCheckpoint(runId: string): Promise<CheckpointRun | null>
  /** 取某文件"改前快照 vs 当前内容"两侧正文（Diff 视图用）：**纯读** —— 打开 Diff 视图不产生任何副作用 */
  getCheckpointSides(runId: string, rel: string): Promise<CheckpointSidesResult>
  /** 把某一处改动**退回去**：写入走**统一写入服务**，所以这次退回自己也会留下检查点轮次
   *  （"退错了还能再退"）；写盘内容由主进程用**与界面同一个** diff 实现算出来。 */
  revertCheckpointHunk(input: RevertHunkInput): Promise<RevertHunkResult>
  /** 回滚：不传 rel 即整轮回滚 */
  rollbackCheckpoint(runId: string, rel?: string): Promise<RollbackReport>
  /** 一轮运行结束后触发（界面刷新用） */
  onCheckpointChanged(cb: (e: StreamEnvelope<string>) => void): () => void
  // ── 危险操作逐次确认（plan8 R5）──
  /** 收到确认请求（界面弹对话框）—— 载荷里带 `conversationId`，用户才知道自己在批谁的 */
  onToolConfirmRequest(cb: (req: ToolConfirmRequest & { conversationId: string }) => void): () => void
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
  /** 读二进制文件用于预览：图片给 `dataUrl`、其余给 `hexHead`，超上限则 `tooLarge` 且**不给数据**。
   *  ⚠️ 渲染端**只能**用 `<img src>` 消费 `dataUrl` —— SVG 是可执行内容，
   *  走 `<object>` / `<iframe>` / 内联就等于执行工作区里的代码。 */
  readWorkspaceBinary(rel: string): Promise<FsBinaryResult>
  // ── 工作区写操作（plan7 批 A2）──
  // 全部经**统一写入服务**：留检查点快照 → 操作同样出现在「文件变更记录」里、同样退得回
  writeWorkspaceFile(rel: string, content: string, expectedMtimeMs?: number): Promise<FsOpResult>
  createWorkspaceDir(rel: string): Promise<FsOpResult>
  renameWorkspacePath(rel: string, nextRel: string): Promise<FsOpResult>
  /** 删除到**回收站**（不是硬删 —— 误删还能自己捞回来） */
  deleteWorkspacePath(rel: string): Promise<FsOpResult>
  /** 把工作区**外**的文件导入进来（拖拽上传） */
  importIntoWorkspace(sourceAbs: string, rel: string): Promise<FsOpResult>
  revealWorkspaceEntry(rel: string): Promise<void>
  // ── 后台任务（plan7 批 D）──
  /** 列出后台任务（挂载时拉一次，之后靠推送） */
  listBackgroundTasks(): Promise<BackgroundTask[]>
  /** 终止一条后台任务（连带它的子进程） */
  killBackgroundTask(id: string): Promise<boolean>
  onBackgroundChanged(cb: (list: BackgroundTask[]) => void): () => void
  // ── 内置终端（plan7 批 C）──
  /** 起会话（**幂等**：本工作区已有活会话就返回它）。
   *  ⚠️ 只读权限档下**主进程会拒绝** —— 不只是把按钮变灰。 */
  terminalStart(size?: { cols: number; rows: number }): Promise<TerminalStartResult>
  /** 写**原始按键**（真 PTY 下 shell 自己管行编辑/回显/补全，所以不是"写一整行"） */
  terminalWrite(data: string): Promise<{ ok: boolean; message?: string }>
  /** 终端尺寸变化（`fit()` 之后调）—— 不传的话 `vim`/进度条会画错 */
  terminalResize(cols: number, rows: number): Promise<void>
  terminalKill(): Promise<boolean>
  /** 背压回执（渲染 → 主进程）：这一段输出已经解析完了，主进程据此恢复/继续暂停 pty 读取 */
  terminalAck(sessionId: string, chars: number): Promise<void>
  /** 重放结束后的背压重对齐（渲染 → 主进程）—— 不复位的话 pty 会永远停在暂停上 */
  terminalResync(sessionId: string): Promise<void>
  terminalRestart(): Promise<TerminalStartResult>
  /** 当前会话快照（含输出缓冲与 `nextSeq`）—— **重挂时靠它重放，不重不漏** */
  terminalSnapshot(): Promise<TerminalSessionSnapshot | null>
  /** 增量输出（**进程级**通道） */
  onTerminalData(cb: (payload: TerminalDataPayload) => void): () => void
  /** 会话状态变化（起/停/退出）—— 界面据此显示"已结束/被停止" */
  onTerminalState(cb: (sessionId: string) => void): () => void
  /** 拖入的文件对象 → 磁盘绝对路径。⚠️ Electron 32+ 起 `File.path` 已移除，必须走 `webUtils.getPathForFile`。
   *  参数写成结构化类型而非 DOM 的 `File`：本文件也被主进程引入，而主进程 tsconfig 没有 DOM lib。 */
  getPathForFile(file: { name: string }): string
  // ── 待办清单（plan7 批 D 提前落地）──
  /** 指定会话的清单：组件挂载 / 切会话时拉一次，之后靠 onTodoChanged 推送 */
  getTodos(conversationId: string): Promise<TodoItem[]>
  onTodoChanged(cb: (e: StreamEnvelope<TodoItem[]>) => void): () => void
  // ── 子代理运行（plan7 批 D：右栏「任务」页签）──
  /** 指定会话最近一批子代理的运行事件（挂载 / 切会话时拉一次，之后靠推送） */
  getSubagents(conversationId: string): Promise<SubagentJobEvent[]>
  onSubagentChanged(cb: (e: StreamEnvelope<SubagentJobEvent[]>) => void): () => void
  // ── 关窗口前的会话落盘（plan11 P0-2）──
  /** 主进程要关窗口了：渲染端把所有在跑的会话落盘，然后回执 */
  onFlushRequest(cb: () => void): () => void
  flushDone(): Promise<void>
}
