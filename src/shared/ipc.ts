// 主 / 渲染进程共享的 IPC 通道定义与类型 —— 两边类型都从这里引用，唯一来源。

import type { UIPrefs } from './splitter'
import type { TodoItem } from './todo'
import type { TokenUsage } from './usage'
import type { TokenSaverTier } from './token-tier'
import type { SubagentJobEvent } from './agent'
import type { BackgroundTask } from './background'
import type { FsBinaryResult, FsListResult, FsReadResult } from './fs-tree'

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
  /**
   * 这次跑属于哪条会话（plan11）。
   * 单次 Agent 调用（plan6 D3/D4）本就没有对话上下文，故**可选**；
   * 缺省时主进程会记成一个明确的哨兵值，而不是留空 —— 出事时要能查"这轮是谁跑的"。
   */
  conversationId?: string
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
  /** 绝对路径 */
  path: string
  /** 已读取的文本内容（过长会被截断） */
  content: string
  /** 内容是否被截断 */
  truncated: boolean
  /**
   * 这个文件**不在当前工作区内**（主人从系统里明确拖/选进来的）。
   *
   * 只影响界面标记，不影响能不能读 —— 边界规则见 `workspace-fs.readAttachment`。
   * 之所以要标出来：工作区是 Agent 的活动范围，用户有权知道自己的上下文里
   * 混进了一份"外面的"文件。
   */
  outside?: boolean
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
  /**
   * 该会话绑定的**模型档案 id**（plan7 F5 之后新增）。
   *
   * 为什么两个字段都留着：`model` 是**模型名**（给人看、也是老数据的全部信息），
   * `modelProfileId` 才能定位"用哪条连接 + 哪把 Key"。
   * 老会话没有这个字段 → 打开时按名字找同名档案兜底（找得到就绑上，找不到就用当前档案）
   * —— **不许因为升级而丢掉会话或让会话打不开**。
   */
  modelProfileId?: string
  /** 勾选启用的内置技能（agent 定义名） */
  skills: string[]
  createdAt: number
  updatedAt: number
  messageCount: number
  /**
   * 这条会话的**真实用量累计**（plan8 R9）。
   *
   * 为什么必须落盘而不是只放内存：界面上这块牌写的是"本会话累计"，
   * 一重启就归零的话，这个数字就是在骗人 —— 用户会拿它做判断（哪条会话烧得多）。
   *
   * 缺字段 = 老数据 / 还没跑过：界面据此显示"暂无"，**不补 0**。
   */
  usage?: TokenUsage
  /**
   * 这条会话累计**省下**的估算 token（plan8 R9.1 工具输出窗口化）。
   * 与 `usage` 分开存：它不是厂商账，是"我们替你做掉的量"，混着算等于两笔账糊在一起。
   */
  avoidedTokens?: number
  /**
   * 这条会话**最后一轮用的省 token 档位**（plan8 R9.1 §七②）。
   *
   * 为什么留在会话索引里：同一条会话中途换档是允许的（档位是全局设置，随时可改），
   * 所以这个字段只代表"最近一次"——**它够用了**：用户问的是"我这会话是在哪种档位下跑的"，
   * 而真要逐轮比对，那属于校准 harness 的事，不该让会话索引承担。
   */
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
  /** 列出全部模型档案 + 当前用哪个 + models.json 的真实路径 */
  modelsList: 'models:list',
  /** 新建或编辑一个模型（`apiKey` 空串 = 不动已存的 Key） */
  modelsSave: 'models:save',
  /** 删除一个模型（至少要留一个；被会话引用时界面要给提示） */
  modelsDelete: 'models:delete',
  /** 切换"当前用哪个模型" */
  modelsSetActive: 'models:set-active',
  /** 测试某个模型的连通性（用它自己的 Key） */
  modelsTest: 'models:test',
  /** 「获取可用模型」：拉厂商那边的模型列表（F5.1） */
  modelsAvailable: 'models:available',
  /** 切换某端点内**当前用哪个模型**（模型目录里的「用」） */
  modelsSetEntry: 'models:set-entry',
  // ── 目标（plan12）：跨轮次存活的长期意图 ──
  /** 列某条会话的目标 */
  goalList: 'goal:list',
  /** 新建目标（用户手建，或 Agent 自建） */
  goalCreate: 'goal:create',
  /** 施加动作：暂停 / 继续 / 完成 / 重开 / 放弃 / 编辑 */
  goalAction: 'goal:action',
  /** 彻底删除（与「放弃」不同：放弃留痕） */
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
  /** 访问权限档（只读 / 可写 / 完全访问） */
  permissionGet: 'permission:get',
  permissionSet: 'permission:set',
  /** 省 token 档位（plan8 R9.1 §七②）：全局一档，不做会话级覆盖 */
  tokenTierGet: 'token-tier:get',
  tokenTierSet: 'token-tier:set',
  /** 当前工作区的 Git 分支 */
  gitInfo: 'git:info',
  /** 选择文件作为上下文附件（读入内容） */
  attachFile: 'attach:file',
  /** 按**路径**取附件（文件树拖进输入框 / 系统文件拖进来） */
  attachPath: 'attach:path',
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
  // ── 会话回滚（plan10 B 批 · ④）──
  /** 回到某条消息之前（**只移游标、不删数据**，所以天然可撤销） */
  convRollback: 'conv:rollback',
  /** 撤销上一次回滚 */
  convUndoRollback: 'conv:undo-rollback',
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
  // ── 关窗口前的会话落盘（plan11 P0-2）──
  /** 主进程 → 界面：要关窗口了，先把所有在跑的会话落盘 */
  flushRequest: 'app:flush-request',
  /** 界面 → 主进程：落盘完成（主进程收到才真关） */
  flushDone: 'app:flush-done',
  // ── 工作区文件树（plan7 批 A，只读）──
  fsList: 'fs:list',
  fsRead: 'fs:read',
  /** 读**二进制**文件（plan7 批 A3：图片 → data URL；其余 → 十六进制头部） */
  fsReadBinary: 'fs:read-binary',
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
export type { FsEntry, FsBinaryResult, FsListResult, FsReadResult } from './fs-tree'

