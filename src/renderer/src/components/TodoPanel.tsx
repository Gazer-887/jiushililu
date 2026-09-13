import { useState } from 'react'
import { useAppStore } from '../store'
import { statsLine, todoStats, type TodoStatus } from '@shared/todo'

// 待办清单面板（plan7 批 D）：输入框**上方**的独立卡片，可折叠、标题右侧一句统计（形态对齐 DSH）。
// 清单为空时整个面板不渲染 —— 没有活在建的时候，界面不该多占一块地方。

const MARK: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○'
}

export default function TodoPanel(): JSX.Element | null {
  const todos = useAppStore((s) => s.todos)
  const [collapsed, setCollapsed] = useState(false)

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
