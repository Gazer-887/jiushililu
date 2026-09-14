import type { AgentTool } from '@shared/agent'
import { GOAL_TEXT_MAX, type Goal } from '@shared/goal'

// 目标工具（plan12 ⑤）：Agent 也能自建「跨轮次存活的长期意图」——待办是这一轮的过程，
// 目标是持续到显式完成/放弃为止的意图（两者的界线见 plan12 §一，写死在那儿免得以后又混）。
//
// 依赖倒置（同 TodoReporter / AskReporter / SubagentDispatcher）：工具层不碰 electron-store 与 IPC ——
// `setGoal` 由组合根（ipc.ts）注入，那里才有 conversationId 与 Agent 身份；
// **署名（createdBy）不归工具层管**，注入方创建时补，工具只管"说什么、校什么"。

export interface GoalCreator {
  setGoal(input: { text: string; doneWhen?: string }): Goal
}

export function createGoalTools(deps: GoalCreator): AgentTool[] {
  const set_goal: AgentTool = {
    schema: {
      name: 'set_goal',
      description:
        '登记一条跨轮次存活的长期意图（界面上持续可见，重启后仍在，用户可暂停/完成/放弃它）。' +
        '与 update_todos 的分工：待办记"这一轮做什么"，目标记"要持续达成什么"。' +
        '用户交代了长期意图（如"以后每次都要…""这个项目最终要…"）时用它登记；' +
        '一轮就能做完的事用 update_todos，不要建成目标。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '目标本身（一句话说清要达成什么）' },
          doneWhen: {
            type: 'string',
            description: '完成判据：怎么算做到了（强烈建议给，防止目标变成永不关闭的僵尸）'
          }
        },
        required: ['text']
      }
    },
    async execute(args) {
      const text = typeof args['text'] === 'string' ? args['text'].trim() : ''
      if (text.length === 0) return '错误：text 不能为空'
      // 上限在这里拦（带人话理由、不惊动 store）—— 与 shared/goal.ts 的 createGoal 同一口径
      if (text.length > GOAL_TEXT_MAX) {
        return `错误：目标过长（最多 ${GOAL_TEXT_MAX} 字，写清要达成什么即可）`
      }
      const doneWhen = typeof args['doneWhen'] === 'string' && args['doneWhen'].trim() ? args['doneWhen'].trim() : undefined
      const goal = deps.setGoal({ text, ...(doneWhen ? { doneWhen } : {}) })
      const tail = goal.doneWhen ? `完成判据：${goal.doneWhen}。` : ''
      return `已登记目标「${goal.text}」。${tail}用户可在目标面板随时暂停/完成它。`
    }
  }

  return [set_goal]
}
