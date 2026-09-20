import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSettings, PermissionPreset, SkillInfo } from '@shared/ipc'
import type {
  AgentChatResult,
  AgentMessage,
  AgentLoopResult,
  AgentTool,
  SubagentJobEvent,
  ToolEvent
} from '@shared/agent'
import type { TodoItem } from '@shared/todo'
import { ToolGate, type PathAccess } from './guard'
import type { ExecEventRecorder } from './exec-events'
import { composeSelfView } from './self-view'
import { createWorkspaceWriter, type WorkspaceWriter } from '../workspace-write'
import { createFileTools } from './tools/file-tools'
import { outputDisciplinePrompt, resolvePolicy, type TokenPolicy } from '@shared/token-tier'
import {
  createSystemTools,
  createSystemToolsWithConfirm,
  type CommandConfirm
} from './tools/system-tools'
import type { RuntimeEnv } from './tools/shell-session'
import { createWebTools } from './tools/web-tools'
import { createBrowserTools } from './tools/browser-tools'
import { createTodoTools } from './tools/todo-tools'
import { createGoalTools } from './tools/goal-tools'
import { createMemoryTools } from './tools/memory-tools'
import { createPlaybookTools } from './tools/playbook-tools'
import { createSkillTools } from './tools/skill-tools'
import { createMcpTools } from './tools/mcp-tools'
import type { SkillsStore } from '../skills/skills-store'
import type { McpManager } from '../mcp/mcp-manager'
import type { MemoryRepo } from '../memory/memory-core'
import type { PlaybookRepo } from '../memory/playbook-core'
import { createAskTools, type AskReporter } from './tools/ask-tools'
import type { AskRequest } from '@shared/ask'
import { createSubagentTools, type SubagentDispatcher } from './tools/subagent-tools'
import type { BackgroundTaskStore } from './background-tasks'
import { runSubagents } from './scheduler'
import {
  composeAgentPrompt,
  loadAgentEntries,
  TOOL_OUTPUT_TRUST_BASELINE,
  type AgentDefinition,
  type LoaderResult
} from './loader'
import type { PlanApprovalBridge } from './plan-approval'
import { runAgentLoop } from './loop'
import { createLogger } from '../log'
import { addUsage, emptyUsage, type TokenUsage } from '@shared/usage'
import type { CheckpointStore } from '../store/checkpoints'
import { createCheckpointStore } from '../store/checkpoints'
import { streamWithToolsOpenAI } from '../providers/openai-agent'
import { streamWithToolsAnthropic } from '../providers/anthropic-agent'
import { SUMMARY_SYSTEM_PROMPT } from './context'

// Agent 运行入口（IPC agent:run 的后端）：把加载器、门控、工具、Provider 通道拼成一杆枪。职责单一：不碰 UI、不碰流式对话。
// ⚠️ 本模块**不得 import 任何 electron 模块**（含 electron-store）：runner 被单测直接 import，而 CI 的 Linux 无 Electron 二进制，一旦引入即 `Electron failed to install correctly`（踩过）。

/**
 * 高危工具：**内核默认工具集不含**（plan6 D4 —— 免得"开箱就能跑命令"）；
 * 自定义 Agent 在 `tools` 里显式声明才会下发，而可写档下每次执行前**逐次确认**（plan8 R5）。
 */
const log = createLogger('agent-runner')

/**
 * 门控拦下工具时的**默认日志落点**（D-119 ① 的复查结论）。
 *
 * ⚠️ 用 `log.warn` 而不是 `console.warn`：run 发生在 main 进程，`console.warn` 只到 stdout ——
 * **打包态用户看不到**，而这恰恰是排查"工具怎么没了"时最需要看到的一行。`createLogger` 会落盘
 * （`app.log`），与同文件其余日志一致。
 *
 * ⚠️ 二值文案（`drop-server-off` / 其余）刻意写死在这里而不是内联：`GateDecision` 将来加第三态时，
 * 这里会多出一个"不在白名单"的误报 —— 但默认落点必须是**有的**，所以宁可留一个显式的兜底分支。
 */
const defaultGatedDropLog = (fullName: string, reason: string): void => {
  log.warn(`[mcp-gate] 未下发 ${fullName}（${reason === 'drop-server-off' ? '电脑控制开关关闭' : '不在白名单'}）`, { reason })
}

/** 内核默认集**不给**的高危能力 → 白话名（自视段报缺口时讲人话，不报裸工具名）。
 *  注意口径：Agent 自己声明了它就照给（R5），滤的是"没声明就走默认集"那条路。 */
const DANGEROUS_TOOLS = new Map([['run_command', '命令执行']])

/** 命令能力的附属件，只能管理 `run_command` 起的后台任务：`run_command` 不在时就收掉，
 *  否则是"能查能杀、却创建不了任何任务"的孤儿工具（0.13.77 真机实测 A3）。 */
const COMMAND_SATELLITES = ['check_command', 'kill_command']
/** 三者同在时**自动补齐**的只有查 —— `kill_command` 是破坏性的，且后台任务存储是**应用级单例**
 *  （`index.ts` 的 `createBackgroundTaskStore()`，跨会话共享），不传 id 的 `check_command` 能列出
 *  别人的任务、按 id 就能停别人的任务。所以它**只给显式声明的**，不白送。 */
const COMMAND_AUTO_ATTACH = ['check_command']

/** 「只读」权限档下模型只能拿到这些（D-032：权限是上限，不是建议）。
 *  浏览器类工具不写本机文件故归入只读，但**会改变远端状态**（点击 / 提交），说明里要标注。
 *  待办清单只改内存状态 → 只读档也该能用（它是"进度可见"，不是"改机器"）。
 *  提问同理：`ask_user` 只是把问题交给用户、**不动机器也不改状态** —— 只读档拦它等于让模型在
 *  拿不定主意时只能猜（那正是本能力要消灭的），故任何档位都该能问。 */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'fetch_url',
  'browser_navigate',
  'browser_read_page',
  'browser_click',
  'browser_type',
  'update_todos',
  // 目标与待办同族（plan12 ⑤）：只写应用自身的会话状态（goals.json），不动机器也不碰用户文件
  'set_goal',
  'ask_user'
])

/**
 * 按权限档求工具上限（纯函数，可单测）。权限档是**硬上限**：声明的 tools 只能在其中再收窄，不能越权扩大。
 *
 * ⚠️ **两条决定在这里交汇，改之前先读完**：
 * - plan6 D4：**内核默认集不含高危工具** —— 没声明（`declared === undefined`）= 用默认集，
 *   所以默认 Agent 拿不到 `run_command`；
 * - plan8 R5：**可写档下声明了就能用，但每次执行前要确认**（确认桥只在可写档注入，见下方 `runAgent`）。
 *   故可写档的上限**不再**滤掉高危工具 —— 否则"声明了也被权限档压住"，R5 永远触发不了，
 *   而界面上却写着"执行命令仍需逐次授权"（2026-09-13 对账时发现这个自相矛盾并改正）。
 * - 只读档仍然只留读类；可写与完全访问的**工具集相同**，差别只在"高危工具要不要逐次确认"。
 */
export function allowedToolsFor(preset: PermissionPreset, declared: string[] | undefined, allNames: string[]): string[] {
  const requested = declared ?? allNames.filter((n) => !DANGEROUS_TOOLS.has(n))
  const known = new Set(allNames)
  const kept = requested.filter((n) => known.has(n) && (preset !== 'read-only' || READ_ONLY_TOOLS.has(n)))
  // 命令组整体性（plan51 F2）：`run_command` 不在就收掉附属件（孤儿），在则补上"查"这一件
  // —— 这是"只能收窄"的**一处刻意例外**，且只补读类（破坏性的 `kill_command` 见上面那条注释）。
  if (!kept.includes('run_command')) return kept.filter((n) => !COMMAND_SATELLITES.includes(n))
  return [...kept, ...COMMAND_AUTO_ATTACH.filter((s) => known.has(s) && !kept.includes(s))]
}

