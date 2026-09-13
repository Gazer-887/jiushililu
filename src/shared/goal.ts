/**
 * 目标（Goal）—— **跨轮次存活的长期意图**（plan12）：待办是"这一轮干什么"、跑完即清，目标是
 * "要持续达成什么"、跨轮次跨重启存活、只能**显式**标记完成 —— 把目标塞进 todo，会让"这轮干完了"
 * 与"这件事永远不做了"变成同一件事，那正是用户要分开的。每个目标属于**一条会话**（plan11 的会话
 * 身份），于是"切回那条会话还看得见它"是自然结果，不必另建一套索引。
 *
 * 纯逻辑：不 import electron、不碰 IO，状态机与校验都在这儿（落盘见 `main/store/goal.ts`）。
 */

/** 目标状态：三种终态之外就只有"在做"与"暂停" */
export type GoalStatus = 'active' | 'paused' | 'done' | 'dropped'

export interface Goal {
  id: string
  conversationId: string
  /** 一句话说清"要达成什么"（**不写步骤** —— 步骤是待办的事） */
  text: string
  status: GoalStatus
  /** 怎么算做到（可空）：没有判据的"完成"只能凭感觉，最容易变成永不关闭的僵尸 */
  doneWhen?: string
  /** 谁建的：`user` = 用户手写；其它值 = Agent 名（内核可自建） */
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type GoalAction = 'pause' | 'resume' | 'complete' | 'reopen' | 'drop' | 'edit'

/**
 * 合法转移表：只列"从哪能到哪"，不在表里的（如对已完成的目标再 complete）一律拒绝并说明理由 ——
 * 静默接受非法动作会让界面出现"点了没反应"或"状态自己变了"这类最难查的怪象。
 */
const TRANSITIONS: Record<GoalAction, { from: GoalStatus[]; to: GoalStatus }> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  complete: { from: ['active', 'paused'], to: 'done' },
  // 重开：做完的事又开始了（很常见："这条目标其实是阶段性的"）
  reopen: { from: ['done', 'dropped'], to: 'active' },
  drop: { from: ['active', 'paused', 'done'], to: 'dropped' },
  // 改正文不改状态（所以 to 由原状态决定，见 applyGoalAction）
  edit: { from: ['active', 'paused', 'done', 'dropped'], to: 'active' }
}

export type GoalResult = { ok: true; goal: Goal } | { ok: false; reason: string }

/** 目标正文长度上限：它是"一句话意图"，不是任务书 */
export const GOAL_TEXT_MAX = 200

/** 建一个目标：文本必须非空（空白串不算），否则界面上就是一条无意义的空行 */
export function createGoal(input: {
  id: string
  conversationId: string
  text: string
  createdBy: string
  doneWhen?: string
  now: number
}): GoalResult {
  const text = input.text.trim()
  if (text.length === 0) return { ok: false, reason: '目标内容不能为空' }
  if (text.length > GOAL_TEXT_MAX) {
    return { ok: false, reason: `目标过长（最多 ${GOAL_TEXT_MAX} 字，写清要达成什么即可）` }
  }
  if (input.conversationId.trim().length === 0) {
    return { ok: false, reason: '目标必须归属于一条会话' }
  }
  const doneWhen = input.doneWhen?.trim()
  return {
    ok: true,
    goal: {
      id: input.id,
      conversationId: input.conversationId,
      text,
      status: 'active',
      ...(doneWhen ? { doneWhen } : {}),
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now
    }
  }
}

/** 施加动作：非法转移**返回理由**而不是静默忽略 —— 界面据此说人话，而不是让人对着按钮发愣 */
export function applyGoalAction(
  goal: Goal,
  action: GoalAction,
  now: number,
  patch?: { text?: string; doneWhen?: string }
): GoalResult {
  const rule = TRANSITIONS[action]
  if (!rule.from.includes(goal.status)) {
    return {
      ok: false,
      reason:
        action === 'resume'
          ? '该目标当前未处于暂停状态'
          : action === 'pause'
            ? '仅进行中的目标可以暂停'
            : action === 'complete'
              ? '该目标已结束（需先「重开」才能再次完成）'
              : '该目标当前状态不支持此操作'
    }
  }

  if (action === 'edit') {
    const text = (patch?.text ?? goal.text).trim()
    if (text.length === 0) return { ok: false, reason: '目标内容不能置空' }
    if (text.length > GOAL_TEXT_MAX) return { ok: false, reason: `目标过长（最多 ${GOAL_TEXT_MAX} 字）` }
    const doneWhen = (patch?.doneWhen ?? goal.doneWhen ?? '').trim()
    return {
      ok: true,
      goal: {
        ...goal,
        text,
        // 清空判据 = 显式去掉它（用 undefined 覆盖，而不是留个空串）
        ...(doneWhen ? { doneWhen } : { doneWhen: undefined }),
        updatedAt: now
      }
    }
  }

  return { ok: true, goal: { ...goal, status: rule.to, updatedAt: now } }
}

/** 界面默认只关心"还在进行/暂停"的（完成与放弃的进历史） */
export function openGoals(goals: Goal[]): Goal[] {
  return sortGoals(goals.filter((g) => g.status === 'active' || g.status === 'paused'))
}

/**
 * 排序：**进行中 → 暂停 → 其它**，同组内新的在前。存盘保持"创建顺序"（排序是**展示**的事）。
 */
export function sortGoals(goals: Goal[]): Goal[] {
  const rank: Record<GoalStatus, number> = { active: 0, paused: 1, done: 2, dropped: 3 }
  return [...goals].sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt - a.createdAt)
}

/**
 * 读回来时**逐条校验**：坏数据丢掉并计数，**绝不整表崩** —— 这份文件会被手改、被旧版本写、
 * 被中断的写截断，一个坏条目让整份目标消失是"静默丢数据"里最不该发生的一种；
 * 调用方拿到 `dropped` 后要留痕（日志），不许悄悄吞掉。
 */
export function normalizeGoals(raw: unknown): { goals: Goal[]; dropped: number } {
  if (!Array.isArray(raw)) return { goals: [], dropped: Array.isArray(raw) ? 0 : 1 }
  const out: Goal[] = []
  let dropped = 0
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      dropped++
      continue
    }
    const g = item as Record<string, unknown>
    const id = typeof g.id === 'string' ? g.id.trim() : ''
    const conversationId = typeof g.conversationId === 'string' ? g.conversationId.trim() : ''
    const text = typeof g.text === 'string' ? g.text.trim() : ''
    const status = g.status
    const okStatus =
      status === 'active' || status === 'paused' || status === 'done' || status === 'dropped'
    const createdAt = typeof g.createdAt === 'number' && Number.isFinite(g.createdAt) ? g.createdAt : 0
    if (!id || !conversationId || !text || !okStatus || seen.has(id)) {
      dropped++
      continue
    }
    seen.add(id)
    const updatedAt =
      typeof g.updatedAt === 'number' && Number.isFinite(g.updatedAt) ? g.updatedAt : createdAt
    const doneWhen = typeof g.doneWhen === 'string' && g.doneWhen.trim().length > 0 ? g.doneWhen : undefined
    out.push({
      id,
      conversationId,
      text,
      status,
      ...(doneWhen ? { doneWhen } : {}),
      createdBy: typeof g.createdBy === 'string' && g.createdBy ? g.createdBy : 'user',
      createdAt,
      updatedAt
    })
  }
  return { goals: out, dropped }
}
