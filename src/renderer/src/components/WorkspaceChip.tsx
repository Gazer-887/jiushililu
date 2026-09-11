import { useEffect, useState } from 'react'
import type { WorkspaceInfo } from '@shared/ipc'

// 工作区 chip（P2）：与新建任务页同一形态——就长在输入框工具条上。
// 显示路径末段（悬停看全路径），点击弹系统目录选择器。
// 这是唯一扩大 Agent 活动范围的入口：边界由用户显式授权，不由模型主张。

export default function WorkspaceChip(): JSX.Element {
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

  const label = ws?.path
    ? (ws.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? ws.path)
    : '选择目录'

  return (
    <button className="chip chip-ws-inline" title={ws?.path ?? '选择工作区目录'} onClick={() => void pick()}>
      <span className="chip-label">工作区</span>
      <span className="chip-value">{busy ? '选择中…' : label}</span>
      <span className="chip-caret">▾</span>
    </button>
  )
}
