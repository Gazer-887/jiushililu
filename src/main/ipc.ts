import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { z } from 'zod'
import { isSafeRel, selectChanges } from '@shared/checkpoint'
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
  type Conversation,
  type ConversationMeta,
  type SkillInfo,
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
  type FsOpResult,
  type BackgroundTask,
  type ConversationRollbackResult
} from '@shared/ipc'
import { getPermissionPreset, getTokenTier, setPermissionPreset, setTokenTier } from './store/settings'
import type { SystemSettings, SystemView } from '@shared/system'
import type { SystemIntegration } from './system-integration'
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
import { createWorkspaceWriter, type WorkspaceWriter } from './workspace-write'
import type { TerminalSessionStore } from './terminal-session'
import type { TerminalSessionSnapshot, TerminalStartResult } from '@shared/terminal'
import type { ConfirmBridge } from './confirm'
import type { AskBridge } from './ask'
import { ASK_MAX_OPTIONS, type AskResult } from '@shared/ask'
import {
  chatSendInputSchema,
  conversationIdSchema,
  incomingMessagesSchema,
  modelEntryPickSchema,
  goalActionSchema,
  goalCreateSchema,
  modelSaveSchema,
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
import { runAgent, ensureAgentRuntime, listSkills, type AgentRuntimeContext } from './agent/runner'
import type { AgentMessage, SubagentJobEvent } from '@shared/agent'
import type { TodoItem } from '@shared/todo'
import { resolveInsideWorkspace } from './agent/guard'
import { statSync } from 'node:fs'
import { getWorkspaceInfo, setWorkspaceRoot } from './store/workspace'
import { readGitInfo } from './store/git-info'
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
import {
  createConversation,
  deleteConversation,
  getConversation,
  knownWorkspaces,
  listConversations,
  renameConversation,
  rollbackConversation,
  saveConversation,
  undoRollback
} from './store/conversations'
import { normalizeHistory } from './store/conversations-core'

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

function friendlyChatError(err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `请求超时（${timeoutMs}ms）：可在设置页调大超时时间，或检查网络 / 代理`
  if (err instanceof Error && err.name === 'AbortError') return '已停止生成'
  return err instanceof Error ? err.message : String(err)
}

export function registerIpcHandlers(deps: {
  agent: AgentRuntimeContext
  userDataDir: string
  confirm: ConfirmBridge
  /** Agent 提问桥。⚠️ 传进来而不是在这里 new：与 confirm 同理 —— **组合根负责"建"，这里只做转交**（本文件一个裸 `.send(` 都不许有） */
  ask: AskBridge
  /** 内置终端会话（plan7 批 C）。⚠️ 传进来而不是在这里 new：**广播代码必须放 `main/index.ts`**（本文件里一个裸 `.send(` 都不许有，见 `tests/unit/stream-envelope.test.ts`），而会话的 `onData` 要往所有窗口推 —— 故"建会话"在组合根，这里只做转交。 */
  terminal: TerminalSessionStore
  /** 系统集成（plan7 批 F1）：同样是组合根建、这里转交 —— 它持有 blocker id 与自启状态，**每个进程只能有一份** */
  system: SystemIntegration
  onFlushDone?: () => void
}): void {
  ipcMain.handle(IPC.settingsGet, () => getSettingsView())

  ipcMain.handle(IPC.settingsSave, (_e, raw: unknown) => {
    const input = friendlyParse(settingsSchema, raw) as SettingsSaveInput
    return saveSettings(input)
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
    return view
  })

  ipcMain.handle(IPC.modelsAvailable, async (_e, raw: unknown) => {
    const id = friendlyParse(conversationIdSchema, raw)
    return listAvailableModels(id)
  })

  ipcMain.handle(IPC.modelsSetEntry, (_e, raw: unknown): ModelsView => {
    const input = friendlyParse(modelEntryPickSchema, raw)
    setActiveEntry(input.profileId, input.entryId)
    return modelsView()
  })

  ipcMain.handle(IPC.modelsDelete, (_e, raw: unknown) => {
    const id = friendlyParse(conversationIdSchema, raw)
    deleteProfileById(id)
  })

  ipcMain.handle(IPC.modelsSetActive, (_e, raw: unknown): ModelsView => {
    const id = friendlyParse(conversationIdSchema, raw)
    setActiveProfile(id)
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
    const controller = gate.controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, settings.timeoutMs)

    // D-032：单一通道 —— 带工具清单 + 流式，由模型自决"直接回答还是先调工具"；文本增量 → chat:chunk（上屏），工具生命周期 → chat:tool（进度卡片）。
    try {
      const result = await runAgent(deps.agent, {
        settings: getSettingsView(),
        apiKey,
        history: messages as AgentMessage[],
        permission: getPermissionPreset(),
        conversationId,
        onText: (delta) => emit.chunk(delta),
        onReasoning: (delta) => emit.reasoning(delta),
        onToolEvent: (evt) => emit.tool(evt),
        // 待办清单（plan7 批 D）：先存主进程，再推给界面 —— 界面重挂载后仍能拉到
        onTodos: (todos) => {
          todosByConversation.set(conversationId, todos)
          emit.todos(todos)
        },
        // 工具输出成形留痕（plan8 R9.1）：界面那条是内存态，日志这条才追得回来
        onToolWindowed: (info) => log.info('工具输出已成形', { conversationId, ...info }),
        // 校准开关（plan8 R9.1）：只认 `JSL_TOOL_WINDOW=off`，不给就是默认开 —— 免得留一个"忘了配就悄悄变了行为"的配置面。
        ...(process.env['JSL_TOOL_WINDOW'] === 'off' ? { toolWindow: false } : {}),
        // 省 token 档位（plan8 R9.1 §七②）：**在这里解析**（组合根读设置再往下给 policy）—— runner 不许碰 electron-store（CI 无 Electron），故读设置只能发生在本层；`JSL_TOKEN_TIER` 是**校准钩子**，环境变量不存在时行为与以前一样。
        policy: resolvePolicy(process.env['JSL_TOKEN_TIER'] ?? getTokenTier()),
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
      // 收尾带货：本轮真实用量（plan8 R9）+ 窗口化省下的估算量（R9.1）
      emit.done(result.usage, result.avoidedTokens ?? 0, getTokenTier())
    } catch (err) {
      // 失败留痕（plan8 R2）：这条以前只发给界面，日志里什么都没有 → 事后无从排查
      log.error('对话执行失败', {
        conversationId,
        timedOut,
        model: settings.model,
        error: err instanceof Error ? err.message : String(err)
      })
      emit.error(friendlyChatError(err, timedOut, settings.timeoutMs))
    } finally {
      clearTimeout(timer)
      chatGate.end(conversationId)
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
        conversationId: req.conversationId ?? AGENT_TASK_OWNER
      })
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

  ipcMain.handle(IPC.workspaceReveal, async (_e, raw: unknown) => {
    const path = z.string().min(1).max(500).parse(raw)
    const allowed = knownWorkspaces()
    if (!allowed.includes(path)) return
    await shell.openPath(path)
  })


  ipcMain.handle(IPC.convList, (): ConversationMeta[] => listConversations())

  ipcMain.handle(IPC.convGet, (_e, raw: unknown): Conversation | null => {
    const id = z.string().min(1).max(64).parse(raw)
    return getConversation(id)
  })

  const convCreateInput = z.object({
    workspace: z.string().min(1).max(500),
    model: z.string().min(1).max(200),
    skills: z.array(z.string().max(64)).max(50),
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

  ipcMain.handle(IPC.convSave, (_e, raw: unknown): ConversationMeta | null => {
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
        avoidedTokens: z.number().finite().nonnegative().optional()
      })
      .parse(raw)
    const messages = normalizeHistory(input.messages as ChatMessage[])
    const parsed = storedMessagesSchema.safeParse(messages)
    if (!parsed.success) {
      // 这条通道以前**静默**拒（不写日志、界面上也没有），失败理由必须留痕
      const reason = parsed.error.issues[0]?.message ?? '参数不合法'
      log.error('会话保存被拒', { id: input.id, count: messages.length, reason })
      throw new Error(`会话未能写入磁盘：${reason}`)
    }
    return saveConversation(input.id, parsed.data as ChatMessage[], {
      ...(input.usage
        ? {
            usage: {
              promptTokens: Math.round(input.usage.promptTokens),
              completionTokens: Math.round(input.usage.completionTokens)
            }
          }
        : {}),
      ...(input.avoidedTokens !== undefined ? { avoidedTokens: Math.round(input.avoidedTokens) } : {})
    })
  })

  ipcMain.handle(IPC.convRename, (_e, raw: unknown): ConversationMeta | null => {
    const input = z.object({ id: z.string().min(1).max(64), title: z.string().max(60) }).parse(raw)
    return renameConversation(input.id, input.title)
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
      where: `仅回滚对话消息，不影响工作区文件`,
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


  ipcMain.handle(IPC.permissionGet, (): PermissionPreset => getPermissionPreset())

  ipcMain.handle(IPC.permissionSet, (_e, raw: unknown): PermissionPreset => {
    const preset = z.enum(['read-only', 'write', 'full-access']).parse(raw)
    const applied = setPermissionPreset(preset)
    // ⚠️ 降到只读时**必须把正在跑的终端会话收掉**：权限档的语义是"这台机器只读，人和模型同一把尺"，一个还在跑的 shell 会让"只读"变成空话 —— 界面横幅写着"不执行命令"，屏幕上却在执行。
    if (applied === 'read-only') deps.terminal.killAll()
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

  ipcMain.handle(IPC.gitInfo, (): Promise<GitInfo | null> =>
    readGitInfo(getWorkspaceInfo(deps.userDataDir).path)
  )

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
        theme: z.enum(['classic', 'ink']).optional(),
        workbench: workbenchSchema.optional(),
        workbenchSizes: workbenchSizesSchema.optional()
      })
      .parse(raw)
    // 形状过了之后交给 setUIPref 做语义清洗并落盘（它返回**清洗后**的完整偏好）
    return setUIPref(patch as Partial<UIPrefs>)
  })

  ipcMain.handle(IPC.uiPrefsReset, (): UIPrefs => resetUIPrefs())

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

  // 后台任务：只读查询 + 终止。**启动**不在这里：那是 run_command 工具的事（要过危险确认）。
  ipcMain.handle(IPC.bgList, (): BackgroundTask[] => deps.agent.background?.list() ?? [])
  ipcMain.handle(IPC.bgKill, (_e, raw: unknown): boolean => {
    const p = z.string().min(1).max(64).safeParse(raw)
    return p.success ? (deps.agent.background?.kill(p.data) ?? false) : false
  })
}