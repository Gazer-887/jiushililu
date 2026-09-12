import Store from 'electron-store'
import {
  applyGoalAction,
  createGoal,
  normalizeGoals,
  sortGoals,
  type Goal,
  type GoalAction
} from '@shared/goal'
import { createLogger } from '../log'

// 目标的落盘（plan12）。
//
// 存在 `userData/goals.json`，一条目标带 `conversationId` —— **目标是会话的属性**，
// 所以"切回那条会话还看得见它"是自然结果，不用另建索引（plan11 给的会话身份在这儿第二次派上用场）。
//
// 两条纪律：
//   ① **读盘逐条校验**：坏条目丢掉并计数 + 留痕，绝不整表崩（`@shared/goal` 的 normalizeGoals）
//   ② **非法状态转移带着理由被拒**，而不是静默不动 —— 界面据此说人话

interface StoredGoals {
  goals?: unknown
}

const store = new Store<StoredGoals>({ name: 'goals' })
const log = createLogger('goal')

function readAll(): Goal[] {
  const { goals, dropped } = normalizeGoals(store.store.goals)
  if (dropped > 0) {
    log.warn('目标文件里有读不懂的条目，已跳过', { dropped, kept: goals.length })
    store.set('goals', goals) // 写回可读的那部分，否则每次读都重复告警
  }
  return goals
}

function writeAll(goals: Goal[]): void {
  store.set('goals', goals)
}

/** 某条会话的目标（新的在前；调用方可再按状态分组显示） */
export function listGoals(conversationId: string): Goal[] {
  return sortGoals(readAll().filter((g) => g.conversationId === conversationId))
}

/**
 * 建一个目标。`createdBy` 是 `user` 或 Agent 名 —— **内核也能自建目标**（这是计划里的要求：
 * "这件事我打算持续做"不该只有用户能说）。
 */
export function createGoalFor(input: {
  conversationId: string
  text: string
  createdBy: string
  doneWhen?: string
}): Goal {
  const now = Date.now()
  const id = `g-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const result = createGoal({
    id,
    conversationId: input.conversationId,
    text: input.text,
    createdBy: input.createdBy,
    ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}),
    now
  })
  if (!result.ok) throw new Error(result.reason)
  writeAll([...readAll(), result.goal])
  log.info('新建目标', { id, conversationId: input.conversationId, by: input.createdBy })
  return result.goal
}

/** 施加一个动作（暂停/继续/完成/重开/放弃/编辑）；非法转移抛出**人话**理由 */
export function actOnGoal(
  id: string,
  action: GoalAction,
  patch?: { text?: string; doneWhen?: string }
): Goal {
  const all = readAll()
  const target = all.find((g) => g.id === id)
  if (!target) throw new Error('这条目标不存在（可能已经被删过了）')
  const result = applyGoalAction(target, action, Date.now(), patch)
  if (!result.ok) throw new Error(result.reason)
  writeAll(all.map((g) => (g.id === id ? result.goal : g)))
  return result.goal
}

/** 彻底删掉（与「放弃」不同：放弃留痕，删除不留） */
export function removeGoal(id: string): void {
  const all = readAll()
  writeAll(all.filter((g) => g.id !== id))
}

/** 会话被删时把它的目标一起清掉 —— 留着就是一堆再也打不开的孤儿 */
export function removeGoalsOf(conversationId: string): void {
  const all = readAll()
  const next = all.filter((g) => g.conversationId !== conversationId)
  if (next.length !== all.length) {
    writeAll(next)
    log.info('会话已删，连带清掉它的目标', { conversationId, removed: all.length - next.length })
  }
}