/**
 * 子代理的工具集：**按它自己的声明装配**。上限是**权限档**，不是"主代理实收了什么"。
 *
 * ⚠️ 口径变更（plan51）：0.13.77 之前是"子代理复用主代理那一份已过滤工具"，于是 `def.tools`
 * 对子代理**完全不生效**（既不收窄也不授予）：声明只读的 reviewer 实拿 `write_file` + `edit`，
 * 声明了 `run_command` 的 executor 实拿不到 —— 而它的提示词正要求"跑构建/跑测试来验证"。
 * 改后上限放宽到「档位 ∩ 自己的声明」：派一个声明了高危工具的 Agent，它就真拿到那个工具
 * （可写档下每次执行照旧弹确认卡 —— 工具实例与主代理同一批，桥也同一批）。
 * 这是 plan6 D4「审查型只给读、执行型才给写」第一次真正成立。
 *
 * ⚠️ 代价：派发口成了一条**能力获取途径**，故带计划批准闸的 Agent 必须没有派发口（见 `runAgent` 里那条裁剪）。
 */
export function subagentToolNamesFor(
  preset: PermissionPreset,
  declared: string[] | undefined,
  allNames: string[]
): string[] {
  return allowedToolsFor(preset, declared, allNames).filter((n) => n !== 'spawn_agents')
}

export function createAllTools(workspaceRoot: string, hooks: ToolHooks = {}): AgentTool[] {
  // 没注入写入服务时的默认实现：能写不能删 —— 宁可删不掉，也不能在没有检查点的场景下悄悄硬删
  const writer =
    hooks.writer ??
    createWorkspaceWriter(workspaceRoot, {
      ...(hooks.pathAccess ? { pathAccess: hooks.pathAccess } : {}),
      trash: async () => {
        throw new Error('未配置回收站，删除操作已被拒绝')
      }
    })
  return [
    ...createFileTools(writer, hooks.policy),
    ...(hooks.confirmCommand
      ? createSystemToolsWithConfirm(
          workspaceRoot,
          hooks.confirmCommand,
          hooks.background,
          hooks.agentLabel,
          hooks.resourcesPath,
          hooks.pathAccess,
          hooks.resolveRuntimeEnv
        )
      : createSystemTools(
          workspaceRoot,
          hooks.background,
          hooks.agentLabel,
          hooks.resourcesPath,
          hooks.pathAccess,
          hooks.resolveRuntimeEnv
        )),
    ...createWebTools(hooks.webSearchDeps),
    ...createBrowserTools(),
    // 待办清单：**有消费者才注册** —— 没人看的话，这工具就是给模型的假承诺
    ...(hooks.onTodos ? createTodoTools({ update: hooks.onTodos }) : []),
    // 目标（plan12 ⑤）：同理 —— onSetGoal 由组合根实现（store + 推送都在那儿，runner 不碰 electron-store）
    ...(hooks.onSetGoal ? createGoalTools({ setGoal: hooks.onSetGoal }) : []),
    // 提问：同理 —— 没人在界面那头作答时，`ask_user` 只会让模型干等满超时
    ...(hooks.ask ? createAskTools(hooks.ask) : []),
    // 子代理派发：同理 —— 没有运行记录消费方时，模型派了也没人看得见
    ...(hooks.spawnAgents ? createSubagentTools(hooks.spawnAgents) : []),
    // 记忆（plan19 批 1）：同理 —— 没有记忆库时下发 remember/recall 只会让模型白写一遍
    ...(hooks.memory
      ? createMemoryTools({
          repo: hooks.memory.repo,
          conversationId: () => hooks.memory!.conversationId,
          ...(hooks.memory.confirm ? { confirm: hooks.memory.confirm } : {})
        })
      : []),
    // Playbook（plan19 批 3）：同理 —— 没有 Playbook 库时下发 save_playbook 只会让模型白写一遍
    ...(hooks.playbook
      ? createPlaybookTools({
          repo: hooks.playbook.repo,
          conversationId: () => hooks.playbook!.conversationId
        })
      : []),
    // 技能（plan22 D-059）：同理 —— 没有技能时下发 use_skill 只会让模型对着空清单调用。
    // ⚠️ 判定口是 hasActive()（**生效**技能非空），不是「store 存在」—— 空目录 / 全被覆盖都算没有。
    ...(hooks.skills?.store.hasActive() ? createSkillTools({ store: hooks.skills.store }) : []),
    // MCP（plan23 D-065）：同理 —— 没有已连接服务器时，外部工具不下发（下发即空头承诺）
    //
    // ⚠️ 2026-09-19 真机 bug：`computerControl` / `onGatedDrop` **漏传了**（只传了 manager + confirm）。
    // 后果是**双重的**，且都验不出来：
    // ① `mcp-tools` 里 `deps.computerControl === true` 恒为 false → 桌面派（windows-mcp）**每个**工具
    //    都被判 `drop-server-off` 整体丢弃 —— 用户装了、连上了、开关也开了，模型手上却**一件都没有**；
    // ② 同一句 `onGatedDrop?.()` 也是空的 → 连"被拦了什么"的日志都没有，
    //    于是排查时翻遍运行日志干干净净，反倒像是"门控压根没跑"（真机就是这么骗过去的）。
    // **为什么单测全绿也没抓住**：`computer-use.test.ts` 测的是纯判据、`mcp-manager.test.ts` 的
    // 「门控与透传」段用的是**非桌面派** server（`isComputerUseServer=false` → 判据第一句就 `keep` 了），
    // 两边都绕开了"hooks → 装配 → 门控"这条真正出事的通路。补的回归测试见
    // `tests/unit/mcp-manager.test.ts` 的「装配层透传」段 —— 那里造的是 `windows-mcp` 派 server。
    ...(hooks.mcp?.manager.hasConnected()
      ? createMcpTools({
          manager: hooks.mcp.manager,
          ...(hooks.mcp.confirm ? { confirm: hooks.mcp.confirm } : {}),
          // 这两个**无条件透传**（不用 `...(cond ? {x} : {})`）：
          // `false` 被条件展开吞成"字段不存在"，看着与显式关闭等价，实则把"关"与"没设置"混成一回事 ——
          // 权限开关上这种含糊迟早出事（D-119 ① 的 P0 复查结论）。
          computerControl: hooks.mcp.computerControl === true,
          onGatedDrop: hooks.mcp.onGatedDrop ?? defaultGatedDropLog
        })
      : [])
  ]
  // ⚠️ 这段装配是**本轮的一次性快照**（D-119 ① 复查补记）：`createAllTools` 在一个 run 开始时
  // 建一次工具表，此后本轮固定。MCP 若在 run 中途断开/重连，本轮**不换表** —— 旧表里的工具调用
  // 会落到已不存在的连接上，由 `manager.callTool` 以人话错误返回（不崩、模型可自纠）。
  // 与 plan43 的「run 内不漂移」同一条口径：**新任务用新环境，正在跑的任务不打断**。
}

/** 本轮用户原话（最后一条 user 消息）。⚠️ 只取 content 为字符串的那些 —— 带图片的消息取不到文字。 */
function lastUserText(history: AgentMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m?.role === 'user' && typeof m.content === 'string') return m.content
  }
  return null
}

