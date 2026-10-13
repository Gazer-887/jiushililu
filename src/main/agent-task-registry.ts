import { randomUUID } from 'node:crypto'
import type { AgentTaskStatus } from '@shared/ipc'

/** 一次性任务的唯一身份与取消源；状态查询不暴露控制器。 */
export function createAgentTaskRegistry() {
  const tasks = new Map<string, AgentTaskStatus & { owner: number; controller: AbortController }>()
  return {
    start(owner: number, task: string, conversationId?: string) {
      if ([...tasks.values()].some((t) => t.owner === owner &&
        (t.status === 'running' || t.status === 'stopping'))) throw new Error('已有 Agent 任务在执行')
      const record = { id: randomUUID(), task, conversationId, owner,
        status: 'running' as AgentTaskStatus['status'], startedAt: Date.now(), controller: new AbortController() }
      tasks.set(record.id, record)
      // 仅淘汰最早终态，不删除在途任务。
      if (tasks.size > 100) {
        const old = [...tasks.values()].find((t) => !['running', 'stopping'].includes(t.status))
        if (old) tasks.delete(old.id)
      }
      return record
    },
    list(owner: number): AgentTaskStatus[] {
      return [...tasks.values()].filter((t) => t.owner === owner)
        .map(({ owner: _owner, controller: _controller, ...t }) => t)
    },
    stop(owner: number, id: string): boolean {
      const t = tasks.get(id)
      if (!t || t.owner !== owner || !['running', 'stopping'].includes(t.status)) return false
      t.status = 'stopping'
      t.controller.abort()
      return true
    },
    finish(id: string, status: AgentTaskStatus['status'], error?: string, output?: string): void {
      const t = tasks.get(id)
      if (t) {
        t.status = status; t.endedAt = Date.now()
        if (error) t.error = error
        if (output) t.output = output.slice(0, 20000)
      }
    },
    abortAll(): void {
      for (const t of tasks.values()) if (t.status === 'running') {
        t.status = 'stopping'; t.controller.abort()
      }
    }
  }
}
