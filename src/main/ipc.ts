import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
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
  type FsReadResult
} from '@shared/ipc'
import {
  getDecryptedApiKey,
  getPermissionPreset,
  getSettingsView,
  hasApiKey,
  saveSettings,
  setModel,
  setPermissionPreset
} from './store/settings'
// createProvider 仍用于「测试连接」与「提示词优化」（轻量调用，与 Agent 循环无关）
import { createProvider } from './providers'
import { getUIPrefs, setUIPref, resetUIPrefs } from './store/ui-prefs'
import { listWorkspaceDir, readWorkspaceFile } from './workspace-fs'
import type { ConfirmBridge } from './confirm'
import { chatMessagesSchema, settingsSchema } from './schemas'
import { runAgent, ensureAgentRuntime, listSkills, type AgentRuntimeContext } from './agent/runner'
import type { AgentMessage } from '@shared/agent'
import { resolveInsideWorkspace } from './agent/guard'
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
  saveConversation
} from './store/conversations'

// 所有来自渲染进程的入参一律过 zod 校验——坏数据挡在主进程门外。
// schema 定义在 ./schemas（不 import electron，可独立单测）；本文件只做翻译与分发。

const activeChats = new Map<number, AbortController>()
/** Agent 循环并发闸（按窗口）：同时只允许一个 Agent 任务 */
const activeAgents = new Set<number>()

const log = createLogger('ipc')

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

  ipcMain.handle(IPC.chatSend, async (e, raw: unknown) => {
    const messages = friendlyParse(chatMessagesSchema, raw) as ChatMessage[]
    const settings = getSettingsView()

    // IPC 层并发防护：渲染层的 streaming 标志只是软约束，这里才是硬闸
    if (activeChats.has(e.sender.id)) {
      e.sender.send(IPC.chatError, '已有任务在进行：请先点「停止」或等待完成')
      return
    }

    if (!settings.baseURL || !settings.model) {
      e.sender.send(IPC.chatError, '还没有配置模型：请先到「设置」页填好接口地址、模型名和 API Key')
      return
    }
    if (!hasApiKey()) {
      e.sender.send(IPC.chatError, '还没有保存 API Key：请先到「设置」页填写并保存')
      return
    }

    const apiKey = getDecryptedApiKey()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, settings.timeoutMs)
    activeChats.set(e.sender.id, controller)

    // D-032：单一通道——带工具清单 + 流式，由模型自决"直接回答还是先调工具"。
    // 文本增量 → chat:chunk（上屏）；工具生命周期 → chat:tool（进度卡片）。
    try {
      const result = await runAgent(deps.agent, {
        settings: getSettingsView(),
        apiKey,
        history: messages as AgentMessage[],
        permission: getPermissionPreset(),
        onText: (delta) => {
          if (!e.sender.isDestroyed()) e.sender.send(IPC.chatChunk, delta)
        },
        onToolEvent: (evt) => {
          if (!e.sender.isDestroyed()) e.sender.send(IPC.chatTool, evt)
        },
        signal: controller.signal
      })
      // 本轮改了文件 → 通知界面刷新「文件变更」页签（plan8 R4）
      if (result.changedFiles > 0 && !e.sender.isDestroyed()) {
        e.sender.send(IPC.checkpointChanged, result.runId)
      }
      if (!e.sender.isDestroyed()) e.sender.send(IPC.chatDone)
    } catch (err) {
      // 失败留痕（plan8 R2）：这条以前只发给界面，日志里什么都没有 → 事后无从排查
      log.error('对话执行失败', {
        timedOut,
        model: settings.model,
        error: err instanceof Error ? err.message : String(err)
      })
      if (!e.sender.isDestroyed()) {
        e.sender.send(IPC.chatError, friendlyChatError(err, timedOut, settings.timeoutMs))
      }
    } finally {
      clearTimeout(timer)
      activeChats.delete(e.sender.id)
    }
  })

  ipcMain.handle(IPC.chatAbort, (e) => {
    activeChats.get(e.sender.id)?.abort()
  })

  // Agent 模式（plan6 D3/D4）：独立上下文 + 单次报告，不走流式
  const agentRunInput = z.object({
    task: z.string().min(1).max(200000),
    agentName: z.string().max(64).optional()
  })
  const failResult = (agent: string, error: string): AgentRunResult => ({
    ok: false, output: '', rounds: 0, stopReason: 'error', agent, error
  })

  ipcMain.handle(IPC.agentRun, async (e, raw: unknown): Promise<AgentRunResult> => {
    // 入参校验走 friendlyParse（人话错误），且失败也返回 AgentRunResult 而非抛裸 ZodError
    let req: { task: string; agentName?: string }
    try {
      req = friendlyParse(agentRunInput, raw) as { task: string; agentName?: string }
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
        agentName: req.agentName
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
    return createConversation(input)
  })

  ipcMain.handle(IPC.convSave, (_e, raw: unknown): ConversationMeta | null => {
    const input = z.object({ id: z.string().min(1).max(64), messages: chatMessagesSchema }).parse(raw)
    return saveConversation(input.id, input.messages as ChatMessage[])
  })

  ipcMain.handle(IPC.convRename, (_e, raw: unknown): ConversationMeta | null => {
    const input = z.object({ id: z.string().min(1).max(64), title: z.string().max(60) }).parse(raw)
    return renameConversation(input.id, input.title)
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
  ipcMain.handle(IPC.attachFile, async (e): Promise<Attachment | null> => {
    const ws = getWorkspaceInfo(deps.userDataDir).path
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { properties: ['openFile' as const], defaultPath: ws }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const picked = res.filePaths[0]!
    if (!resolveInsideWorkspace(ws, picked)) {
      throw new Error('只能引用当前工作区内的文件（越界已被拒绝）')
    }
    const buf = await readFile(picked)
    const LIMIT = 64 * 1024
    const truncated = buf.byteLength > LIMIT
    return {
      name: basename(picked),
      path: picked,
      content: buf.subarray(0, LIMIT).toString('utf8'),
      truncated
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
        dockWidth: z.number().min(1).max(4096).optional()
      })
      .parse(raw)
    return setUIPref(patch)
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
}