/** 工具层的可注入钩子（写入服务 / 危险操作确认 / 待办清单 / 子代理） */
export interface ToolHooks {
  writer?: WorkspaceWriter
  policy?: TokenPolicy
  /** 路径放行策略（plan29 D-089）：**只有 Agent 线**该传 —— 传 `{ allowOutside: true }` = 完全访问档无边界。
   *  不传 = 锁死工作区（fail-closed）。⚠️ **界面线永远不要传**（界面越权，见 `guard.ts` 的 `PathAccess`）。 */
  pathAccess?: PathAccess
  /** 网页搜索源（plan31 D-096 扩展）：Firecrawl 密钥由组合根解密传入；null/不传 = 用零密钥默认源（DDG） */
  webSearchDeps?: { firecrawlApiKey: string | null }
  /** 执行 shell 命令前的逐次确认（plan8 R5）；不传 = 不确认 */
  confirmCommand?: CommandConfirm
  onTodos?: (todos: TodoItem[]) => void
  /** 目标创建口（plan12 ⑤）；不传 = 不下发 set_goal 工具（「有消费者才注册」，同 todos/ask/subagent） */
  onSetGoal?: (input: { text: string; doneWhen?: string }) => import('@shared/goal').Goal
  /** 提问口（Agent 向用户要主意）；不传 = 不下发 ask_user 工具 */
  ask?: AskReporter
  /** 子代理派发口（plan7 批 D）；不传 = 不下发 spawn_agents 工具 */
  spawnAgents?: SubagentDispatcher
  background?: BackgroundTaskStore
  agentLabel?: string
  /**
   * plan43 S3：用户选中的开发环境（运行时）→ 命令执行时的 PATH 覆盖。
   *
   * 与 `memory.enabled` 同手法：**传函数而非值**，且**每个 agent run 现读** ——
   * 用户在设置页换了运行时，下一个任务即生效（run 内不变，见 shell-session 的指纹机制）。
   * 不注入 = 不覆盖 PATH（本功能未启用时行为与从前逐字一致）。
   */
  resolveRuntimeEnv?: () => RuntimeEnv
  /**
   * 记忆工具口（plan19 批 1）。不传 = 不下发 `remember` / `recall`（「有消费者才注册」，同 todos / ask / subagent）；
   * `conversationId` 由 `runAgent` 在装配处补 —— 同一个 hooks 对象会被多条会话共用，它自己不知道这一轮是谁。
   */
  memory?: {
    repo: MemoryRepo
    conversationId: string
    /** 记忆开关（批 1）：false = 这一轮**不下发** remember / recall（结构性关断，不是提示词层面） */
    enabled?: () => boolean
    confirm?: (reason: string) => Promise<boolean>
    /** 本轮用户原话（批 4 纠正识别用）。取值见 `lastUserText` */
    lastUserMessage?: () => string | null
  }
  /**
   * Playbook 工具口（plan19 批 3）。不传 = 不下发 `save_playbook` / `recall_playbook`
   * （「有消费者才注册」，同 todos / ask / subagent / memory）。
   * ⚠️ Playbook **没有开关**：它是模型显式调用的程序记忆，不像自动记忆那样会自己花钱。
   */
  playbook?: {
    repo: PlaybookRepo
    conversationId: string
  }
  /** 技能库（plan22）。不传 = 不下发 use_skill（「有消费者才注册」，D-059）。只读档可用（D-058：纯读操作） */
  skills?: {
    store: SkillsStore
  }
  /** MCP 客户端（plan23）。不传或无已连接服务器 = 不下发任何 mcp__ 工具（D-065）；执行默认走确认桥（D-064） */
  mcp?: {
    manager: McpManager
    confirm?: (req: { tool: string; detail: string }) => Promise<boolean>
    /**
     * plan44 门控：电脑控制开关（**本轮**值）与被拦日志回调。
     *
     * ⚠️ 两个都必须传（`computerControl` 用必填、`onGatedDrop` 有默认落点兜底）——
     * 2026-09-19 的真机 bug 就是这两个漏传导致的（D-119 ①）：开关恒 false ⇒ 桌面派工具整体丢弃；
     * 回调为空 ⇒ **连一条日志都没有**，排查时看着像"门控压根没跑"。
     * 这里把 `computerControl` 收成必填（`boolean` 而非 `boolean | undefined`）是**刻意的**：
     * 漏传它必须在**编译期**就报错，而不是运行期静默全拦。
     */
    computerControl: boolean
    onGatedDrop?: (fullName: string, reason: string) => void
  }
  /** 打包态资源根（找随包的 ripgrep）。装配层注入 —— runner 不许 import electron；不传 = 只用环境变量/PATH 上的 rg */
  resourcesPath?: string | null
}

export interface AgentRuntimeContext {
  getWorkspaceRoot(): string
  builtinAgentsDir: string
  userAgentsDir: string
  checkpoints: CheckpointStore
  /** 删除到回收站（plan7 批 A2）。由主进程注入 `shell.trashItem`：runner 不许 import electron（见文件头）；不注入 = 删除被拒绝（安全默认） */
  trash?: (abs: string) => Promise<void>
  background?: BackgroundTaskStore
  /** 提问桥（`ask_user` 的落地口）。由组合根注入：它要推窗口，而 runner 不许 import electron；
   *  会话身份**不在这里补** —— 同一个上下文会被多条会话共用，`conversationId` 只能由 `runAgent` 按轮次补。 */
  ask?: AskReporter
  /**
   * 计划批准桥（plan27）。由组合根注入：它要推窗口，而 runner 不许 import electron。
   *
   * 不注入 = **闸门不生效**，退回 plan27 之前的行为：方案作为本轮最终输出返回，
   * **不会自动接着执行**。这是刻意的口径 —— 拿不到「有人点头」的通道时，
   * 唯一安全的做法是**停在方案上**（planner 没有写工具，把方案交回用户零风险）；
   * 而"没桥就报错"会让单测 / CLI 这类无人值守场景彻底不可用，代价大于收益。
   */
  planApproval?: PlanApprovalBridge
  /** 打包态资源根（找随包的 ripgrep，L0 检索）。由组合根注入 `process.resourcesPath` —— runner 不许 import electron */
  resourcesPath?: string | null
  /**
   * plan43 S3：用户选中的开发环境（运行时）→ 命令执行时的 PATH 覆盖。
   *
   * 由组合根提供（它持有 settings 与 userData 路径）：runner 不许碰 electron-store / fs。
   * **每个 agent run 现读** —— 用户在设置页换了运行时，下一个任务即生效。
   * 不注入 = 不覆盖 PATH（本功能未启用时行为与从前逐字一致）。
   */
  resolveRuntimeEnv?: () => RuntimeEnv
  /** 记忆库（plan19 批 1）。由组合根注入：runner 不许碰 electron-store / fs，故"读写记忆"只能发生在那一层 */
  memory?: {
    repo: MemoryRepo
    /** 记忆开关（批 1）：false = 不下发 remember / recall。每轮读一次 → 改设置即时生效，不用重启 */
    enabled?: () => boolean
    confirm?: (reason: string, conversationId: string) => Promise<boolean>
  }
  /** Playbook 库（plan19 批 3）。由组合根注入 —— runner 不许碰 electron-store / fs */
  playbook?: {
    repo: PlaybookRepo
  }
  /** 技能库（plan22）。由组合根注入（内置 resources/skills + 用户 userData/skills 两层）—— runner 不许碰 fs / electron */
  skills?: {
    store: SkillsStore
  }
  /** MCP 管理器（plan23）。由组合根注入 —— runner 不碰 electron；已连接服务器的工具经此聚合与转发 */
  mcp?: {
    manager: McpManager
  }
  confirmCommand?: (req: {
    tool: string
    detail: string
    agent: string
    where: string
    conversationId: string
  }) => Promise<boolean>
}

export function ensureAgentRuntime(ctx: AgentRuntimeContext): void {
  mkdirSync(ctx.getWorkspaceRoot(), { recursive: true })
  mkdirSync(ctx.userAgentsDir, { recursive: true })
}

/** 两层加载（plan17 D2 → **D-103 修订**）：用户 > 内置；**项目级已取消** —— 子 Agent 随场景而行动，
 *  不做开关也不分层（开关/分层在这里都是冗余步骤）。工作区 `.agents/*.md` 若还有旧定义 →
 *  warnings 提示迁移（fail-soft 不静默，但也不再加载它）。 */
export function loadAgentRegistry(ctx: AgentRuntimeContext): LoaderResult {
  const projectDir = join(ctx.getWorkspaceRoot(), '.agents')
  const legacy = existsSync(projectDir)
    ? readdirSync(projectDir).filter((f) => f.toLowerCase().endsWith('.md'))
    : []
  const migrateHints = legacy.map(
    (f) => `工作区 .agents/${f}：项目级子 Agent 已取消（D-103），请把定义移到用户层（设置 → 子 Agent）或删除该文件`
  )
  const { entries, warnings } = loadAgentEntries([
    { dir: ctx.builtinAgentsDir, source: 'builtin' },
    { dir: ctx.userAgentsDir, source: 'user' }
  ])
  return {
    definitions: new Map(entries.filter((e) => !e.overridden).map((e) => [e.name, e])),
    warnings: [...migrateHints, ...warnings]
  }
}