/**
 * 工作区写操作结果（plan7 批 A2）——
 * 失败也**用人话回**、不抛异常：界面直接拿去显示，不必再翻译一遍
 */
export interface FsOpResult {
  ok: boolean
  message: string
  /**
   * **外部冲突**（plan7 批 A3 范围② 的边界②）：文件在"打开之后、保存之前"被改过。
   * 这时**不写盘**，让用户选（覆盖 / 重新载入）—— 不做静默覆盖。
   */
  conflict?: boolean
  /** 写成功后的新 mtime（毫秒）：编辑器拿它当新的冲突基线 */
  mtimeMs?: number
}

/** 待办清单（plan7 批 D 提前落地）—— 定义见 @shared/todo */
export type { TodoItem, TodoStatus, TodoStats } from './todo'

/** 子代理运行事件（plan7 批 D）—— 定义见 @shared/agent */
export type { SubagentJobEvent } from './agent'

/** 后台任务（plan7 批 D）—— 定义见 @shared/background */
export type { BackgroundTask } from './background'

/**
 * **流式事件信封**（plan11 §2.1）。
 *
 * 所有流式/推送通道一律走这个信封：`conversationId` 说明"这条事件属于哪一轮跑"，
 * 载荷放里面。有了它，界面在**切会话之后仍然知道每个字该落到哪条会话**——
 * 这也正是并发的前提（没有身份，两个会话的字就会互相串）。
 *
 * ⚠️ 这不只是"多带一个字段"：主进程里**只有 `main/chat-emitter.ts` 一个文件**
 * 能发流式事件，而它把 `conversationId` 在构造时闭包捕获 ——
 * **漏带 id 在结构上不可能发生**（守常见 `tests/unit/stream-envelope.test.ts`）。
 */
/**
 * `chat:done` 的信封负载（plan8 R9）。
 *
 * 为什么**收尾事件要带货**而不是另开一条 `usage:changed` 通道：
 * 用量是"这一轮的总结"，和"跑完了"是同一件事、同一时刻到的。
 * 分两条发就会出现"done 到了、usage 还没到"的中间态，界面得为它写一个假的等待态。
 *
 * `usage: null` = **厂商没报**（不是 0）—— 界面据此显示占用估算，不假装知道精确值。
 */
export interface ChatDonePayload {
  usage: TokenUsage | null
  /**
   * 本轮**工具输出窗口化省下的估算 token**（plan8 R9.1）。
   *
   * 为什么与 `usage` 并列而不是加进它：一个是**厂商真值**、一个是**本地估算**，
   * 混在一起用户就分不清哪个数字能信。它**不参与**会话用量账本的加减。
   */
  avoided?: number
  /**
   * 这一轮用的**省 token 档位**（plan8 R9.1 §七②）。
   *
   * 用户定调第 4 条：**计量必须记下"这轮用的哪一档"** —— 否则事后按档位比数字时，
   * 说不清"这个数是在哪一档下跑出来的"。界面把它显示在用量牌上（如「平衡」）。
   * 缺字段 = 老版本主进程 / 还没选过 → 界面**不显示档位标签**，不替它编一个默认值。
   */
  tier?: TokenSaverTier
}

