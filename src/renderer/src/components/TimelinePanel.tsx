// 时间线面板（plan26 S2 · D-078）：执行事件流的回放视图 —— 右抽屉第 9 个页签。
//
// 数据源：主进程读 `<userData>/exec-events.jsonl`（`exec-events:list` IPC，倒序）。
// 形态（C 级最小）：按会话过滤的事件列表（kind 标签分色 + 相对时间 + 一行摘要）；
// **不做**时间轴拖拽、逐字回放、搜索 —— 正文回看走既有工具卡片与对话流（事件只有元数据）。
//
// ⚠️ 「回放」的粒度就是事件粒度：工具调用有名字/耗时/大小但没有入参正文，这是 D-077 的
// 隐私取舍（入参可能是文件正文）。想逐字回看工具输出请用对话流里的工具卡片。

import { useCallback, useEffect, useState } from 'react'
import { EXEC_EVENT_LABELS, type ExecEvent, type ExecEventKind } from '@shared/exec-events'
import { useAppStore } from '../store'

/** 相对时间（列表里不放大段 ISO 串；超过一天给绝对日期） */
function relTime(at: string): string {
  const t = Date.parse(at)
  if (Number.isNaN(t)) return at
  const diff = Date.now() - t
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 一行摘要：事件的核心事实（结构化拼装，不渲染任何正文） */
function summarize(e: ExecEvent): string {
  switch (e.kind) {
    case 'run_start':
      return typeof e.agentName === 'string' && e.agentName ? `开始（${e.agentName}）` : '开始'
    case 'tool_call':
      return `调用 ${String(e.tool ?? '?')}`
    case 'tool_result': {
      const ok = e.ok === false ? '失败' : '完成'
      const ms = typeof e.ms === 'number' ? ` · ${Math.round(e.ms)}ms` : ''
      const bytes = fmtBytes(e.bytes)
      const win = e.windowed === true ? ' · 已压缩' : ''
      return `${String(e.tool ?? '?')} ${ok}${ms}${bytes ? ` · ${bytes}` : ''}${win}`
    }
    case 'approve': {
      const verdict = e.allowed === true ? '允许' : '拒绝'
      const reason = typeof e.reason === 'string' && e.reason !== 'user' ? `（${e.reason}）` : ''
      return `审批 ${String(e.tool ?? '?')}：${verdict}${reason}`
    }
    case 'trim': {
      const cnt = typeof e.droppedCount === 'number' ? `${e.droppedCount} 条` : '?'
      const bytes = fmtBytes(e.bytes)
      const sum = e.summarized === true ? ' · 已摘要' : ''
      return `裁剪 ${cnt}${bytes ? ` / ${bytes}` : ''}${sum}`
    }
    case 'run_end': {
      const reason = typeof e.stopReason === 'string' ? e.stopReason : '中断'
      const rounds = typeof e.rounds === 'number' ? ` · ${e.rounds} 轮` : ''
      const ms = typeof e.durationMs === 'number' ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : ''
      return `结束：${reason}${rounds}${ms}`
    }
  }
}

export default function TimelinePanel(): JSX.Element {
  const activeId = useAppStore((s) => s.activeId)
  const [events, setEvents] = useState<ExecEvent[]>([])
  const [skipped, setSkipped] = useState(0)
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const query = scope === 'current' && activeId ? { conversationId: activeId } : {}
      const res = await window.api.listExecEvents(query)
      setEvents(res.events)
      setSkipped(res.skipped)
    } finally {
      setLoading(false)
    }
  }, [scope, activeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="tl-root">
      <div className="tl-bar">
        <button
          type="button"
          className={`tl-scope ${scope === 'current' ? 'tl-scope-on' : ''}`}
          onClick={() => setScope('current')}
        >
          本会话
        </button>
        <button
          type="button"
          className={`tl-scope ${scope === 'all' ? 'tl-scope-on' : ''}`}
          onClick={() => setScope('all')}
        >
          全部
        </button>
        <span className="tl-count">
          {loading ? '读取中…' : `${events.length} 条`}
          {skipped > 0 ? `（跳过坏行 ${skipped}）` : ''}
        </span>
        <button type="button" className="tl-refresh" onClick={() => void refresh()} title="重新读取">
          刷新
        </button>
      </div>

      {events.length === 0 ? (
        <div className="tl-empty">
          {scope === 'current' ? '本会话还没有执行事件' : '还没有执行事件'}
          <div className="tl-empty-hint">对话跑一轮之后，工具调用 / 审批 / 裁剪会出现在这里</div>
        </div>
      ) : (
        <ul className="tl-list">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`tl-item tl-${e.kind}`}>
              <span className="tl-kind">{EXEC_EVENT_LABELS[e.kind as ExecEventKind] ?? e.kind}</span>
              {e.agentScope === 'sub' ? <span className="tl-sub">子</span> : null}
              <span className="tl-text">{summarize(e)}</span>
              <span className="tl-time">{relTime(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
