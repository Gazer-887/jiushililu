import { useEffect, useState } from 'react'
import type { ToolConfirmRequest } from '@shared/ipc'
import { useAppStore } from '../store'

// 危险操作确认对话框（plan8 R5）
// 为什么需要：权限档只是"事先的上限"（只读/可写/完全访问），"可写"档下模型仍能执行任意 shell ——
// 用户没法说"这一次让我看一眼"，这个框补的就是那一次。三条行为约定：
// ① **不点就不放行**：主进程超时无应答即按拒绝处理（安全默认）—— 界面不做倒计时催促，也不自动允许。
// ② 展示**命令原文**且不截断关键部分 —— 判危险靠内容，不靠工具名。
// ③ **排队，不覆盖**（plan11 P0-3）：单槽 state 时后到的请求会顶掉正在显示的那条，并发下用户
//    "读着 A 的命令、点下的却是 B 的允许"，R5 那句"看过才批准"就不成立 —— 这是**安全语义**问题。
//    故：一次只显示队首并写明还有几条排队；每条标明来自哪条会话；答复按**该条的 id** 配对。

export default function ConfirmDialog(): JSX.Element | null {
  /** 待确认队列：数组而非单个 `req` —— **后到的排到后面，绝不覆盖前面那条** */
  const [queue, setQueue] = useState<ToolConfirmRequest[]>([])
  const [busy, setBusy] = useState(false)
  const conversations = useAppStore((s) => s.conversations)

  useEffect(() => {
    return window.api.onToolConfirmRequest((r) => {
      setQueue((q) => [...q, r])
      setBusy(false)
    })
  }, [])

  const req = queue[0] ?? null
  if (!req) return null

  // **两种确认说两种话**（plan10 §六 第 6 条）：文件回滚在右抽屉、会话回滚在消息右键，是两件不同的事。
  // 会话回滚这一路**不许出现"文件"二字**（否则用户以为点一个两个都退；有一条断言专门钉这个）。
  const isRollback = req.kind === 'rollback-messages'

  /** 请求来自哪条会话：拿不到标题就退回 id，**绝不显示成"未知"**让人无从追溯 */
  const fromTitle =
    conversations.find((c) => c.id === req.conversationId)?.title ?? req.conversationId

  const answer = async (allowed: boolean): Promise<void> => {
    const current = queue[0]
    if (!current) return
    setBusy(true)
    try {
      // ⚠️ 按**这一条的 id** 配对，不用"当前那条" —— 排队的那几条各有各的 id
      await window.api.respondToolConfirm({ id: current.id, allowed })
    } finally {
      setBusy(false)
      setQueue((q) => q.slice(1))
    }
  }

  return (
    <div className="cf-mask" role="dialog" aria-modal="true" aria-label={isRollback ? '会话回滚确认' : '危险操作确认'}>
      <div className="cf-box">
        <div className="cf-head">
          <span className="cf-title">{isRollback ? '确认回滚这段对话' : '需要你确认'}</span>
          <span className="cf-tool">{req.tool}</span>
        </div>

        <p className="cf-desc">
          {isRollback
            ? '仅回滚对话消息：这段对话里靠后的部分会从界面上隐去，工作区里的文件一个都不动。回滚之后可以撤销。'
            : '即将在工作区执行一条命令。命令能做的事没有上限，请看一眼再决定。'}
        </p>

        <pre className="cf-cmd">{req.detail}</pre>

        <div className="cf-meta">
          <span className="cf-from" title={fromTitle}>
            来自会话：{fromTitle}
          </span>
          <span>发起：{req.agent}</span>
          <span className="cf-where" title={req.where}>
            位置：{req.where}
          </span>
        </div>

        {queue.length > 1 && (
          <p className="cf-queue">还有 {queue.length - 1} 条确认在排队，这条答复后就轮到手</p>
        )}

        <div className="cf-actions">
          <button className="cf-btn" disabled={busy} onClick={() => void answer(false)}>
            拒绝
          </button>
          <button className="cf-btn cf-btn-go" disabled={busy} onClick={() => void answer(true)}>
            {isRollback ? '回滚对话' : '允许这一次'}
          </button>
        </div>
        <p className="cf-note">60 秒内不选择将按「拒绝」处理。</p>
      </div>
    </div>
  )
}
