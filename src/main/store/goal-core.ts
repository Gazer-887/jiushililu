import {
  applyGoalAction,
  createGoal,
  normalizeGoals,
  sortGoals,
  type Goal,
  type GoalAction
} from '@shared/goal'

// 目标存储的**纯逻辑**（不依赖 electron / electron-store，便于单测）。形状照 `store/conversations-core.ts`：
// 「读一份、写一份」抽成 `GoalBackend` 接缝，语义留在这儿可单测，electron-store 的装配只留在薄壳 `goal.ts`。
//
// 为什么要抽（plan12 §三 步 1 的出口判据「写→读回一致」原先测不到）：架构守卫
// `tests/unit/architecture.test.ts` 禁止单测 import 图里出现 electron / electron-store，
// 而原来五个入口直接挂在模块级 `new Store()` 上 ⇒ 整段落盘语义在单测层是黑的。
// ⚠️ 语义**零变化**是这次重构的底线：坏条目丢弃+计数+留痕+回写、非法转移抛人话理由，一条都不许改味。

/** 存/取的**唯一**接缝 —— 与 `ConversationsBackend` 同一思路，只是目标整表小，一次读全表 */
export interface GoalBackend {
  /** 读原始落盘值（未经校验）—— 校验与计数是 core 的事，不是 backend 的事 */
  readRaw(): unknown
  writeRaw(goals: Goal[]): void
}

/** 留痕出口（生产传 `createLogger('goal')`；测试传收集数组，好断言「坏数据有留痕」） */
export interface GoalLog {
  warn(msg: string, meta: Record<string, unknown>): void
  info(msg: string, meta: Record<string, unknown>): void
}

export interface GoalRepo {
  listGoals(conversationId: string): Goal[]
  createGoalFor(input: {
    conversationId: string
    text: string
    createdBy: string
    doneWhen?: string
  }): Goal
  actOnGoal(id: string, action: GoalAction, patch?: { text?: string; doneWhen?: string }): Goal
  removeGoal(id: string): void
  removeGoalsOf(conversationId: string): void
}

/** 目标 id：`g-<毫秒时间戳 base36>-<4 位随机>` —— 同一毫秒连建也要撞不上（随机段负责这件事） */
function newId(now: number): string {
  return `g-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function createGoalRepo(backend: GoalBackend, log: GoalLog): GoalRepo {
  function readAll(): Goal[] {
    const { goals, dropped } = normalizeGoals(backend.readRaw())
    if (dropped > 0) {
      log.warn('目标文件里有读不懂的条目，已跳过', { dropped, kept: goals.length })
      // 写回可读的那部分，否则每次读都重复告警（原行为，不许省）
      backend.writeRaw(goals)
    }
    return goals
  }

  function writeAll(goals: Goal[]): void {
    backend.writeRaw(goals)
  }

  return {
    /** 某条会话的目标（新的在前；调用方可再按状态分组显示） */
    listGoals(conversationId: string): Goal[] {
      return sortGoals(readAll().filter((g) => g.conversationId === conversationId))
    },

    /**
     * 建一个目标。`createdBy` 是 `user` 或 Agent 名 —— **内核也能自建目标**（计划里的要求：
     * "这件事我打算持续做"不该只有用户能说）。
     */
    createGoalFor(input: {
      conversationId: string
      text: string
      createdBy: string
      doneWhen?: string
    }): Goal {
      const now = Date.now()
      const id = newId(now)
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
    },

    /** 施加一个动作（暂停/继续/完成/重开/放弃/编辑）；非法转移抛出**人话**理由 */
    actOnGoal(
      id: string,
      action: GoalAction,
      patch?: { text?: string; doneWhen?: string }
    ): Goal {
      const all = readAll()
      const target = all.find((g) => g.id === id)
      if (!target) throw new Error('该目标不存在（可能已被删除）')
      const result = applyGoalAction(target, action, Date.now(), patch)
      if (!result.ok) throw new Error(result.reason)
      writeAll(all.map((g) => (g.id === id ? result.goal : g)))
      return result.goal
    },

    /** 彻底删掉（与「放弃」不同：放弃留痕，删除不留） */
    removeGoal(id: string): void {
      const all = readAll()
      writeAll(all.filter((g) => g.id !== id))
    },

    /** 会话被删时把它的目标一起清掉 —— 留着就是一堆再也打不开的孤儿 */
    removeGoalsOf(conversationId: string): void {
      const all = readAll()
      const next = all.filter((g) => g.conversationId !== conversationId)
      if (next.length !== all.length) {
        writeAll(next)
        log.info('会话已删，连带清掉它的目标', { conversationId, removed: all.length - next.length })
      }
    }
  }
}
