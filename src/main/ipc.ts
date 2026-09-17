import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { z } from 'zod'
import { isSafeRel, selectChanges } from '@shared/checkpoint'
import { FONT_SCALE_KEYS, THEME_IDS, UI_FONT_MAX } from '@shared/splitter'
import { revertOneHunk, samePath } from './revert-flow'
import {
  IPC,
  type Attachment,
  type BrowserState,
  type ChatMessage,
  type GitInfo,
  type PermissionPreset,
  type SettingsSaveInput,
  type TestResult,
  type AgentRunResult,
  type WorkspaceInfo,
  type StorageLocationInfo,
  type StorageWriteResult,
  type Conversation,
  type ConversationMeta,
  type SkillInfo,
  type SkillWriteResult,
  type LogsInfo,
  type CheckpointRun,
  type CheckpointRunMeta,
  type CheckpointSidesResult,
  type RevertHunkResult,
  type RollbackReport,
  type UIPrefs,
  type FsListResult,
  type FsReadResult,
  type FsBinaryResult,
  type FsOpenResult,
  type FsOfficeResult,
  type FsOpResult,
  type BackgroundTask,
  type ConversationRollbackResult,
  type GitStatusResult,
  type GitOpResult,
  type GitCommitResult,
  type McpSaveResult,
  type McpServerConfig,
  type McpServerStatus
} from '@shared/ipc'
import { getPermissionPreset, getTokenTier, setPermissionPreset, setTokenTier, getMemoryEnabled, setMemoryEnabled, getComputerControlEnabled, setComputerControlEnabled, getAutoMemoryEnabled, setAutoMemoryEnabled, getReflectionModel, setReflectionModel, getReflectionDailyLimit, setReflectionDailyLimit, getFirecrawlKey, setFirecrawlKey, getSkillsDisabled, setSkillsDisabled, getVoiceConfig, setVoiceConfig, getVoiceApiKey } from './store/settings'
import { transcribe, testVoiceEndpoint } from './voice/transcribe'
import type { VoicePatch } from '@shared/voice'
import type { SystemSettings, SystemView } from '@shared/system'
import type { NetworkPatch, NetworkView } from '@shared/network'
import { networkSetSchema } from '@shared/network'
import type { SystemIntegration } from './system-integration'
import type { NetworkProxy } from './network-proxy'
import { listSystemFonts } from './system-fonts'
import { resolvePolicy, type TokenSaverTier } from '@shared/token-tier'
// 「当前用哪个模型」由**模型档案**决定（plan7 F5 多模型）：内核/界面永远只看见"当前这一个模型"，真源搬到了 store/models
import {
  deleteProfileById,
  getActiveEntry,
  getDecryptedApiKey,
  getSettingsView,
  hasApiKey,
  listProfiles,
  modelsFilePath,
  profileForTest,
  listAvailableModels,
  saveEndpoint,
  setActiveEntry,
  saveSettings,
  setActiveProfile,
  setModel
} from './store/models'
import { getProfileKey, hasProfileKey } from './store/settings'
import { maskKey } from './store/mask'
import type { ModelProfileView, ModelsView, ModelSaveInput } from '@shared/models'
import { createProvider } from './providers'
import { getUIPrefs, setUIPref, resetUIPrefs } from './store/ui-prefs'
import { listWorkspaceDir, readAttachment, readWorkspaceBinary, readWorkspaceFile } from './workspace-fs'
import { renderOfficePreview } from './office-preview'
import { createWorkspaceWriter, type WorkspaceWriter } from './workspace-write'
import type { TerminalSessionStore } from './terminal-session'
import type { TerminalSessionSnapshot, TerminalStartResult } from '@shared/terminal'
import type { ConfirmBridge } from './confirm'
import type { PlanApprovalBridge } from './agent/plan-approval'
import type { AskBridge } from './ask'
import { ASK_MAX_OPTIONS, type AskResult } from '@shared/ask'
import {
  chatSendInputSchema,
  conversationIdSchema,
  incomingMessagesSchema,
  MAX_STORED_CHARS,
  modelEntryPickSchema,
  goalActionSchema,
  goalCreateSchema,
  modelSaveSchema,
  mcpServerSchema,
  settingsSchema,
  storedMessagesSchema
} from './schemas'
import { createChatEmitter } from './chat-emitter'
import { createChatGate } from './agent/concurrency'
import { actOnGoal, createGoalFor, listGoals, removeGoal } from './store/goal'
import type { Goal } from '@shared/goal'
import {
  BUILTIN_TYPES,
  DIRTY_MAX_LEN,
  PANE_ABS_MIN,
  PANE_DEFAULT,
  PANE_MAX_COUNT,
  PATH_MAX_LEN,
  TAB_MAX_COUNT
} from '@shared/workbench'

// 工作台分栏布局的 **IPC 边界**校验（plan9 W2，三层里的第二层）：只做「形状 + 尺寸上限」。⚠️ 上限也要卡 —— 布局是**频繁写入**的对象，某处逻辑出 bug 反复往数组里塞会把盘写成巨大 JSON；语义清洗交给 setUIPref → sanitizeLayout。
const zPaneContent = z.union([
  z.object({
    kind: z.literal('builtin'),
    type: z
      .string()
      .refine((v) => (BUILTIN_TYPES as readonly string[]).includes(v), '未知的内置面板类型')
  }),
  z.object({
    kind: z.literal('file'),
    path: z.string().min(1).max(PATH_MAX_LEN),
    mode: z.enum(['preview', 'edit']),
    dirty: z.string().max(DIRTY_MAX_LEN).optional()
  })
])

const zPaneTab = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(256),
  content: zPaneContent,
  keepAlive: z.boolean().optional()
})

const zPane = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(256),
  min: z.number().finite().min(PANE_ABS_MIN).max(PANE_DEFAULT),
  tabs: z.array(zPaneTab).max(TAB_MAX_COUNT),
  active: z.number().int().min(0).max(TAB_MAX_COUNT),
  collapsed: z.boolean()
})

const workbenchSchema = z.object({
  schemaVersion: z.number().int().min(1),
  panes: z.array(zPane).max(PANE_MAX_COUNT)
})

const workbenchSizesSchema = z.object({
  paneWidths: z.array(z.number().finite().min(PANE_ABS_MIN).max(4096)).max(PANE_MAX_COUNT)
})

// 系统集成（plan7 批 F1）：只认这两个键 —— zod 会**剥掉**未声明字段，故新增开关必须在这里一起声明
const systemSetSchema = z.object({
  keepRunning: z.boolean().optional(),
  openAtLogin: z.boolean().optional()
})

// 网络代理（plan7 批 F2）：schema 与 `networkSetSchema` 同源（放在 @shared 是为了让界面与这里共用一份判据）
const netProxySetSchema = networkSetSchema
import { runAgent, ensureAgentRuntime, listSkills, type AgentRuntimeContext } from './agent/runner'
import { createExecEventRecorder, readExecEvents, sanitizeExecEventQuery, type ExecEventSink } from './agent/exec-events'
import type { ExecEventListResult } from '@shared/exec-events'
import type { AgentMessage, SubagentJobEvent } from '@shared/agent'
import type { TodoItem } from '@shared/todo'
import { resolveInsideWorkspace } from './agent/guard'
import { sendToAll } from './window-registry'
import { loadAgentEntries } from './agent/loader'
import { deleteAgentFile, readAgentDefinition, saveAgentDefinition } from './store/agents-store'
import { saveSkillFile, deleteSkillFile } from './skills/skills-write'
import { nodeFsAdapter } from './store/conversations-fs'
import type { MemoryStore } from './store/memory-store'
import type { PlaybookStore } from './store/playbook-store'
import { composeMemoryBlock, estimateMemoryTokens } from './memory/inject'
import { composePlaybookBlock } from './memory/playbook-inject'
import { composeSkillBlock, filterDisabledEntries } from '@shared/skills'
import { composeRulesBlock } from './rules/rules'
import type { PlaybookIndex, PlaybookSaveInput, PlaybookSaveResult } from '@shared/playbook'
import type { MemoryEntry, MemoryIndex, MemorySaveInput, MemorySaveResult, MemoryStats, MemorySwitchResult, MemoryAutoSettings } from '@shared/memory'
import type { AgentSaveInput, AgentSaveResult, AgentsView } from '@shared/agents'
import { statSync } from 'node:fs'
import { getWorkspaceInfo, resetWorkspaceRoot, setWorkspaceRoot } from './store/workspace'
import { clearPendingDataDir, getStorageLocationInfo, requestRestoreToDefault, setPendingDataDir } from './store/data-location'
import {
  NotARepoError,
  gitCommit,
  gitStage,
  gitUnstage,
  readGitDiff,
  readGitInfo,
  readGitStatus
} from './store/git-info'
import {
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserReload,
  getBrowserState,
  setBrowserBounds,
  setBrowserVisible
} from './browser'
import { getLogDir, listLogFiles, createLogger } from './log'
import { setWatchdogPhase } from './watchdog'
import {
  createConversation,
  deleteConversation,
  getConversation,
  knownWorkspaces,
  listConversations,
  renameConversation,
  rollbackConversation,
  saveConversation,
  setConversationTitleIfEquals,
  undoRollback
} from './store/conversations'
import {
  buildTitlePrompt,
  deriveTitle,
  fitStoredBudget,
  normalizeHistory,
  sanitizeGeneratedTitle
} from './store/conversations-core'

// 所有来自渲染进程的入参一律过 zod 校验——坏数据挡在主进程门外。schema 定义在 ./schemas（不 import electron，可独立单测）；本文件只做翻译与分发。

/** 对话并发上限（plan11 §2.1）：一条会话 = 一堆工具调用 / 子进程，不设上限等于允许一键压垮机器；3 条够"改代码 + 查资料 + 跑长任务"三件事并行。 */
const MAX_CONCURRENT_CHATS = 3

/** 进行中的对话**按会话**记（plan11 §2.1）：`同会话重复发送 → 拒绝；跨会话 → 放行`（以前 key 是 `e.sender.id`，一个窗口只能跑一条）。
 *  ⚠️ 闸的逻辑抽在 `./agent/concurrency`（纯函数可单测）：`verify-shot` 把 `chat:send` 整个 stub 掉了，界面上"两条都在跑"与闸的实际值**无关** —— 只有纯单测验得到它。 */
const chatGate = createChatGate(MAX_CONCURRENT_CHATS)
const activeAgents = new Set<number>()

/** 当前待办清单（plan7 批 D）：**主进程内存态，不落盘**（它表达"这一轮干到哪了"的即时视图）；按会话存是因为界面会随视图切换重挂载、且两条会话会互相顶掉。 */
const todosByConversation = new Map<string, TodoItem[]>()

/** 最近一批子代理的运行事件（plan7 批 D）：同一 runId 内按 name+index **就地更新**（start 先落一条，end/error 覆盖它），换批次清空重来 —— 界面显示的是"当前这批"。同样**按会话**存。 */
const subagentsByConversation = new Map<string, { runId: string | null; events: SubagentJobEvent[] }>()

const log = createLogger('ipc')

/** 检查点轮次的**归属哨兵**（plan11 P0-11）：`begin` 的第三参必须给得出答案 —— 界面直接发起的文件操作、单次 Agent 调用都没有对话上下文，两者都记成明确的哨兵而不是留空（留空 = 查不出"这轮是谁跑的"）。 */
const UI_RUN_OWNER = 'ui'
const AGENT_TASK_OWNER = 'agent-task'

/**
 * **当前活跃会话 id**（批 2 plan19）：主进程对"用户当前在用哪条会话"的缓存。
 * ⚠️ **不是真相源**（真相源是渲染端 `activeId`）—— 主进程据此做两件事：
 *   ① 关窗落盘时把当前会话入反思队列（`installFlushBeforeClose`）；
 *   ② 会话切换通知触发异步反思（`convSwitch` handler）。
 * `null` 表示用户当前不在任何会话上（启动初始态 / 切到空会话）。
 */
let activeConversationId: string | null = null

export function getActiveConversationId(): string | null {
  return activeConversationId
}

export function setActiveConversationId(id: string | null): void {
  activeConversationId = id
}

const fieldLabels: Record<string, string> = {
  providerType: '协议类型',
  baseURL: '接口地址',
  model: '模型名',
  apiKey: 'API Key',
  temperature: 'temperature（随机性，0~2）',
  topP: 'Top P（核采样，0~1）',
  topK: 'Top K（候选词数，1~200）',
  maxToolRounds: '工具调用轮数',
  supportsImages: '图片输入支持',
  maxTokens: 'max_tokens（单次回答上限）',
  timeoutMs: '超时（毫秒）',
  stream: '流式开关',
  contextWindow: '上下文窗口（客户端元数据）',
  reasoningEffort: '思考强度',
  messages: '消息列表'
}

function friendlyParse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue.path.join('.')
  const label = fieldLabels[path] ?? (path || '参数')
  const bounds = issue as { maximum?: number; minimum?: number }
  let detail = issue.message
  if (issue.code === 'too_big' && bounds.maximum !== undefined) detail = `不能大于 ${bounds.maximum}`
  else if (issue.code === 'too_small' && bounds.minimum !== undefined) detail = `不能小于 ${bounds.minimum}`
  throw new Error(`参数不合法：${label} —— ${detail}`)
}

function friendlyChatError(err: unknown): string {
  // ⚠️ 这里**不再有**「请求超时（Xms）：可在设置页调大超时时间」那一档（plan29 D-091）：
  // 它指向的是一个从不存在的实体 —— 超的从来不是「请求」，而且那个数字已被删除。
  // 现在超时由 provider 层分型上报（首包 / 流中断），带具体层级的原话，直接透传即可。
  if (err instanceof Error && err.name === 'AbortError') return '已停止生成'
  return err instanceof Error ? err.message : String(err)
}