export interface StreamEnvelope<T> {
  conversationId: string
  payload: T
}

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
  /**
   * 哪条会话在问（plan11 P0-3）。
   * 并发时用户必须一眼看出"我正在批的是**哪条会话**的命令" ——
   * 否则单槽确认框会把 A 的内容换成 B，而他以为批的是看过的那一条。
   */
  conversationId: string
  /**
   * 确认的种类 —— 界面据此说**不同的话**。
   *
   * 为什么必须分开：文件回滚（右抽屉「文件变更记录」）与会话回滚（消息右键）
   * 是**两件事**，如果确认框说同一句话，用户会以为点一个两个都退 ——
   * plan10 §六 第 6 条把这条拆成了三条可判定断言，其中一条专门要求
   * 会话回滚的确认文案里**不许出现"文件"二字**。
   *
   * 缺省视为 `'command'`（老调用方不用改）。
   */
  kind?: 'command' | 'rollback-messages'
}

/** 会话回滚的结果 */
export interface ConversationRollbackResult {
  /**
   * 回滚后的**权威**会话（含可见正文）。
   *
   * ⚠️ 渲染端**必须用它覆盖自己的内存** —— 否则下一次保存会把已经"回滚掉"的
   * 内容又写回去，等于**回滚被自己的界面撤销**（这类功能最经典的事故）。
   */
  conversation: Conversation
  /** 还能不能撤销（被裁掉的尾巴还在不在） */
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
  /** 「获取可用模型」（F5.1）：拉这个端点能调的模型 ID 列表 */
  listAvailableModels(id: string): Promise<import('./models').AvailableModels>
  /** 切换某端点内当前用哪个模型 */
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
  /**
   * 停止**指定会话**的生成（plan11）。
   * 参数从"无"改成必填：并发时"停止"必须指名道姓 —— 不指名就是停错会话。
   */
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
  /** 在系统文件管理器中打开某目录 */
  revealWorkspace(path: string): Promise<void>
  listConversations(): Promise<ConversationMeta[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(input: ConversationCreateInput): Promise<Conversation>
  saveConversation(
    id: string,
    messages: ChatMessage[],
    /**
     * 会话统计（plan8 R9 / R9.1）：**给了才更新，不给就保持盘上原值**。
     * 用一个对象而不是并列参数：这类"账"以后还会加（压缩次数、回滚次数…），
     * 每加一项就改一次签名会波及所有调用点。
     */
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
  /**
   * **回到第 `toIndex` 条消息之前**（plan10 B 批 ④）。
   *
   * 走 R5 的确认桥：用户拒绝 → 返回 `null`（什么都不做）。
   * **正在生成回复时拒绝**（主进程用现成的并发闸判断）——
   * 流式还没结束就回滚，等于在动的数据上做手术。
   */
  rollbackConversation(id: string, toIndex: number): Promise<ConversationRollbackResult | null>
  /** 撤销上一次回滚（把被裁掉的尾巴接回来；不需要确认 —— 它是**恢复**，不是破坏） */
  undoRollbackConversation(id: string): Promise<ConversationRollbackResult | null>
  /** 弹文件选择器并读入内容作为附件（工作区外的文件也能选，会在界面上标出来） */
  attachFile(): Promise<Attachment | null>
  /**
   * 按路径取附件 —— 与 `attachFile` **共用同一份读取与边界规则**（只差"路径从哪来"）。
   *
   * 两个入口：工作区文件树拖进会话（相对路径）、系统文件拖进来（绝对路径）。
   * 边界规则见 `workspace-fs.readAttachment` 的注释。
   */
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
  /**
   * 读二进制文件用于预览。
   *
   * 图片返回 `dataUrl`（可直接塞进 `<img src>`）、非图片返回 `hexHead`（十六进制转储）、
   * 超过体积上限则 `tooLarge: true` 且**不给数据**。
   *
   * ⚠️ 渲染端**只能**用 `<img src>` 消费 `dataUrl` —— SVG 是可执行内容，
   * 走 `<object>` / `<iframe>` / 内联就等于执行工作区里的代码。
   */
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
