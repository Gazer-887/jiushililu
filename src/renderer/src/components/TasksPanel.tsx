import { useEffect } from 'react'
import type { SubagentJobEvent } from '@shared/agent'
import { useAppStore } from '../store'

// 右栏「任务」页签（plan7 批 D —— 2026-09-12 用户意见：
// 「任务管理可以改为子代理和后台任务查看，也是跟 DSH 学的」）。
//
// 显示**当前这批**子代理在干什么：谁在跑、跑完没有、跑了几轮、结果如何。
// 数据是主进程累积的运行事件（start 先落一条，end/error 到了覆盖它）。
//
// 空态说明"怎么才会有" —— 比一句"暂无数据"有用得多。

/** 一行状态：进行中 / 已完成（几轮 · 几秒）/ 失败 */
function statusText(j: SubagentJobEvent): string {
  if (j.phase === 'start') return '进行中'
  const secs = j.endedAt ? ((j.endedAt - j.startedAt) / 1000).toFixed(1) : '?'
  if (j.phase === 'error') return `失败 · ${secs}s`
  return `已完成 · ${j.rounds ?? 0} 轮 · ${secs}s`
}

export default function TasksPanel(): JSX.Element {
  const list = useAppStore((s) => s.subagents)

  useEffect(() => {
    // 挂载时拉一次（记录在主进程），之后靠推送
    void window.api.getSubagents().then((l) => useAppStore.getState().setSubagents(l))
    return window.api.onSubagentChanged((l) => useAppStore.getState().setSubagents(l))
  }, [])

  const running = list.filter((j) => j.phase === 'start').length

  if (list.length === 0) {
    return (
      <div className="tasks-panel">
        <div className="tasks-empty">
          当前没有子代理在跑。
          <br />
          主代理遇到可以并行的独立子任务时（比如同时审几个文件、分别查几条线索），
          会用 spawn_agents 派出去 —— 那时这里会显示谁在跑、跑了几轮、结果如何。
        </div>
      </div>
    )
  }

  return (
    <div className="tasks-panel">
      <div className="tasks-head">
        <span className="tasks-title">子代理</span>
        <span className="tasks-sub">
          {running > 0 ? `${running} 个在跑` : `${list.length} 个已完成`}
        </span>
      </div>
      <div className="tasks-list">
        {list.map((j) => (
          <div key={`${j.name}-${j.index}`} className={`task-item task-${j.phase}`}>
            <span className="task-dot" aria-hidden="true" />
            <div className="task-body">
              <div className="task-row">
                <span className="task-name">{j.name}</span>
                <span className="task-status">{statusText(j)}</span>
              </div>
              <div className="task-task" title={j.task}>
                {j.task}
              </div>
              {(j.error || j.summary) && (
                <div className="task-result">{j.error ?? j.summary}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