export function registerIpcHandlers(deps: {
  agent: AgentRuntimeContext
  userDataDir: string
  /** 回收站（plan34 S2b 技能删除用）：组合根注入（shell.trashItem 的包装）—— 与 agent 上下文里的同一份 */
  trash: (abs: string) => Promise<void>
  /**
   * 记忆库（plan19 批 1）。同样是组合根建、这里转交 —— 它要落到 userData 下，
   * 而且一轮对话期间要收集"写了什么"（护栏 2 的上报载荷）。
   */
  memory: MemoryStore
  /**
   * Playbook 库（plan19 批 3，会做线）。同样是组合根建、这里转交 ——
   * 落 userData 下；一轮对话前要组装条件召回段（活跃标签匹配在组合根做，runner 不做推断）。
   */
  playbook: PlaybookStore
  confirm: ConfirmBridge
  /** Agent 提问桥。⚠️ 传进来而不是在这里 new：与 confirm 同理 —— **组合根负责"建"，这里只做转交**（本文件一个裸 `.send(` 都不许有） */
  ask: AskBridge
  /** 计划批准桥（plan27）。同 confirm / ask：**组合根负责建，这里只把渲染端的答复转交回去** */
  planApproval: PlanApprovalBridge
  /** 内置终端会话（plan7 批 C）。⚠️ 传进来而不是在这里 new：**广播代码必须放 `main/index.ts`**（本文件里一个裸 `.send(` 都不许有，见 `tests/unit/stream-envelope.test.ts`），而会话的 `onData` 要往所有窗口推 —— 故"建会话"在组合根，这里只做转交。 */
  terminal: TerminalSessionStore
  /** 系统集成（plan7 批 F1）：同样是组合根建、这里转交 —— 它持有 blocker id 与自启状态，**每个进程只能有一份** */
  system: SystemIntegration
  /**
   * 执行事件流 sink（plan26 D-077）：组合根建、这里转交 —— 本轮对话的 recorder
   * 以 conversationId 绑定（每条会话一份），时间线据此过滤回放。
   */
  execEventSink: ExecEventSink
  /**
   * 智能标题的轻调用（plan26 D-080）：组合根装配（它持有模型出口）。同 ReflectChat 口径 ——
   * 不带工具、不带记忆注入；**不传 = 不启用**（标题保持 deriveTitle 机械推导，零退化）。
   */
  titleChat?: (messages: ChatMessage[]) => Promise<string>
  /** 网络代理（plan7 批 F2）：同样是组合根建 —— session 是进程级的、凭据要过 safeStorage，两件都不能在这里 new */
  network: NetworkProxy
  onFlushDone?: () => void
  /**
   * 设置变更广播（2026-09-13，设置独立窗口）。
   *
   * **为什么放在组合根而不是本文件**：本文件里一个裸 `.send(` 都不许有
   * （`tests/unit/stream-envelope.test.ts` 有守卫）。设置窗口与主窗口是**两个渲染进程**，
   * store 不共享 —— 一处改了必须让另一处知道，否则"同一份数据实时联动"就是空话。
   * 故这里只**上报变更事实**，真正的遍历发送交给 `main/index.ts`。
   */
  onSettingsChanged?: (kind: 'settings' | 'ui-prefs' | 'models' | 'permission') => void
  /**
   * 开设置窗口（幂等）。由侧栏齿轮触发 —— 渲染端不 import electron，建窗口只能在主进程。
   */
  openSettingsWindow?: () => void
}): void {
  /**
   * 滚动摘要缓存（plan26 D-080）：进程内、会话级、不落盘 —— 重启后首轮裁剪重新摘要（如实登记的取舍）。
   * 由本层创建并传给 runner（它组装 summarize 闭包）；会话删除时不清（量小，进程退出自然回收）。
   */
  const summaryCache = new Map<string, string>()

  /**
   * 智能标题（plan26 D-080）：首答落盘后（convSave 且 messages 恰为 1 user + 1 assistant）触发一次。
   * 触发时机选在 **convSave** 而不是对话流收尾 —— 后者跑在渲染端落盘之前，读不到首答。
   * 四条防线（防乱起名/防冲掉用户改名/防重复烧钱/防拖慢主链路）：
   *   ① 只在「当前标题 === deriveTitle(首条 user)」时动手（用户改过 = 条件不成立，天然让位）；
   *   ② 改名前走 setTitleIfEquals 原子条件更新（生成期间用户改名 → 静默放弃）；
   *   ③ 成功后标题不再是机械候选 → 后续每轮天然不再触发（只跑一次，无需额外状态）；
   *   ④ fire-and-forget + fail-soft（标题是锦上添花，任何失败都静默）。
   */
  const maybeGenerateSmartTitle = (conversationId: string): void => {
    if (!deps.titleChat) return
    void (async () => {
      try {
        const conv = getConversation(conversationId)
        if (!conv) return
        const firstUser = conv.messages.find((m) => m.role === 'user')?.content
        const firstAssistant = conv.messages.find((m) => m.role === 'assistant')?.content
        if (!firstUser || !firstAssistant) return
        const expected = deriveTitle(firstUser)
        if (conv.title !== expected) return // ① 标题已非机械候选（用户改过 / 已智能生成过）
        const raw = await deps.titleChat!([
          { role: 'user', content: buildTitlePrompt(firstUser, firstAssistant) }
        ])
        const clean = sanitizeGeneratedTitle(raw)
        if (!clean || clean === expected) return
        const updated = setConversationTitleIfEquals(conversationId, expected, clean) // ②
        if (updated) {
          log.info('智能标题已生成', { conversationId, title: clean })
          sendToAll(IPC.convChanged)
        }
      } catch (err) {
        // ④ fail-soft：静默退机械标题
        log.warn('智能标题生成失败（保留机械标题）', {
          conversationId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })()
  }

  ipcMain.handle(IPC.settingsOpenWindow, () => {
    deps.openSettingsWindow?.()
  })

  // 关设置窗口：**由发起方那个窗口自己关**，不用"按用途取设置窗口"——
  // 发起关窗的必然是设置窗口（× 只画在它上面），用 `event.sender` 拿到的就是它本人，
  // 且避免了"用户连点两次 × / 窗口已在关闭路上"时取到 null 的边界。
  ipcMain.handle(IPC.settingsCloseWindow, (event) => {
    const wc = event.sender
    const win = BrowserWindow.fromWebContents(wc)
    if (win && !win.isDestroyed()) win.close()
  })

  ipcMain.handle(IPC.settingsGet, () => getSettingsView())

  // —— 语音输入（plan45）：配置读写 / 转写 / 测试连接。Key 只进不出（视图仅回 hasApiKey）——
  ipcMain.handle(IPC.voiceGetConfig, () => getVoiceConfig())
  ipcMain.handle(IPC.voiceSetConfig, (_e, raw: unknown) => {
    const p = (raw ?? {}) as Partial<VoicePatch>
    const patch: VoicePatch = {}
    if (typeof p.endpoint === 'string') patch.endpoint = p.endpoint
    if (typeof p.model === 'string') patch.model = p.model
    if (p.language === 'auto' || p.language === 'zh' || p.language === 'en') patch.language = p.language
    if (typeof p.disclosureAccepted === 'boolean') patch.disclosureAccepted = p.disclosureAccepted
    if (p.apiKey === null || typeof p.apiKey === 'string') patch.apiKey = p.apiKey
    setVoiceConfig(patch)
    return getVoiceConfig()
  })
  ipcMain.handle(IPC.voiceTranscribe, async (_e, audio: ArrayBuffer | Uint8Array, mime: unknown) => {
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio ?? new ArrayBuffer(0))
    const cfg = getVoiceConfig()
    return transcribe({
      endpoint: cfg.endpoint,
      apiKey: getVoiceApiKey(),
      model: cfg.model,
      language: cfg.language,
      audio: bytes,
      mime: typeof mime === 'string' ? mime : 'audio/webm'
    })
  })
  ipcMain.handle(IPC.voiceTest, async () => {
    const cfg = getVoiceConfig()
    return testVoiceEndpoint({ endpoint: cfg.endpoint, apiKey: getVoiceApiKey(), model: cfg.model, language: cfg.language })
  })

  // —— 开发环境（plan43）：探测只读、失败不抛；选择只存"语言→路径" ——
  ipcMain.handle(IPC.devEnvDetect, async (_e, force: unknown) => {
    const { detectRuntimes, filterNoise } = await import('./dev-env/runtime-detect')
    const snap = await detectRuntimes(force === true)
    return filterNoise(snap)
  })
  ipcMain.handle(IPC.devEnvSelect, async (_e, language: unknown, path: unknown) => {
    const { setDevEnvSelected } = await import('./store/settings')
    if (typeof language !== 'string' || !['node', 'python', 'uv'].includes(language)) {
      return getDevEnvSelectedSnapshot()
    }
    const p = path === null ? null : typeof path === 'string' && path.length > 0 ? path : null
    return setDevEnvSelected(language, p)
  })
  async function getDevEnvSelectedSnapshot(): Promise<Record<string, string>> {
    const { getDevEnvSelected } = await import('./store/settings')
    return getDevEnvSelected()
  }

  ipcMain.handle(IPC.settingsSave, (_e, raw: unknown) => {
    const input = friendlyParse(settingsSchema, raw) as SettingsSaveInput
    const saved = saveSettings(input)
    // 通知**所有**窗口重读 —— 主窗口的权限档、供应商标签都取自这里
    deps.onSettingsChanged?.('settings')
    return saved
  })

  ipcMain.handle(IPC.settingsTest, async (_e, raw: unknown): Promise<TestResult> => {
    const input = friendlyParse(settingsSchema, raw) as SettingsSaveInput
    const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : getDecryptedApiKey()
    if (!apiKey) {
      return { ok: false, message: '尚未保存 API Key：请先在下方填写并保存，或填写后直接点「测试连接」' }
    }
    const provider = createProvider(input.providerType)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    try {
      return await provider.testConnection({
        settings: input,
        apiKey,
        messages: [],
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  })

  // 多模型管理的视图里**只给 Key 的掩码**（与 `settings:get` 同一条规矩：明文 Key 永远不回渲染进程）。
  const modelsView = (): ModelsView => {
    const { profiles, activeId } = listProfiles()
    return {
      profiles: profiles.map((p) => ({
        ...p,
        hasApiKey: hasProfileKey(p.id),
        apiKeyMasked: maskKey(getProfileKey(p.id))
      })),
      activeId,
      filePath: modelsFilePath()
    }
  }

  ipcMain.handle(IPC.modelsList, () => modelsView())

  ipcMain.handle(IPC.modelsSave, (_e, raw: unknown): ModelProfileView => {
    const input = friendlyParse(modelSaveSchema, raw) as ModelSaveInput
    const saved = saveEndpoint(input)
    const view = modelsView().profiles.find((p) => p.id === saved.id)
    if (!view) throw new Error('保存后没能读回这个端点（存储异常）')
    // 模型档案变了 → 主窗口的供应商标签/输入框工具栏要跟着变
    deps.onSettingsChanged?.('models')
    return view
  })

  ipcMain.handle(IPC.modelsAvailable, async (_e, raw: unknown) => {
    const id = friendlyParse(conversationIdSchema, raw)
    return listAvailableModels(id)
  })

  ipcMain.handle(IPC.modelsSetEntry, (_e, raw: unknown): ModelsView => {
    const input = friendlyParse(modelEntryPickSchema, raw)
    setActiveEntry(input.profileId, input.entryId)
    // 「当前模型」变了要广播：别的窗口（设置窗口等）读的是主进程真值，不喊一声就永远拿旧值
    deps.onSettingsChanged?.('models')
    return modelsView()
  })

  ipcMain.handle(IPC.modelsDelete, (_e, raw: unknown) => {
    const id = friendlyParse(conversationIdSchema, raw)
    deleteProfileById(id)
    deps.onSettingsChanged?.('models')
  })

  ipcMain.handle(IPC.modelsSetActive, (_e, raw: unknown): ModelsView => {
    const id = friendlyParse(conversationIdSchema, raw)
    setActiveProfile(id)
    // "当前用哪个模型"是主窗口输入框上直接显示的，必须立刻同步
    deps.onSettingsChanged?.('models')
    return modelsView()
  })

  ipcMain.handle(IPC.modelsTest, async (_e, raw: unknown): Promise<TestResult> => {
    const id = friendlyParse(conversationIdSchema, raw)
    const target = profileForTest(id)
    if (!target) return { ok: false, message: '该模型不存在（可能已被删除）' }
    if (!target.apiKey) {
      return { ok: false, message: '该模型尚未填写 API Key：请点「编辑」补充后再测试' }
    }
    const provider = createProvider(target.settings.providerType)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), target.settings.timeoutMs)
    try {
      return await provider.testConnection({
        settings: target.settings,
        apiKey: target.apiKey,
        messages: [],
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  })

  // 目标属于**一条会话**（plan11 的会话身份在这儿第二次派上用场）：切回那条会话还看得见它，是自然结果。
  ipcMain.handle(IPC.goalList, (_e, raw: unknown): Goal[] => {
    const conversationId = friendlyParse(conversationIdSchema, raw)
    return listGoals(conversationId)
  })

  ipcMain.handle(IPC.goalCreate, (_e, raw: unknown): Goal => {
    const input = friendlyParse(goalCreateSchema, raw)
    return createGoalFor({
      conversationId: input.conversationId,
      text: input.text,
      createdBy: 'user',
      ...(input.doneWhen ? { doneWhen: input.doneWhen } : {})
    })
  })

  ipcMain.handle(IPC.goalAction, (_e, raw: unknown): Goal => {
    const input = friendlyParse(goalActionSchema, raw)
    return actOnGoal(input.id, input.action, input.patch)
  })

  ipcMain.handle(IPC.goalDelete, (_e, raw: unknown): void => {
    const id = friendlyParse(conversationIdSchema, raw)
    removeGoal(id)
  })

  ipcMain.handle(IPC.chatSend, async (e, raw: unknown) => {
    const input = friendlyParse(chatSendInputSchema, raw)
    const conversationId = input.conversationId
    const messages = input.messages as ChatMessage[]
    const settings = getSettingsView()

    // 这一轮所有事件的**唯一发送口**：会话身份在构造时进了闭包，之后不可能漏（plan11 §2.5）
    const emit = createChatEmitter(e.sender, conversationId)

    // IPC 层并发防护：渲染层的 streaming 标志只是软约束，这里才是硬闸（同会话重复 → 拒，跨会话 → 放行）。
    const gate = chatGate.begin(conversationId)
    if (!gate.ok) {
      emit.error(gate.message)
      return
    }

    if (!settings.baseURL || !settings.model) {
      // 开跑前就退回的路径，**必须把刚占的位子还回去** —— 不然这条会话在闸里永远"在跑"，连重发都发不出去
      chatGate.end(conversationId)
      emit.error('尚未配置模型：请先到「设置」页填写接口地址、模型名与 API Key')
      return
    }
    if (!hasApiKey()) {
      chatGate.end(conversationId)
      emit.error('尚未保存 API Key：请先到「设置」页填写并保存')
      return
    }

    const apiKey = getDecryptedApiKey()
    // ⚠️ plan29 D-090：这里原来有一层**整轮墙钟**（`setTimeout(() => controller.abort(), settings.timeoutMs)`），
    // 已按用户决议**彻底删除** —— 不保留为「默认关闭的设置项」（保留会多一层误用风险 + 误用后的处理成本）。
    //
    // 为什么删掉它不留下"毫无兜底"的窗口：它本来就是个**错口径**的选择 —— 把五种性质完全不同的情况
    // （建连慢 / 首包迟迟不来 / 吐了一半断流 / 工具跑得久 / 子代理在并行）压成同一个数字，
    // 于是任何一种慢都被报成同一句话「请求超时」，用户按那句话去调大，只会把正常的情况也一起等更久。
    // 现在三层各有归属，且各自都能说清自己是哪一层：
    //   · 首包慢   → providers/stream-guard.ts 的首包守卫（60s）
    //   · 流中断   → 同上的分片间隔守卫（90s，**唯一能识别真卡死**的指标）
    //   · 工具卡住 → run_command 自己的超时（可调、上限 600s）
    // 而「整轮总时长」这件事**本来就该由人决定** —— 随时可点停止。这与项目原则同源：
    // **该不该停是人判断的，不该由代码替他猜一个数字**。
    const controller = gate.controller
    // 诊断三件套（0.13.42 反馈：出现过"长时间无回复"却无从查起）。开始 / 首包 / 完成三个时刻都落日志，
    // 下次再卡，日志能直接区分"请求没发出去 / 发了没首包 / 首包后断流"三种卡法
    const startedAt = Date.now()
    let firstSignalAt = 0

    // 记忆注入段（plan19 批 1）：组装 + 开采集。放在 `try` **之前** —— 出错时也要能 drain 到已发生的写入。
    const memoryBlock = beginMemoryTurn(conversationId)
    // Playbook 条件召回段（plan19 批 3）：活跃标签从**用户这一轮的原话**推断，交集非空才注入。
    const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const playbookBlock = assemblePlaybookBlock(conversationId, lastUserText)
    // 技能清单段（plan22）：静态资产，无条件组装（预算截断在 composeSkillBlock 内完成，截断双侧可见）
    const skillBlock = assembleSkillBlock()
    // 规则段（plan24）：**无条件注入**的约束（工作区 AGENTS.md + rules/ + 用户层）
    const rulesBlock = assembleRulesBlock()
    // 诊断①：开始时刻。没有它，"卡死"发生时日志里一片空白，连"请求到底发没发"都说不清
    log.info('对话开始', {
      conversationId,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      historyMessages: messages.length,
      memoryInjected: memoryBlock !== null,
      playbookInjected: playbookBlock !== null
    })

    // D-032：单一通道 —— 带工具清单 + 流式，由模型自决"直接回答还是先调工具"；文本增量 → chat:chunk（上屏），工具生命周期 → chat:tool（进度卡片）。
    try {
      const result = await runAgent(deps.agent, {
        settings: getSettingsView(),
        apiKey,
        history: messages as AgentMessage[],
        // 主 Agent（plan17 G2）：渲染端按会话带上；定义不存在 → runAgent 抛人话错误走下方 catch → emit.error
        agentName: input.agentName,
        permission: getPermissionPreset(),
        // Firecrawl（plan32）：配了 Key 就用密钥源，没配回落默认搜索源（runner/web-tools 决定）
        firecrawlApiKey: getFirecrawlKey() || null,
        // 自视段（2026-09-15）：电脑控制开关由组合根读好传入（runner 不碰 electron-store）
        computerControl: getComputerControlEnabled(),
        conversationId,
        onText: (delta) => {
          if (firstSignalAt === 0) {
            firstSignalAt = Date.now()
            log.info('对话首包（正文）', { conversationId, latencyMs: firstSignalAt - startedAt })
          }
          emit.chunk(delta)
        },
        onReasoning: (delta) => {
          if (firstSignalAt === 0) {
            firstSignalAt = Date.now()
            log.info('对话首包（思考）', { conversationId, latencyMs: firstSignalAt - startedAt })
          }
          emit.reasoning(delta)
        },
        onToolEvent: (evt) => emit.tool(evt),
        // 待办清单（plan7 批 D）：先存主进程，再推给界面 —— 界面重挂载后仍能拉到
        onTodos: (todos) => {
          todosByConversation.set(conversationId, todos)
          emit.todos(todos)
        },
        // 目标创建（plan12 ⑤）：Agent 也能自建 —— store 写入与界面推送都在组合根（runner 不碰 electron-store）。
        // createdBy 与本轮 agentLabel 同口径（plan17：会话用了自定义 Agent 就归它，不再是写死的"内核默认"）；子代理走 scheduler、
        // 不注入 onSetGoal —— 单次报告的子代理不该留下长期意图。
        onSetGoal: (goalInput) => {
          const goal = createGoalFor({
            conversationId,
            text: goalInput.text,
            createdBy: input.agentName ?? '内核默认',
            ...(goalInput.doneWhen ? { doneWhen: goalInput.doneWhen } : {})
          })
          emit.goal(goal)
          return goal
        },
        // 工具输出成形留痕（plan8 R9.1）：界面那条是内存态，日志这条才追得回来
        onToolWindowed: (info) => log.info('工具输出已成形', { conversationId, ...info }),
        // 校准开关（plan8 R9.1）：只认 `JSL_TOOL_WINDOW=off`，不给就是默认开 —— 免得留一个"忘了配就悄悄变了行为"的配置面。
        ...(process.env['JSL_TOOL_WINDOW'] === 'off' ? { toolWindow: false } : {}),
        // 省 token 档位（plan8 R9.1 §七②）：**在这里解析**（组合根读设置再往下给 policy）—— runner 不许碰 electron-store（CI 无 Electron），故读设置只能发生在本层；`JSL_TOKEN_TIER` 是**校准钩子**，环境变量不存在时行为与以前一样。
        policy: resolvePolicy(process.env['JSL_TOKEN_TIER'] ?? getTokenTier()),
        // 记忆段（plan19 批 1）：组合根组装好传进去，runner 只负责拼进 system（接在安全基线之后）
        memoryBlock,
        // Playbook 段（plan19 批 3）：同上 —— 活跃标签匹配已在组合根做完，runner 只拼段
        playbookBlock,
        // 技能段（plan22）：同上 —— 预算截断已在组合根做完，runner 只拼段
        skillBlock,
        // 规则段（plan24）：同上 —— 无条件注入的约束
        rulesBlock,
        // 执行事件流（plan26 D-077）：每轮对话一份 recorder —— 工具/裁剪/起止/审批进时间线
        execEvents: createExecEventRecorder({
          sink: deps.execEventSink,
          conversationId,
          agentScope: 'main',
          onDropped: (kind, keys) => log.warn('执行事件含白名单外字段，已丢弃', { kind, keys })
        }),
        // 滚动摘要（plan26 D-080）：缓存由本层持有（跨轮），runner 据此组装 summarize 闭包
        summaryCache,
        onSubagentEvent: (evt) => {
          const state = subagentsByConversation.get(conversationId) ?? { runId: null, events: [] }
          if (state.runId !== evt.runId) {
            state.runId = evt.runId
            state.events = []
          }
          const idx = state.events.findIndex((x) => x.name === evt.name && x.index === evt.index)
          const next = state.events.slice()
          if (idx >= 0) next[idx] = evt
          else next.push(evt)
          state.events = next
          subagentsByConversation.set(conversationId, state)
          emit.subagents(next)
        },
        signal: controller.signal
      })
      // 本轮改了文件 → 通知界面刷新「文件变更」页签（plan8 R4）
      if (result.changedFiles > 0) emit.checkpoint(result.runId)
      // 收尾带货：本轮真实用量（plan8 R9）+ 窗口化省下的估算量（R9.1）+ **注入税**（plan19 §5.2，
      // 本地估算 —— 记忆段这轮占了多少，用量牌上要有个读数，不然"越用越重"没人看得见）
      log.info('对话完成', {
        conversationId,
        durationMs: Date.now() - startedAt,
        firstSignalMs: firstSignalAt > 0 ? firstSignalAt - startedAt : null,
        stopReason: result.stopReason,
        rounds: result.rounds,
        changedFiles: result.changedFiles
      })
      emit.done(result.usage, result.avoidedTokens ?? 0, getTokenTier(), estimateMemoryTokens(memoryBlock))
    } catch (err) {
      // 失败留痕（plan8 R2）：这条以前只发给界面，日志里什么都没有 → 事后无从排查
      log.error('对话执行失败', {
        conversationId,
        model: settings.model,
        error: err instanceof Error ? err.message : String(err)
      })
      emit.error(friendlyChatError(err))
    } finally {
      chatGate.end(conversationId)
      // 护栏 2（D-043）：本轮写了什么 —— 取走上报载荷。空手而归则不推（免界面反复闪"没有写入"）
      endMemoryTurn(conversationId)
    }
  })

  ipcMain.handle(IPC.chatAbort, (_e, raw: unknown) => {
    // 并发之后"停止"必须指名道姓 —— 不指名就是停错会话
    const conversationId = friendlyParse(conversationIdSchema, raw)
    chatGate.abort(conversationId)
  })

  ipcMain.handle(IPC.flushDone, () => {
    deps.onFlushDone?.()
  })

  ipcMain.handle(IPC.todoGet, (_e, raw: unknown): TodoItem[] => {
    const id = friendlyParse(conversationIdSchema, raw)
    return todosByConversation.get(id) ?? []
  })
  ipcMain.handle(IPC.subagentGet, (_e, raw: unknown): SubagentJobEvent[] => {
    const id = friendlyParse(conversationIdSchema, raw)
    return subagentsByConversation.get(id)?.events ?? []
  })

  const agentRunInput = z.object({
    task: z.string().min(1).max(200000),
    agentName: z.string().max(64).optional(),
    conversationId: conversationIdSchema.optional()
  })
  const failResult = (agent: string, error: string): AgentRunResult => ({
    ok: false, output: '', rounds: 0, stopReason: 'error', agent, error
  })

  ipcMain.handle(IPC.agentRun, async (e, raw: unknown): Promise<AgentRunResult> => {
    let req: { task: string; agentName?: string; conversationId?: string }
    try {
      req = friendlyParse(agentRunInput, raw) as {
        task: string
        agentName?: string
        conversationId?: string
      }
    } catch (err) {
      return failResult('内核默认', err instanceof Error ? err.message : String(err))
    }
    // 并发闸（交叉验证提出）：Agent 循环成本高（可跑满轮数 + 命令执行），同时只允许一个
    if (activeAgents.has(e.sender.id)) {
      return failResult(req.agentName ?? '内核默认', '已有 Agent 任务在执行，请等待当前任务结束')
    }
    activeAgents.add(e.sender.id)
    try {
      const settings = getSettingsView()
      if (!settings.baseURL || !settings.model) {
        return failResult(req.agentName ?? '内核默认', '尚未配置模型：请先到「设置」页填写接口地址、模型名与 API Key')
      }
      const apiKey = getDecryptedApiKey()
      if (!apiKey) {
        return failResult(req.agentName ?? '内核默认', '尚未保存 API Key：请先到「设置」页填写并保存')
      }
      const result = await runAgent(deps.agent, {
        settings,
        apiKey,
        history: [{ role: 'user', content: req.task }],
        agentName: req.agentName,
        conversationId: req.conversationId ?? AGENT_TASK_OWNER,
        // 自视段：一次性任务同样报告配置（模型名/工具/子代理）
        computerControl: getComputerControlEnabled(),
        // Firecrawl（plan32）：与对话线同一口径 —— 配了就用，没配回落默认源
        firecrawlApiKey: getFirecrawlKey() || null,
        // 一次性任务也注入记忆并采集痕迹（少了它，模型在这里 remember 就没人上报 —— 静默缺口）
        memoryBlock: beginMemoryTurn(req.conversationId ?? AGENT_TASK_OWNER),
        // 一次性任务同样走条件召回（任务描述即"用户原话"，活跃标签从它推断）
        playbookBlock: assemblePlaybookBlock(req.conversationId ?? AGENT_TASK_OWNER, req.task),
        // 一次性任务同样注入技能清单（plan22 D-057）
        skillBlock: assembleSkillBlock(),
        // 一次性任务同样注入规则（plan24）：约束对一次性任务同样生效
        rulesBlock: assembleRulesBlock()
      })
      endMemoryTurn(req.conversationId ?? AGENT_TASK_OWNER)
      return {
        ok: result.stopReason === 'completed',
        output: result.output,
        rounds: result.rounds,
        stopReason: result.stopReason,
        agent: result.agent,
        ...(result.stopReason === 'max-rounds'
          ? { error: `已达轮数预算上限（${result.rounds} 轮）并强制停止，以下为部分产出` }
          : {})
      }
    } catch (err) {
      log.error('Agent 任务失败', { agentName: req.agentName, error: err instanceof Error ? err.message : String(err) })
      return failResult(req.agentName ?? '内核默认', err instanceof Error ? err.message : String(err))
    } finally {
      activeAgents.delete(e.sender.id)
    }
  })


  ipcMain.handle(IPC.settingsSetModel, (_e, raw: unknown) => {
    const model = z.string().min(1).max(200).parse(raw)
    return setModel(model)
  })

  ipcMain.handle(IPC.workspaceGet, (): WorkspaceInfo => getWorkspaceInfo(deps.userDataDir))

  // 用户显式授权一个真实目录作为工作区（唯一扩大 Agent 活动范围的入口）
  ipcMain.handle(IPC.workspacePick, async (e): Promise<WorkspaceInfo | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]!
    setWorkspaceRoot(picked)
    // 切工作区 → 收掉终端会话：那个 shell 还停在**上一个项目**的目录里，且"每工作区一个会话"的语义下它已没有归属（懒收 = 不碰终端就不收，等于不收）
    deps.terminal.killAll()
    ensureAgentRuntime(deps.agent) // 新工作区目录先备好
    return getWorkspaceInfo(deps.userDataDir)
  })

  ipcMain.handle(IPC.workspaceSetKnown, (_e, raw: unknown): WorkspaceInfo | null => {
    const path = z.string().min(1).max(500).parse(raw)
    const allowed = knownWorkspaces()
    if (!allowed.includes(path)) return null
    setWorkspaceRoot(path)
    deps.terminal.killAll() // 同上：切工作区即收终端会话，不留旧项目的 shell
    ensureAgentRuntime(deps.agent)
    return getWorkspaceInfo(deps.userDataDir)
  })

  // 恢复内置默认工作区（plan7 批 F4）：与「选择目录」同为切换动作，语义对齐（收终端会话 + 备好新目录）
  ipcMain.handle(IPC.workspaceReset, (): WorkspaceInfo => {
    resetWorkspaceRoot()
    deps.terminal.killAll()
    ensureAgentRuntime(deps.agent)
    return getWorkspaceInfo(deps.userDataDir)
  })

  ipcMain.handle(IPC.workspaceReveal, async (_e, raw: unknown) => {
    const path = z.string().min(1).max(500).parse(raw)
    const allowed = knownWorkspaces()
    if (!allowed.includes(path)) return
    await shell.openPath(path)
  })

  // 存储位置（plan10 C 批）：这里只做「读配置 + 记 pending」——迁移/回退本体在**下次启动**由
  // bootstrap-data-dir 执行（数据正在被读写的进程不能自己搬自己）。canceled = 用户关了目录框。
  ipcMain.handle(IPC.storageGet, (): StorageLocationInfo => getStorageLocationInfo())
  ipcMain.handle(IPC.storagePick, async (e): Promise<StorageWriteResult> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return setPendingDataDir(result.filePaths[0]!)
  })
  ipcMain.handle(IPC.storageReset, (): StorageWriteResult => requestRestoreToDefault())
  ipcMain.handle(IPC.storageUndoPending, (): StorageWriteResult => clearPendingDataDir())


  ipcMain.handle(IPC.convList, (): ConversationMeta[] => listConversations())

  ipcMain.handle(IPC.convGet, (_e, raw: unknown): Conversation | null => {
    const id = z.string().min(1).max(64).parse(raw)
    return getConversation(id)
  })

  const convCreateInput = z.object({
    workspace: z.string().min(1).max(500),
    model: z.string().min(1).max(200),
    // 主 Agent（plan17）：可选；老渲染端不传也能过（skills 同理——plan17 起 PlusMenu 不再写入）
    agentName: z.string().max(64).optional(),
    skills: z.array(z.string().max(64)).max(50).optional(),
    firstMessage: z.string().max(200000).optional()
  })

  ipcMain.handle(IPC.convCreate, (_e, raw: unknown): Conversation => {
    const input = convCreateInput.parse(raw)
    // 会话工作区必须来自"已被授权过的目录"或当前工作区，防止渲染层随意指定
    const current = getWorkspaceInfo(deps.userDataDir).path
    if (input.workspace !== current && !knownWorkspaces().includes(input.workspace)) {
      throw new Error(`工作区未被授权：${input.workspace}`)
    }
    // **绑定"当前端点的当前模型"**（plan7 F5.1）：`modelProfileId` 记端点（用哪条连接 + 哪把 Key）、`modelEntryId` 记目录里的哪一条 —— 渲染端不用关心，它此刻用的就是这一对。
    const active = getActiveEntry()
    return createConversation({
      ...input,
      ...(active
        ? { model: active.entry.model, modelProfileId: active.profile.id, modelEntryId: active.entry.id }
        : {})
    })
  })

  const convSaveCore = (raw: unknown): ConversationMeta | null => {
    // **先松收下 → 规整 → 再严格校验**：① 流式占位（`content` 为空）是**合法中间状态**，先收得下来；② 丢掉没内容的消息；③ 落盘前严格把关。
    // ⚠️ 以前是"直接严格 parse"，于是"流式没吐字就切会话/点停止/关窗口"这几条路**保存必然被拒**，而调用方 `void persistActive()` —— 静默、丢数据、无从解释。
    const input = z
      .object({
        id: z.string().min(1).max(64),
        messages: incomingMessagesSchema,
        // 用量账本（plan8 R9）：可选。**不信任上游的数字**——负/非有限一律拒，免得一个 NaN 写进索引，之后每次列表都读到一个坏值
        usage: z
          .object({
            promptTokens: z.number().finite().nonnegative(),
            completionTokens: z.number().finite().nonnegative()
          })
          .optional(),
        avoidedTokens: z.number().finite().nonnegative().optional(),
        // 注入税（plan19 §5.2）：同样是估算，单独一笔账
        memoryTokens: z.number().finite().nonnegative().optional(),
        // 主 Agent（plan17 D9）：空串 = 切回内核默认（主进程删字段）；不传 = 不动原值
        agentName: z.string().max(64).optional()
      })
      .parse(raw)
    const normalized = normalizeHistory(input.messages as ChatMessage[])
    // 超预算先丢分段保正文（plan36）；丢完仍超（正文本身超）才让 strict 审整条拒
    const { messages, stripped } = fitStoredBudget(normalized, MAX_STORED_CHARS)
    if (stripped > 0) {
      log.warn('会话分段超预算，已丢分段保正文', { id: input.id, stripped })
    }
    const parsed = storedMessagesSchema.safeParse(messages)
    if (!parsed.success) {
      // 这条通道以前**静默**拒（不写日志、界面上也没有），失败理由必须留痕
      const reason = parsed.error.issues[0]?.message ?? '参数不合法'
      log.error('会话保存被拒', { id: input.id, count: messages.length, reason })
      throw new Error(`会话未能写入磁盘：${reason}`)
    }
    // 批 2：会话正文的 UTF-8 字节数。⚠️ 用 Buffer.byteLength 而非 .length
    //    （审查 B5 P0：中文字符 1 字符 = 3 字节，字符数会让中文会话误判"过反思前置门"）
    const bodyBytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
    const savedMeta = saveConversation(input.id, parsed.data as ChatMessage[], {
      ...(input.usage
        ? {
            usage: {
              promptTokens: Math.round(input.usage.promptTokens),
              completionTokens: Math.round(input.usage.completionTokens)
            }
          }
        : {}),
      ...(input.avoidedTokens !== undefined ? { avoidedTokens: Math.round(input.avoidedTokens) } : {}),
      ...(input.memoryTokens !== undefined ? { memoryTokens: Math.round(input.memoryTokens) } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      bodyBytes
    })
    // 智能标题（plan26 D-080）：首答刚落盘时触发一次（条件收在 maybeGenerateSmartTitle 内部）
    if (savedMeta && parsed.data.length === 2 && parsed.data.some((m) => m.role === 'assistant')) {
      maybeGenerateSmartTitle(input.id)
    }
    return savedMeta
  }
  // 看门狗标记（plan37 S0）：会话保存是同步 fs 链；回存前值而非硬写 idle（单槽坑，见 watchdog.ts）
  ipcMain.handle(IPC.convSave, (_e, raw: unknown): ConversationMeta | null => {
    const prevPhase = setWatchdogPhase('conversation:save')
    try {
      return convSaveCore(raw)
    } finally {
      setWatchdogPhase(prevPhase)
    }
  })

  ipcMain.handle(IPC.convRename, (_e, raw: unknown): ConversationMeta | null => {
    const input = z.object({ id: z.string().min(1).max(64), title: z.string().max(60) }).parse(raw)
    return renameConversation(input.id, input.title)
  })

  // ── 会话切换通知（批 2 plan19）────────────────────────────────────────
  // ⚠️ 主进程据此维护 `activeConversationId` + 异步触发反思（不 await，50ms 内返回）。
  //    **不是真相源**（真相源是渲染端 `activeId`），主进程只是缓存。
  //    反思异步跑：handler 不 await，避免渲染端切会话时被反思堵住。
  ipcMain.handle(IPC.convSwitch, (_e, raw: unknown): void => {
    const input = z
      .object({
        prevId: z.string().min(1).max(64).nullable(),
        nextId: z.string().min(1).max(64).nullable()
      })
      .parse(raw)
    activeConversationId = input.nextId
    // 切走有内容的会话 → 入反思队列 + 异步跑（不 await）
    if (
      input.prevId &&
      input.prevId !== input.nextId &&
      getAutoMemoryEnabled() &&
      getMemoryEnabled()
    ) {
      deps.memory.enqueueReflection(input.prevId)
      void deps.memory.runReflection(input.prevId).catch((err) => {
        log.warn('反思异步执行失败', {
          conversationId: input.prevId,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }
  })

  // 会话回滚（plan10 B 批 ④）三条边界：① **正在生成回复时拒绝回滚**（流式没结束就动历史 = 在动的数据上做手术）；② **走 R5 确认桥**（`kind: 'rollback-messages'`，文案必须与**文件回滚**分得清）；③ **回传权威正文**（渲染端用它覆盖内存）。
  // ⚠️ 回滚**不删数据**（只移游标），所以"撤销"零成本 —— 这也是它敢用"确认一下就执行"的原因。
  const doRollback = async (
    id: string,
    toIndex: number
  ): Promise<ConversationRollbackResult | null> => {
    const current = getConversation(id)
    if (!current) return null
    const visible = current.messages.length
    const target = Math.max(0, Math.min(Math.floor(toIndex), visible))
    if (target === visible) return null

    const hidden = visible - target
    const allowed = await deps.confirm.ask({
      kind: 'rollback-messages',
      tool: '会话回滚',
      detail: `回到第 ${target + 1} 条消息之前：其后 ${hidden} 条将从对话中隐去（可撤销）`,
      agent: current.title,
      // ⚠️ 措辞必须说清「什么退了、什么没退」（plan46 §2.3）：原句「不影响工作区文件」容易被读成
      // "什么都没发生过"，而实际是**对话退了、文件与提交没退** —— 两者会打架（有实机截图为证：
      // 提示条写"文件未改动"，右侧工作台却躺着一批产物）
      where: '对话历史会退回，但工作区文件与 git 提交**不会**跟着回退 —— 若这轮改过文件，请自行处理',
      conversationId: id
    })
    if (!allowed) return null
    const outcome = rollbackConversation(id, target)
    if (!outcome) return null
    log.info('会话回滚', { id, from: visible, to: target, hidden, canUndo: outcome.canUndo })
    return {
      conversation: { ...outcome.meta, messages: outcome.messages },
      canUndo: outcome.canUndo,
      total: outcome.total
    }
  }

  ipcMain.handle(IPC.convRollback, async (e, raw: unknown): Promise<ConversationRollbackResult | null> => {
    const input = z
      .object({ id: z.string().min(1).max(64), toIndex: z.number().int().min(0).max(100000) })
      .parse(raw)
    if (chatGate.isRunning(input.id)) {
      throw new Error('该会话正在生成回复：请先等待其结束或点「停止」，再执行回滚')
    }
    return doRollback(input.id, input.toIndex)
  })

  ipcMain.handle(IPC.convUndoRollback, (_e, raw: unknown): ConversationRollbackResult | null => {
    const id = z.string().min(1).max(64).parse(raw)
    // 撤销是**恢复**，不是破坏 —— 不需要确认
    const outcome = undoRollback(id)
    if (!outcome) return null
    log.info('撤销会话回滚', { id, cursor: outcome.meta.messageCount, total: outcome.total })
    return {
      conversation: { ...outcome.meta, messages: outcome.messages },
      canUndo: outcome.canUndo,
      total: outcome.total
    }
  })

  ipcMain.handle(IPC.convDelete, (_e, raw: unknown): void => {
    const id = z.string().min(1).max(64).parse(raw)
    deleteConversation(id)
  })

  ipcMain.handle(IPC.skillsList, (): SkillInfo[] => listSkills(deps.agent))

  // ── MCP（plan23）──────────────────────────────
  ipcMain.handle(IPC.mcpList, (): McpServerStatus[] => deps.agent.mcp?.manager.listServers() ?? [])
  ipcMain.handle(IPC.mcpSave, (_e, raw: unknown): McpSaveResult => {
    const parsed = mcpServerSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, reason: parsed.error.issues[0]?.message ?? 'MCP 服务器配置不合法' }
    }
    const saved = deps.agent.mcp?.manager.saveServer(parsed.data as McpServerConfig) ?? {
      ok: false,
      reason: 'MCP 未初始化'
    }
    // 保存后立即重连（enabled 才会真的连），状态经广播刷新到界面
    if (saved.ok) {
      void deps.agent
        .mcp!.manager.reconnect(parsed.data.name)
        .then(() => sendToAll(IPC.mcpChanged))
        .catch(() => sendToAll(IPC.mcpChanged))
    }
    return saved
  })
  ipcMain.handle(IPC.mcpDelete, (_e, name: string): McpSaveResult => {
    const id = z.string().min(1).max(64).parse(name)
    const removed = deps.agent.mcp?.manager.deleteServer(id) ?? { ok: false, reason: 'MCP 未初始化' }
    sendToAll(IPC.mcpChanged)
    return removed
  })
  ipcMain.handle(IPC.mcpReconnect, async (_e, name: string): Promise<McpSaveResult> => {
    const id = z.string().min(1).max(64).parse(name)
    const r = (await deps.agent.mcp?.manager.reconnect(id)) ?? { ok: false, reason: 'MCP 未初始化' }
    sendToAll(IPC.mcpChanged)
    return r
  })
  // 连接状态变化（连接/断开/调用失败）→ 界面刷新状态徽标
  deps.agent.mcp?.manager.onChange(() => sendToAll(IPC.mcpChanged))
  // plan34 S2b：技能库变化（写路径 reload 触发）→ 各窗口技能列表刷新
  deps.agent.skills?.store.onChange(() => sendToAll(IPC.skillsChanged))

  // ── 子 Agent 管理（plan17）：MD 文件是唯一真相源；loadAgentRegistry 每轮重读盘 → 保存即生效，无失效机制 ──
  // 两层视图（D-103：用户 > 内置，项目级已取消）与 runner 的 loadAgentRegistry 同一份数据源，管理页看到的就是运行时生效的集合（含被覆盖条目）。
  const agentLayers = () => [
    { dir: deps.agent.builtinAgentsDir, source: 'builtin' as const },
    { dir: deps.agent.userAgentsDir, source: 'user' as const }
  ]

  ipcMain.handle(IPC.agentsList, (): AgentsView => loadAgentEntries(agentLayers()))

  const agentSaveInputSchema = z.object({
    name: z.string().max(64),
    description: z.string().max(500),
    // ⚠️ 只验形状不验成员（plan17 D3）：声明了不存在的工具由 allowedToolsFor 运行时过滤，这里枚举会造成"表单与 loader 两套口径"
    tools: z.array(z.string().max(64)).max(64),
    model: z.string().max(200).optional(),
    // plan27：只认 'plan' 这一个字面量（与 loader 同口径 —— 乱写忽略，不报错，免得一个笔误卡住整条保存）
    approval: z.literal('plan').optional(),
    executor: z.string().max(64).optional(),
    systemPrompt: z.string().min(1).max(100000),
    file: z.string().min(1).max(1000).optional()
  })

  ipcMain.handle(IPC.agentsRead, (_e, raw: unknown): AgentSaveInput | null => {
    const file = z.string().min(1).max(1000).parse(raw)
    const def = readAgentDefinition(nodeFsAdapter, file, [deps.agent.userAgentsDir], 'user')
    if (!def) return null
    return {
      name: def.name,
      description: def.description,
      tools: def.tools ?? [],
      ...(def.model ? { model: def.model } : {}),
      // plan27：不回填的话，用户一打开表单再保存就把批准配置丢了（表单管理的字段必须完整往返）
      ...(def.approval === 'plan' ? { approval: 'plan' as const } : {}),
      ...(def.executor ? { executor: def.executor } : {}),
      systemPrompt: def.systemPrompt,
      file: def.file
    }
  })

  ipcMain.handle(IPC.agentsSave, (_e, raw: unknown): AgentSaveResult => {
    const input = friendlyParse(agentSaveInputSchema, raw)
    const { entries } = loadAgentEntries(agentLayers())
    const result = saveAgentDefinition(nodeFsAdapter, deps.agent.userAgentsDir, input, {
      builtinNames: entries.filter((e) => e.source === 'builtin').map((e) => e.name)
    })
    if (result.ok) {
      log.info('Agent 定义已保存', { name: input.name, file: result.file })
      sendToAll(IPC.agentsChanged)
    }
    return result
  })

  ipcMain.handle(IPC.agentsDelete, (_e, raw: unknown): { ok: true } | { ok: false; reason: string } => {
    const file = z.string().min(1).max(1000).parse(raw)
    const result = deleteAgentFile(nodeFsAdapter, file, deps.agent.userAgentsDir)
    if (result.ok) {
      log.info('Agent 定义已删除', { file })
      sendToAll(IPC.agentsChanged)
    }
    return result
  })

  // ── 记忆（plan19 批 1）────────────────────────────────────────────────
  /** 本轮的写入尝试记录。`friendlyParse` 只挡形状，长度与凭据归 `validateMemoryFields`（唯一口径） */
  const memorySaveSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(500),
    // plan25 D-071：class 含 profile —— 用户手动编辑/新建画像走这条 IPC（UI 下拉不给新建画像的
    // 入口，但编辑既有画像条目时分类要能保留）；模型直写 profile 由 save 层拒绝（D-073）。
    class: z.enum(['style', 'default', 'knowledge', 'profile']),
    body: z.string().min(1).max(100_000),
    origin: z.enum(['model', 'user', 'reflection']).optional(),
    evidence: z
      .object({ conversationId: z.string().min(1).max(64), turnIndex: z.number().int().min(0).optional() })
      .nullable()
      .optional(),
    file: z.string().min(1).max(1000).optional(),
    confirmed: z.boolean().optional(),
    // plan33 问题四：相似度闸门被拦后，用户在「选中即记」卡片明确选「仍要另存」才带 true。
    // 模型通路不传这个字段（memory-tools 无此参数）—— 模型被拒后只能换更具体的 name。
    force: z.boolean().optional()
  })

  /** 开一轮记忆采集并组装注入段。段在这里组装 —— 组合根才知道记忆库在哪（runner 不许碰 electron-store）。 */
  function beginMemoryTurn(conversationId: string): string | null {
    const index = deps.memory.list()
    // 注入事件落在这里：`inject` 去重（集合没变不写）由 repo 负责
    deps.memory.record({ kind: 'inject', conversationId, names: index.entries.map((e) => e.name) })
    deps.memory.beginTurn()
    return composeMemoryBlock(index)
  }

  /** 取走本轮写入痕迹并推给界面（护栏 2，D-043）。空手而归就**不推** —— 免得界面反复闪"没有写入" */
  function endMemoryTurn(conversationId: string): void {
    const turn = deps.memory.drainTurn()
    if (turn.written.length === 0 && turn.rejected.length === 0) return
    sendToAll(IPC.memoryNotice, { conversationId, ...turn })
  }

  ipcMain.handle(IPC.memoryList, (): MemoryIndex => deps.memory.list())

  ipcMain.handle(IPC.memoryRead, (_e, raw: unknown): MemoryEntry | null => {
    const file = z.string().min(1).max(1000).parse(raw)
    return deps.memory.get(file)
  })

  ipcMain.handle(IPC.memorySave, (_e, raw: unknown): MemorySaveResult => {
    const input = friendlyParse(memorySaveSchema, raw)
    const result = deps.memory.save(input as MemorySaveInput)
    if (result.ok) {
      log.info('记忆已保存', { name: input.name, file: result.file })
      sendToAll(IPC.memoryChanged)
    }
    return result
  })

  ipcMain.handle(IPC.memoryDelete, (_e, raw: unknown): boolean => {
    const file = z.string().min(1).max(1000).parse(raw)
    const removed = deps.memory.remove(file, 'user')
    if (removed) {
      log.info('记忆已删除', { file })
      sendToAll(IPC.memoryChanged)
    }
    return removed
  })

  // ── 合并疑似重复（plan33 问题四）── 方向由 repo.merge 按 createdAt 重判，渲染端传的顺序不 trusted。
  ipcMain.handle(
    IPC.memoryMerge,
    (_e, raw: unknown): { ok: boolean; message: string } => {
      const pair = z
        .object({ olderFile: z.string().min(1).max(1000), newerFile: z.string().min(1).max(1000) })
        .parse(raw)
      const result = deps.memory.merge(pair.olderFile, pair.newerFile)
      if (result.ok) {
        log.info('记忆已合并', pair)
        sendToAll(IPC.memoryChanged)
      }
      return result
    }
  )

  // ── 记忆开关（plan19 批 1）── 批 1 只管**通路 A**：关掉就不下发 remember / recall（结构性，
  //    由 runAgent 每轮按 `enabled()` 判断，"有消费者才注册"的同一口径）。通路 B 是用户主动行为，不受它管。
  ipcMain.handle(IPC.memoryGetSwitch, (): boolean => getMemoryEnabled())

  ipcMain.handle(IPC.memorySetSwitch, (_e, raw: unknown): MemorySwitchResult => {
    const enabled = z.boolean().parse(raw)
    const before = getMemoryEnabled()
    const after = setMemoryEnabled(enabled)
    // 判据 14：完全访问档 + 开启记忆 = **最大风险组合**。必须当场告知（判据 14 明文：
    // 只在设置页躺一行字等于没写），且**每次从关到开**都告一次 —— 风险组合是重新成立的。
    // 标记落 meta.json：有了落点，"告知过"这三个字才查得到，不是靠"我记得说过"。
    let warnFullAccess = false
    if (enabled && !before && getPermissionPreset() === 'full-access') {
      warnFullAccess = true
      const meta = deps.memory.backend.readMeta()
      deps.memory.backend.writeMeta({ ...meta, fullAccessNoticeShownAt: new Date().toISOString() })
      log.warn('记忆已开启且当前为完全访问档：已当场告知并落痕', {})
    }
    if (before !== after) sendToAll(IPC.memoryChanged)
    return { enabled: after, warnFullAccess }
  })

  // ── 记忆批 2：候选批准/拒绝 + 统计 ──
  // 候选由反思执行器写入 candidates/，批准 = 覆盖旧记忆 + 删候选，拒绝 = 删候选。
  // ⚠️ file 来自渲染进程，backend.remove 内已有 `insideCandidates` 边界检查。
  ipcMain.handle(IPC.memoryApprove, (_e, raw: unknown): MemorySaveResult => {
    const file = z.string().min(1).max(1000).parse(raw)
    const result = deps.memory.approveCandidate(file)
    if (result.ok) {
      log.info('候选已批准', { file, newFile: result.file })
      sendToAll(IPC.memoryChanged)
    }
    return result
  })

  ipcMain.handle(IPC.memoryReject, (_e, raw: unknown): boolean => {
    const file = z.string().min(1).max(1000).parse(raw)
    const removed = deps.memory.rejectCandidate(file)
    if (removed) {
      log.info('候选已拒绝', { file })
      sendToAll(IPC.memoryChanged)
    }
    return removed
  })

  ipcMain.handle(IPC.memoryStats, (): MemoryStats | null => deps.memory.getStats())

  /**
   * 用户标记「这条不对」（批 4）。⚠️ **只落一条 `flag` 事件，不改条目本身** ——
   * 用户可能在判断前还要看看，直接改动或删除等于替他做决定。
   * 它是 `falsePositiveRate` 的唯一数据来源（在此之前该指标恒为 0，属"算了但算不出东西"）。
   */
  ipcMain.handle(IPC.memoryFlag, (_e, raw: unknown): boolean => {
    const name = z.string().min(1).max(200).parse(raw)
    const ok = deps.memory.record({
      kind: 'flag',
      conversationId: getActiveConversationId(),
      name
    })
    if (ok) log.info('记忆已被用户标记为不准确', { name })
    return ok
  })

  /** Playbook 保存入参。⚠️ 长度与标签合法性归 `validatePlaybookFields`（唯一口径），这里只挡形状 */
  const playbookSaveSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(500),
    tags: z.array(z.string().min(1).max(100)).min(1).max(50),
    body: z.string().min(1).max(100_000),
    origin: z.enum(['model', 'playbook-reflection']).optional(),
    file: z.string().min(1).max(1000).optional()
  })

  // ── Playbook（plan19 批 3，会做线）──────────────────────────────────────
  // ⚠️ 条件召回：活跃标签与条目 tags 交集非空才注入 —— 预算与语义记忆**分开**
  //    （语义记忆无条件注入，才有"注入税"这个读数；Playbook 只在任务类型匹配时才花）。
  // ⚠️ 标签推断在**组合根**做（`loader.ts` 是纯函数、不接触运行时状态；
  //    `runner.ts` 只管拼段），本文件是唯一同时知道"这一轮是谁 + Playbook 库在哪"的地方。

  /**
   * 关键词 → 活跃标签。⚠️ 这是**声明过的无实验支撑初值**（plan19 §十二）：
   * 只求"可演示、可机器判定"，不求准；后续可升级为工具序列分析而不影响存储格式。
   * 全部小写比对（`normalizeTag` 同一口径）。
   */
  const PLAYBOOK_TAG_KEYWORDS: Record<string, readonly string[]> = {
    'file-edit': ['编辑', '改一下', '修改文件', '重命名', 'edit', 'rename'],
    debug: ['调试', '报错', 'bug', '为什么失败', '排查', 'debug'],
    research: ['调研', '查一下', '搜索', '对比', 'research', 'search'],
    build: ['构建', '打包', '编译', 'build', 'compile'],
    test: ['测试', '跑测试', '单测', 'test'],
    refactor: ['重构', '整理代码', '拆分', 'refactor']
  }

  /** 从一句话里推断活跃标签（可多个）。空字符串 → 空数组（不误召回） */
  function inferActiveTags(text: string): string[] {
    const lower = text.toLowerCase()
    const hit: string[] = []
    for (const [tag, words] of Object.entries(PLAYBOOK_TAG_KEYWORDS)) {
      if (words.some((w) => lower.includes(w))) hit.push(tag)
    }
    return hit
  }

  /**
   * 组装 Playbook 条件召回段。⚠️ 与 `beginMemoryTurn` 各自独立 ——
   * 没有"本轮开始/结束"的配对（Playbook 不需要采集写入痕迹：它是模型显式调用，不是自动写入）。
   * `text` = 用户这一轮的原话（活跃标签的唯一来源）。
   */
  function assemblePlaybookBlock(conversationId: string, text: string): string | null {
    const activeTags = inferActiveTags(text)
    if (activeTags.length === 0) return null
    const index = deps.playbook.list()
    const block = composePlaybookBlock(index, activeTags)
    if (block !== null) {
      // 注入事件：只在真的注入了才记（没注入就不该有痕）
      const matched = index.entries
        .filter((e) => e.tags.some((t) => activeTags.includes(t)))
        .map((e) => e.name)
      deps.playbook.record({ kind: 'playbook_inject', conversationId, names: matched })
    }
    return block
  }

  /**
   * 组装技能清单段（plan22 D-057）。技能是**静态资产**（无活跃标签推断），
   * 组装即全量交给 composeSkillBlock 做预算截断；截断发生时 log 一条
   * —— 模型侧的块尾有「另有 N 条」，开发侧有这条日志，**双侧都不静默**。
   */
  function assembleSkillBlock(): string | null {
    const store = deps.agent.skills?.store
    if (!store) return null
    // plan34 S1：**注入前**过滤掉被禁用的技能 —— 这里是「真禁用」的落点（模型侧确实看不到），
    // **不是**靠设置页藏 UI。⚠️ 只过滤注入，不过滤 `store.view()`：设置页必须看到被禁用的项才能重新开启。
    // 立即生效（用户拍板）：工具/技能每轮装配，下一轮请求自然按新开关走。
    const enabledEntries = filterDisabledEntries(store.view().entries, getSkillsDisabled())
    const { block, droppedByBytes, droppedByCount } = composeSkillBlock(enabledEntries)
    if (droppedByBytes + droppedByCount > 0) {
      log.warn(
        `技能清单超出注入预算：字节上限丢弃 ${droppedByBytes} 条、条数上限丢弃 ${droppedByCount} 条（共 ${enabledEntries.length} 条）`,
        {}
      )
    }
    return block
  }

  /** 组装规则注入段（plan24 D-068）：**无条件注入**的约束（每轮都在）；预算截断时 log 被丢文件名 */
  function assembleRulesBlock(): string | null {
    const { block, droppedFiles } = composeRulesBlock(deps.agent.getWorkspaceRoot(), deps.userDataDir)
    if (droppedFiles.length > 0) {
      log.warn(`规则文件超出注入预算：未注入 ${droppedFiles.join('、')}`, {})
    }
    return block
  }

  ipcMain.handle(IPC.playbookList, (): PlaybookIndex => deps.playbook.list())

  // 执行事件流（plan26 D-077）：时间线回放的数据源 —— 只读 JSONL，倒序 + 会话过滤 + limit。
  // ⚠️ 事件里只有元数据（白名单在 recorder 侧强制），这里原样交出、不做二次裁剪。
  ipcMain.handle(IPC.execEventsList, (_e, raw: unknown): ExecEventListResult => {
    return readExecEvents(deps.userDataDir, nodeFsAdapter, sanitizeExecEventQuery(raw))
  })

  ipcMain.handle(IPC.playbookSave, (_e, raw: unknown): PlaybookSaveResult => {
    const input = friendlyParse(playbookSaveSchema, raw)
    const result = deps.playbook.save(input as PlaybookSaveInput)
    if (result.ok) {
      log.info('Playbook 已保存', { name: input.name, file: result.file })
      sendToAll(IPC.playbookChanged)
    }
    return result
  })

  ipcMain.handle(IPC.playbookDelete, (_e, raw: unknown): boolean => {
    const file = z.string().min(1).max(1000).parse(raw)
    const removed = deps.playbook.remove(file)
    if (removed) {
      log.info('Playbook 已删除', { file })
      sendToAll(IPC.playbookChanged)
    }
    return removed
  })

  // 批 2：自动记忆成本设置（开关 + 日上限 + 反思模型）
  ipcMain.handle(IPC.memoryGetAuto, (): MemoryAutoSettings => ({
    autoMemoryEnabled: getAutoMemoryEnabled(),
    reflectionModel: getReflectionModel(),
    reflectionDailyLimit: getReflectionDailyLimit()
  }))
  ipcMain.handle(
    IPC.memorySetAuto,
    (_e, patch: Partial<MemoryAutoSettings>): MemoryAutoSettings => {
      if (typeof patch.autoMemoryEnabled === 'boolean') {
        setAutoMemoryEnabled(patch.autoMemoryEnabled)
      }
      if (typeof patch.reflectionModel === 'string') {
        setReflectionModel(patch.reflectionModel || null)
      }
      if (typeof patch.reflectionDailyLimit === 'number') {
        setReflectionDailyLimit(patch.reflectionDailyLimit)
      }
      return {
        autoMemoryEnabled: getAutoMemoryEnabled(),
        reflectionModel: getReflectionModel(),
        reflectionDailyLimit: getReflectionDailyLimit()
      }
    }
  )

  // ── 电脑控制开关（2026-09-15 立，plan44 09-18 接上实体）── 单一真相源：
  //    每轮发送现取此值传入 createMcpTools，桌面派（windows-mcp）server 的工具据此整体下发/拦截。
  //    开关变更自**下一轮对话**起生效（工具表按轮重建）。
  ipcMain.handle(IPC.computerControlGet, (): boolean => getComputerControlEnabled())

  ipcMain.handle(IPC.computerControlSet, (_e, raw: unknown): boolean => {
    const enabled = z.boolean().parse(raw)
    return setComputerControlEnabled(enabled)
  })

  // ── 技能禁用名单（plan34 S1/S2a）──「真禁用」的读写口：assembleSkillBlock 注入前过滤（模型侧确实看不到）。
  //    ⚠️ 只有技能走名单 —— 技能文件是用户资产不可写；**MCP 的开关走配置 `cfg.enabled`**（单一真相源，见 mcpSet）。
  ipcMain.handle(IPC.skillsDisabledGet, (): string[] => getSkillsDisabled())

  ipcMain.handle(IPC.skillsDisabledSet, (_e, raw: unknown): string[] => {
    const names = z.array(z.string().min(1).max(120)).max(500).parse(raw)
    return setSkillsDisabled(names)
  })

  // ── 技能写路径（plan34 S2b）── 只落**用户层**（内置随包不可写）；删除走回收站（非硬删）。
  //    写后 store.reload()（装配层重扫）→ onChange 接线统一广播 skillsChanged（见下方接线），不在 handler 里各发各的。
  ipcMain.handle(IPC.skillSave, (_e, raw: unknown): SkillWriteResult => {
    const input = z
      .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        description: z.string().min(1).max(1024),
        descriptionZh: z.string().max(1024).optional(),
        descriptionEn: z.string().max(1024).optional(),
        version: z.string().max(40).optional(),
        body: z.string().min(1).max(200000)
      })
      .parse(raw)
    const r = saveSkillFile({ userDir: deps.agent.skills?.store.getUserDir() ?? null }, input)
    if (r.ok) deps.agent.skills?.store.reload()
    return r
  })

  ipcMain.handle(IPC.skillDelete, async (_e, raw: unknown): Promise<SkillWriteResult> => {
    const name = z.string().min(1).max(64).parse(raw)
    const r = await deleteSkillFile(
      { userDir: deps.agent.skills?.store.getUserDir() ?? null, trash: deps.trash },
      name
    )
    if (r.ok) deps.agent.skills?.store.reload()
    return r
  })


  ipcMain.handle(IPC.permissionGet, (): PermissionPreset => getPermissionPreset())

  ipcMain.handle(IPC.permissionSet, (_e, raw: unknown): PermissionPreset => {
    const preset = z.enum(['read-only', 'write', 'full-access']).parse(raw)
    const applied = setPermissionPreset(preset)
    // ⚠️ 降到只读时**必须把正在跑的终端会话收掉**：权限档的语义是"这台机器只读，人和模型同一把尺"，一个还在跑的 shell 会让"只读"变成空话 —— 界面横幅写着"不执行命令"，屏幕上却在执行。
    if (applied === 'read-only') deps.terminal.killAll()
    // plan40 S3：广播给各窗口，终端面板据此重取权限并重 boot —— 界面不许停在旧档的"运行中"
    deps.onSettingsChanged?.('permission')
    return applied
  })

  // 省 token 档位与权限档同一个模式：**人定的档存在主进程**，界面只是它的一个视图。这里用 zod 收口而不是"认不出就回落"：回落是给**读**用的，**写**进来的脏值必须当场拒。
  ipcMain.handle(IPC.tokenTierGet, (): TokenSaverTier => getTokenTier())

  ipcMain.handle(IPC.tokenTierSet, (_e, raw: unknown): TokenSaverTier => {
    const tier = z.enum(['rich', 'ultimate', 'balanced', 'light']).parse(raw)
    return setTokenTier(tier)
  })

  // 系统集成（plan7 批 F1）。⚠️ 返回的是**主进程算出来的真值**（含 blocker 是否真生效、自启是否被系统接受），
  // 界面一律用它回显 —— 乐观更新会做出"点了变绿、其实没生效"的假象。
  ipcMain.handle(IPC.systemGet, (): SystemView => deps.system.view())

  ipcMain.handle(IPC.systemSet, (_e, raw: unknown): SystemView => {
    const patch = systemSetSchema.parse(raw) as Partial<SystemSettings>
    return deps.system.set(patch)
  })

  // ── 网络代理（plan7 批 F2）──
  //
  // ⚠️ 取数一律走主进程返回值回显、**不做乐观更新**：代理"配了但没生效"是一个**静默**故障
  //    （界面看不出来、日志不报错、请求照旧直连），只有主进程的 `applied` 与探测到的
  //    `effective` 能证明它到底生效没有。
  // ── 界面字体（plan7 批 F3）：枚举失败返回原因，不抛 —— 别让一个下拉框把设置页打挂 ──
  ipcMain.handle(IPC.fontsList, () => listSystemFonts())

  ipcMain.handle(IPC.netProxyGet, (): NetworkView => deps.network.view())

  ipcMain.handle(IPC.netProxySet, async (_e, raw: unknown): Promise<NetworkView> => {
    const patch = netProxySetSchema.parse(raw) as NetworkPatch
    const view = await deps.network.set(patch)
    // 代理改了要广播：设置窗口与主窗口是两个渲染进程，不推就只有一半界面知道
    deps.onSettingsChanged?.('settings')
    return view
  })

  // ── Firecrawl（plan32）：web_search 的密钥型源 ──
  //
  // Key 只进不出：读回只有 `hasKey`（与代理凭据同口径 —— 明文不回显，改就重新填）。
  // 保存失败（加密服务不可用）把人话错误原样抛给渲染端显示，不静默吞。
  ipcMain.handle(IPC.firecrawlGet, () => ({ hasKey: getFirecrawlKey().length > 0 }))

  ipcMain.handle(IPC.firecrawlSet, (_e, raw: unknown): { hasKey: boolean } => {
    const key = raw === null ? null : z.string().max(500).parse(raw)
    setFirecrawlKey(key !== null && key.length > 0 ? key : null)
    return { hasKey: getFirecrawlKey().length > 0 }
  })

  ipcMain.handle(IPC.gitInfo, (): Promise<GitInfo | null> =>
    readGitInfo(getWorkspaceInfo(deps.userDataDir).path)
  )

  // ── 源代码管理（plan16）：变更列表 / 暂存 / 提交 ──
  //
  // ⚠️ 这一组里的 add / restore / commit 是**写操作**，但与"工作区文件写入"同属**用户在界面上亲手点的**那一类：
  //    不受权限档拦截（权限档管的是 **Agent** 能碰什么，见 `agent/runner.ts` 的 `allowedToolsFor`）。
  //    真正挡住越界的是 `store/git-info.ts` 里的 `safeRel`（`resolveInsideWorkspace`）——
  //    界面传来的每一条路径都要过它，否则就能 `git add ../../别的目录/文件`。

  const gitPathsSchema = z.array(z.string().min(1).max(1024)).min(1).max(500)

  ipcMain.handle(IPC.gitStatus, async (): Promise<GitStatusResult> => {
    try {
      return { ok: true, view: await readGitStatus(deps.agent.getWorkspaceRoot()) }
    } catch (err) {
      // 非 Git 仓库是最常见的一种，**必须说清**：空白面板会被读成"没有改动"，那是假账。
      // 顺带给"怎么办"（其余情况 —— git 没装 / 超时 —— 原样把原因说出来，不编）
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        view: null,
        message:
          err instanceof NotARepoError
            ? `${message} —— 可在终端里执行 git init，或换一个工作区`
            : message
      }
    }
  })

  ipcMain.handle(IPC.gitDiff, async (_e, raw: unknown): Promise<string> => {
    const rel = z.string().min(1).max(1024).parse(raw)
    return readGitDiff(deps.agent.getWorkspaceRoot(), rel)
  })

  /** 写操作收口：**失败原样带 git 的原因**回界面（项目一贯的"界面把原因说出来"），成功后广播刷新 */
  const runGitWrite = async (fn: () => Promise<void>): Promise<GitOpResult> => {
    try {
      await fn()
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    sendToAll(IPC.gitChanged)
    return { ok: true }
  }

  ipcMain.handle(IPC.gitStage, async (_e, raw: unknown): Promise<GitOpResult> => {
    const p = gitPathsSchema.safeParse(raw)
    if (!p.success) return { ok: false, message: '入参不合法' }
    return runGitWrite(() => gitStage(deps.agent.getWorkspaceRoot(), p.data))
  })

  ipcMain.handle(IPC.gitUnstage, async (_e, raw: unknown): Promise<GitOpResult> => {
    const p = gitPathsSchema.safeParse(raw)
    if (!p.success) return { ok: false, message: '入参不合法' }
    return runGitWrite(() => gitUnstage(deps.agent.getWorkspaceRoot(), p.data))
  })

  ipcMain.handle(IPC.gitCommit, async (_e, raw: unknown): Promise<GitCommitResult> => {
    const p = z.string().min(1).max(20_000).safeParse(raw)
    if (!p.success) return { ok: false, summary: '', message: '提交消息不能为空' }
    try {
      const summary = await gitCommit(deps.agent.getWorkspaceRoot(), p.data)
      sendToAll(IPC.gitChanged)
      return { ok: true, summary }
    } catch (err) {
      // git 的失败原因很有用（"nothing to commit" / hook 挂了 / 没配 user.email）—— 原话回给用户
      return { ok: false, summary: '', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 附件：选文件 → 读入内容（上限 64KB，超出截断并标注）；「路径 → 附件」实现在 `workspace-fs.readAttachment`，**两个入口共用**（文件选择框 / 拖拽进来）—— 抽到那边是为了能单测。
  ipcMain.handle(IPC.attachFile, async (e): Promise<Attachment | null> => {
    const ws = getWorkspaceInfo(deps.userDataDir).path
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { properties: ['openFile' as const], defaultPath: ws }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return readAttachment(ws, res.filePaths[0]!)
  })

  // 拖拽进来的文件：相对路径来自工作区文件树（必须在工作区内），绝对路径来自系统资源管理器（明确拖入即放行）；边界规则与理由集中在 `workspace-fs.readAttachment`，这里只管留痕。
  ipcMain.handle(IPC.attachPath, async (_e, raw: unknown): Promise<Attachment> => {
    const pathOrRel = z.string().min(1).max(4096).parse(raw)
    const ws = getWorkspaceInfo(deps.userDataDir).path
    try {
      return await readAttachment(ws, pathOrRel)
    } catch (err) {
      // **留痕**：附件被拒以前是静默的 —— 界面上看到一句"越界"、日志里什么都没有，事后只能靠猜。带上载荷与边界就够定位了。
      log.warn('附件被拒', {
        received: pathOrRel,
        workspace: ws,
        kind: /^[a-zA-Z]:[\\/]|^\\\\/.test(pathOrRel) ? '系统拖拽/绝对路径' : '工作区相对路径',
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  })

  ipcMain.handle(IPC.promptPolish, async (_e, raw: unknown): Promise<string> => {
    const text = z.string().min(1).max(20000).parse(raw)
    const settings = getSettingsView()
    const apiKey = getDecryptedApiKey()
    if (!settings.baseURL || !settings.model || !apiKey) {
      throw new Error('请先在「设置」页配置模型与 API Key。')
    }
    const provider = createProvider(settings.providerType)
    let out = ''
    await provider.streamChat(
      {
        settings: { ...settings, stream: false },
        apiKey,
        messages: [
          {
            role: 'system',
            content:
              '你是提示词优化器。把用户草稿改写成更清晰、可执行的指令：保留原意与关键约束，补齐必要的目标与产出格式，不添加用户没提的需求。只输出改写后的文本本身，不要解释。'
          },
          { role: 'user', content: text }
        ],
        signal: AbortSignal.timeout(45000)
      },
      { onChunk: (t) => { out += t } }
    )
    return out.trim() || text
  })


  ipcMain.handle(IPC.browserState, (): BrowserState => getBrowserState())

  ipcMain.handle(IPC.browserNavigate, async (_e, raw: unknown): Promise<BrowserState> => {
    const url = z.string().min(1).max(2000).parse(raw)
    return browserNavigate(url)
  })

  ipcMain.handle(IPC.browserBack, (): BrowserState => browserGoBack())
  ipcMain.handle(IPC.browserForward, (): BrowserState => browserGoForward())
  ipcMain.handle(IPC.browserReload, (): BrowserState => browserReload())

  ipcMain.handle(IPC.browserSetVisible, (_e, raw: unknown): void => {
    setBrowserVisible(Boolean(z.boolean().parse(raw)))
  })

  ipcMain.handle(IPC.browserSetBounds, (_e, raw: unknown): void => {
    const b = z
      .object({
        x: z.number().min(-10000).max(10000),
        y: z.number().min(-10000).max(10000),
        width: z.number().min(0).max(10000),
        height: z.number().min(0).max(10000)
      })
      .parse(raw)
    setBrowserBounds(b)
  })


  ipcMain.handle(IPC.logsOpen, async (): Promise<boolean> => {
    const dir = getLogDir()
    if (!dir) return false
    const err = await shell.openPath(dir)
    return err.length === 0
  })

  ipcMain.handle(IPC.logsInfo, (): LogsInfo => {
    const dir = getLogDir()
    return { dir, files: listLogFiles() }
  })


  ipcMain.handle(IPC.checkpointList, (): CheckpointRunMeta[] => deps.agent.checkpoints.list())

  ipcMain.handle(IPC.checkpointGet, (_e, rawRunId: unknown): CheckpointRun | null => {
    const parsed = z.string().min(1).max(64).safeParse(rawRunId)
    if (!parsed.success) return null
    return deps.agent.checkpoints.get(parsed.data)
  })

/** Diff 视图取两侧内容（plan13 B3）。**纯读**：不落盘、不动检查点、不产生轮次。两侧**都在这里读**（快照 + 当前）—— 一次 IPC 拿到的两侧才是**同一时刻**的一致快照，分两次读中间可能被 Agent 改掉。 */
  ipcMain.handle(
    IPC.checkpointSides,
    async (_e, raw: unknown): Promise<CheckpointSidesResult> => {
      const parsed = z
        .object({ runId: z.string().min(1).max(64), rel: z.string().min(1).max(1024) })
        .safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'bad-rel' }
      const { runId, rel } = parsed.data

      // 先挡路径：rel 会用来拼磁盘路径（与回滚同一道防线）
      if (!isSafeRel(rel)) return { ok: false, reason: 'bad-rel' }

      const run = deps.agent.checkpoints.get(runId)
      if (!run) return { ok: false, reason: 'run-missing' }
      const change = selectChanges(run.changes, rel)[0]
      if (!change) return { ok: false, reason: 'not-recorded' }

      // ⚠️ **工作区一致性**（审查指出）：检查点目录是全局的，列表里会有别的工作区的轮次，而 rel 是相对路径 —— 拿当前工作区去拼就会比到**同名的另一个文件**；拦在这里，比"显示一份对不上的差异"诚实得多。
      const workspaceRoot = deps.agent.getWorkspaceRoot()
      if (!samePath(run.workspace, workspaceRoot)) {
        return { ok: false, reason: 'other-workspace' }
      }

      const snap = deps.agent.checkpoints.readBackup(runId, rel)
      // `created` 是**合法地**没有快照侧（当轮之前文件不存在），其余失败才是真看不了
      if (!snap.ok && snap.reason !== 'created') {
        return { ok: false, reason: 'backup-missing' }
      }

      const cur = await readWorkspaceFile(deps.agent.getWorkspaceRoot(), rel)
      const after = cur.ok ? cur.content : null
      const beforeTruncated = snap.ok ? snap.truncated : false
      const afterTruncated = cur.ok && cur.truncated === true
      // 有损解码（GBK / 二进制）：界面对这类文件必须说"逐处退回会损坏它"
      const lossy = (snap.ok && snap.lossy) || (cur.ok && cur.lossy === true)

      return {
        ok: true,
        runId,
        rel: change.rel,
        kind: change.kind,
        before: snap.ok ? snap.content : null,
        after,
        beforeBytes: change.beforeBytes,
        afterBytes: cur.ok ? cur.size : 0,
        truncated: beforeTruncated || afterTruncated,
        lossy,
        ...(cur.ok && cur.mtimeMs !== undefined ? { mtimeMs: cur.mtimeMs } : {}),
        runStatus: run.status
      }
    }
  )

  ipcMain.handle(
    IPC.checkpointRollback,
    (_e, raw: unknown): RollbackReport => {
      const input = z
        .object({ runId: z.string().min(1).max(64), rel: z.string().min(1).max(1024).optional() })
        .parse(raw)
      // ⚠️ **回滚也要能"再回滚一次"**：回滚是"把现在的内容换成别的"，它自己不留快照的话，用户退错了就**永远回不去** —— 所以先把"即将被覆盖的当前内容"存成一轮检查点，再动手。
      const preRunId = deps.agent.checkpoints.snapshotCurrent(
        input.runId,
        input.rel,
        '界面：回滚前的自动备份',
        UI_RUN_OWNER
      )
      const report = deps.agent.checkpoints.rollback(input.runId, input.rel)
      log.info('执行回滚', {
        runId: input.runId,
        target: input.rel ?? '（整轮）',
        preRunId: preRunId ?? '（无可备份内容）',
        restored: report.restored.length,
        deleted: report.deleted.length,
        failed: report.failed.length,
        rejected: report.rejected.length
      })
      return report
    }
  )

  ipcMain.handle(IPC.confirmRespond, (_e, raw: unknown): void => {
    const parsed = z
      .object({ id: z.string().min(1).max(64), allowed: z.boolean() })
      .safeParse(raw)
    if (!parsed.success) return
    deps.confirm.respond(parsed.data)
  })

  // 计划批准回执（plan27）：同样只做**形状校验 + 转交** —— 配对、超时、按拒绝的语义都在
  // `agent/plan-approval.ts` 那层（它是纯函数、可单测；本文件 import 了 electron，CI 上跑不了）。
  // 返回 `false` = 主进程**没认领**（已超时 / 已中断）：界面据此如实说明，不许当成送达。
  ipcMain.handle(IPC.planApprovalRespond, (_e, raw: unknown): boolean => {
    const parsed = z
      .object({ id: z.string().min(1).max(64), allowed: z.boolean() })
      .safeParse(raw)
    if (!parsed.success) return false
    return deps.planApproval.respond(parsed.data)
  })

  // 提问回执：这里只做**形状校验 + 转交**。配对、三种形态的优先级、超时都在 `ask.ts` 的桥里（那层纯函数可单测；
  // 本文件 import 了 electron，CI 上跑不了）。值只当**候选**看：不在选项里的一律由桥丢弃。
  // ⚠️ `skip` / `text` 必须写进 schema —— zod 默认**丢掉**未声明的键，漏一个就等于"界面的跳过与自填被静默吞掉"。
  ipcMain.handle(IPC.askRespond, (_e, raw: unknown): boolean => {
    const parsed = z
      .object({
        id: z.string().min(1).max(64),
        values: z.array(z.string().max(200)).max(ASK_MAX_OPTIONS),
        skip: z.boolean().optional(),
        // 上限只为拦异常载荷：用户自己写的答案不该因为界面之外的原因被砍
        text: z.string().max(4000).optional()
      })
      .safeParse(raw)
    if (!parsed.success) return false
    const result: AskResult = parsed.data
    return deps.ask.respond(result)
  })

  ipcMain.handle(IPC.uiPrefsGet, (): UIPrefs => getUIPrefs())

  ipcMain.handle(IPC.uiPrefsSet, (_e, raw: unknown): UIPrefs => {
    const patch = z
      .object({
        sidebarWidth: z.number().min(1).max(4096).optional(),
        dockWidth: z.number().min(1).max(4096).optional(),
        theme: z.enum(THEME_IDS).optional(),
        // 字号档/字体名（plan7 批 F3）：形状在这层把关，语义清洗（坏值回落）交给 setUIPref
        fontScale: z.enum(FONT_SCALE_KEYS).optional(),
        uiFont: z.string().max(UI_FONT_MAX).optional(),
        workbench: workbenchSchema.optional(),
        workbenchSizes: workbenchSizesSchema.optional()
      })
      .parse(raw)
    // 形状过了之后交给 setUIPref 做语义清洗并落盘（它返回**清洗后**的完整偏好）
    const next = setUIPref(patch as Partial<UIPrefs>)
    // 主题/布局改了 → 另一个窗口要跟着变（尤其主题：它是文档级属性，不通知就一边新一边旧）
    deps.onSettingsChanged?.('ui-prefs')
    return next
  })

  ipcMain.handle(IPC.uiPrefsReset, (): UIPrefs => {
    const next = resetUIPrefs()
    deps.onSettingsChanged?.('ui-prefs')
    return next
  })

  // ── 工作区文件树（只读）：工作区路径每次实时解析（用户可切换工作区，免重启）
  ipcMain.handle(IPC.fsList, (_e, raw: unknown): Promise<FsListResult> => {
    const rel = z.string().max(1024).safeParse(raw)
    return listWorkspaceDir(deps.agent.getWorkspaceRoot(), rel.success ? rel.data : '')
  })

  ipcMain.handle(IPC.fsRead, (_e, raw: unknown): Promise<FsReadResult> => {
    const rel = z.string().min(1).max(1024).parse(raw)
    return readWorkspaceFile(deps.agent.getWorkspaceRoot(), rel)
  })

  ipcMain.handle(IPC.fsReadBinary, (_e, raw: unknown): Promise<FsBinaryResult> => {
    const rel = z.string().min(1).max(1024).parse(raw)
    return readWorkspaceBinary(deps.agent.getWorkspaceRoot(), rel)
  })

  // Office 内嵌预览（docx/xlsx）：主进程解析 → 内存预览表 → 渲染端拿沙箱 URL。
  // ⚠️ 故意不在渲染端解析：HTML 是用户文件内容，渲染层「零 HTML 注入原语」的基线不能破。
  ipcMain.handle(IPC.officePreview, (_e, raw: unknown): Promise<FsOfficeResult> => {
    const rel = z.string().min(1).max(1024).parse(raw)
    return renderOfficePreview(deps.agent.getWorkspaceRoot(), rel)
  })

  // 工作区写操作（plan7 批 A2）：① 全部走**统一写入服务**（界面与 Agent 同一条写入路径）；② 每个操作**各开一个检查点轮次**，于是界面里删掉/改掉的东西同样出现在「文件变更记录」里、同样退得回；③ 删除走回收站，不是硬删。
  const fsWriteInput = z.object({
    rel: z.string().min(1).max(1024),
    content: z.string().max(5_000_000),
    /** 冲突基线（编辑时带上；文件树的新建/重命名那条**不带**）：带了就比对 mtime，对不上**不写盘**、回 `conflict: true` 让用户选 —— 不做静默覆盖。 */
    expectedMtimeMs: z.number().nonnegative().optional()
  })
  const fsRelInput = z.object({ rel: z.string().min(1).max(1024) })
  const fsRenameInput = z.object({
    rel: z.string().min(1).max(1024),
    nextRel: z.string().min(1).max(1024)
  })
  const fsImportInput = z.object({
    sourceAbs: z.string().min(1).max(4096),
    rel: z.string().min(1).max(1024)
  })

/** 开一个检查点轮次 → 跑写入 → 收尾。**失败也照样 finish**：manifest 是增量落盘的，已发生的改动仍可回滚。 */
  const runFsOp = async (
    label: string,
    fn: (writer: WorkspaceWriter) => Promise<string>
  ): Promise<FsOpResult> => {
    const workspaceRoot = deps.agent.getWorkspaceRoot()
    // 界面直接发起的文件操作（新建 / 改名 / 删除）不属于任何一条会话 —— 用一个**明确的哨兵**记归属，不留空（检查点里"这轮是谁跑的"必须永远答得出来）
    const runId = deps.agent.checkpoints.begin(workspaceRoot, label, UI_RUN_OWNER)
    const writer = createWorkspaceWriter(workspaceRoot, {
      beforeChange: (rel, abs) => deps.agent.checkpoints.record(runId, workspaceRoot, rel, abs),
      trash: (abs) => shell.trashItem(abs)
    })
    try {
      return { ok: true, message: await fn(writer) }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      deps.agent.checkpoints.finish(runId)
      // ⚠️ 必须在这里广播一次"检查点变了"（面板据此刷新），且**必须走 `createChatEmitter`**：界面自己发起的写操作同样产生轮次，而"逐处退回"刚承诺了"退错了还能再退"，承诺一条**找不到的轮次**就成骗人的话。
      // **不许写裸 `webContents.send`**：结构性守卫（`tests/unit/stream-envelope.test.ts`）要求"ipc.ts 一个裸 `.send(` 都不许有"——绕开唯一发送口会漏带会话身份、界面串台。用广播而非只发发起窗口：检查点列表是**全局**的，谁改了它谁就该刷新。
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          createChatEmitter(win.webContents, UI_RUN_OWNER).checkpoint(runId)
        }
      }
      // 顺带通知 Git 面板刷新（plan16）：这里改的是工作区文件，git 状态必然跟着变 ——
      // 与 `git:*` 写操作走同一条广播，面板只订阅一处，不靠定时器轮询去猜。
      sendToAll(IPC.gitChanged)
    }
  }

  ipcMain.handle(IPC.fsWrite, async (_e, raw: unknown): Promise<FsOpResult> => {
    const p = fsWriteInput.safeParse(raw)
    if (!p.success) return { ok: false, message: '入参不合法' }
    const workspaceRoot = deps.agent.getWorkspaceRoot()

    // **边界②：外部冲突**（plan7 批 A3）：文件可能在"打开之后、保存之前"被改过 —— 这时**不许静默覆盖**，把冲突如实回给界面由用户选；拿不到 mtime（文件刚被删）也当作冲突。
    if (p.data.expectedMtimeMs !== undefined) {
      const abs = resolveInsideWorkspace(workspaceRoot, p.data.rel)
      if (!abs) return { ok: false, message: `路径「${p.data.rel}」越出工作区边界，已拒绝` }
      let currentMtime: number | null = null
      try {
        currentMtime = statSync(abs).mtimeMs
      } catch {
        currentMtime = null
      }
      if (currentMtime === null || Math.abs(currentMtime - p.data.expectedMtimeMs) > 1) {
        log.info('保存被拦下：文件在打开之后被改过', {
          rel: p.data.rel,
          expected: p.data.expectedMtimeMs,
          current: currentMtime
        })
        return {
          ok: false,
          conflict: true,
          message: currentMtime === null ? '该文件已不存在（可能被删除或重命名）' : '文件在打开之后已被修改',
          ...(currentMtime !== null ? { mtimeMs: currentMtime } : {})
        }
      }
    }

    const res = await runFsOp('界面 · 写文件', (w) => w.write(p.data.rel, p.data.content))
    if (!res.ok) return res
    // 写成功 → 回新的 mtime 当基线（编辑器据此继续编辑不会立刻自撞"冲突"）
    const abs = resolveInsideWorkspace(workspaceRoot, p.data.rel)
    let mtimeMs: number | undefined
    if (abs) {
      try {
        mtimeMs = statSync(abs).mtimeMs
      } catch {
        mtimeMs = undefined
      }
    }
    return { ...res, ...(mtimeMs !== undefined ? { mtimeMs } : {}) }
  })

  ipcMain.handle(IPC.fsMkdir, (_e, raw: unknown): Promise<FsOpResult> => {
    const p = fsRelInput.safeParse(raw)
    if (!p.success) return Promise.resolve({ ok: false, message: '入参不合法' })
    return runFsOp('界面 · 新建文件夹', (w) => w.mkdir(p.data.rel))
  })

  ipcMain.handle(IPC.fsRename, (_e, raw: unknown): Promise<FsOpResult> => {
    const p = fsRenameInput.safeParse(raw)
    if (!p.success) return Promise.resolve({ ok: false, message: '入参不合法' })
    return runFsOp('界面 · 重命名', (w) => w.rename(p.data.rel, p.data.nextRel))
  })

  ipcMain.handle(IPC.fsDelete, (_e, raw: unknown): Promise<FsOpResult> => {
    const p = fsRelInput.safeParse(raw)
    if (!p.success) return Promise.resolve({ ok: false, message: '入参不合法' })
    return runFsOp('界面 · 删除', (w) => w.remove(p.data.rel))
  })

  ipcMain.handle(IPC.fsImport, (_e, raw: unknown): Promise<FsOpResult> => {
    const p = fsImportInput.safeParse(raw)
    if (!p.success) return Promise.resolve({ ok: false, message: '入参不合法' })
    return runFsOp('界面 · 导入文件', (w) => w.copyIn(p.data.sourceAbs, p.data.rel))
  })

  // 内置终端：这些 handler 只做**两件事** —— 校验入参 → 转给会话层。真正的逻辑（权限门控 / cwd 校验 / 缓冲 / 序号 / 树杀）都在 `terminal-session.ts`（依赖注入、可单测）；handler 这层 import 了 electron，CI 上跑不了。
  ipcMain.handle(IPC.terminalStart, (_e, raw: unknown): TerminalStartResult => {
    const size = z
      .object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) })
      .safeParse(raw)
    return deps.terminal.start(size.success ? size.data : undefined)
  })

  ipcMain.handle(IPC.terminalRestart, (): TerminalStartResult => deps.terminal.restart())

  ipcMain.handle(IPC.terminalSnapshot, (): TerminalSessionSnapshot | null => deps.terminal.current())

  ipcMain.handle(IPC.terminalWrite, (_e, raw: unknown): { ok: boolean; message?: string } => {
    // 上限 64KB：一次按键/粘贴不该有这么大，真有就是异常，别把它灌进 pty
    const parsed = z.string().max(64 * 1024).safeParse(raw)
    if (!parsed.success) return { ok: false, message: '输入不合法' }
    return deps.terminal.write(parsed.data)
  })

  ipcMain.handle(IPC.terminalResize, (_e, raw: unknown): void => {
    const parsed = z
      .object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) })
      .safeParse(raw)
    if (!parsed.success) return
    deps.terminal.resize(parsed.data.cols, parsed.data.rows)
  })

  ipcMain.handle(IPC.terminalKill, (): boolean => deps.terminal.kill())

  // 背压回执（plan14 §三⑤ 的硬要求）：界面每解析完一段就回一次，主进程按"未回执字符数"暂停/恢复 pty 读取。**不是可选优化** —— xterm 的 `write()` 在 50MB 未解析数据时直接抛异常丢数据。
  ipcMain.handle(IPC.terminalAck, (_e, raw: unknown): void => {
    const parsed = z
      .object({ sessionId: z.string().max(200), chars: z.number().int().min(0).max(64 * 1024 * 1024) })
      .safeParse(raw)
    if (!parsed.success) return
    deps.terminal.ack(parsed.data.sessionId, parsed.data.chars)
  })

  // 背压**重对齐**：界面重挂并重放完之后调。没有它的话，"切走页签期间没人回执"会让 pty 一直停在暂停上 —— 切回来看到的是"活着但永远静止"的终端。
  ipcMain.handle(IPC.terminalResync, (_e, raw: unknown): void => {
    const parsed = z.object({ sessionId: z.string().max(200) }).safeParse(raw)
    if (!parsed.success) return
    deps.terminal.resync(parsed.data.sessionId)
  })

