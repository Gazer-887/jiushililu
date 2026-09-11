import { useEffect, useState } from 'react'
import type { ToolConfirmRequest } from '@shared/ipc'

// 危险操作确认对话框（plan8 R5）
//
// 为什么需要它：权限档是"事先设定的上限"（只读 / 可写 / 完全访问），
// 但"可写"档下模型仍能执行任意 shell 命令 —— 用户没法说"这一次让我看一眼"。
// 这个框补的就是那一次。
//
// 两条行为约定：
//   ① **不点就不放行**：主进程 60 秒无应答即按拒绝处理（安全默认）。
//      所以界面不显示倒计时催促，但也不做"自动允许"。
//   ② 展示**命令原文**且不截断关键部分：判断危险与否靠的是内容，不是工具名。

export default function ConfirmDialog(): JSX.Element | null {
  const [req, setReq] = useState<ToolConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return window.api.onToolConfirmRequest((r) => {
      setReq(r)
      setBusy(false)
    })
  }, [])

  if (!req) return null

  const answer = async (allowed: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.api.respondToolConfirm({ id: req.id, allowed })
    } finally {
      setReq(null)
    }
  }

  return (
    <div className="cf-mask" role="dialog" aria-modal="true" aria-label="危险操作确认">
      <div className="cf-box">
        <div className="cf-head">
          <span className="cf-title">需要你确认</span>
          <span className="cf-tool">{req.tool}</span>
        </div>

        <p className="cf-desc">
          即将在工作区执行一条命令。命令能做的事没有上限，请看一眼再决定。
        </p>

        <pre className="cf-cmd">{req.detail}</pre>

        <div className="cf-meta">
          <span>发起：{req.agent}</span>
          <span className="cf-where" title={req.where}>
            位置：{req.where}
          </span>
        </div>

        <div className="cf-actions">
          <button className="cf-btn" disabled={busy} onClick={() => void answer(false)}>
            拒绝
          </button>
          <button className="cf-btn cf-btn-go" disabled={busy} onClick={() => void answer(true)}>
            允许这一次
          </button>
        </div>
        <p className="cf-note">60 秒内不选择将按「拒绝」处理。</p>
      </div>
    </div>
  )
}
