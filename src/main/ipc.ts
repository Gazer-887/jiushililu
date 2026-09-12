import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
// 注：`readFile` / `basename` / 附件体积上限都已随 `readAttachment` 移到
import { z } from 'zod'
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
  type RollbackReport,
  type UIPrefs,
  type FsListResult,
  type FsReadResult,
  type FsBinaryResult,
  type FsOpResult,
  type BackgroundTask,
  type ConversationRollbackResult
} from '@shared/ipc'
import { getPermissionPreset, setPermissionPreset } from './store/settings'
// 「当前用哪个模型」现在由**模型档案**决定（plan7 F5 多模型）：
// 下面这几个名字语义没变（内核/界面永远只看见"当前这一个模型"），只是真源搬到了 store/models
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
// createProvider 仍用于「测试连接」与「提示词优化」（轻量调用，与 Agent 循环无关）
import { createProvider } from './providers'
import { getUIPrefs, setUIPref, resetUIPrefs } from './store/ui-prefs'
import { listWorkspaceDir, readAttachment, readWorkspaceBinary, readWorkspaceFile } from './workspace-fs'
import { createWorkspaceWriter, type WorkspaceWriter } from './workspace-write'
import type { ConfirmBridge } from './confirm'
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

// 工作台分栏布局的 **IPC 边界**校验（plan9 W2，三层里的第二层）。
//
// 这一层只做「形状 + 尺寸上限」。为什么上限也要卡：
// 布局是**频繁写入**的对象（拖拽、开栏、切页签都写），一旦某处逻辑出 bug 反复往数组里塞，
// 没有上限就会把盘写成一个巨大的 JSON，且启动时被完整读进内存。
// 上限值全部从 workbench.ts 取，**不另抄一份**（防止两处漂移）。
// 语义清洗（丢弃不认识的内置类型、截断超长内容、栏数与栏宽对齐）交给 setUIPref → sanitizeLayout。
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

// 所有来自渲染进程的入参一律过 zod 校验——坏数据挡在主进程门外。
// schema 定义在 ./schemas（不 import electron，可独立单测）；本文件只做翻译与分发。

/**
 * 对话并发的上限（plan11 §2.1）：每跑一条会话就是一堆工具调用 / 子进程，
 * 不设上限等于允许用户一键把机器压垮；3 条够"一条改代码 + 一条查资料 + 一条跑长任务"。
 */
const MAX_CONCURRENT_CHATS = 3

/**
 * 进行中的对话，**按会话**记（plan11 §2.1）。
 *
 * 以前 key 是 `e.sender.id`（窗口）—— 一个窗口同时只能跑一条会话。
 * 现在按 `conversationId` 记：**同会话重复发送 → 拒绝；跨会话 → 放行**。
 *
 * ⚠️ 闸的逻辑抽在 `./agent/concurrency`（纯函数，可单测）：`verify-shot` 把 `chat:send`
 * 整个 stub 掉了，界面上"两条都在跑"与闸的实际值**无关** —— 实测把上限改回 1，
 * 那边 6 条并发断言照样全绿。也就是说：**只有纯单测才验得到这道闸**。
 */
const chatGate = createChatGate(MAX_CONCURRENT_CHATS)
/** Agent 循环并发闸（按窗口）：同时只允许一个 Agent 任务 */
const activeAgents = new Set<number>()

/**
 * 当前待办清单（plan7 批 D 提前落地）：**主进程内存态，不落盘** ——
 * 它表达的是"这一轮干到哪了"的即时视图，不是历史数据，重开应用从空开始符合直觉。
 * 存主进程而非渲染端：界面会随视图切换重挂载，清单不该跟着丢。
 *
 * plan11：改成**按会话**存 —— 以前是模块级单例，两条会话的清单会互相顶掉。
 */
const todosByConversation = new Map<string, TodoItem[]>()

/**
 * 最近一批子代理的运行事件（plan7 批 D）：同一 runId 内按 name+index **就地更新** ——
 * start 先落一条，end/error 到了覆盖它（与界面里"进行中 → 已完成"是同一件事）。
 * 换批次（新 runId）则清空重来：界面显示的是"当前这批"，不是历史台账。
 *
 * plan11：同样**按会话**存（单例会被另一条会话的子代理事件顶掉）。
 */
const subagentsByConversation = new Map<string, { runId: string | null; events: SubagentJobEvent[] }>()

const log = createLogger('ipc')