/** 逐处退回（plan13 B4）——「把 Agent 改的这一处还原成改之前」。写在**文件操作这一片**是因为它必须复用 `runFsOp`（统一写入服务 + 自动开检查点轮次）。
 *  三道闸：① **算差异的输入必须与界面看到的同一份**（比 mtime，对不上就拒 —— 否则"点了第 2 处、改掉第 N 处"，**不报错、只改错内容**）；② **写盘走统一写入服务**（这次退回自己也有检查点，"退错了还能再退"）；
 *  ③ **不安全的情形一律退化成"请用整份退回"** —— `created` 没有改前内容可还原，截断拿半个文件写盘就是把大文件砍坏。 */
  ipcMain.handle(
    IPC.checkpointRevertHunk,
    async (_e, raw: unknown): Promise<RevertHunkResult> => {
      const parsed = z
        .object({
          runId: z.string().min(1).max(64),
          rel: z.string().min(1).max(1024),
          hunkIndex: z.number().int().min(1).max(100000),
          expectedMtimeMs: z.number()
        })
        .safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'bad-input' }

      // ⚠️ 三道闸**搬去了 `revert-flow.ts`**，不在这里 —— handler 这层 import 了 electron、CI 上跑不了，那段逻辑曾一条测试都没有（详见该文件头部）。
      const workspaceRoot = deps.agent.getWorkspaceRoot()
      const result = await revertOneHunk(
        {
          store: deps.agent.checkpoints,
          workspaceRoot,
          readCurrent: async (rel) => {
            const cur = await readWorkspaceFile(workspaceRoot, rel)
            if (!cur.ok) return null
            return {
              content: cur.content,
              ...(cur.mtimeMs !== undefined ? { mtimeMs: cur.mtimeMs } : {}),
              ...(cur.truncated === true ? { truncated: true } : {}),
              ...(cur.lossy === true ? { lossy: true } : {})
            }
          },
          // 走统一写入服务（`runFsOp` 里开检查点轮次 → 这次退回自己也留痕、也退得回）
          writeThrough: async (rel, content) => {
            const report = await runFsOp(
              `界面：退回 ${rel} 第 ${parsed.data.hunkIndex} 处`,
              (w) => w.write(rel, content)
            )
            if (!report.ok) throw new Error(report.message)
            return report.message
          }
        },
        parsed.data
      )

      if (result.ok) {
        log.info('逐处退回完成', { runId: result.rel, hunkIndex: result.hunkIndex })
      } else {
        log.info('逐处退回被拒绝', { rel: parsed.data.rel, reason: result.reason })
      }
      return result
    }
  )

  ipcMain.handle(IPC.fsReveal, (_e, raw: unknown): Promise<void> => {
    const p = fsRelInput.safeParse(raw)
    if (!p.success) return Promise.resolve()
    const abs = resolveInsideWorkspace(deps.agent.getWorkspaceRoot(), p.data.rel)
    if (abs) shell.showItemInFolder(abs)
    return Promise.resolve()
  })

  // 用系统默认程序打开（pptx 等不支持内嵌预览的格式的出口）。与 fsReveal 同一条边界：
  // 只开工作区内（resolveInsideWorkspace，含符号链接防逃逸），越界一律拒绝。
  ipcMain.handle(IPC.fsOpenInSystem, async (_e, raw: unknown): Promise<FsOpenResult> => {
    const p = fsRelInput.safeParse(raw)
    if (!p.success) return { ok: false, error: '路径不合法' }
    const abs = resolveInsideWorkspace(deps.agent.getWorkspaceRoot(), p.data.rel)
    if (!abs) return { ok: false, error: '路径越出工作区边界，拒绝访问' }
    const msg = await shell.openPath(abs)
    return msg ? { ok: false, error: msg } : { ok: true }
  })

  // 后台任务：只读查询 + 终止。**启动**不在这里：那是 run_command 工具的事（要过危险确认）。
  ipcMain.handle(IPC.bgList, (): BackgroundTask[] => deps.agent.background?.list() ?? [])
  ipcMain.handle(IPC.bgKill, (_e, raw: unknown): boolean => {
    const p = z.string().min(1).max(64).safeParse(raw)
    return p.success ? (deps.agent.background?.kill(p.data) ?? false) : false
  })
}