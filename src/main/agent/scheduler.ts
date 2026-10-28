import type {
  AgentChatResult,
  AgentMessage,
  AgentStopReason,
  AgentTool,
  RunPermissionGuard,
  RunRequestPolicy,
  SubagentJobEvent
} from '@shared/agent'
import type { RunTerminal } from '@shared/execution-outcome'
import type { ProviderExecutionContext } from '@shared/request-policy'
import { runAgentLoop } from './loop'
import { AgentRunFailure, ProviderError, isAbortError } from '../providers/errors'
import { composeAgentPrompt, TOOL_OUTPUT_TRUST_BASELINE } from './loader'
import { composeConductRules } from './conduct-rules'
import type { TokenPolicy } from '@shared/token-tier'
import type { AgentDefinition } from './loader'
import { withAgentScope, type ExecEventRecorder } from './exec-events'

// 子代理调度器（plan6 D3/D5）：并发上限 + 单代理预算，独立上下文执行，结果带名字回流。
// plan7 批 D 追加 onJobEvent：右栏「任务」页签要显示"谁在跑、跑了几轮"，光有最终结果数组不够 ——
// 中间那段时间界面是一片空白，故在开始 / 结束 / 失败三个点各报一次。

export interface SubagentJobResult {
  name: string
  ok: boolean
  output: string
  /** 仅 ok=true 时有意义 */
  rounds: number
  /** error = 调度层失败（未真正执行），与"跑满预算"区分开 */
  stopReason: AgentStopReason | 'error'
  /** 失败原因（调度层错误，如模型通道异常） */
  error?: string
  terminal?: RunTerminal
}

export interface SubagentRunOptions {
  /** 父轮次取消时不再启动下一工具或领取新的子作业。 */
  signal?: AbortSignal
  definitions: AgentDefinition[]
  /** 统一任务书（所有定义共用） */
  task: string
  /** 逐作业任务书（与 definitions 同序）；给了就覆盖该作业的统一任务书 */
  tasks?: string[]
  /**
   * 按定义求该子代理的工具集 —— **不是一个共用数组**：一份共用数组会让 `def.tools` 对子代理
   * 完全不生效（既不收窄也不授予，plan51 F1 修的正是这个）。上限与口径由 runner 侧决定。
   * ⚠️ 每个 **job** 各调一次（同角色并发两个 job 也各调一次）—— 浏览器工具按 job 身份装配，
   * 按 def 缓存会让同角色两个 job 共用一个任务适配器（plan79 修正 C）。
   * 第二个参数是该 job 独立的权限守卫（S3-40C2）；命令/浏览器工具据此在确认等待后重核。
   */
  toolsFor: (def: AgentDefinition, guard?: RunPermissionGuard) => AgentTool[]
  /**
   * 每个子作业**独立**的权限/活性守卫（S3-40C2）：由 runner 按父 run 的冻结起点与权威来源构造。
   * ⚠️ 每 job 调一次，兄弟子 run 的观察状态与已批准资格必须隔离；不许共用一个守卫实例。
   * 不传 = 旧调用方兼容（子循环不做实时权限重核）。
   */
  guardFor?: (def: AgentDefinition) => RunPermissionGuard | undefined
  /**
   * 按定义产出模型通道（生产环境按 def.model 选模型；测试注入 mock）。
   *  ⚠️ 第二个参数是 **scheduler 同一次装配的 jobTools**（修正 C）：schema 与执行工具必须同源，
   *  实现里不许再自己调一次 toolsFor（浏览器工具两次求值 = 两份适配器，schema 与真工具分岔）。
   *  ⚠️ 第三个参数是**本作业唯一的运行上下文**（S3-30T2）：由 `contextFactory` 在作业边界建一次，
   *  供该子任务的全部模型轮复用；`undefined` = 旧请求（无身份/服务档）。
   */
  chatFactory: (
    def: AgentDefinition,
    tools: AgentTool[],
    context?: ProviderExecutionContext
  ) => (messages: AgentMessage[]) => Promise<AgentChatResult>
  /**
   * 每个真实子任务在**运行边界**建一次运行上下文（S3-30T2）。由 runner 注入（它持有版本、
   * 父 run 冻结策略与模型能力快照）；本层只按作业调用，不自己造上下文形状、不读配置。
   * 不传 / 返回 undefined = 旧请求（保持改造前行为）。
   */
  contextFactory?: (def: AgentDefinition) => ProviderExecutionContext | undefined
  /** 并发上限（D5，默认 3） */
  maxConcurrency?: number
  /** 单代理轮数预算（默认 12） */
  maxRoundsPerAgent?: number
  /** 批次 id（不传则自动生成）—— 同一次 spawn 的子代理归到一组 */
  runId?: string
  /** 运行事件（开始 / 结束 / 失败）—— 界面据此显示进度 */
  onJobEvent?: (evt: SubagentJobEvent) => void
  /** 省 token 档位（plan8 R9.1 §七②③）的开关取值；**与主代理同一份**（由 runner 透传） */
  policy?: TokenPolicy
  /**
   * run 级不可变请求策略（S3-20D1）：**只能继承父 run 的快照**，本层不解析、不复制、不改写。
   * ⚠️ 不按子代理自己的模型另算速度档 —— 同一 run 的主循环与全部子代理必须共用父 run 那一个冻结对象。
   */
  requestPolicy?: RunRequestPolicy
  /** 输出纪律提示（§七③）：拼在子代理系统提示末尾；**与主代理同档**（不给就不加） */
  systemSuffix?: string
  /**
   * 执行事件流（plan26 D-077）：**盲审 A P0-2**——scheduler 原本不传 onToolEvent/execEvents，
   * 子代理的工具调用/审批全程不可见。透传主代理的 recorder，本层自动把 agentScope 标成 'sub'
   * （withAgentScope 派生），时间线上子代理活动与主代理可区分。不给 = 不记录。
   */
  execEvents?: ExecEventRecorder
}

