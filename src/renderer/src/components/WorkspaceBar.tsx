import { useEffect, useState } from 'react'
import type { WorkspaceInfo } from '@shared/ipc'

// 工作区条（P2）：显示当前 Agent 可读写的目录，并提供"选择目录"入口。
// 这是唯一扩大 Agent 活动范围的方式——边界由用户显式授权，不由模型主张。

export default function WorkspaceBar(): JSX.Element {
  const [ws, setWs] = useState<WorkspaceInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getWorkspace().then(setWs)
  }, [])

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.pickWorkspace()
      if (next) setWs(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ws-bar">
      <span className="ws-label">工作区</span>
      <span className="ws-path" title={ws?.path ?? ''}>
        {ws ? ws.path : '加载中…'}
      </span>
      {ws && !ws.custom && <span className="ws-tag">内置</span>}
      <button className="ws-pick" disabled={busy} onClick={() => void pick()}>
        {busy ? '选择中…' : '选择目录'}
      </button>
    </div>
  )
}
