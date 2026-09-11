import type {
  AgentChatResult,
  AgentMessage,
  AgentStopReason,
  AgentTool,
  SubagentJobEvent
} from '@shared/agent'
import { runAgentLoop } from './loop'
import type { AgentDefinition } from './loader'

// 子代理调度器（plan6 D3/D5）：并发上限 + 单代理预算，独立上下文执行，结果带名字回流。
//
// plan7 批 D 追加：**运行事件**（onJobEvent）。
// 起因：右栏「任务」页签要显示"谁在跑、跑了几轮、结果如何"，
// 而光有最终的结果数组不够 —— 中间那段时间界面是一片空白。
// 故在开始/结束/失败三个点各报一次，让"进行中"这件事在界面上成立。

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
}

export interface SubagentRunOptions {
  definitions: AgentDefinition[]
  /** 统一任务书（所有定义共用） */
  task: string
  /** 逐作业任务书（与 definitions 同序）；给了就覆盖该作业的统一任务书 */
  tasks?: string[]
  tools: AgentTool[]
  /** 按定义产出模型通道（生产环境按 def.model 选模型；测试注入 mock） */
  chatFactory: (def: AgentDefinition) => (messages: AgentMessage[]) => Promise<AgentChatResult>
  /** 并发上限（D5，默认 3） */
  maxConcurrency?: number
  /** 单代理轮数预算（默认 12） */
  maxRoundsPerAgent?: number
  /** 批次 id（不传则自动生成）—— 同一次 spawn 的子代理归到一组 */
  runId?: string
  /** 运行事件（开始 / 结束 / 失败）—— 界面据此显示进度 */
  onJobEvent?: (evt: SubagentJobEvent) => void
}

/** 事件里任务书与结果摘要的截断长度（界面只显示一行） */
const SUMMARY_MAX = 160

export async function runSubagents(opts: SubagentRunOptions): Promise<SubagentJobResult[]> {
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 3)
  const runId = opts.runId ?? `sub-${Date.now().toString(36)}`
  const results: SubagentJobResult[] = new Array(opts.definitions.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
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
        const loop = await runAgentLoop({
          systemPrompt: `你是子代理「${def.name}」。${def.description}\n\n${def.systemPrompt}`,
          history: [{ role: 'user', content: jobTask }],
          tools: opts.tools,
          maxRounds: opts.maxRoundsPerAgent,
          chat: opts.chatFactory(def)
        })
        results[index] = {
          name: def.name,
          ok: true,
          output: loop.output,
          rounds: loop.rounds,
          stopReason: loop.stopReason
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
          summary: loop.output.slice(0, SUMMARY_MAX)
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results[index] = {
          name: def.name,
          ok: false,
          output: '',
          rounds: 0,
          stopReason: 'error',
          error: message
        }
        opts.onJobEvent?.({
          runId,
          name: def.name,
          index,
          phase: 'error',
          task: taskBrief,
          startedAt,
          endedAt: Date.now(),
          error: message.slice(0, SUMMARY_MAX)
        })
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, opts.definitions.length) }, () =>
    worker()
  )
  await Promise.all(workers)
  return results
}