/** 技能列表（plan22 D-056）。⚠️ 本函数**曾把 agent 注册表当技能返回**（早期概念混淆的产物），
 *  renderer 侧零消费，2026-09-16 改为真技能列表 —— 通道名 `skills:list` 复用，
 *  agent 列表走 `agents:list`（plan17），功能不重叠。 */
export function listSkills(ctx: AgentRuntimeContext): SkillInfo[] {
  const store = ctx.skills?.store
  if (!store) return []
  return store
    .view()
    .entries.map((e) => ({
      name: e.name,
      description: e.description,
      // plan34 S2a：双语简介带出（内置项的 `›` 下拉展示用；自定义项 UI 不展示）
      descriptionZh: e.descriptionZh,
      descriptionEn: e.descriptionEn,
      source: e.source,
      overridden: e.overridden
    }))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'user' ? -1 : 1))
}

export interface RunAgentArgs {
  settings: ModelSettings
  apiKey: string
  history: AgentMessage[]
  /** **这次跑属于哪条会话**（plan11），必填：检查点靠它记归属、危险确认靠它说清"哪条会话在问"；少了它，出事时连这轮是谁的都说不清。 */
  conversationId: string
  agentName?: string
  permission?: PermissionPreset
  /** Firecrawl 密钥（plan31）：由组合根从设置解密后传入；不传 = web_search 走零密钥默认源 */
  firecrawlApiKey?: string | null
  onText?: (delta: string) => void
  /** 思考增量回调（DeepSeek 系 `reasoning_content`），界面上显示"思考过程"。⚠️ Anthropic 的 thinking 与 tools 互斥，故工具循环里只对 OpenAI 兼容协议生效。 */
  onReasoning?: (delta: string) => void
  onToolEvent?: (evt: ToolEvent) => void
  /**
   * 执行事件流（plan26 D-077）。**由组合根装配**（conversationId 已知、fs sink 在 main）——
   * runner 不建 recorder，只向 loop/scheduler 透传。不传 = 不记录。
   */
  execEvents?: ExecEventRecorder
  /**
   * 滚动摘要缓存（plan26 D-080）：`Map<conversationId, 摘要文本>`，由组合根创建、跨轮持有。
   * 给了才启用滚动摘要（裁剪时调模型）；**不给 = 机械占位**（现状行为，零退化）。
   * 进程内会话级缓存（不落盘）——重启后首轮裁剪重新摘要，如实登记的取舍（D-080）。
   */
  summaryCache?: Map<string, string>
  onTodos?: (todos: TodoItem[]) => void
  /** 目标创建口（plan12 ⑤）：组合根实现——调 goal store + 推送界面；不传 = 不下发 set_goal 工具 */
  onSetGoal?: (input: { text: string; doneWhen?: string }) => import('@shared/goal').Goal
  onSubagentEvent?: (evt: SubagentJobEvent) => void
  /** 工具输出被**窗口化**时回调（plan8 R9.1）：非要有这条痕 —— 工具事件是渲染进程内存态、每轮清空、重挂载即丢，只靠界面显示"已压缩 xx%"等于"当时没看见就永远查不到"。 */
  onToolWindowed?: (info: { name: string; beforeTokens: number; afterTokens: number; reason: string }) => void
  signal?: AbortSignal
  /** 工具输出窗口化开关（plan8 R9.1），不给 = 开；关掉后输出原样进上下文，供 A/B 校准与"怀疑被压糊"复现 */
  toolWindow?: boolean
  /** 省 token 档位（plan8 R9.1 §七②）解析出的开关，**由调用方注入** —— runner 不许碰 electron-store，故"读用户设置"只能发生在组合根（`ipc.ts` / `scheduler.ts`）。 */
  policy?: TokenPolicy
  /**
   * 记忆注入段（plan19 批 1）。**由组合根组装好传进来** —— runner 不知道记忆库在哪，也不该知道。
   * `null` / 缺省 = 这一段不出现。
   */
  memoryBlock?: string | null
  /**
   * Playbook 注入段（plan19 批 3）。**由组合根组装好传进来**（含活跃标签匹配结果）——
   * runner 不知道 Playbook 库在哪，也不做标签推断。
   * ⚠️ 与 `memoryBlock` **各自独立**：预算语义不同（记忆无条件注入，Playbook 条件召回）。
   * `null` / 缺省 = 这一段不出现。
   */
  playbookBlock?: string | null
  /**
   * 技能注入段（plan22 D-057）。**由组合根组装好传进来**（`composeSkillBlock` 纯函数产出的成品块）
   * —— runner 不知道技能库在哪。`null` / 缺省 = 这一段不出现。
   */
  skillBlock?: string | null
  /**
   * 规则注入段（plan24 D-068）。**由组合根组装好传进来**（composeRulesBlock 产出）。
   * 规则是**无条件注入**的约束（区别于技能的按需加载）—— 每轮都必须在模型眼前。
   * `null` / 缺省 = 没有任何规则文件。
   */
  rulesBlock?: string | null
  /**
   * 电脑控制开关（2026-09-15 用户需求）：由组合根读好传入，进自视段**并**供 MCP 门控使用。
   *
   * ⚠️ **可选是刻意的**（D-119 ① 复查裁定，2026-09-19）：`scheduler` 等非交互调用点不传它，
   * 语义就是"缺省 = 关"。**权限类不许替用户默认开**，而 `=== true` 正是这条语义的落地点
   * （`undefined` / `false` / 任何非 `true` 都判关）。⚠️ 改这里之前先记住：把它改成"非 false 即真"
   * 会让所有忘记传的调用点**静默放开电脑控制** —— 失效方向就从"关"翻成了"开"，那是安全问题。
   * 生产侧 `ipc.ts` 每次发送都现取 `getComputerControlEnabled()`，不存在漏传。
   */
  computerControl?: boolean
  /**
   * plan27：显式跳过计划批准闸。
   * ⚠️ **内层（executor）递归调用必须传 `true`** —— 与「executor 自身不带 `approval:plan`」构成**双保险**，
   * 防「批准完又弹一张卡」的无限套娃。
   */
  skipPlanApproval?: boolean
}

/**
 * plan27：决定「批准之后由谁来执行」。
 * 优先用 agent 自己声明的 `executor`；否则退回 `code-executor`；都没有则交回**内核默认工具集**
 * （不是「不执行」—— 内核默认在可写档下本来就能写，只是少了 executor 的职责提示词）。
 * ⚠️ 声明了但**不存在**的名字 ⇒ 继续往兜底找，而不是报错 —— 与 `tools` 的宽松口径一致
 * （写歪一个名字不该让整条流程断掉）。
 */
function pickExecutor(declared: string | undefined, registry: LoaderResult): string | undefined {
  if (declared && registry.definitions.has(declared)) return declared
  if (registry.definitions.has('code-executor')) return 'code-executor'
  return undefined
}

/** runAgent 的返回：loop 结果 + 本轮账目（agent / runId / 改动数 / 用量）+ plan27 批准结论 */
export type AgentRunResult = AgentLoopResult & {
  agent: string
  runId: string
  changedFiles: number
  usage: TokenUsage | null
  /** plan27：本轮「计划批准」结论。`undefined` = **没触发批准闸**（普通 agent / 空方案 / 显式跳过） */
  planApproved?: boolean
}

