import { useCallback, useEffect, useState } from 'react'
import { describeKind, type CheckpointRun, type CheckpointRunMeta } from '@shared/checkpoint'
import DiffView from './DiffView'

// 文件变更记录：把 Agent 每一轮的写入留痕摊开，支持整轮或单文件回滚。
//
// 补上的是"改坏退不回"这个缺口 —— 看得见改了哪些，也退得回。

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
  /** 正在看差异的那个文件（`null` = 没展开）；看完不收起来会一直占着面板高度 */
  const [diffTarget, setDiffTarget] = useState<{ runId: string; rel: string } | null>(null)
  /** 差异视图的刷新令牌：回滚会改掉磁盘内容，而 DiffView 的依赖只有 (runId, rel) ——
   *  不给它一个变化的 key，它会继续显示回滚前算出的差异（"看着还有改动，其实已经退回去了"）。 */
  const [diffNonce, setDiffNonce] = useState(0)
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
    // 一轮改了文件后主进程推事件，面板据此刷新（无需手动点刷新）
    return window.api.onCheckpointChanged(() => void reload())
  }, [reload])

  const toggle = async (runId: string): Promise<void> => {
    if (openId === runId) {
      setOpenId(null)
      setDetail(null)
      setDiffTarget(null) // 收起这一轮时，别把差异视图留在别处悬着
      return
    }
    setOpenId(runId)
    setDiffTarget(null)
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
      setDiffNonce((n) => n + 1) // 内容被改过，差异视图必须重算（见 diffNonce）
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setConfirmKey(null)
    }
  }

  /** 二次确认：回滚会删掉本轮新建的文件，不能一点就走。
   *  `confirmLabel` 的理由：对**新建**文件来说，"回滚"的真实含义是**把文件删掉**，
   *  而确认按钮写着"确认回滚"——用户看不出这一步会删东西，所以后果不同就得换文案。 */
  const ConfirmButton = ({
    k,
    label,
    confirmLabel = '确认回滚',
    onConfirm
  }: {
    k: string
    label: string
    confirmLabel?: string
    onConfirm: () => void
  }): JSX.Element =>
    confirmKey === k ? (
      <span className="ck-confirm">
        <button className="ck-btn ck-btn-danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
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
      <p className="ck-hint">
        回滚前会<strong>先将当前内容另存一份</strong>，因此回滚后仍可再退回来。
      </p>

      {runs.length === 0 ? (
        <div className="ck-empty">暂无文件改动。</div>
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
                    <span className="ck-badge ck-badge-warn">未正常结束</span>
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
                    <div className="ck-file-empty">该轮次没有写文件</div>
                  ) : (
                    detail.changes.map((c) => (
                      <div key={c.rel} className="ck-file-item">
                        <div className="ck-file">
                          <span className={`ck-kind ${c.kind === 'created' ? 'ck-kind-new' : ''}`}>
                            {describeKind(c.kind)}
                          </span>
                          <span className="ck-file-rel" title={c.rel}>
                            {c.rel}
                          </span>
                          <span className="ck-file-size">
                            {c.kind === 'modified' ? `${c.beforeBytes} B` : '—'}
                          </span>
                          {/* 先看清改成了什么样，再决定退不退 */}
                          <button
                            className="ck-btn"
                            disabled={busy}
                            onClick={() =>
                              setDiffTarget((t) =>
                                t?.rel === c.rel && t.runId === r.runId
                                  ? null
                                  : { runId: r.runId, rel: c.rel }
                              )
                            }
                          >
                            {diffTarget?.rel === c.rel && diffTarget.runId === r.runId
                              ? '收起差异'
                              : '看差异'}
                          </button>
                          <ConfirmButton
                            k={`${r.runId}:${c.rel}`}
                            label="回滚"
                            {...(c.kind === 'created' ? { confirmLabel: '确认删除' } : {})}
                            onConfirm={() => void doRollback(r.runId, c.rel)}
                          />
                        </div>
                        {diffTarget?.rel === c.rel && diffTarget.runId === r.runId && (
                          <DiffView
                            key={diffNonce}
                            runId={r.runId}
                            rel={c.rel}
                            onClose={() => setDiffTarget(null)}
                          />
                        )}
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