/**
 * 检查点轮次的**归属哨兵**（plan11 P0-11）：`begin` 的第三参必须给得出答案。
 * 界面直接发起的文件操作不属于任何会话，单次 Agent 调用也没有对话上下文 ——
 * 两者都记成明确的哨兵，而不是留空（留空 = 出事时查不出"这轮是谁跑的"）。
 */
const UI_RUN_OWNER = 'ui'
const AGENT_TASK_OWNER = 'agent-task'

// 把 zod 的英文校验错误翻译成人话（设置页直接展示，不再甩原始 JSON）
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
  /** 危险操作确认桥（plan8 R5） */
  confirm: ConfirmBridge
  /** 渲染端回报"要关窗口前的落盘已完成"（plan11 P0-2）—— 主进程收到才真关 */
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
      return { ok: false, message: '还没有 API Key：请先在下方填写并保存，或填好后直接点「测试连接」' }
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

  // ── 多模型管理（plan7 F5）────────────────────────────────────────────
  //
  // 视图里**只给 Key 的掩码**（`hasApiKey` / `apiKeyMasked`）—— 与 `settings:get` 同一条规矩：
  // 明文 Key 永远不回渲染进程。
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

  // 「获取可用模型」（F5.1）：拉厂商的模型列表，失败给人话
  ipcMain.handle(IPC.modelsAvailable, async (_e, raw: unknown) => {
    const id = friendlyParse(conversationIdSchema, raw)
    return listAvailableModels(id)
  })

  // 切端点内的当前模型（模型目录里「用」那个动作）
  ipcMain.handle(IPC.modelsSetEntry, (_e, raw: unknown): ModelsView => {
    const input = friendlyParse(modelEntryPickSchema, raw)
    setActiveEntry(input.profileId, input.entryId)
    return modelsView()
  })

  ipcMain.handle(IPC.modelsDelete, (_e, raw: unknown) => {
    const id = friendlyParse(conversationIdSchema, raw) // 与其它 id 同一条长度约束
    deleteProfileById(id) // 护栏（至少留一个）在里面，抛出的是人话
  })

  ipcMain.handle(IPC.modelsSetActive, (_e, raw: unknown): ModelsView => {
    const id = friendlyParse(conversationIdSchema, raw)
    setActiveProfile(id)
    // 切换模型要立刻生效：设置页与输入框读的都是"当前档案"，无需重启 ✓
    return modelsView()
  })

  ipcMain.handle(IPC.modelsTest, async (_e, raw: unknown): Promise<TestResult> => {
    const id = friendlyParse(conversationIdSchema, raw)
    const target = profileForTest(id)
    if (!target) return { ok: false, message: '这个模型不存在（可能已经被删过了）' }
    if (!target.apiKey) {
      return { ok: false, message: '这个模型还没有填 API Key：点「编辑」补上再测' }
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

  // ── 目标（plan12）──────────────────────────────────────────────────
  //
  // 目标属于**一条会话**（plan11 给的会话身份在这儿第二次派上用场）：
  // 切回那条会话还看得见它，是自然结果而不是另建索引。
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

    // IPC 层并发防护：渲染层的 streaming 标志只是软约束，这里才是硬闸。
    // 同会话重复 → 拒；跨会话 → 放行（上限见 MAX_CONCURRENT_CHATS）。
    // 规则本身在 ./agent/concurrency（纯函数，有单测 —— 这里只负责把话传给界面）
    const gate = chatGate.begin(conversationId)
    if (!gate.ok) {
      emit.error(gate.message)
      return
    }

    if (!settings.baseURL || !settings.model) {
      // 开跑前就退回的路径，**必须把刚占的位子还回去** ——
      // 不然这条会话在闸里永远"在跑"，之后连重发都发不出去
      chatGate.end(conversationId)
      emit.error('还没有配置模型：请先到「设置」页填好接口地址、模型名和 API Key')
      return
    }
    if (!hasApiKey()) {
      chatGate.end(conversationId)
      emit.error('还没有保存 API Key：请先到「设置」页填写并保存')
      return
    }

    const apiKey = getDecryptedApiKey()
    const controller = gate.controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, settings.timeoutMs)

    // D-032：单一通道——带工具清单 + 流式，由模型自决"直接回答还是先调工具"。
    // 文本增量 → chat:chunk（上屏）；工具生命周期 → chat:tool（进度卡片）。
    try {
      const result = await runAgent(deps.agent, {
        settings: getSettingsView(),
        apiKey,
        history: messages as AgentMessage[],
        permission: getPermissionPreset(),
        conversationId,
        onText: (delta) => emit.chunk(delta),
        // 思考流单独走一条通道：界面把它显示成"思考过程"，不与正文混在一起
        onReasoning: (delta) => emit.reasoning(delta),
        onToolEvent: (evt) => emit.tool(evt),
        // 待办清单（plan7 批 D）：先存主进程，再推给界面 —— 界面重挂载后仍能拉到
        onTodos: (todos) => {
          todosByConversation.set(conversationId, todos)
          emit.todos(todos)
        },
        // 子代理事件（plan7 批 D）：同批内就地更新，换批则重开
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
      // 收尾带货：本轮真实用量（plan8 R9）。厂商没报就是 null —— 界面据此退回占用估算
      emit.done(result.usage)
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

  // 关窗口前的落盘回执（plan11 P0-2）：主进程收到它才真关窗口
  ipcMain.handle(IPC.flushDone, () => {
    deps.onFlushDone?.()
  })

  // 待办清单：界面挂载时拉一次当前值（之后靠 chatSend 里的推送更新）
  ipcMain.handle(IPC.todoGet, (_e, raw: unknown): TodoItem[] => {
    const id = friendlyParse(conversationIdSchema, raw)
    return todosByConversation.get(id) ?? []
  })
  ipcMain.handle(IPC.subagentGet, (_e, raw: unknown): SubagentJobEvent[] => {
    const id = friendlyParse(conversationIdSchema, raw)
    return subagentsByConversation.get(id)?.events ?? []
  })

  // Agent 模式（plan6 D3/D4）：独立上下文 + 单次报告，不走流式
  const agentRunInput = z.object({
    task: z.string().min(1).max(200000),
    agentName: z.string().max(64).optional(),
    // 归属（plan11）：可选，缺省由主进程记成哨兵值
    conversationId: conversationIdSchema.optional()
  })
  const failResult = (agent: string, error: string): AgentRunResult => ({
    ok: false, output: '', rounds: 0, stopReason: 'error', agent, error
  })

  ipcMain.handle(IPC.agentRun, async (e, raw: unknown): Promise<AgentRunResult> => {
    // 入参校验走 friendlyParse（人话错误），且失败也返回 AgentRunResult 而非抛裸 ZodError
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
      return failResult(req.agentName ?? '内核默认', '已有 Agent 任务在执行：请等待当前任务结束')
    }
    activeAgents.add(e.sender.id)
    try {
      const settings = getSettingsView()
      if (!settings.baseURL || !settings.model) {
        return failResult(req.agentName ?? '内核默认', '还没有配置模型：请先到「设置」页填好接口地址、模型名和 API Key')
      }
      const apiKey = getDecryptedApiKey()
      if (!apiKey) {
        return failResult(req.agentName ?? '内核默认', '还没有保存 API Key：请先到「设置」页填写并保存')
      }
      const result = await runAgent(deps.agent, {
        settings,
        apiKey,
        history: [{ role: 'user', content: req.task }],
        agentName: req.agentName,
        // 单次 Agent 调用没有对话上下文：记一个**明确的哨兵**，不留空 —— 出事时要能追溯
        conversationId: req.conversationId ?? AGENT_TASK_OWNER
      })
      return {
        ok: result.stopReason === 'completed',
        output: result.output,
        rounds: result.rounds,
        stopReason: result.stopReason,
        agent: result.agent,
        ...(result.stopReason === 'max-rounds'
          ? { error: `已达轮数预算上限（${result.rounds} 轮）被强制停止，以下为部分产出` }
          : {})
      }
    } catch (err) {
      log.error('Agent 任务失败', { agentName: req.agentName, error: err instanceof Error ? err.message : String(err) })
      return failResult(req.agentName ?? '内核默认', err instanceof Error ? err.message : String(err))
    } finally {
      activeAgents.delete(e.sender.id)
    }
  })

  // ── P2 工作台 ────────────────────────────────────────────────

  // 只改模型名（快速切换），其余配置不动
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
    ensureAgentRuntime(deps.agent) // 新工作区目录先备好
    return getWorkspaceInfo(deps.userDataDir)
  })

  // 切换到「已知工作区」（历史会话用过的路径）——不接受任意路径
  ipcMain.handle(IPC.workspaceSetKnown, (_e, raw: unknown): WorkspaceInfo | null => {
    const path = z.string().min(1).max(500).parse(raw)
    const allowed = knownWorkspaces()
    if (!allowed.includes(path)) return null
    setWorkspaceRoot(path)
    ensureAgentRuntime(deps.agent)
    return getWorkspaceInfo(deps.userDataDir)
  })

  // 在系统文件管理器中打开目录
  ipcMain.handle(IPC.workspaceReveal, async (_e, raw: unknown) => {
    const path = z.string().min(1).max(500).parse(raw)
    const allowed = knownWorkspaces()
    if (!allowed.includes(path)) return
    await shell.openPath(path)
  })

  // ── 会话（P2 侧边栏）────────────────────────────────────────

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
    // **绑定"当前端点的当前模型"**（plan7 F5.1）：`model` 记名字（给人看、老数据只有它），
    // `modelProfileId` 记端点（用哪条连接 + 哪把 Key），`modelEntryId` 记目录里的哪一条。
    // 渲染端不用关心 —— 它此刻用的就是当前那一对。
    const active = getActiveEntry()
    return createConversation({
      ...input,
      ...(active
        ? { model: active.entry.model, modelProfileId: active.profile.id, modelEntryId: active.entry.id }
        : {})
    })
  })

  ipcMain.handle(IPC.convSave, (_e, raw: unknown): ConversationMeta | null => {
    // **先松收下 → 规整 → 再严格校验**，三步各司其职：
    //   ① 松：流式占位（content 为空）是**合法中间状态**，先收得下来；
    //   ② 规整：把没内容的消息丢掉（`normalizeHistory` 的注释里写了这条渠道的真实代价）；
    //   ③ 严：真正落盘前照旧严格把关。
    // 以前是"直接严格 parse"，于是"流式没吐字就切会话/点停止/关窗口"这几条路
    // **保存必然被拒**，而调用方是 `void persistActive()` —— 静默、丢数据、无从解释。
    const input = z
      .object({
        id: z.string().min(1).max(64),
        messages: incomingMessagesSchema,
        // 用量账本（plan8 R9）：可选。**不信任上游的数字**——负/非有限一律拒，
        // 免得一个 NaN 写进索引，之后每次列表都读到一个坏值
        usage: z
          .object({
            promptTokens: z.number().finite().nonnegative(),
            completionTokens: z.number().finite().nonnegative()
          })
          .optional()
      })
      .parse(raw)
    const messages = normalizeHistory(input.messages as ChatMessage[])
    const parsed = storedMessagesSchema.safeParse(messages)
    if (!parsed.success) {
      // 这条通道以前**静默**拒（不写日志、界面上也没有），失败理由必须留痕
      const reason = parsed.error.issues[0]?.message ?? '参数不合法'
      log.error('会话保存被拒', { id: input.id, count: messages.length, reason })
      throw new Error(`会话没能存进磁盘：${reason}`)
    }
    return saveConversation(
      input.id,
      parsed.data as ChatMessage[],
      input.usage
        ? {
            promptTokens: Math.round(input.usage.promptTokens),
            completionTokens: Math.round(input.usage.completionTokens)
          }
        : undefined
    )
  })

  ipcMain.handle(IPC.convRename, (_e, raw: unknown): ConversationMeta | null => {
    const input = z.object({ id: z.string().min(1).max(64), title: z.string().max(60) }).parse(raw)
    return renameConversation(input.id, input.title)
  })

  // ── 会话回滚（plan10 B 批 · ④）──────────────────────────────────
  //
  // 三条边界，每条都有理由：
  //   ① **正在生成回复时拒绝回滚** —— 复用现成的并发闸（`chatGate`，按**会话**判断：
  //      回滚哪条会话就只看那条会话跑没跑，别把另一条会话的流当成障碍）
  //      流式还没结束就动历史，等于在动的数据上做手术
  //   ② **走 R5 确认桥**（`kind: 'rollback-messages'`）—— 回滚会"藏起"一段对话，
  //      不该一点就走；而且文案必须与**文件回滚**分得清（plan10 §六 第 6 条）
  //   ③ **回传权威正文** —— 渲染端用它覆盖内存，否则下一次保存会把回滚掉的内容写回来
  //
  // ⚠️ 注意回滚**不删数据**（只移游标），所以"撤销"是零成本的 ——
  //    这也是它敢用"确认一下就执行"的原因。
  const doRollback = async (
    id: string,
    toIndex: number
  ): Promise<ConversationRollbackResult | null> => {
    const current = getConversation(id)
    if (!current) return null
    const visible = current.messages.length
    const target = Math.max(0, Math.min(Math.floor(toIndex), visible))
    if (target === visible) return null // 没东西可回滚，不打扰用户

    const hidden = visible - target
    const allowed = await deps.confirm.ask({
      kind: 'rollback-messages',
      tool: '会话回滚',
      detail: `回到第 ${target + 1} 条消息之前 —— 之后 ${hidden} 条将从对话里隐去（可撤销）`,
      agent: current.title,
      where: `仅回滚对话消息，不影响工作区里的文件`,
      // 这条回滚属于哪条会话 —— 确认框要显示出来（plan11 P0-3）
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
      throw new Error('这条会话正在生成回复：请先等它结束、或点「停止」，再回滚')
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

  // ── 输入框工具栏（P2 控制台）────────────────────────────────

  ipcMain.handle(IPC.permissionGet, (): PermissionPreset => getPermissionPreset())

  ipcMain.handle(IPC.permissionSet, (_e, raw: unknown): PermissionPreset => {
    const preset = z.enum(['read-only', 'write', 'full-access']).parse(raw)
    return setPermissionPreset(preset)
  })

  ipcMain.handle(IPC.gitInfo, (): Promise<GitInfo | null> =>
    readGitInfo(getWorkspaceInfo(deps.userDataDir).path)
  )

  // 附件：选文件 → 读入内容（**限工作区内**，上限 64KB，超出截断并标注）
  //
  // 「路径 → 附件」的实现在 `workspace-fs.readAttachment`，**两个入口共用**
  // （文件选择框 / 拖拽进来）—— 抽到那边是为了能单测（那里不碰 electron）
  ipcMain.handle(IPC.attachFile, async (e): Promise<Attachment | null> => {
    const ws = getWorkspaceInfo(deps.userDataDir).path
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { properties: ['openFile' as const], defaultPath: ws }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return readAttachment(ws, res.filePaths[0]!)
  })

  // 拖拽进来的文件（③ 文件拖进会话）——
  // 相对路径来自工作区文件树（必须在工作区内），绝对路径来自系统资源管理器（明确拖入即放行）。
  // 边界规则与理由集中在 `workspace-fs.readAttachment` 一处，这里只管留痕。
  ipcMain.handle(IPC.attachPath, async (_e, raw: unknown): Promise<Attachment> => {
    const pathOrRel = z.string().min(1).max(4096).parse(raw)
    const ws = getWorkspaceInfo(deps.userDataDir).path
    try {
      return await readAttachment(ws, pathOrRel)
    } catch (err) {
      // **留痕**：附件被拒以前是静默的 —— 用户在界面上看到一句"越界"，
      // 而日志里什么都没有，事后只能靠猜是哪条路进来的。带上载荷与边界就够定位了。
      log.warn('附件被拒', {
        received: pathOrRel,
        workspace: ws,
        // 绝对路径 = 从系统资源管理器拖来的；相对路径 = 从工作区文件树拖来的
        kind: /^[a-zA-Z]:[\\/]|^\\\\/.test(pathOrRel) ? '系统拖拽/绝对路径' : '工作区相对路径',
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  })

  // 提示词优化：一次轻量模型调用，把草稿改写成更清晰的指令
  ipcMain.handle(IPC.promptPolish, async (_e, raw: unknown): Promise<string> => {
    const text = z.string().min(1).max(20000).parse(raw)
    const settings = getSettingsView()
    const apiKey = getDecryptedApiKey()
    if (!settings.baseURL || !settings.model || !apiKey) {
      throw new Error('请先在「设置」页配置模型与 API Key')
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

  // ── 内置浏览器（真浏览器，Agent 可操控同一实例）──────────────

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

  // ── 日志（plan8 R2）：排查入口 ──────────────────────────────

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

  // ── 检查点与回滚（plan8 R4）：Agent 改坏文件能退回去 ──────────

  ipcMain.handle(IPC.checkpointList, (): CheckpointRunMeta[] => deps.agent.checkpoints.list())

  ipcMain.handle(IPC.checkpointGet, (_e, rawRunId: unknown): CheckpointRun | null => {
    const parsed = z.string().min(1).max(64).safeParse(rawRunId)
    if (!parsed.success) return null
    return deps.agent.checkpoints.get(parsed.data)
  })

  ipcMain.handle(
    IPC.checkpointRollback,
    (_e, raw: unknown): RollbackReport => {
      const input = z
        .object({ runId: z.string().min(1).max(64), rel: z.string().min(1).max(1024).optional() })
        .parse(raw)
      const report = deps.agent.checkpoints.rollback(input.runId, input.rel)
      log.info('执行回滚', {
        runId: input.runId,
        target: input.rel ?? '（整轮）',
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

  // ── 界面布局偏好（plan7 批 A0）──────────────────────────────
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

  // ── 工作区文件树（plan7 批 A，只读）──────────────────────────
  // 工作区路径每次实时解析（用户可切换工作区，免重启）
  ipcMain.handle(IPC.fsList, (_e, raw: unknown): Promise<FsListResult> => {
    const rel = z.string().max(1024).safeParse(raw)
    return listWorkspaceDir(deps.agent.getWorkspaceRoot(), rel.success ? rel.data : '')
  })

  ipcMain.handle(IPC.fsRead, (_e, raw: unknown): Promise<FsReadResult> => {
    const rel = z.string().min(1).max(1024).parse(raw)
    return readWorkspaceFile(deps.agent.getWorkspaceRoot(), rel)
  })

  // 二进制预览（plan7 批 A3）：图片走 data URL、其余走十六进制头部
  ipcMain.handle(IPC.fsReadBinary, (_e, raw: unknown): Promise<FsBinaryResult> => {
    const rel = z.string().min(1).max(1024).parse(raw)
    return readWorkspaceBinary(deps.agent.getWorkspaceRoot(), rel)
  })

  // ── 工作区写操作（plan7 批 A2）──────────────────────────────
  // 三个关键点：
  //   ① 全部走**统一写入服务** —— 界面与 Agent 是同一条写入路径
  //   ② 每个操作**各开一个检查点轮次** —— 于是界面里删掉/改掉的东西，同样出现在
  //      「文件变更记录」里、同样退得回（这正是批 A2 一直卡着不做的原因）
  //   ③ 删除走 shell.trashItem（回收站），不是硬删
  const fsWriteInput = z.object({
    rel: z.string().min(1).max(1024),
    content: z.string().max(5_000_000),
    /**
     * 冲突基线（编辑时带上；文件树的新建/重命名那条**不带**，因为本来就没有"打开"这一步）。
     * 带了就比对 mtime：对不上**不写盘**，回 `conflict: true` 让用户选 —— 不做静默覆盖。
     */
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

  /**
   * 开一个检查点轮次 → 跑写入 → 收尾。
   * 失败也照样 finish：manifest 是增量落盘的，已发生的改动仍可回滚（R4 的设计）。
   */
  const runFsOp = async (
    label: string,
    fn: (writer: WorkspaceWriter) => Promise<string>
  ): Promise<FsOpResult> => {
    const workspaceRoot = deps.agent.getWorkspaceRoot()
    // 界面直接发起的文件操作（新建 / 改名 / 删除）不属于任何一条会话 ——
    // 用一个**明确的哨兵**记归属，而不是留空：检查点里"这轮是谁跑的"必须永远答得出来
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
    }
  }

  ipcMain.handle(IPC.fsWrite, async (_e, raw: unknown): Promise<FsOpResult> => {
    const p = fsWriteInput.safeParse(raw)
    if (!p.success) return { ok: false, message: '入参不合法' }
    const workspaceRoot = deps.agent.getWorkspaceRoot()

    // **边界②：外部冲突**（plan7 批 A3）——
    // 文件可能在"打开之后、保存之前"被改过（Agent 或别的程序）。
    // 这时**不许静默覆盖**：把冲突如实回给界面，由用户选"覆盖 / 重新载入"。
    // 拿不到 mtime（文件刚被删）也当作冲突 —— 那种情况更不该闷头写下去。
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
          message: currentMtime === null ? '这个文件已经不在了（可能被删或改名）' : '文件在打开之后被改过',
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

  ipcMain.handle(IPC.fsReveal, (_e, raw: unknown): Promise<void> => {
    const p = fsRelInput.safeParse(raw)
    if (!p.success) return Promise.resolve()
    const abs = resolveInsideWorkspace(deps.agent.getWorkspaceRoot(), p.data.rel)
    if (abs) shell.showItemInFolder(abs)
    return Promise.resolve()
  })

  // ── 后台任务（plan7 批 D）──
  // 只读查询 + 终止。**启动**不在这里：那是 run_command 工具的事（要过危险确认）。
  ipcMain.handle(IPC.bgList, (): BackgroundTask[] => deps.agent.background?.list() ?? [])
  ipcMain.handle(IPC.bgKill, (_e, raw: unknown): boolean => {
    const p = z.string().min(1).max(64).safeParse(raw)
    return p.success ? (deps.agent.background?.kill(p.data) ?? false) : false
  })
}