/** 事件里任务书与结果摘要的截断长度（界面只显示一行） */
const SUMMARY_MAX = 160

export async function runSubagents(opts: SubagentRunOptions): Promise<SubagentJobResult[]> {
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 3)
  const runId = opts.runId ?? `sub-${Date.now().toString(36)}`
  const results: SubagentJobResult[] = new Array(opts.definitions.length)
  let next = 0
  let cancelled: unknown

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled) throw cancelled
      opts.signal?.throwIfAborted()
      const index = next
      next++
      if (index >= opts.definitions.length) return
      const def = opts.definitions[index]!
      const jobTask = opts.tasks?.[index] ?? opts.task
      const taskBrief = jobTask.slice(0, SUMMARY_MAX)
      const startedAt = Date.now()
      opts.onJobEvent?.({
        runId,
        name: def.name,
        index,
        phase: 'start',
        task: taskBrief,
        startedAt
      })
      try {
        // 权限守卫按 job 建一次：兄弟子 run 的观察状态必须隔离（S3-40C2）。
        const jobGuard = opts.guardFor?.(def)
        // 工具集与纪律**同源同次求值**：纪律要按这份实收工具表取舍，分两次算迟早对不上
        const jobTools = opts.toolsFor(def, jobGuard)
        // S3-30T2：**每个作业建一次**运行上下文（兄弟/父子随机键隔离），该作业所有模型轮共用
        const jobContext = opts.contextFactory?.(def)
        const loop = await runAgentLoop({
          signal: opts.signal,
          ...(jobGuard
            ? {
                canStart: (toolName?: string) => jobGuard.canStart(toolName),
                canCommit: () => jobGuard.canCommit()
              }
            : {}),
          systemPrompt:
            // 拼接走 loader 的纯函数（plan17 D10）：与主循环同式，防两处格式漂移
            composeAgentPrompt(def, 'subagent') +
            // 做事纪律（K6）：按**这个子代理实收的工具表**取舍。整段照搬主代理那份，就会给它
            // 一堆它没有的工具（update_todos / set_goal / spawn_agents…）—— 那正是 0.13.77 真机
            // 实测里"提示词承诺工具表没有的能力"的同一个病，而子代理才是真正交验证报告的那一个。
            // 不传 gaps：子代理拿不到派发口，"派给某某"这条出路对它不成立，会落到"未能验证"分支。
            `\n\n${composeConductRules({ toolNames: jobTools.map((t) => t.schema.name) })}` +
            // 输出纪律（§七③）：与主代理同一份 —— 子代理的输出同样计费，纪律不该只约束一半
            (opts.systemSuffix ? `\n\n${opts.systemSuffix}` : '') +
            // 防注入基线：与主代理**同一条**。子代理读的正是构建日志与命令输出这类外部内容
            `\n\n${TOOL_OUTPUT_TRUST_BASELINE}`,
          history: [{ role: 'user', content: jobTask }],
          tools: jobTools,
          maxRounds: opts.maxRoundsPerAgent,
          chat: opts.chatFactory(def, jobTools, jobContext),
          // 刻意**不传 `contextWindow`** ⇒ 子代理这条路没有历史折叠与滚动摘要
          // （`agent/loop.ts · runAgentLoop` 里 `trimOpts` 缺参即整段不启用）。取舍：子代理历史短、
          // 轮数封顶兜着（`maxRounds` 默认 12），0.75 阈值多半永不触发，补传却要为折叠多花摘要调用。
          // 护栏仍有两道：轮数上限 + 下面那条 `policy`（工具输出窗口化）。触发条件与完整理由见 `PLAN/plan55` §十（K37）。
          // 子代理跟主代理**同一个档位**：否则用户看到的省钱行为跟自己的设置对不上，最难解释
          ...(opts.policy ? { policy: opts.policy } : {}),
          // S3-20D1：请求策略快照**原样透传**（同一个冻结引用）—— 本层不重新解析，也不按 def.model 另算。
          ...(opts.requestPolicy ? { requestPolicy: opts.requestPolicy } : {}),
          // plan26 D-077：子代理执行事件标 'sub'（tool_call/tool_result/run_start/run_end 全覆盖）
          ...(opts.execEvents ? { execEvents: withAgentScope(opts.execEvents, 'sub') } : {})
        })
        const terminal: RunTerminal | undefined =
          loop.terminal ?? (loop.stopReason === 'completed' ? { state: 'completed' } : undefined)
        results[index] = {
          name: def.name,
          ok: true,
          output: loop.output,
          rounds: loop.rounds,
          stopReason: loop.stopReason,
          ...(terminal ? { terminal } : {})
        }
        opts.onJobEvent?.({
          runId,
          name: def.name,
          index,
          phase: 'end',
          task: taskBrief,
          startedAt,
          endedAt: Date.now(),
          rounds: loop.rounds,
          summary: loop.output.slice(0, SUMMARY_MAX),
          ...(terminal ? { terminal } : {})
        })
      } catch (err) {
        if (opts.signal?.aborted || isAbortError(err)) {
          cancelled = err
          const cancelTerminal: RunTerminal = { state: 'cancelled', code: 'user-stop' }
          opts.onJobEvent?.({
            runId,
            name: def.name,
            index,
            phase: 'error',
            task: taskBrief,
            startedAt,
            endedAt: Date.now(),
            error: '已停止执行',
            terminal: cancelTerminal
          })
          throw err
        }
        let terminal: RunTerminal | undefined
        if (err instanceof AgentRunFailure && err.facts?.terminal) {
          terminal = err.facts.terminal
        } else if (err instanceof ProviderError && err.facts?.terminal) {
          terminal = err.facts.terminal
        }
        const message = err instanceof Error ? err.message : String(err)
        results[index] = {
          name: def.name,
          ok: false,
          output: '',
          rounds: 0,
          stopReason: 'error',
          error: message,
          ...(terminal ? { terminal } : {})
        }
        opts.onJobEvent?.({
          runId,
          name: def.name,
          index,
          phase: 'error',
          task: taskBrief,
          startedAt,
          endedAt: Date.now(),
          error: message.slice(0, SUMMARY_MAX),
          ...(terminal ? { terminal } : {})
        })
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, opts.definitions.length) }, () =>
    worker()
  )
  // 等已在途作业收尾，不让父轮次提前drain而子作业仍在写记忆。
  const settled = await Promise.allSettled(workers)
  const rejected = settled.find((result) => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  return results
}
