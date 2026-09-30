import Store from 'electron-store'
import type { Goal, GoalAction } from '@shared/goal'
import { createGoalRepo, type GoalRepo } from './goal-core'
import { createLogger } from '../log'

// 目标的落盘装配（plan12）：存在 `userData/goals.json`，语义全在 `goal-core.ts`（那儿可单测）。
// 本文件**只装配、不含逻辑**：`new Store()` 单例 + 一个读写接缝 + 五个转发口。
// ⚠️ 别把判断写回这里 —— 写回来就等于把刚拆出来的可测性又放回单测照不到的那一层
//（`tests/unit/architecture.test.ts` 禁止单测链路出现 electron-store）。
//
// 一条目标带 `conversationId` —— **目标是会话的属性**，所以"切回那条会话还看得见它"是自然结果，
// 不用另建索引（plan11 给的会话身份在这儿第二次派上用场）。

interface StoredGoals {
  goals?: unknown
}

const store = new Store<StoredGoals>({ name: 'goals' })
const log = createLogger('goal')

const repo: GoalRepo = createGoalRepo(
  {
    readRaw: () => store.store.goals,
    writeRaw: (goals: Goal[]) => {
      store.set('goals', goals)
    }
  },
  log
)

/** 某条会话的目标（新的在前；调用方可再按状态分组显示） */
export function listGoals(conversationId: string): Goal[] {
  return repo.listGoals(conversationId)
}

/** 建一个目标；`createdBy` 是 `user` 或 Agent 名（内核也能自建） */
export function createGoalFor(input: {
  conversationId: string
  text: string
  createdBy: string
  doneWhen?: string
}): Goal {
  return repo.createGoalFor(input)
}

/** 施加一个动作（暂停/继续/完成/重开/放弃/编辑）；非法转移抛出**人话**理由 */
export function actOnGoal(
  id: string,
  action: GoalAction,
  patch?: { text?: string; doneWhen?: string }
): Goal {
  return repo.actOnGoal(id, action, patch)
}

/** 彻底删掉（与「放弃」不同：放弃留痕，删除不留） */
export function removeGoal(id: string): void {
  repo.removeGoal(id)
}

/** 会话被删时把它的目标一起清掉 */
export function removeGoalsOf(conversationId: string): void {
  repo.removeGoalsOf(conversationId)
}
