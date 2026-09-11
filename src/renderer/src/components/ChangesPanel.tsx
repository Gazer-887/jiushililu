import { useCallback, useEffect, useState } from 'react'
import { describeKind, type CheckpointRun, type CheckpointRunMeta } from '@shared/checkpoint'

// 文件变更记录（plan8 R4）：把 Agent 每一轮的写入留痕摊开，支持一键回滚。
//
// 为什么这个面板重要：Agent 已经能改真实文件了，但在此之前**改坏退不回**。
// 这里补的就是那个"退"—— 用户看到改了哪些、能选中某轮或某个文件退回去。

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function ChangesPanel(): JSX.Element {
  const [runs, setRuns] = useState<CheckpointRunMeta[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CheckpointRun | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setRuns(await window.api.listCheckpoints())
    } catch {
      setRuns([])
    }
  }, [])

  useEffect(() => {
    void reload()
    // 一轮运行改了文件后主进程会推事件，面板据此刷新（无需手动点刷新）
    return window.api.onCheckpointChanged(() => void reload())
  }, [reload])

  const toggle = async (runId: string): Promise<void> => {
    if (openId === runId) {
      setOpenId(null)
      setDetail(null)
      return
    }
    setOpenId(runId)
    setDetail(await window.api.getCheckpoint(runId))
  }

  const doRollback = async (runId: string, rel?: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const r = await window.api.rollbackCheckpoint(runId, rel)
      const parts: string[] = []
      if (r.restored.length > 0) parts.push(`还原 ${r.restored.length} 个`)
      if (r.deleted.length > 0) parts.push(`删除 ${r.deleted.length} 个`)
      if (r.failed.length > 0) parts.push(`失败 ${r.failed.length} 个`)
      if (r.rejected.length > 0) parts.push(`拒绝 ${r.rejected.length} 个`)
      setNotice({
        ok: r.failed.length === 0 && r.rejected.length === 0,
        text: parts.length > 0 ? `已回滚：${parts.join('，')}` : '这一轮没有需要回滚的改动'
      })
      await reload()
      setDetail(await window.api.getCheckpoint(runId))
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setConfirmKey(null)
    }
  }

  /** 二次确认：回滚会删掉本轮新建的文件，不能一点就走 */
  const ConfirmButton = ({
    k,
    label,
    onConfirm
  }: {
    k: string
    label: string
    onConfirm: () => void
  }): JSX.Element =>
    confirmKey === k ? (
      <span className="ck-confirm">
        <button className="ck-btn ck-btn-danger" disabled={busy} onClick={onConfirm}>
          确认回滚
        </button>
        <button className="ck-btn" disabled={busy} onClick={() => setConfirmKey(null)}>
          取消
        </button>
      </span>
    ) : (
      <button className="ck-btn" disabled={busy} onClick={() => setConfirmKey(k)}>
        {label}
      </button>
    )

  return (
    <div className="ck-panel">
      <div className="ck-head">
        <span className="ck-title">文件变更记录</span>
        <button className="ck-btn" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      <p className="ck-hint">Agent 每轮改文件前会自动留存快照。改坏了可一键退回改动前的样子。</p>

      {runs.length === 0 ? (
        <div className="ck-empty">还没有文件改动。Agent 写文件后，这里会列出它改过什么。</div>
      ) : (
        <div className="ck-runs">
          {runs.map((r) => (
            <div key={r.runId} className="ck-run">
              <div className="ck-run-head">
                <button className="ck-run-toggle" onClick={() => void toggle(r.runId)}>
                  <span className="ck-caret">{openId === r.runId ? '▾' : '▸'}</span>
                  <span className="ck-run-main">
                    <span className="ck-run-time">{fmtTime(r.at)}</span>
                    <span className="ck-run-meta">
                      {r.agent} · {r.fileCount} 个文件
                      {r.createdCount > 0 && ` · 新建 ${r.createdCount}`}
                      {r.modifiedCount > 0 && ` · 修改 ${r.modifiedCount}`}
                    </span>
                  </span>
                </button>
                <span className="ck-run-tail">
                  {r.rolledBackAt !== undefined && <span className="ck-badge ck-badge-done">已回滚</span>}
                  {r.rolledBackAt === undefined && r.status === 'running' && (
                    <span className="ck-badge ck-badge-warn">未收尾</span>
                  )}
                  <ConfirmButton
                    k={r.runId}
                    label="整轮回滚"
                    onConfirm={() => void doRollback(r.runId)}
                  />
                </span>
              </div>

              {openId === r.runId && detail && (
                <div className="ck-files">
                  {detail.changes.length === 0 ? (
                    <div className="ck-file-empty">这一轮没有写文件</div>
                  ) : (
                    detail.changes.map((c) => (
                      <div key={c.rel} className="ck-file">
                        <span className={`ck-kind ${c.kind === 'created' ? 'ck-kind-new' : ''}`}>
                          {describeKind(c.kind)}
                        </span>
                        <span className="ck-file-rel" title={c.rel}>
                          {c.rel}
                        </span>
                        <span className="ck-file-size">
                          {c.kind === 'modified' ? `${c.beforeBytes} B` : '—'}
                        </span>
                        <ConfirmButton
                          k={`${r.runId}:${c.rel}`}
                          label="回滚"
                          onConfirm={() => void doRollback(r.runId, c.rel)}
                        />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
    </div>
  )
}
