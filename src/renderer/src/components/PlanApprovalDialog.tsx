import { useEffect, useState } from 'react'
import type { PlanApprovalRequest } from '@shared/ipc'
import { useAppStore } from '../store'

// 计划批准卡（plan27）
// 为什么需要：planner agent 物理上只有读类工具（它「只能规划」是靠**没有写工具**保证的），所以它出完方案
// 本轮就结束了 —— 用户要接着干，得自己切到执行 agent 再把方案重述一遍。这个卡补的就是那次**交接**：
// 把方案摆出来，等用户点头，然后才由执行 agent 接手。
//
// 与 `ConfirmDialog`（命令确认）**刻意分开**，不合并成一张卡：
// ① 那个框问的是「要不要执行**这条命令**」，`detail` 是短字段、文案写死「即将执行一条命令」；
//    这里要摆**一整篇方案**（长文本、需滚动），语义上也不是「危险操作」。
// ② 命令确认是**安全关键路径**（文案与断言都钉在它上面），混进方案会污染它的可读性与断言。
//
// 但三条原则**照抄不改**（它们对"问用户要一个决定"同样成立）：
// ① **不点就不放行**：主进程超时无应答即按拒绝处理（安全默认）—— 界面不做倒计时催促，也不自动允许；
// ② 展示**方案全文**且不截断 —— 判方案靠内容，不靠一句摘要；
// ③ **排队，不覆盖**：一次只显示队首并写明还有几条排队；每条标明来自哪条会话；答复按**该条的 id** 配对。

export default function PlanApprovalDialog(): JSX.Element | null {
  /** 待批准队列：数组而非单个 `req` —— **后到的排到后面，绝不覆盖前面那条** */
  const [queue, setQueue] = useState<PlanApprovalRequest[]>([])
  const [busy, setBusy] = useState(false)
  const conversations = useAppStore((s) => s.conversations)

  useEffect(() => {
    return window.api.onPlanApprovalRequest((r) => {
      setQueue((q) => [...q, r])
      setBusy(false)
    })
  }, [])

  const req = queue[0] ?? null
  if (!req) return null

  /** 方案来自哪条会话：拿不到标题就退回 id，**绝不显示成"未知"**让人无从追溯 */
  const fromTitle = conversations.find((c) => c.id === req.conversationId)?.title ?? req.conversationId

  const answer = async (allowed: boolean): Promise<void> => {
    const current = queue[0]
    if (!current) return
    setBusy(true)
    try {
      // ⚠️ 按**这一条的 id** 配对，不用"当前那条" —— 排队的那几条各有各的 id
      await window.api.respondPlanApproval({ id: current.id, allowed })
    } finally {
      setBusy(false)
      setQueue((q) => q.slice(1))
    }
  }

  return (
    <div className="cf-mask" role="dialog" aria-modal="true" aria-label="计划批准">
      <div className="cf-box pa-box">
        <div className="cf-head">
          <span className="cf-title">方案待批准</span>
          <span className="cf-tool">{req.agent}</span>
        </div>

        <p className="cf-desc">
          下方是「{req.agent}」给出的方案。点「批准并执行」由执行 agent 按它落地；点「暂不执行」则本轮到此结束，
          方案仍留在对话里，你可以改完要求再来一轮。
        </p>

        <pre className="pa-plan">{req.plan}</pre>

        <div className="cf-meta">
          <span className="cf-from" title={fromTitle}>
            来自会话：{fromTitle}
          </span>
          <span>方案来自：{req.agent}</span>
        </div>

        {queue.length > 1 && (
          <p className="cf-queue">还有 {queue.length - 1} 份方案在排队，本条答复后轮至下一条</p>
        )}

        <div className="cf-actions">
          <button className="cf-btn" disabled={busy} onClick={() => void answer(false)}>
            暂不执行
          </button>
          <button className="cf-btn cf-btn-go" disabled={busy} onClick={() => void answer(true)}>
            批准并执行
          </button>
        </div>
        <p className="cf-note">10 分钟内不选择将按「暂不执行」处理。</p>
      </div>
    </div>
  )
}
