import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { statsLine, todoStats, type TodoStatus } from '@shared/todo'

// 待办清单面板（plan7 批 D）：输入框**上方的独立卡片**，可折叠、标题右侧一句统计（形态对齐 DSH）。
// 清单为空时整个面板不渲染 —— 没有活在建的时候，界面不该多占一块地方。

const MARK: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○'
}

export default function TodoPanel(): JSX.Element | null {
  const todos = useAppStore((s) => s.todos)
  // 与目标的联动（plan12 ⑥·最小）：挂着进行中的目标时，面板顶部显示"服务于哪条"——
  // 待办是过程、目标是意图，这行字把两者的从属关系摆在明面上（多条时取排序后的第一条 + 计数）
  const serving = useAppStore((s) => s.goals).filter((g) => g.status === 'active' || g.status === 'paused')
  const servingFirst = serving[0]
  const [collapsed, setCollapsed] = useState(false)

  // 重启后拉回上一轮的待办（门禁红灯挖出的静默缺陷）：todos 的存档在主进程，但此前只有两条到路 ——
  // Agent 推送（update_todos → todo:changed）、App 挂载时的一次性 pull（彼时 activeId 多半还没就绪，
  // pull 空跑且没人补拉）⇒ 重启后待办面板一直空白。照 GoalPanel 的写法：挂载 / 切会话时拉一次，
  // 落点仍走 store 的按会话分流（setTodos 带 conversationId，不会串台）。
  const activeId = useAppStore((s) => s.activeId)
  useEffect(() => {
    if (!activeId) return
    let alive = true
    void window.api.getTodos(activeId).then((list) => {
      if (alive) useAppStore.getState().setTodos({ conversationId: activeId, payload: list })
    })
    return () => {
      alive = false
    }
  }, [activeId])

  if (todos.length === 0) return null
  const stats = todoStats(todos)

  return (
    <div className="todo-panel">
      <button
        className="todo-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="todo-title">任务</span>
        <span className="todo-stats">{statsLine(stats)}</span>
        <span className="todo-caret" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>

      {!collapsed && servingFirst && (
        <div
          className="todo-goal"
          title={
            serving.length > 1
              ? `本轮待办服务于进行中的目标（共 ${serving.length} 条）：${servingFirst.text}`
              : `本轮待办服务于这条目标：${servingFirst.text}`
          }
        >
          <span className="todo-goal-tag">目标</span>
          <span className="todo-goal-text">{servingFirst.text}</span>
          {serving.length > 1 && <span className="todo-goal-more">等 {serving.length} 条</span>}
        </div>
      )}

      {!collapsed && (
        <div className="todo-list">
          {todos.map((t) => (
            <div key={t.id} className={`todo-item todo-${t.status}`}>
              <span className="todo-mark" aria-hidden="true">
                {MARK[t.status]}
              </span>
              <span className="todo-text">{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
