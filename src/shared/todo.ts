// 待办清单（plan7 批 D「任务管理」）—— 类型 + 归一化 + 统计，纯逻辑。
// **必须放 shared**：渲染进程不得 import electron（CI 无二进制会炸），可单测的逻辑一律不进 main。

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** 稳定 id：用于 React key 与状态比较 */
  id: string
  text: string
  status: TodoStatus
}

export interface TodoStats {
  total: number
  completed: number
  inProgress: number
  pending: number
}

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

/** 清单长度上限：模型可能一口气吐几百条，界面放不下也没意义 */
export const MAX_TODOS = 50

/** 防超长文本撑破面板 */
const MAX_TEXT = 200

/**
 * 归一化模型入参 —— 模型给什么都可能：非数组、缺 text、超长文本、多余字段。
 * 宁可丢字段，也不能让脏数据流进界面（与 `sanitizeTheme` 同一条思路）。
 */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  raw.slice(0, MAX_TODOS).forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return
    const rec = entry as Record<string, unknown>
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : ''
    if (!text) return
    // 状态不认识就按"待处理"——比丢掉这一条更合理（内容还在，只是状态未知）
    const rawStatus = rec['status']
    const status: TodoStatus = TODO_STATUSES.includes(rawStatus as TodoStatus)
      ? (rawStatus as TodoStatus)
      : 'pending'
    const id = typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : `t${i + 1}`
    out.push({ id, text: text.slice(0, MAX_TEXT), status })
  })
  return out
}

export function todoStats(todos: TodoItem[]): TodoStats {
  let completed = 0
  let inProgress = 0
  let pending = 0
  for (const t of todos) {
    if (t.status === 'completed') completed++
    else if (t.status === 'in_progress') inProgress++
    else pending++
  }
  return { total: todos.length, completed, inProgress, pending }
}

/** 标题右侧的一句话统计（DSH 形态） */
export function statsLine(s: TodoStats): string {
  return `${s.completed} 已完成 · ${s.inProgress} 进行中 · ${s.pending} 待处理`
}
