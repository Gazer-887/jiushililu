// 后台任务（plan7 批 D 后半）—— 类型与展示逻辑放 shared：
// 渲染进程要用同一份，且**渲染进程不得 import electron / node:child_process**
// （CI 无二进制会炸），故能共享的部分一律下沉到这里。

export interface BackgroundTask {
  id: string
  command: string
  /** 启动时的工作区（仅用于显示） */
  cwd: string
  /** 谁起的（内核默认 / 子代理名） */
  agent: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed' | 'killed'
  exitCode?: number
  /** 累积输出（stdout + stderr 合流） */
  output: string
  /** 是否因超限被截断过 */
  truncated: boolean
}

/** 一行状态文案（界面与工具共用，别写两份） */
export function statusText(t: BackgroundTask, now: number = Date.now()): string {
  const secs = ((t.endedAt ?? now) - t.startedAt) / 1000
  if (t.status === 'running') return `运行中 · ${Math.round(secs)}s`
  const code = t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ''
  const label = t.status === 'done' ? '已完成' : t.status === 'killed' ? '已终止' : '失败'
  return `${label} · ${secs.toFixed(1)}s${code}`
}
