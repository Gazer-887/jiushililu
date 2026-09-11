// 主 / 渲染进程共享的 IPC 通道定义与类型 —— 两边类型都从这里引用，唯一来源。

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
  skillsList: 'skills:list'
} as const

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
}
