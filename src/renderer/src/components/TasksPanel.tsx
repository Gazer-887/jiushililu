import { useEffect } from 'react'
import type { SubagentJobEvent } from '@shared/agent'
import { statusText } from '@shared/background'
import { useAppStore } from '../store'

// 右栏「任务」页签（plan7 批 D，2026-09-12 用户意见：任务管理改为子代理 + 后台任务查看，学 DSH）。
// 两块：① 子代理运行记录（谁在跑、几轮、结果，同一批次内就地更新）② 后台任务（进度、输出、一键终止）。
// 空态要说明"怎么才会有" —— 比一句"暂无数据"有用得多。

/** 一行状态文本：进行中 / 已完成（几轮 · 几秒）/ 失败 */
function jobStatus(j: SubagentJobEvent): string {
  if (j.phase === 'start') return '进行中'
  const secs = j.endedAt ? ((j.endedAt - j.startedAt) / 1000).toFixed(1) : '?'
  if (j.phase === 'error') return `失败 · ${secs}s`
  return `已完成 · ${j.rounds ?? 0} 轮 · ${secs}s`
}

export default function TasksPanel(): JSX.Element {
  const jobs = useAppStore((s) => s.subagents)
  const bgTasks = useAppStore((s) => s.backgroundTasks)

  useEffect(() => {
    // 挂载时各拉一次（记录都在主进程），之后靠推送。plan11：子代理事件**按会话**归属 —— 只拉当前会话那份
    const activeId = useAppStore.getState().activeId
    if (activeId) {
      void window.api
        .getSubagents(activeId)
        .then((l) => useAppStore.getState().setSubagents({ conversationId: activeId, payload: l }))
    }
    void window.api
      .listBackgroundTasks()
      .then((l) => useAppStore.getState().setBackgroundTasks(l))
    const offSub = window.api.onSubagentChanged((e) => useAppStore.getState().setSubagents(e))
    const offBg = window.api.onBackgroundChanged((l) =>
      useAppStore.getState().setBackgroundTasks(l)
    )
    return () => {
      offSub()
      offBg()
    }
  }, [])

  const runningJobs = jobs.filter((j) => j.phase === 'start').length
  const runningBg = bgTasks.filter((t) => t.status === 'running').length

  return (
    <div className="tasks-panel">
      {/* ── 子代理 ── */}
      <div className="tasks-head">
        <span className="tasks-title">子代理</span>
        <span className="tasks-sub">
          {jobs.length === 0
            ? '无'
            : runningJobs > 0
              ? `${runningJobs} 个运行中`
              : `${jobs.length} 个已完成`}
        </span>
      </div>
      {jobs.length > 0 && (
        <div className="tasks-list">
          {jobs.map((j) => (
            <div key={`${j.name}-${j.index}`} className={`task-item task-${j.phase}`}>
              <span className="task-dot" aria-hidden="true" />
              <div className="task-body">
                <div className="task-row">
                  <span className="task-name">{j.name}</span>
                  <span className="task-status">{jobStatus(j)}</span>
                </div>
                <div className="task-task" title={j.task}>
                  {j.task}
                </div>
                {(j.error || j.summary) && <div className="task-result">{j.error ?? j.summary}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 后台任务 ── */}
      <div className="tasks-head tasks-head-gap">
        <span className="tasks-title">后台任务</span>
        <span className="tasks-sub">
          {bgTasks.length === 0 ? '无' : runningBg > 0 ? `${runningBg} 个运行中` : `${bgTasks.length} 个`}
        </span>
      </div>
      {bgTasks.length > 0 && (
        <div className="tasks-list">
          {bgTasks.map((t) => (
            <div key={t.id} className={`task-item task-bg-${t.status}`}>
              <span className="task-dot" aria-hidden="true" />
              <div className="task-body">
                <div className="task-row">
                  <span className="task-name">{t.id}</span>
                  <span className="task-status">{statusText(t)}</span>
                </div>
                <div className="task-cmd" title={t.command}>
                  {t.command}
                </div>
                {t.output && <pre className="task-output">{t.output.slice(-2000)}</pre>}
                {t.truncated && <div className="task-task">（输出过长，只显示末尾）</div>}
                {t.status === 'running' && (
                  <div className="task-actions">
                    <button
                      className="ex-btn"
                      onClick={() => void window.api.killBackgroundTask(t.id)}
                    >
                      终止
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