export async function runAgent(ctx: AgentRuntimeContext, args: RunAgentArgs): Promise<AgentRunResult> {
  const workspaceRoot = ctx.getWorkspaceRoot()
  const registry = loadAgentRegistry(ctx)

  const def = args.agentName ? (registry.definitions.get(args.agentName) ?? null) : null
  // 先校验 Agent 名再建检查点：否则"名字写错"会留下一个永远停在 running 的空轮次
  if (args.agentName && !def) {
    throw new Error(
      `找不到名为「${args.agentName}」的 Agent 定义（已加载：${[...registry.definitions.keys()].join('、') || '无'}）`
    )
  }

  // 检查点边界（plan8 R4）：**一轮运行 = 一个可回滚的检查点**，必须在建工具之前开始，好让写文件工具拿得到 recorder
  const agentLabel = args.agentName ?? '内核默认'
  const runId = ctx.checkpoints.begin(workspaceRoot, agentLabel, args.conversationId)

  // ── 子代理派发（plan7 批 D）── 两条边界：① 子代理按**自己的 def** 装配工具，上限是**权限档**
  // 而不是"主代理实收了什么"（所以派一个声明了高危工具的 Agent，它就拿得到那个高危工具；
  //  也所以声明只读的 Agent 真的只读 —— 详见 `subagentToolNamesFor` 的口径变更说明）；
  // ② **拿不到 spawn_agents 自己**（否则递归派生、成本失控）。
  // `allTools` / `preset` 在下面才初始化：本闭包要等 `dispatch` 被真调用时才求值，故用 let 打破顺序。
  // ⚠️ 兜底**抛错而不是返回空数组**：静默发空工具 = 子代理一个活儿干不了、提示词照旧许诺它有能力，
  // 且没有任何一道闸会红（顺序哪天被打乱，表现必须是响，不是"看起来像没权限"）。
  let toolsForSubagent: (def: AgentDefinition) => AgentTool[] = () => {
    throw new Error('子代理工具集尚未初始化（派发早于装配）—— 这是接线错误，不是权限不足')
  }
  const subagentDispatcher: SubagentDispatcher = {
    async dispatch(jobs) {
      const missing = [
        ...new Set(jobs.filter((j) => !registry.definitions.has(j.agent)).map((j) => j.agent))
      ]
      if (missing.length > 0) {
        const known = [...registry.definitions.keys()].join('、') || '（无）'
        return `错误：找不到子代理定义「${missing.join('、')}」。已注册的有：${known}`
      }
      const results = await runSubagents({
        definitions: jobs.map((j) => registry.definitions.get(j.agent)!),
        task: '',
        tasks: jobs.map((j) => j.task),
        toolsFor: toolsForSubagent,
        // 子代理按**自己的 def.model** 建通道（缺省沿用当前会话模型），输出不上屏（只回流给主代理）
        chatFactory: (d) => {
          // 用 `effective` 而非 `args.settings`：档位对思考强度的覆盖（§七③）必须对子代理同样生效，否则轻量档用户派个子代理，那边还在高思考强度空烧
          const model = d.model ? { ...effective, model: d.model } : effective
          // schema 与执行用的工具**同源同次求值**：两份各算一次迟早分岔（实收 schema 与真工具对不上）
          const schemas = toolsForSubagent(d).map((t) => t.schema)
          return (messages: AgentMessage[]) => {
            // 子代理**不再自带整轮墙钟**（plan29 D-090）：原来这里在父 signal 缺席时给一个
            // `AbortSignal.timeout(model.timeoutMs)`，而子代理是并发跑的 —— 等于每个子代理各拿一个
            // 与"父轮次总时长"同数量级的数字，父轮的预算被并发地重复消耗。现在的口径是：
            // 只传父 signal（**父停子停**），每一轮自己的健壮性由 provider 的首包 / 分片间隔守卫负责。
            return model.providerType === 'anthropic'
              ? streamWithToolsAnthropic(model, args.apiKey, messages, schemas, () => {}, args.signal)
              : streamWithToolsOpenAI(model, args.apiKey, messages, schemas, () => {}, args.signal)
          }
        },
        ...(args.onSubagentEvent ? { onJobEvent: args.onSubagentEvent } : {}),
        ...(args.policy ? { policy: args.policy } : {}),
        // 输出纪律（§七③）：与主代理**同一份** —— 子代理的输出同样计费，纪律不该只约束一半
        ...(discipline ? { systemSuffix: discipline } : {}),
        // plan26 D-077：执行事件流透传（子代理活动标 'sub'，盲审 A P0-2）
        ...(args.execEvents ? { execEvents: args.execEvents } : {})
      })
      const parts = results.map((r) =>
        r.ok
          ? // plan8 R9.1：不在这里 `slice(0, 6000)` —— 子代理报告常"结论在最后"，砍前 6000 字符等于扔掉结论；原样交回，由 loop.ts 统一收形
            `【${r.name}】完成（${r.rounds} 轮）\n${r.output}`
          : `【${r.name}】失败：${r.error ?? '未知原因'}`
      )
      return parts.join('\n\n---\n\n')
    }
  }

  /**
   * 路径放行策略（plan29 D-089）—— 「完全访问」档在 **Agent 线**上真的无边界。
   *
   * 这是把档位从「名不副实」拉回「名实相符」的那一行：在此之前 `full-access` 的实际语义
   * 只有"免确认弹窗"，文件访问仍被无条件锁在工作区内（用户称之为「假完全」，是准确描述）。
   *
   * ⚠️ 两个刻意的约束：
   * 1. **只喂 Agent 侧**（writer + 工具）—— 界面线的文件访问**绝不**受此影响，
   *    否则把一个「权限不足」的问题换成「界面越权」这个更严重的问题（见 `guard.ts` 的 `PathAccess`）；
   * 2. **只有 full-access 才为真**，其余档位 `undefined` = fail-closed。默认档（write）必须维持旧行为。
   */
  const pathAccess: PathAccess | undefined =
    (args.permission ?? 'write') === 'full-access' ? { allowOutside: true } : undefined

  // 写入服务（plan7 批 A2）：**快照挂在服务层** —— 界面与 Agent 走的都是这一条路径；子代理复用同一批工具实例，故它们的写操作同样记进本轮的检查点。
  const writer = createWorkspaceWriter(workspaceRoot, {
    ...(pathAccess ? { pathAccess } : {}),
    beforeChange: (rel, abs) => ctx.checkpoints.record(runId, workspaceRoot, rel, abs),
    trash: async (abs) => {
      if (!ctx.trash) throw new Error('未配置回收站，删除操作已被拒绝')
      await ctx.trash(abs)
    }
  })

  // plan43 S3：开发环境（运行时）→ 命令执行的 PATH 覆盖。
  // ⚠️ **在这里求值一次**（把值而非函数交给工具集）—— 这是「**run 内不漂移**」这条承诺的落地点。
  //
  // 曾经的做法是传函数、让 `getShell()` 每次现读，注释还写着"保证改了设置后新起的会话用新环境"。
  // 那是**错的**：`getShell()` 每条 `run_command` 都调，于是**同一个 run 内**用户一改设置，
  // 下一条命令就换了环境 —— `cd`/`set` 还留着、PATH 却换了，正是这条承诺要防的
  // 「同一任务里两条命令跑在两个环境里」（2026-09-19 子代理复查抓出）。
  //
  // 正确语义 = 「**新任务用新环境，正在跑的任务不打断**」，与 VS Code 的
  // 「新开终端才跟随」同构（一个 run ≈ 一个新终端）。改设置 → 下一个 run 生效。
  const runtimeEnvForRun = ctx.resolveRuntimeEnv?.()
  const allTools = createAllTools(workspaceRoot, {
    writer,
    ...(pathAccess ? { pathAccess } : {}),
    webSearchDeps: { firecrawlApiKey: args.firecrawlApiKey ?? null },
    ...(args.policy ? { policy: args.policy } : {}),
    ...(ctx.background ? { background: ctx.background, agentLabel } : {}),
    ...(runtimeEnvForRun ? { resolveRuntimeEnv: () => runtimeEnvForRun } : {}),
    // 逐次确认（plan8 R5）：仅「可写」档需要 —— 只读档本就不下发 run_command；完全访问档是用户明确选的"别拦我"
    ...(ctx.confirmCommand && (args.permission ?? 'write') === 'write'
      ? {
          confirmCommand: (command: string) =>
            ctx.confirmCommand!({
              tool: 'run_command',
              detail: command,
              agent: agentLabel,
              where: workspaceRoot,
              conversationId: args.conversationId
            })
        }
      : {}),
    ...(args.onTodos ? { onTodos: args.onTodos } : {}),
    // 记忆（plan19 批 1）：`conversationId` 在这里补 —— 与 `confirmCommand` 同一手法。
    // ⚠️ 开关在这里**每轮读一次**：关掉就整个不下发 remember / recall（结构性关断，
    //    不是"工具还在但让它别用"——后者靠提示词，提示词挡不住想用的模型）。
    ...(ctx.memory && (ctx.memory.enabled?.() ?? true)
      ? {
          memory: {
            repo: ctx.memory.repo,
            conversationId: args.conversationId,
            enabled: ctx.memory.enabled,
            // 批 4：纠正识别要"这一轮用户说了什么"。数据只有这里（`args.history`）有 ——
            // 工具层拿不到，故由装配处注入。取**最后一条** user（本轮的原话）。
            lastUserMessage: () => lastUserText(args.history),
            ...(ctx.memory.confirm
              ? {
                  confirm: (reason: string) =>
                    ctx.memory!.confirm!(reason, args.conversationId)
                }
              : {})
          }
        }
      : {}),
    ...(args.onSetGoal ? { onSetGoal: args.onSetGoal } : {}),
    // Playbook（plan19 批 3）：`conversationId` 同样在这里补。⚠️ 无开关 —— 它是模型显式调用的
    // 程序记忆（不像自动记忆那样自己花钱），"有消费者才注册"是唯一门槛。
    ...(ctx.playbook
      ? {
          playbook: {
            repo: ctx.playbook.repo,
            conversationId: args.conversationId
          }
        }
      : {}),
    // 技能（plan22）：只读资产、无开关 —— use_skill 是读操作（D-058），「有消费者才注册」是唯一门槛
    ...(ctx.skills ? { skills: { store: ctx.skills.store } } : {}),
    // MCP（plan23 D-064）：外部代码执行，确认桥在这里补 conversationId（同一上下文被多会话共用）
    ...(ctx.mcp
      ? {
          mcp: {
            manager: ctx.mcp.manager,
            // plan44 决策 4：桌面派门控读**本轮**的 computerControl（ipc 每次发送现取设置）；
            // 被拦工具记日志（决策 3b：未知工具名默认屏蔽要"看得见被拦了什么"才查得动）
            computerControl: args.computerControl === true,
            onGatedDrop: defaultGatedDropLog,
            ...(ctx.confirmCommand
              ? {
                  confirm: (req: { tool: string; detail: string }) =>
                    ctx.confirmCommand!({
                      tool: req.tool,
                      detail: req.detail,
                      agent: 'MCP',
                      where: 'MCP',
                      conversationId: args.conversationId
                    })
                }
              : {})
          }
        }
      : {}),
    // 提问：conversationId 在这里补（工具层拿不到会话身份，界面要靠它说明"这条问题出自哪条会话"）；
    // 权限档**不做额外限制**（ask_user 只把问题交给用户，只读档也该能问）。
    ...(ctx.ask
      ? {
          ask: {
            ask: (req: Omit<AskRequest, 'id'>) =>
              ctx.ask!.ask({ ...req, conversationId: args.conversationId })
          }
        }
      : {}),
    ...(registry.definitions.size > 0 ? { spawnAgents: subagentDispatcher } : {}),
    // L0 检索（plan3/plan4）：打包态把随包的 ripgrep 位置传下去 —— 工具层不许 import electron
    ...(ctx.resourcesPath ? { resourcesPath: ctx.resourcesPath } : {})
  })
  const allNames = allTools.map((t) => t.schema.name)

  // 权限档在一轮内是定值，且**主/子代理共用同一档**（子代理不许借派发换档）
  const preset: PermissionPreset = args.permission ?? 'write'
  // 工具白名单：**权限档是硬上限**（D-032），自定义 Agent 的 tools 只能在其中再收窄
  //
  // 带计划批准闸的 Agent **不许有派发口**（plan51）：子代理现在按自己的声明装配，留着派发口就
  // 等于"批准卡还没弹，写操作已经经子代理落盘"——plan27 那条「先批准、后执行」当场失效。
  // 结构性掐掉，不靠"当前内置 planner 恰好没声明 spawn_agents"这层运气。
  const allowed = allowedToolsFor(preset, def?.tools, allNames).filter(
    (n) => !(def?.approval === 'plan' && n === 'spawn_agents')
  )
  const gate = new ToolGate(allowed)
  const tools = allTools.filter((t) => gate.check(t.schema.name).ok)

  toolsForSubagent = (d) => {
    const allow = new Set(subagentToolNamesFor(preset, d.tools, allNames))
    return allTools.filter((t) => allow.has(t.schema.name))
  }

  /** 省 token 档位（§七②③）：**组合根已解析好传进来**；没传（如单测直接调 `runAgent`）按**平衡档**补齐 */
  const policy: TokenPolicy = args.policy ?? resolvePolicy(null)
  // 提示词拼接抽成纯函数（plan17 D10）：主循环与 scheduler 同式防漂移；主对话跑自定义 Agent 不自称"子代理"
  const systemPrompt = def
    ? composeAgentPrompt(def, 'main')
    : '你是九十里路的内核 Agent：专注于完成任务，可使用提供的工具读写工作区内的文件。'
  // 行为纪律（2026-09-12 真机实测后补）：起因是模型没调工具、凭"目录应该是空的"直接作答 —— 结果蒙对了，但那是**运气**，核因是提示词缺"必须先查再答"这条纪律。
  // 每条 = 一个行块，首行的编号由下面统一补（后两条按实收工具表取舍，编号不能写死）。
  const CONDUCT_FIXED: string[][] = [
    [
      '**能查就查，不许猜。** 凡是工具能确认的事实——工作区里有哪些文件、文件内容是什么、',
      '   网页上写了什么、命令输出是什么——**必须先调用工具核实，再回答**。',
      '   禁止凭推测、记忆或"应该差不多"直接作答。宁可多调一次工具，也不许给出没有依据的答案。'
    ],
    ['**没核实过的事，不要用笃定的语气讲。** 不确定就说不确定，并说明需要查什么。'],
    [
      '**能力不足时如实说，并给替代方案。** 若某件事要靠**本轮工具表里没有**的能力才能做成，',
      '   明确说明缺什么，再提出用现有工具能达到同样目的的替代做法。'
    ],
    [
      '**多步任务先列清单。** 需要三步以上的活儿，先用 update_todos 列出计划，',
      '   之后每完成一步就更新一次状态——用户据此知道进行到哪了。',
      '   单步小事不必列（清单是给"长活"用的，不是每句话都开一张表）。',
      '   另外：用户交代了**跨轮次**的长期意图（"以后每次都要…""这个项目最终要…"）时，',
      '   用 set_goal 登记成目标——目标跨轮次存活、用户能暂停/完成它，与待办是两回事。'
    ]
  ]

  // ★ 后两条按**本轮实收的工具表**取舍（plan51 F3）。0.13.77 真机实测里模型第一轮就发现
  // "提示词教我用 run_command，工具表里没有这件"，于是白烧轮次自证矛盾 —— 承诺拿不到的能力比不承诺更贵。
  const has = (name: string): boolean => tools.some((t) => t.schema.name === name)
  // 能力缺口（plan51 F4）：只报**有真实出口**的那些 —— 本会话没拿到、且确有可派 Agent 声明了它。
  // 没有出口就不报（self-view 约束②：不许写拿不到的承诺），纪律第 6 条也据此走"未能验证"分支。
  const capabilityGaps = has('spawn_agents')
    ? [...DANGEROUS_TOOLS]
        .filter(([cap]) => !has(cap))
        .map(([cap, label]) => ({
          capability: cap,
          label,
          // 按**装配后的实收**判定，不按"名字被声明过"：名字写歪（loader 宽松解析、不验成员）
          // 或被档位滤掉时，`subagentToolNamesFor` 给不出它 —— 那样报出来就又是一次假承诺。
          agents: [...registry.definitions.values()]
            .filter((d) => subagentToolNamesFor(preset, d.tools, allNames).includes(cap))
            .map((d) => d.name)
        }))
        .filter((g) => g.agents.length > 0)
    : []
  const conductBlocks: string[][] = [...CONDUCT_FIXED]
  if (has('spawn_agents')) {
    conductBlocks.push([
      '**能并行的独立活派给子代理。** 有多个互不依赖的子任务（同时审几个文件、分别查几条线索）时，',
      '   用 spawn_agents 一次派出去并行跑，比一件件做快得多。',
      '   但子代理看不到你们的对话，任务书必须自包含；有先后依赖的活别派。'
    ])
  }
  conductBlocks.push(
    has('run_command')
      ? [
          '**耗时的活转后台 —— 但"输出多"不等于"耗时长"。** 构建、起服务、下载这类真要跑几十秒以上的，',
          '   用 run_command 的 background=true 转后台，再用 check_command 查进度（前台只有 30 秒，硬等必然超时）。',
          '   反过来：**打印一大堆内容的命令（cat/tail 大文件、跑本地脚本刷日志）是毫秒级的** —— 直接前台跑，',
          '   **不要因为"它输出会很长"就转后台**：那会白多出好几轮（2026-09-13 真机实测：模型把一条毫秒级命令',
          '   转后台后又去 check_command / kill_command，一轮任务多烧了好几倍 token）。'
        ]
      : capabilityGaps.length > 0
        ? [
            '**本轮没有命令执行能力**（工具表里没有 run_command）。需要跑构建、起服务、装依赖时：',
            '   用 spawn_agents 派给 <self_view> 里"缺能力"那行列出的子代理，别自己凭"应该能跑"下结论。'
          ]
        : [
            '**本轮没有命令执行能力**（工具表里没有 run_command，也没有可派发的子代理提供它）。',
            '   涉及"跑一遍才知道"的结论，如实说明**未能验证**，不许凭推测宣称已通过。'
          ]
  )
  const CONDUCT_RULES = ['**做事纪律（必须遵守）**：', ...conductBlocks.map((b, i) => `${i + 1}. ${b.join('\n')}`)].join(
    '\n'
  )

/** 输出纪律（plan8 R9.1 §七③）：土豪 / 极致档**不加**，平衡档加标准三条，轻量档再加篇幅克制。
 *  ⚠️ 它必须落在**稳定位置**（§七④ 前缀稳定）：同档位下这段字节级不变，只有**换档**会失效一次。 */
  const discipline = outputDisciplinePrompt(policy.outputDiscipline)
  // 记忆段接在**安全基线之后**：数据边界必须先于数据出现（护栏 3）。顺序反了等于先上菜、
  // 再说"这是样品别当真"。⚠️ 段本身静态（`composeMemoryBlock` 只依赖记忆集合），前缀缓存才不会被每轮打散。
  const memoryBlock = args.memoryBlock ?? null
  // Playbook 段（plan19 批 3）：接在记忆段**之后**。段本身静态（`composePlaybookBlock` 只依赖
  // Playbook 集合与活跃标签，两者在一轮内都是定值），前缀缓存不会被每轮打散。
  const playbookBlock = args.playbookBlock ?? null
  // 技能段（plan22 D-057）：接在 Playbook 段**之后**。段本身静态（composeSkillBlock 只依赖技能
  // 集合，一轮内是定值），前缀缓存不会被每轮打散。预算截断在 composeSkillBlock 内完成（不静默）。
  const skillBlock = args.skillBlock ?? null
  // 规则段（plan24 D-068）：接在技能段**之后**，**无条件注入**的约束（规则 = 每轮必须看到的约定）。
  const rulesBlock = args.rulesBlock ?? null
  // 自视段（2026-09-15 用户需求）：模型名取**通道真值**（自定义 Agent 用 def.model，与会话缺省同式）；
  // 子代理清单以 spawn_agents 是否下发为准（"有消费者才注册"的反向：没派发口就不报，免得模型空头许诺）。
  // 能力缺口那段已在纪律之前算好（纪律第 6 条要按它选分支，两处必须同源）。
  const selfViewBlock = composeSelfView({
    model: def?.model ?? args.settings.model,
    providerType: args.settings.providerType,
    platform: process.platform,
    toolNames: tools.map((t) => t.schema.name),
    subagentNames: tools.some((t) => t.schema.name === 'spawn_agents')
      ? [...registry.definitions.keys()]
      : [],
    capabilityGaps,
    computerControl: args.computerControl === true
  })
  const guardedSystem = `${systemPrompt}\n\n${selfViewBlock}\n\n${CONDUCT_RULES}\n\n${discipline ? `${discipline}\n\n` : ''}${TOOL_OUTPUT_TRUST_BASELINE}${memoryBlock ? `\n\n${memoryBlock}` : ''}${playbookBlock ? `\n\n${playbookBlock}` : ''}${skillBlock ? `\n\n${skillBlock}` : ''}${rulesBlock ? `\n\n${rulesBlock}` : ''}`

/** 生效的模型设置。`reasoningEffortOverride`（§七③）：**只有轻量档会给值**，其余档 `null` = **不动用户的设置** —— 每个模型档案里配的思考强度是用户自己的判断。
 *  （本项目 DSH 面板实测：输出里约 52% 是推理，故它是输出侧最大杠杆。） */
  const base: ModelSettings = def?.model ? { ...args.settings, model: def.model } : args.settings
  const effective: ModelSettings = policy.reasoningEffortOverride
    ? { ...base, reasoningEffort: policy.reasoningEffortOverride }
    : base
  // 工具 schema 必须下发给模型（否则模型无从知晓可调工具——交叉验证抓出的必修 bug）
  const toolSchemas = tools.map((t) => t.schema)
/** 本轮累计的真实用量（plan8 R9）：一轮里**可能调好几次模型**，每次的 usage 都要加起来 —— 只记最后一次会让账面少一大半；
 *  `null` = 厂商一次都没报（**不是**"用量为 0"，两者必须分得清）。 */
  let usageAcc: TokenUsage | null = null

  const chat = async (messages: AgentMessage[], onText: (delta: string) => void): Promise<AgentChatResult> => {
    // plan29 D-090：**这里原来有一层整轮墙钟**（`args.signal ?? AbortSignal.timeout(settings.timeoutMs)`），
    // 已删除，两条理由：
    // ① 它是**死代码** —— 外层一旦给了 signal（生产必给），`??` 右侧永不执行，看着像兜底其实什么都没做；
    // ② 就算它生效也是错的口径 —— 把"建连慢 / 首包慢 / 断流 / 工具跑得久"压成同一个数字，
    //    于是任何一种慢都报成同一句话。现在由 provider 层的**首包 + 分片间隔**两层守卫负责
    //    （见 providers/stream-guard.ts），它知道自己是哪一层超时，也就能说清是哪一层。
    // `args.signal` 只剩一个语义：**用户点了停止** —— 该立刻停，且不该有第二个数字来抢这个决定权。
    const signal = args.signal
    const res =
      effective.providerType === 'anthropic'
        ? await streamWithToolsAnthropic(effective, args.apiKey, messages, toolSchemas, onText, signal)
        : await streamWithToolsOpenAI(
            effective,
            args.apiKey,
            messages,
            toolSchemas,
            onText,
            signal,
            args.onReasoning
          )
    if (res.usage) usageAcc = addUsage(usageAcc ?? emptyUsage(), res.usage)
    return res
  }

  // ── 滚动摘要（plan26 D-080）：裁剪发生时对被裁段 + 旧摘要调一次模型 ──
  // 空工具表 = 纯对话请求；结果写回缓存（下次裁剪复用，不必重新摘要全史）。
  // ⚠️ 用量计入 usageAcc（D-080）：摘要确实花了钱，账单数字应与厂商对得上 —— 用户能看到的
  //    「本轮用量」里包含它；归因说明见台账。
  const summarize = async (dropped: AgentMessage[]): Promise<string | null> => {
    const prior = args.summaryCache?.get(args.conversationId) ?? null
    const transcript = dropped
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n')
      .slice(0, 8000) // 摘要输入预算（8k 字符 ≈ 2k token 上限；超了截断——摘要宁短勿爆）
    const summarizeMessages: AgentMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${prior ? `【已有摘要】\n${prior}\n\n` : ''}【新增被折叠的对话】\n${transcript}`
      }
    ]
    try {
      const signal = AbortSignal.timeout(30_000) // 摘要不拖主链路：30s 兜底
      const res =
        effective.providerType === 'anthropic'
          ? await streamWithToolsAnthropic(effective, args.apiKey, summarizeMessages, [], () => {}, signal)
          : await streamWithToolsOpenAI(effective, args.apiKey, summarizeMessages, [], () => {}, signal)
      if (res.usage) usageAcc = addUsage(usageAcc ?? emptyUsage(), res.usage)
      const text = (res.text ?? '').trim()
      if (!text) return null
      args.summaryCache?.set(args.conversationId, text)
      return text
    } catch {
      return null // fail-soft 内聚：回调自己兜底；loop 侧还有一层 catch（防注入回调不守约）
    }
  }

  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
      systemPrompt: guardedSystem,
      history: args.history,
      tools,
      maxRounds: args.settings.maxToolRounds || 12,
      contextWindow: args.settings.contextWindow || 65536,
      chat,
      ...(args.onText ? { onText: args.onText } : {}),
      ...(args.onToolEvent ? { onToolEvent: args.onToolEvent } : {}),
      ...(args.onToolWindowed ? { onToolWindowed: args.onToolWindowed } : {}),
      ...(args.toolWindow === undefined ? {} : { toolWindow: args.toolWindow }),
      ...(args.policy ? { policy: args.policy } : {}),
      // plan26 D-077：执行事件流（组合根装配 recorder，不传 = 不记录）
      ...(args.execEvents ? { execEvents: args.execEvents } : {}),
      // plan26 D-080：滚动摘要 —— 只在组合根给了缓存时启用（没缓存 = 机械占位，零退化）
      ...(args.summaryCache ? { summarize } : {})
    })
  } finally {
    // 无论正常结束、抛异常还是被中止都要收尾 —— 否则 manifest 停在 running，界面把完成的轮次显示成"中断"（即便没收尾，快照也已增量落盘、仍可回滚）。
    ctx.checkpoints.finish(runId)
  }

  const changedFiles = ctx.checkpoints.get(runId)?.changes.length ?? 0
  let final: AgentRunResult = { ...result, agent: def?.name ?? '内核默认', runId, changedFiles, usage: usageAcc }
  let planApproved: boolean | undefined

  // ── 计划批准闸（plan27）──────────────────────────────────────────────
  // 位置说明（三条都已核过，别再挪）：
  //  · 只能放这里：**子代理走 scheduler.ts 的 `runAgentLoop`，根本不进本函数** ⇒ 天然不会被卡住等批准；
  //  · 不放 ipc.ts：那是薄层，且它那套整轮墙钟正被 plan29 删掉 —— 依赖它会跟着坏；
  //  · 不做成工具（如 submit_plan）：工具是**模型可选调用**的，模型不调就永远停不下来，
  //    「必须停下来等我点头」这条核心价值会当场失守。
  if (def?.approval === 'plan' && ctx.planApproval && !args.skipPlanApproval) {
    const plan = (result.output ?? '').trim()
    // 空方案不弹卡：对空气等批准是荒谬交互，也免得用户白等一场
    if (plan.length > 0) {
      planApproved = await ctx.planApproval.request(
        { agent: def.name, plan, conversationId: args.conversationId },
        args.signal ? { signal: args.signal } : undefined
      )

      if (planApproved) {
        // 二次 runAgent（D-082）：executor 有自己的 `def.model` / 工具集 / 检查点，全部复用现有 machinery。
        // 为什么**不**在同一轮里把写工具塞回去：planner 的「只读」是靠**没有写工具**保证的硬事实——
        // 中途换工具集等于亲手拆掉这条保证；而且自视段会先报只读后报可写，模型自己都会糊涂。
        // ⚠️ 这条保证现在还需要另一半才闭合：planner 也没有派发口（否则它能借子代理写 —— 见上面 `allowed` 的裁剪）。
        const execResult = await runAgent(ctx, {
          ...args,
          agentName: pickExecutor(def.executor, registry),
          history: [
            ...args.history,
            { role: 'assistant', content: result.output },
            { role: 'user', content: '请按上述方案执行（已获用户批准）。' }
          ],
          // 双保险之一（另一半是 executor 自身不带 approval:plan）：防「批准完又弹一张卡」的无限套娃
          skipPlanApproval: true
        })
        final = {
          ...execResult,
          // 用量**求和**：两轮都花了钱，账单必须与厂商对得上（归并口径见 PLAN/plan27_计划批准.md D-082）。
          // 其余账目（runId / changedFiles / stopReason）以 **executor 那轮**为准 —— planner 无写操作，检查点空转。
          usage: execResult.usage ? addUsage(usageAcc ?? emptyUsage(), execResult.usage) : usageAcc,
          // agent 仍报**用户启用的那个**：他看到的应是「我选的 agent 干了这件事」，而不是「偷偷换了个人」
          agent: def.name
        }
        log.info('计划已批准，转交执行', { 方案来自: def.name, 实际执行: execResult.agent })
      } else {
        log.info('计划未获批准，本轮不执行', { 方案来自: def.name })
      }
    }
  }

  return { ...final, ...(planApproved === undefined ? {} : { planApproved }) }
}

/** 组装运行上下文。工作区用**惰性解析函数**（P2：用户可在界面切换目录，每次运行前重新解析，无需重启）。⚠️ 本模块的 electron 禁令见文件头。 */
export function createAgentContext(opts: {
  getWorkspaceRoot: () => string
  builtinAgentsDir: string
  userAgentsDir: string
  checkpointDir: string
  confirmCommand?: (req: {
    tool: string
    detail: string
    agent: string
    where: string
    conversationId: string
  }) => Promise<boolean>
  background?: BackgroundTaskStore
  /** 记忆库（plan19 批 1）。由组合根注入 —— runner 不许碰 electron-store / fs */
  memory?: {
    repo: MemoryRepo
    /** 记忆开关（批 1）：false = 不下发 remember / recall。每轮读一次 → 改设置即时生效，不用重启 */
    enabled?: () => boolean
    confirm?: (reason: string, conversationId: string) => Promise<boolean>
  }
  /** Playbook 库（plan19 批 3）。由组合根注入 —— runner 不许碰 electron-store / fs */
  playbook?: {
    repo: PlaybookRepo
  }
  /** 技能库（plan22）。由组合根注入（内置 resources/skills + 用户 userData/skills 两层）—— runner 不许碰 fs / electron */
  skills?: {
    store: SkillsStore
  }
  /** MCP 管理器（plan23）。由组合根注入 —— runner 不碰 electron；已连接服务器的工具经此聚合与转发 */
  mcp?: {
    manager: McpManager
  }
  trash?: (abs: string) => Promise<void>
  ask?: AskReporter
  /** 计划批准桥（plan27）。由组合根注入 —— runner 不许 import electron，推窗口只能在那一层做 */
  planApproval?: PlanApprovalBridge
  /** 打包态资源根（找随包的 ripgrep，L0 检索）。由组合根注入 —— runner 不许 import electron */
  resourcesPath?: string | null
  /** plan43 S3：用户选中的开发环境 → PATH 覆盖（组合根提供；每个 agent run 现读） */
  resolveRuntimeEnv?: () => RuntimeEnv
}): AgentRuntimeContext {
  const ctx: AgentRuntimeContext = {
    getWorkspaceRoot: opts.getWorkspaceRoot,
    builtinAgentsDir: opts.builtinAgentsDir,
    userAgentsDir: opts.userAgentsDir,
    checkpoints: createCheckpointStore(opts.checkpointDir),
    ...(opts.confirmCommand ? { confirmCommand: opts.confirmCommand } : {}),
    ...(opts.background ? { background: opts.background } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.playbook ? { playbook: opts.playbook } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    ...(opts.trash ? { trash: opts.trash } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.planApproval ? { planApproval: opts.planApproval } : {}),
    ...(opts.resolveRuntimeEnv ? { resolveRuntimeEnv: opts.resolveRuntimeEnv } : {})
  }
  ensureAgentRuntime(ctx)
  return ctx
}
