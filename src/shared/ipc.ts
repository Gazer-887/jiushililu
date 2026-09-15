// 主 / 渲染进程共用的 IPC 通道与类型 —— 通道名字面量只在这里写一次，主/渲染两侧都从这里取。

import type { UIPrefs } from './splitter'
import type { TodoItem } from './todo'
import type { Goal } from './goal'
import type { TokenUsage } from './usage'
import type { TokenSaverTier } from './token-tier'
import type { SubagentJobEvent } from './agent'
import type { BackgroundTask } from './background'
import type { FsBinaryResult, FsListResult, FsReadResult, FsOpenResult } from './fs-tree'
import type { FsOfficeResult } from './office-preview'
import type { AskRequest, AskResult } from './ask'
import type { SystemSettings, SystemView } from './system'
import type { NetworkPatch, NetworkView } from './network'
import type { SystemFontsResult } from './font-names'
import type { GitChange } from './git-status'

export type ProviderType = 'openai-compatible' | 'anthropic'

/** 思考强度：统一词表，由适配层翻译成各厂商方言（reasoning_effort 档位 / Anthropic thinking 预算） */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'max'

export interface ModelSettings {
  providerType: ProviderType
  baseURL: string
  model: string
  /** 三个采样参数 null = 不发该字段、跟随厂商默认（与 0 不是一回事）。⚠️ Anthropic 规定 temperature 与 top_p 互斥，适配层按 top_p 优先处理。 */
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
  maxToolRounds: number
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

export interface AgentRunRequest {
  task: string
  agentName?: string
  /** 这轮跑属于哪条会话（plan11）；单次 Agent 调用本无对话上下文故可选 —— 缺省时主进程写一个明确哨兵值、不留空（出事要能查"这轮是谁跑的"）。 */
  conversationId?: string
}

export interface WorkspaceInfo {
  path: string
  custom: boolean
}

/** 存储位置（plan10 C 批）：应用自身数据（会话/设置/检查点等）的落点，可迁移到自定义目录 */
export interface StorageLocationInfo {
  /** 当前生效的数据目录（= userData） */
  current: string
  /** 是否自定义（非默认 AppData 目录） */
  custom: boolean
  /** 已保存、下次启动迁移生效的目标目录；null = 无待办迁移 */
  pendingDir: string | null
  /** pending 语义：'migrate' 换新目录 / 'restore' 回默认 */
  pendingKind: 'migrate' | 'restore' | null
  /** 最近一次迁移/回退事件（启动时发生，设置页提示条显示） */
  lastEvent: { kind: 'ok' | 'error'; text: string; at: string } | null
}

/** 存储位置写入结果：ok 带最新信息 / reason 是可直接显示的人话 / canceled 用户取消了目录框 */
export type StorageWriteResult =
  | { ok: true; info: StorageLocationInfo }
  | { ok: false; reason: string }
  | { canceled: true }

/** 访问权限档（D-032：能力归模型、**权限归人**）—— 唯一由用户定的档位，接 P1 白名单门控 */
export type PermissionPreset = 'read-only' | 'write' | 'full-access'

export interface Attachment {
  name: string
  path: string
  content: string
  truncated: boolean
  /** 这个文件**不在当前工作区内**（从系统里明确拖/选进来的）：只影响界面标记、不影响能不能读 —— 用户有权知道上下文里混进了"外面的"文件；边界规则见 `workspace-fs.readAttachment`。 */
  outside?: boolean
}

export interface GitInfo {
  branch: string
  dirty: boolean
}

/**
 * 源代码管理面板的完整视图（plan16）。
 *
 * 与主进程 `readGitStatus` 一一对应 —— 界面**不做增量推断**（自己猜哪条新增了），
 * 每次都拿整份重画。理由：git 状态有多个来源（Agent 改文件、终端跑命令、外面编辑器改），
 * 增量推断必漏，漏了就是"改了却不显示"这种最难查的假账。
 */
export interface GitStatusView {
  branch: string
  changes: GitChange[]
  /** 领先上游多少条提交（`↑ N`）。没有上游分支时为 0 —— 不是错误，本地分支本来就可以没上游 */
  ahead: number
}

/** 非仓库 / 未装 git 时，面板要**说清原因**而不是空白 —— 空面板会被读成"没改动" */
export interface GitStatusResult {
  ok: boolean
  view: GitStatusView | null
  /** 失败原因（原样带 git 的 stderr，用户要能照着去查） */
  message?: string
}

/** 一次写操作（暂存 / 取消暂存 / 提交）的结果。失败时 `message` 是 **git 的原话**，界面照着显示 */
export interface GitOpResult {
  ok: boolean
  message?: string
}

/** 提交结果：成功给一行摘要（回显"提交到哪了"），失败给原因 */
export interface GitCommitResult extends GitOpResult {
  summary: string
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface LogsInfo {
  dir: string | null
  files: string[]
}

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

import type { TerminalDataPayload, TerminalSessionSnapshot, TerminalStartResult } from './terminal'
export type { TerminalChunk, TerminalDataPayload, TerminalSessionSnapshot, TerminalStartResult } from './terminal'

export interface AgentRunResult {
  ok: boolean
  output: string
  rounds: number
  /** error = 调度/配置层失败（未真正执行） */
  stopReason: 'completed' | 'max-rounds' | 'error'
  agent: string
  error?: string
}


export interface ConversationMeta {
  id: string
  title: string
  workspace: string
  model: string
  /** 该会话绑定的**模型档案 id**（plan7 F5）：`model` 只是给人看/老数据里的模型名，只有它才能定位"用哪条连接 + 哪把 Key"。
   *  ⚠️ 老会话缺字段 → 按名字找同名档案兜底，**不许因为升级丢掉会话或打不开会话**。 */
  modelProfileId?: string
  skills: string[]
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 这条会话的**真实用量累计**（plan8 R9），必须落盘：牌上写的是"本会话累计"，一重启就归零就是在骗人。
   *  缺字段 = 老数据 / 还没跑过 → 界面显示"暂无"，**不补 0**。 */
  usage?: TokenUsage
  /** 这条会话**省下**的估算 token（plan8 R9.1）：不是厂商账，故与 `usage` 分开存 —— 混算等于两笔账糊一起 */
  avoidedTokens?: number
  /** **注入税**累计（plan19 §5.2）：记忆段每轮占掉的**估算** token。与 `usage` / `avoidedTokens` **三笔账分开**
   *  —— 厂商真值 / 我们替它做的减法 / 我们自己加的固定开销，混一起就分不清谁是谁 */
  memoryTokens?: number
  /** **最后一轮**用的省 token 档位（plan8 R9.1 §七②）：档位是全局设置、会话中途可换，故它只代表最近一次 —— 逐轮比对是校准 harness 的事。 */
  tokenTier?: TokenSaverTier
  /**
   * 会话正文的 **UTF-8 字节数**（批 2 plan19）：反思前置门用它判断是否值得跑（< 2048 字节跳过）。
   * ⚠️ 是 `Buffer.byteLength(JSON.stringify(messages), 'utf8')`，**不是字符数**
   *    （审查 B5 P0：中文字符 1 字符 = 3 字节，字符数会让中文会话全部误判为"过前置门"）。
   * 缺字段 = 老数据 / 还没保存过 → 反思前置门跳过（不跑反思，不报错）。
   */
  bodyBytes?: number
  /** 最近一次使用的**主 Agent**（plan17 D9）：缺字段 = 内核默认（老会话零回归）。落盘才能重启恢复 */
  agentName?: string
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[]
}

export interface ConversationCreateInput {
  workspace: string
  model: string
  modelProfileId?: string
  /** 会话创建时选的主 Agent（plan17）；缺省 = 内核默认 */
  agentName?: string
  /** 历史遗留（plan17 起 PlusMenu 不再写入）：老入口的技能勾选，保留兼容 */
  skills?: string[]
  firstMessage?: string
}

export interface SkillInfo {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
  /** plan22：被高层同名技能覆盖（不在生效集合，仅列表可见） */
  overridden?: boolean
}

// ── MCP 客户端（plan23）──────────────────────────────

export type McpTransportKind = 'stdio' | 'sse'

export interface McpServerConfig {
  /** 服务器名（kebab-slug，用作工具前缀 mcp__<name>__） */
  name: string
  transport: McpTransportKind
  command?: string
  args?: string[]
  /** ⚠️ 可能含 token —— 配置住 userData/mcp-servers.json（不入 git），写入走原子写 */
  env?: Record<string, string>
  url?: string
  enabled: boolean
}

export type McpServerState = 'connected' | 'error' | 'disabled'

export interface McpServerTool {
  name: string
  description?: string
  /** MCP inputSchema（JSON Schema）—— manager 聚合工具时透传给模型；UI 不展示 */
  inputSchema?: Record<string, unknown>
}

export interface McpServerStatus {
  config: McpServerConfig
  state: McpServerState
  error?: string
  tools: McpServerTool[]
}

export interface McpSaveResult {
  ok: boolean
  reason?: string
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsTest: 'settings:test',
  settingsSetModel: 'settings:set-model',
  modelsList: 'models:list',
  /** `apiKey` 空串 = 不动已存的 Key */
  modelsSave: 'models:save',
  /** 至少要留一个（护栏在主进程）；被会话引用时界面要给提示 */
  modelsDelete: 'models:delete',
  modelsSetActive: 'models:set-active',
  modelsTest: 'models:test',
  modelsAvailable: 'models:available',
  modelsSetEntry: 'models:set-entry',
  // ── 子 Agent 管理（plan17）──
  /** 三层全量视图（含被覆盖条目与加载警告）；工具目录走 `@shared/agents` 静态常量，不进载荷 */
  agentsList: 'agents:list',
  agentsRead: 'agents:read',
  agentsSave: 'agents:save',
  agentsDelete: 'agents:delete',
  /** save/delete 后的跨窗广播（AGENTS.md 多窗口铁律：广播 + 各窗重读，不搬变更内容） */
  agentsChanged: 'agents:changed',
  // ── 记忆（plan19 批 1）──
  /** 索引视图（含被预算截断的条数与解析警告）；正文按 `file` 单独取 */
  memoryList: 'memory:list',
  memoryRead: 'memory:read',
  memorySave: 'memory:save',
  memoryDelete: 'memory:delete',
  /** save/delete 后的跨窗广播（同 agents 口径） */
  memoryChanged: 'memory:changed',
  // ── 记忆批 2：候选批准/拒绝 + 统计 ──
  /** 批准候选条目（用候选覆盖旧记忆 + 删候选文件）；返回新条目 file */
  memoryApprove: 'memory:approve',
  /** 拒绝候选条目（删候选文件，不动旧记忆） */
  memoryReject: 'memory:reject',
  /** 取记忆统计（存活率 / 使用率，从事件流算） */
  memoryStats: 'memory:stats',
  /** 用户手工标记「这条不对」（plan19 批 4）：误伤率的唯一数据来源 */
  memoryFlag: 'memory:flag',
  // ── 记忆批 2：自动记忆成本设置（开关 + 日上限 + 反思模型）──
  memoryGetAuto: 'memory:get-auto',
  memorySetAuto: 'memory:set-auto',
  /** **记忆开关**（plan19 批 1）：批 1 只管通路 A（模型工具）是否下发，通路 B 不受它管 */
  memoryGetSwitch: 'memory:get-switch',
  memorySetSwitch: 'memory:set-switch',
  /**
   * **电脑控制开关**（2026-09-15 用户需求）。当前版本**尚无对应的电脑控制工具** —— 开关先落门控：
   * 状态会进自视段（模型对自身配置如实报告），工具上线后此处即权限闸。
   */
  computerControlGet: 'computer-control:get',
  computerControlSet: 'computer-control:set',
  /** 护栏 2 的落点（D-043）：**本轮**写入痕迹 —— 只推"刚发生的事实"，全量归巡检区 */
  memoryNotice: 'memory:notice',
  // ── Playbook（plan19 批 3，会做线）──
  /** 列出 Playbook 条目（含预算截断信息） */
  playbookList: 'playbook:list',
  /** 新建 / 编辑条目（带 file = 编辑） */
  playbookSave: 'playbook:save',
  /** 删除条目 */
  playbookDelete: 'playbook:delete',
  /** save/delete 后的跨窗广播（同 memory:changed 口径） */
  playbookChanged: 'playbook:changed',
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
  // 恢复内置默认工作区（plan7 批 F4）：选了自定义目录后得有一条回内置的路，否则默认落点成了单程票
  workspaceReset: 'workspace:reset',
  workspaceReveal: 'workspace:reveal',
  // ── 存储位置（plan10 C 批）：应用数据落点可配 + 启动时迁移 ──
  storageGet: 'storage:get',
  storagePick: 'storage:pick',
  storageReset: 'storage:reset',
  storageUndoPending: 'storage:undo-pending',
  convList: 'conv:list',
  convGet: 'conv:get',
  convCreate: 'conv:create',
  convSave: 'conv:save',
  convRename: 'conv:rename',
  convDelete: 'conv:delete',
  /**
   * **会话切换通知**（批 2 plan19）：渲染端切会话时主动告知主进程 prevId / nextId。
   * ⚠️ 主进程据此维护 `activeConversationId`（关窗落盘队列用它）+ 异步触发反思（不 await，50ms 内返回）。
   * **不是真相源**（真相源是渲染端 `activeId`），只是主进程的缓存，可能过时但**关窗时写队列是幂等的**。
   */
  convSwitch: 'conv:switch',
  skillsList: 'skills:list',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  mcpDelete: 'mcp:delete',
  mcpReconnect: 'mcp:reconnect',
  mcpChanged: 'mcp:changed',
  permissionGet: 'permission:get',
  permissionSet: 'permission:set',
  tokenTierGet: 'token-tier:get',
  tokenTierSet: 'token-tier:set',
  // ── 系统集成（plan7 批 F1）：后台运行 + 开机自启 ──
  systemGet: 'system:get',
  systemSet: 'system:set',
  // ── 网络代理（plan7 批 F2）：三档 + 手动地址 + 凭据（凭据只进不出）──
  netProxyGet: 'net-proxy:get',
  netProxySet: 'net-proxy:set',
  // ── 界面字体（plan7 批 F3）：系统字体枚举（主进程读注册表，document.fonts 只有已加载的）──
  fontsList: 'fonts:list',
  gitInfo: 'git:info',
  // ── 源代码管理（plan16）：变更列表 / 暂存 / 提交 ──
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitCommit: 'git:commit',
  /** Git 状态变化的广播（进程级，不混用 `settings:changed`）：写操作 / 工作区文件变更 / 终端跑完命令后发 */
  gitChanged: 'git:changed',
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
  checkpointList: 'checkpoint:list',
  checkpointGet: 'checkpoint:get',
  checkpointSides: 'checkpoint:sides',
  checkpointRevertHunk: 'checkpoint:revert-hunk',
  checkpointRollback: 'checkpoint:rollback',
  checkpointChanged: 'checkpoint:changed',
  // ── 危险操作逐次确认（plan8 R5）：请求带 `conversationId`，用户才知道在批谁的 ──
  confirmRequest: 'confirm:request',
  confirmRespond: 'confirm:respond',
  // ── Agent 向用户提问（带选项）：与确认桥**分开两条通道**（安全语义 vs 信息语义，理由见 `@shared/ask` 文件头）──
  askRequest: 'ask:request',
  askRespond: 'ask:respond',
  // ── 会话回滚（plan10 B 批 · ④）──
  /** 回到某条消息之前：**只移游标、不删数据**，所以天然可撤销 */
  convRollback: 'conv:rollback',
  convUndoRollback: 'conv:undo-rollback',
  uiPrefsGet: 'ui-prefs:get',
  uiPrefsSet: 'ui-prefs:set',
  uiPrefsReset: 'ui-prefs:reset',
  todoChanged: 'todo:changed',
  todoGet: 'todo:get',
  /** Agent 自建目标时的实时推送（plan12 ⑤，带会话信封）；用户侧操作后由 goal:list 重拉，不走这条 */
  goalChanged: 'goal:changed',
  subagentChanged: 'subagent:changed',
  subagentGet: 'subagent:get',
  flushRequest: 'app:flush-request',
  flushDone: 'app:flush-done',
  // ── 设置独立窗口（2026-09-13）──
  // 开设置窗口（幂等：已开则聚焦，不开第二个）
  settingsOpenWindow: 'settings:open-window',
  // 关设置窗口（由**设置窗口自己**发起：按 Esc。渲染端拿不到 BrowserWindow，只能走主进程；
  // ⚠️ 刻意不画自绘关闭按钮——系统标题栏已有 ×，双 × 紧贴易误关整个应用，2026-09-14 用户反馈）
  settingsCloseWindow: 'settings:close-window',
  // ⚠️ 变更广播是**进程级**通道（每个窗口都该收到，与终端/后台任务同类）——
  //    它不在 `STREAM_CONSTS` 里，须显式登记进 `stream-envelope.test.ts` 的 `EXEMPT_CONSTS`。
  settingsChanged: 'settings:changed',
  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsReadBinary: 'fs:read-binary',
  // ── Office 内嵌预览（2026-09-14，用户反馈 docx 只能看十六进制）──
  // 主进程解析 docx/xlsx → 注册内存预览 → 渲染端拿 `jsl-preview://mem/<token>` 用沙箱 iframe 加载。
  // 解析放主进程是刻意的：渲染层「零 HTML 注入原语」的安全基线不破（真源见 shared/office-preview.ts）。
  officePreview: 'office:preview',
  /** 用系统默认程序打开工作区内的文件（pptx 等不支持内嵌的格式的出口；shell.openPath） */
  fsOpenInSystem: 'fs:open-in-system',
  // ── 工作区写操作（plan7 批 A2）：全部走统一写入服务 + 各开一个检查点轮次 ──
  fsWrite: 'fs:write',
  fsMkdir: 'fs:mkdir',
  fsRename: 'fs:rename',
  fsDelete: 'fs:delete',
  fsImport: 'fs:import',
  fsReveal: 'fs:reveal',
  bgList: 'bg:list',
  bgKill: 'bg:kill',
  bgChanged: 'bg:changed',
  // ⚠️ 下面几个是**进程级**通道（终端属于工作区、不属于任何一条会话）：它们**不在** `STREAM_CONSTS` 里，而是**显式登记**在 `tests/unit/stream-envelope.test.ts` 的 `EXEMPT_CONSTS` 里并写明理由。
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

export type { FsEntry, FsBinaryResult, FsListResult, FsReadResult, FsOpenResult } from './fs-tree'

export type { FsOfficeResult, OfficeSheetEntry } from './office-preview'

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

// 提问契约在 `@shared/ask`：这里**再导出**一次，渲染端只认 `@shared/ipc` 一个模块入口，不必到处记路径
export type { AskAnswer, AskOption, AskRequest, AskResult } from './ask'

export type { SubagentJobEvent } from './agent'

export type { BackgroundTask } from './background'

/** **流式事件信封**（plan11 §2.1）：流式/推送通道一律带 `conversationId`，界面切会话后仍知道每个字该落到哪条会话 —— 这也是并发的前提。
 *  ⚠️ 主进程里**只有 `main/chat-emitter.ts` 能发流式事件**（id 在构造时闭包捕获，漏带 id 在结构上不可能，守常见 `tests/unit/stream-envelope.test.ts`）。 */
/** `chat:done` 的信封负载（plan8 R9）：收尾事件带货，而不是另开一条 `usage:changed` —— 用量就是"这一轮的总结"，同时刻到。`usage: null` = **厂商没报**（不是 0），界面显示占用估算、不假装知道精确值。 */
export interface ChatDonePayload {
  usage: TokenUsage | null
  /** 本轮省下的估算 token（plan8 R9.1）：与 `usage` 并列而不合并 —— 一个是**厂商真值**、一个是**本地估算**；它**不进**会话用量账本。 */
  avoided?: number
  /** 这一轮用的档位（plan8 R9.1 §七②）：不记档位，事后按档比数字就说不清数是从哪跑出来的。缺字段 = 老主进程 → 界面**不显示档位标签**，不替它编默认值。 */
  tier?: TokenSaverTier
  /** **注入税**（plan19 §5.2）：本轮记忆段占掉的**本地估算** token。缺/为 0 = 没有记忆段 → 界面**不显示**，不显示 0。 */
  memoryTokens?: number
}

export interface StreamEnvelope<T> {
  conversationId: string
  payload: T
}

/** 危险操作确认请求（plan8 R5）：权限档管"能碰什么"（事先、粗粒度），它管"这一次要不要"（当场、细粒度）—— 互补关系，不是替代关系。 */
export interface ToolConfirmRequest {
  id: string
  tool: string
  detail: string
  agent: string
  where: string
  /** 哪条会话在问（plan11 P0-3）：不标出来，单槽确认框会把 A 的内容换成 B，而用户以为批的是他看过的那一条。 */
  conversationId: string
  /** 确认的种类，界面据此说**不同的话**：文件回滚与会话回滚是两件事，说同一句话用户会以为点一个两个都退（会话回滚的文案里**不许出现"文件"二字**）。缺省视为 `'command'`。 */
  kind?: 'command' | 'rollback-messages'
}

/** 会话回滚的结果 */
export interface ConversationRollbackResult {
  /** 回滚后的**权威**会话（含可见正文）。⚠️ 渲染端**必须用它覆盖自己的内存** —— 否则下次保存会把已"回滚掉"的内容写回去，等于**回滚被自己的界面撤销**。 */
  conversation: Conversation
  canUndo: boolean
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
  listModels(): Promise<import('./models').ModelsView>
  saveModel(input: import('./models').ModelSaveInput): Promise<import('./models').ModelProfileView>
  deleteModel(id: string): Promise<void>
  setActiveModel(id: string): Promise<import('./models').ModelsView>
  /** 测试某个模型的连通性 —— 用**它自己的** Key，不是当前那把 */
  testModel(id: string): Promise<TestResult>
  listAvailableModels(id: string): Promise<import('./models').AvailableModels>
  setActiveModelEntry(profileId: string, entryId: string): Promise<import('./models').ModelsView>
  listGoals(conversationId: string): Promise<import('./goal').Goal[]>
  createGoal(input: {
    conversationId: string
    text: string
    doneWhen?: string
  }): Promise<import('./goal').Goal>
  actOnGoal(
    id: string,
    action: import('./goal').GoalAction,
    patch?: { text?: string; doneWhen?: string }
  ): Promise<import('./goal').Goal>
  deleteGoal(id: string): Promise<void>
  chatSend(input: {
    conversationId: string
    messages: ChatMessage[]
    /** 本次发送用的主 Agent（plan17）：不带 = 内核默认；带了但定义不存在 → 主进程报人话错误 */
    agentName?: string
  }): Promise<void>
  chatAbort(conversationId: string): Promise<void>
  onChatChunk(cb: (e: StreamEnvelope<string>) => void): () => void
  onChatReasoning(cb: (e: StreamEnvelope<string>) => void): () => void
  onChatDone(cb: (e: StreamEnvelope<ChatDonePayload>) => void): () => void
  onChatError(cb: (e: StreamEnvelope<string>) => void): () => void
  onChatTool(cb: (e: StreamEnvelope<import('./agent').ToolEvent>) => void): () => void
  runAgent(request: AgentRunRequest): Promise<AgentRunResult>
  getWorkspace(): Promise<WorkspaceInfo>
  pickWorkspace(): Promise<WorkspaceInfo | null>
  /** 切换到"已知工作区"（历史会话用过的路径）——不接受任意路径，收紧权限面 */
  setKnownWorkspace(path: string): Promise<WorkspaceInfo | null>
  /** 恢复内置默认工作区（plan7 批 F4）：**只影响新任务** —— 已创建的会话各自绑定当时的工作区，不动 */
  resetWorkspace(): Promise<WorkspaceInfo>
  revealWorkspace(path: string): Promise<void>
  // 存储位置（plan10 C 批）
  getStorageLocation(): Promise<StorageLocationInfo>
  pickStorageDir(): Promise<StorageWriteResult>
  resetStorageLocation(): Promise<StorageWriteResult>
  undoStoragePending(): Promise<StorageWriteResult>
  listConversations(): Promise<ConversationMeta[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(input: ConversationCreateInput): Promise<Conversation>
  saveConversation(
    id: string,
    messages: ChatMessage[],
    /** 会话统计（plan8 R9 / R9.1 / plan17）：**给了才更新，不给就保持盘上原值**。用对象而非并列参数 —— 这类"账"以后还会加。 */
    stats?: { usage?: TokenUsage; avoidedTokens?: number; agentName?: string }
  ): Promise<ConversationMeta | null>
  renameConversation(id: string, title: string): Promise<ConversationMeta | null>
  deleteConversation(id: string): Promise<void>
  listSkills(): Promise<SkillInfo[]>
  /** MCP（plan23）：服务器列表（含状态与工具数） */
  mcpListServers(): Promise<McpServerStatus[]>
  mcpSaveServer(config: McpServerConfig): Promise<McpSaveResult>
  mcpDeleteServer(name: string): Promise<McpSaveResult>
  mcpReconnect(name: string): Promise<McpSaveResult>
  onMcpChanged(cb: () => void): () => void
  // ── 子 Agent 管理（plan17）──
  listAgents(): Promise<import('./agents').AgentsView>
  readAgent(file: string): Promise<import('./agents').AgentSaveInput | null>
  saveAgent(input: import('./agents').AgentSaveInput): Promise<import('./agents').AgentSaveResult>
  deleteAgent(file: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** save/delete 后各窗重读的信号（不搬变更内容） */
  onAgentsChanged(cb: () => void): () => void
  // ── 记忆（plan19 批 1）──
  listMemory(): Promise<import('./memory').MemoryIndex>
  readMemory(file: string): Promise<import('./memory').MemoryEntry | null>
  saveMemory(input: import('./memory').MemorySaveInput): Promise<import('./memory').MemorySaveResult>
  deleteMemory(file: string): Promise<boolean>
  /** **记忆开关**：批 1 只管通路 A。`warnFullAccess` = 开启时正处于完全访问档（判据 14 要当场告警） */
  getMemorySwitch(): Promise<boolean>
  setMemorySwitch(enabled: boolean): Promise<import('./memory').MemorySwitchResult>
  /** **电脑控制开关**（2026-09-15）：当前无对应工具，先落门控（状态进自视段） */
  getComputerControl(): Promise<boolean>
  setComputerControl(enabled: boolean): Promise<boolean>
  /** save/delete 后各窗重读的信号（不搬变更内容） */
  onMemoryChanged(cb: () => void): () => void
  /** 护栏 2：本轮写入痕迹（`<MemoryNotice />` 的数据源，D-043） */
  onMemoryNotice(cb: (notice: import('./memory').MemoryNoticeEvent) => void): () => void
  // ── 记忆批 2：会话切换通知 + 候选批准/拒绝 + 统计 ──
  /** 通知主进程会话切换（prevId 可为 null = 从空切换；nextId 可为 null = 切到空会话） */
  switchConversation(prevId: string | null, nextId: string | null): Promise<void>
  /** 批准候选：用候选内容覆盖旧记忆 + 删候选文件；返回新条目 file */
  approveMemory(file: string): Promise<import('./memory').MemorySaveResult>
  /** 拒绝候选：删候选文件，旧记忆不动 */
  rejectMemory(file: string): Promise<boolean>
  /** 取记忆统计（存活率/使用率）。没事件可算 → 返回 null，界面显示「暂无」 */
  getMemoryStats(): Promise<import('./memory').MemoryStats | null>
  /** 用户手工标记「这条不对」（批 4）：只在事件流落一条 `flag`，**不改条目本身** */
  flagMemory(name: string): Promise<boolean>
  /**
   * 自动记忆成本设置（批 2）：开关 + 日上限 + 反思模型。
   * ⚠️ `autoMemoryEnabled` 缺省时由档位提供默认值（轻量档关、其余档开）；显式设过不被档位覆盖。
   */
  getMemoryAuto(): Promise<import('./memory').MemoryAutoSettings>
  setMemoryAuto(patch: Partial<import('./memory').MemoryAutoSettings>): Promise<import('./memory').MemoryAutoSettings>
  // ── Playbook（plan19 批 3，会做线）──
  /** 列出 Playbook 条目（含预算截断信息） */
  listPlaybook(): Promise<import('./playbook').PlaybookIndex>
  /** 新建 / 编辑条目（`file` 有值 = 编辑既有条目） */
  savePlaybook(input: import('./playbook').PlaybookSaveInput): Promise<import('./playbook').PlaybookSaveResult>
  /** 删除条目 */
  deletePlaybook(file: string): Promise<boolean>
  /** save/delete 后各窗重读的信号（不搬变更内容） */
  onPlaybookChanged(cb: () => void): () => void
  getPermission(): Promise<PermissionPreset>
  setPermission(preset: PermissionPreset): Promise<PermissionPreset>
  /** 省 token 档位（plan8 R9.1 §七②）：全局一档，与权限档同样"存在主进程、界面只是视图" */
  getTokenTier(): Promise<TokenSaverTier>
  setTokenTier(tier: TokenSaverTier): Promise<TokenSaverTier>
  /** 系统集成（plan7 批 F1）：值与**真生效状态**都由主进程给（界面不猜） */
  getSystem(): Promise<SystemView>
  setSystem(patch: Partial<SystemSettings>): Promise<SystemView>
  /** 网络代理（plan7 批 F2）：**当前生效的代理**由主进程探测后给，界面不猜 */
  getNetwork(): Promise<NetworkView>
  setNetwork(patch: NetworkPatch): Promise<NetworkView>
  /** 系统字体枚举（plan7 批 F3）：**列不出就明说**，不做假下拉框 */
  listFonts(): Promise<SystemFontsResult>
  getGitInfo(): Promise<GitInfo | null>
  // ── 源代码管理（plan16）──
  /** 完整状态（分支 + 变更列表 + 待推送计数）。**非 Git 仓库不是错误** —— 走 `ok:false` + `message` 说清原因 */
  getGitStatus(): Promise<GitStatusResult>
  /** 某文件「工作区 vs HEAD」的差异原文（unified 格式）。空串 = 该文件没有可显示的差异 */
  getGitDiff(rel: string): Promise<string>
  gitStage(rels: string[]): Promise<GitOpResult>
  gitUnstage(rels: string[]): Promise<GitOpResult>
  gitCommit(message: string): Promise<GitCommitResult>
  /** Git 状态变了（自己提交完 / Agent 改了文件 / 终端跑了 git 命令）—— 面板据此**重拉**，不靠定时器猜 */
  onGitChanged(cb: () => void): () => void
  /** **回到第 `toIndex` 条消息之前**（plan10 B 批 ④）：走 R5 确认桥，用户拒绝 → 返回 `null`。⚠️ **正在生成回复时拒绝** —— 流式没结束就回滚等于在动的数据上做手术。 */
  rollbackConversation(id: string, toIndex: number): Promise<ConversationRollbackResult | null>
  /** 撤销上一次回滚（把被裁掉的尾巴接回来；不需要确认 —— 它是**恢复**，不是破坏） */
  undoRollbackConversation(id: string): Promise<ConversationRollbackResult | null>
  attachFile(): Promise<Attachment | null>
  /** 按路径取附件 —— 与 `attachFile` **共用同一份读取与边界规则**（只差"路径从哪来"）。 */
  attachPath(pathOrRel: string): Promise<Attachment>
  polishPrompt(text: string): Promise<string>
  getBrowserState(): Promise<BrowserState>
  browserNavigate(url: string): Promise<BrowserState>
  browserBack(): Promise<BrowserState>
  browserForward(): Promise<BrowserState>
  browserReload(): Promise<BrowserState>
  setBrowserVisible(visible: boolean): Promise<void>
  setBrowserBounds(bounds: BrowserBounds): Promise<void>
  onBrowserChanged(cb: (s: BrowserState) => void): () => void
  openLogsDir(): Promise<boolean>
  getLogsInfo(): Promise<LogsInfo>
  listCheckpoints(): Promise<CheckpointRunMeta[]>
  getCheckpoint(runId: string): Promise<CheckpointRun | null>
  /** 取某文件"改前快照 vs 当前内容"两侧正文（Diff 视图用）：**纯读** —— 打开 Diff 视图不产生任何副作用 */
  getCheckpointSides(runId: string, rel: string): Promise<CheckpointSidesResult>
  /** 把某一处改动**退回去**：写入走**统一写入服务**（这次退回自己也会留下检查点轮次，"退错了还能再退"）；写盘内容由主进程用**与界面同一个** diff 实现算出来。 */
  revertCheckpointHunk(input: RevertHunkInput): Promise<RevertHunkResult>
  rollbackCheckpoint(runId: string, rel?: string): Promise<RollbackReport>
  onCheckpointChanged(cb: (e: StreamEnvelope<string>) => void): () => void
  // ── 危险操作逐次确认（plan8 R5）──
  /** 收到确认请求（界面弹对话框）—— 载荷里带 `conversationId`，用户才知道自己在批谁的 */
  onToolConfirmRequest(cb: (req: ToolConfirmRequest & { conversationId: string }) => void): () => void
  /** 回传用户答复；无人应答时主进程超时按拒绝处理 */
  respondToolConfirm(result: ToolConfirmResult): Promise<void>
  // ── Agent 向用户提问（带选项）──
  /** 收到提问（界面弹卡片让用户选）—— 载荷自带 `conversationId`，用户才知道这条问题出自哪条会话 */
  onAskRequest(cb: (req: AskRequest) => void): () => void
  /** 回传作答。⚠️ 返回 `false` = 主进程**没认领**（已超时 / 已被中断 / 值不在选项里）：界面据此如实说明，
   *  不许当成送达 —— 那正是把"没人回答"翻译成"用户选了"的那类假账。 */
  respondAsk(result: AskResult): Promise<boolean>
  getUIPrefs(): Promise<UIPrefs>
  setUIPrefs(patch: Partial<UIPrefs>): Promise<UIPrefs>
  resetUIPrefs(): Promise<UIPrefs>
  // ── 设置独立窗口（2026-09-13）──
  /** 开设置窗口。**幂等**：已开则聚焦，不开第二个。 */
  openSettingsWindow(): Promise<void>
  /** 关设置窗口（设置窗口自己点 × 时调；渲染端拿不到 BrowserWindow） */
  closeSettingsWindow(): Promise<void>
  /** 设置变更广播（进程级，不带会话信封）。`kind` 说明变的是哪一类，界面据此决定重读什么。 */
  onSettingsChanged(cb: (kind: 'settings' | 'ui-prefs' | 'models') => void): () => void
  listWorkspaceDir(rel: string): Promise<FsListResult>
  readWorkspaceFile(rel: string): Promise<FsReadResult>
  /** 读二进制文件用于预览：图片给 `dataUrl`、其余给 `hexHead`，超上限则 `tooLarge` 且**不给数据**。
   *  ⚠️ 渲染端**只能**用 `<img src>` 消费 `dataUrl` —— SVG 是可执行内容，走 `<object>` / `<iframe>` / 内联就等于执行工作区里的代码。 */
  readWorkspaceBinary(rel: string): Promise<FsBinaryResult>
  /** Office 内嵌预览（docx/xlsx/xls/xlsm）：主进程解析后返回**沙箱 URL**（内存预览），
   *  渲染端只许用 `<iframe sandbox="">` 加载 —— HTML 是用户文件内容，不许进主文档。 */
  previewOffice(rel: string): Promise<FsOfficeResult>
  /** 用系统默认程序打开工作区内的文件（pptx 等不支持内嵌预览的格式的出口） */
  openWorkspacePathInSystem(rel: string): Promise<FsOpenResult>
  // ── 工作区写操作（plan7 批 A2）──
  writeWorkspaceFile(rel: string, content: string, expectedMtimeMs?: number): Promise<FsOpResult>
  createWorkspaceDir(rel: string): Promise<FsOpResult>
  renameWorkspacePath(rel: string, nextRel: string): Promise<FsOpResult>
  /** 删除到**回收站**（不是硬删 —— 误删还能自己捞回来） */
  deleteWorkspacePath(rel: string): Promise<FsOpResult>
  /** 把工作区**外**的文件导入进来（拖拽上传） */
  importIntoWorkspace(sourceAbs: string, rel: string): Promise<FsOpResult>
  revealWorkspaceEntry(rel: string): Promise<void>
  listBackgroundTasks(): Promise<BackgroundTask[]>
  /** 终止一条后台任务（连带它的子进程） */
  killBackgroundTask(id: string): Promise<boolean>
  onBackgroundChanged(cb: (list: BackgroundTask[]) => void): () => void
  /** 起会话（**幂等**）。⚠️ 只读权限档下**主进程会拒绝** —— 不只是把按钮变灰。 */
  terminalStart(size?: { cols: number; rows: number }): Promise<TerminalStartResult>
  /** 写**原始按键**（真 PTY 下 shell 自己管行编辑/回显/补全，所以不是"写一整行"） */
  terminalWrite(data: string): Promise<{ ok: boolean; message?: string }>
  terminalResize(cols: number, rows: number): Promise<void>
  terminalKill(): Promise<boolean>
  /** 背压回执（渲染 → 主进程）：这一段输出已经解析完了，主进程据此恢复/继续暂停 pty 读取 */
  terminalAck(sessionId: string, chars: number): Promise<void>
  /** 重放结束后的背压重对齐（渲染 → 主进程）—— 不复位的话 pty 会永远停在暂停上 */
  terminalResync(sessionId: string): Promise<void>
  terminalRestart(): Promise<TerminalStartResult>
  /** 当前会话快照（含输出缓冲与 `nextSeq`）—— **重挂时靠它重放，不重不漏** */
  terminalSnapshot(): Promise<TerminalSessionSnapshot | null>
  onTerminalData(cb: (payload: TerminalDataPayload) => void): () => void
  onTerminalState(cb: (sessionId: string) => void): () => void
  /** 拖入的文件对象 → 磁盘绝对路径。⚠️ Electron 32+ 起 `File.path` 已移除，必须走 `webUtils.getPathForFile`；
   *  参数写成结构化类型而非 DOM 的 `File`：本文件也被主进程引入，而主进程 tsconfig 没有 DOM lib。 */
  getPathForFile(file: { name: string }): string
  // ── 待办清单（plan7 批 D 提前落地）──
  getTodos(conversationId: string): Promise<TodoItem[]>
  onTodoChanged(cb: (e: StreamEnvelope<TodoItem[]>) => void): () => void
  /** Agent 自建目标（plan12 ⑤）：实时并入当前会话的目标列表 */
  onGoalChanged(cb: (e: StreamEnvelope<Goal>) => void): () => void
  getSubagents(conversationId: string): Promise<SubagentJobEvent[]>
  onSubagentChanged(cb: (e: StreamEnvelope<SubagentJobEvent[]>) => void): () => void
  // ── 关窗口前的会话落盘（plan11 P0-2）──
  onFlushRequest(cb: () => void): () => void
  flushDone(): Promise<void>
}
