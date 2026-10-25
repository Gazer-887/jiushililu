import { randomUUID } from 'node:crypto'
import type { AgentTaskStatus } from '@shared/ipc'
import type { RunTerminal } from '@shared/execution-outcome'

export interface AgentTaskRecord extends AgentTaskStatus {
  terminal?: RunTerminal
}

const TERMINAL_STATUSES = new Set<AgentTaskStatus['status']>(['completed', 'failed', 'cancelled'])

function mapTerminalToStatus(terminal: RunTerminal): AgentTaskStatus['status'] {
  if (terminal.state === 'completed') return 'completed'
  if (terminal.state === 'cancelled') return 'cancelled'
  return 'failed'
}

/** 一次性任务的唯一身份与取消源；状态查询不暴露控制器。 */
export function createAgentTaskRegistry() {
  const tasks = new Map<string, AgentTaskRecord & { owner: number; controller: AbortController }>()
  return {
    start(owner: number, task: string, conversationId?: string) {
      if ([...tasks.values()].some((t) => t.owner === owner &&
        (t.status === 'running' || t.status === 'stopping'))) throw new Error('已有 Agent 任务在执行')
      const record: AgentTaskRecord & { owner: number; controller: AbortController } = {
        id: randomUUID(),
        task,
        conversationId,
        owner,
        status: 'running',
        startedAt: Date.now(),
        controller: new AbortController()
      }
      tasks.set(record.id, record)
      // 仅淘汰最早终态，不删除在途任务。
      if (tasks.size > 100) {
        const old = [...tasks.values()].find((t) => !['running', 'stopping'].includes(t.status))
        if (old) tasks.delete(old.id)
      }
      return record
    },
    list(owner: number): AgentTaskRecord[] {
      return [...tasks.values()]
        .filter((t) => t.owner === owner)
        .map((t) => ({
          id: t.id,
          task: t.task,
          conversationId: t.conversationId,
          status: t.status,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          error: t.error,
          output: t.output,
          ...(t.terminal ? { terminal: t.terminal } : {})
        }))
    },
    get(id: string): AgentTaskRecord | undefined {
      const t = tasks.get(id)
      if (!t) return undefined
      return {
        id: t.id,
        task: t.task,
        conversationId: t.conversationId,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        error: t.error,
        output: t.output,
        ...(t.terminal ? { terminal: t.terminal } : {})
      }
    },
    stop(owner: number, id: string): boolean {
      const t = tasks.get(id)
      if (!t || t.owner !== owner || !['running', 'stopping'].includes(t.status)) return false
      t.status = 'stopping'
      t.controller.abort()
      return true
    },
    finish(
      id: string,
      statusOrTerminal: AgentTaskStatus['status'] | RunTerminal,
      error?: string,
      output?: string,
      terminal?: RunTerminal
    ): void {
      const t = tasks.get(id)
      if (!t || TERMINAL_STATUSES.has(t.status)) return

      t.endedAt = Date.now()
      if (error) t.error = error
      if (output) t.output = output.slice(0, 20000)

      const explicitTerminal =
        terminal ??
        (typeof statusOrTerminal === 'object' && statusOrTerminal !== null && 'state' in statusOrTerminal
          ? statusOrTerminal
          : undefined)

      if (explicitTerminal) {
        t.terminal = explicitTerminal
        t.status = mapTerminalToStatus(explicitTerminal)
      } else {
        const raw = statusOrTerminal as string
        if (['denied', 'unknown', 'truncated', 'max-rounds'].includes(raw)) {
          t.status = 'failed'
          t.terminal = { state: raw as RunTerminal['state'] }
        } else {
          t.status = statusOrTerminal as AgentTaskStatus['status']
        }
      }
    },
    abortAll(): void {
      for (const t of tasks.values()) if (t.status === 'running') {
        t.status = 'stopping'; t.controller.abort()
      }
    }
  }
}
