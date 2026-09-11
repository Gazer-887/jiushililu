import type { AgentChatResult, AgentMessage, AgentStopReason, AgentTool } from '@shared/agent'
import { runAgentLoop } from './loop'
import type { AgentDefinition } from './loader'

// 子代理调度器（plan6 D3/D5）：并发上限 + 单代理预算，独立上下文执行，结果带名字回流。

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
  /** 派发给每个子代理的任务 prompt（子代理看不到主对话，任务书要自包含） */
  task: string
  tools: AgentTool[]
  /** 按定义产出模型通道（生产环境按 def.model 选模型；测试注入 mock） */
  chatFactory: (def: AgentDefinition) => (messages: AgentMessage[]) => Promise<AgentChatResult>
  /** 并发上限（D5，默认 3） */
  maxConcurrency?: number
  /** 单代理轮数预算（默认 12） */
  maxRoundsPerAgent?: number
}

export async function runSubagents(opts: SubagentRunOptions): Promise<SubagentJobResult[]> {
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 3)
  const results: SubagentJobResult[] = new Array(opts.definitions.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next++
      if (index >= opts.definitions.length) return
      const def = opts.definitions[index]!
      try {
        const loop = await runAgentLoop({
          systemPrompt: `你是子代理「${def.name}」。${def.description}\n\n${def.systemPrompt}`,
          history: [{ role: 'user', content: opts.task }],
          tools: opts.tools,
          maxRounds: opts.maxRoundsPerAgent,
          chat: opts.chatFactory(def)
        })
        results[index] = { name: def.name, ok: true, output: loop.output, rounds: loop.rounds, stopReason: loop.stopReason }
      } catch (err) {
        results[index] = {
          name: def.name,
          ok: false,
          output: '',
          rounds: 0,
          stopReason: 'error',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, opts.definitions.length) }, () => worker())
  await Promise.all(workers)
  return results
}
