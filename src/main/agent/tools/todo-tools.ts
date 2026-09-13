import type { AgentTool } from '@shared/agent'
import { normalizeTodos, todoStats, type TodoItem } from '@shared/todo'

// 待办清单工具（plan7 批 D 提前落地）。界面在输入框上方显示这份清单，
// 让"Agent 干到哪一步了"这件事**可见**，而不是只看得到零散的工具调用。

/** 汇报口（依赖倒置，同 WriteRecorder / browser-bridge）：工具层只管"清单变了"，消费者（IPC 推送 / 单测）它不关心 */
export interface TodoReporter {
  update(todos: TodoItem[]): void
}

export function createTodoTools(reporter: TodoReporter): AgentTool[] {
  const update_todos: AgentTool = {
    schema: {
      name: 'update_todos',
      description:
        '维护本次任务的待办清单（用户能在界面上看到进度）。多步任务开工前先列清单，' +
        '之后每完成一步就更新一次。每次都要传**完整清单**，不是增量；' +
        '同一时刻最多一条 in_progress。任务全部完成后把最后一条也置为 completed。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整待办清单（按执行顺序排列）',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '这一步要做什么（短句，别写成小作文）' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'pending 待处理 / in_progress 进行中 / completed 已完成'
                }
              },
              required: ['text', 'status']
            }
          }
        },
        required: ['todos']
      }
    },
    async execute(args) {
      const todos = normalizeTodos(args['todos'])
      if (todos.length === 0) return '错误：todos 不能为空，且每一项都必须有 text 字段'
      reporter.update(todos)
      const s = todoStats(todos)
      return `已更新待办清单：共 ${s.total} 项（已完成 ${s.completed}，进行中 ${s.inProgress}，待处理 ${s.pending}）`
    }
  }

  return [update_todos]
}
