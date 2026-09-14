import { useEffect } from 'react'
import { useAppStore } from '../store'

// 护栏 2「写入即可见」的落点（**D-043**）：照 `GoalPanel` / `TodoPanel` 的形态挂在 ChatView。
//
// ⚠️ 为什么不是在消息流里插一行"痕迹行"：项目**没有**那个机制（渲染层对 `tool_calls` 零命中），
//    消息主干是 `msg msg-${role}` + MessageMarkdown，插一行非消息要动渲染主干与结构守卫 ——
//    实测零位置，所以走面板（D-043 拍板取 (b)）。
// ⚠️ 与右抽屉巡检区的分工：这里管"**刚刚**发生了什么"（当场、零摩擦、自动消退），
//    巡检区管"历史上积累了什么"（事后、需主动查看）。两处都干同一件事就是双 X 案同族。
// ⚠️ 数据走 store（由 App 的推送处理器写入），**不自建一次性 pull** —— 那是时序炸弹（TodoPanel 消失案）。

/** 自动消退时长。⚠️ **未校准初值**（plan19 §十二 同类处理）：长了挡视线，短了看不完。 */
const AUTO_DISMISS_MS = 12_000

export default function MemoryNotice(): JSX.Element | null {
  const notice = useAppStore((s) => s.memoryNotice)
  const activeId = useAppStore((s) => s.activeId)
  const clear = useAppStore((s) => s.clearMemoryNotice)

  // 只显示**当前会话**的痕迹：用户已经切走了，就不该再看到那条会话的写入
  const shown = notice && notice.conversationId === activeId ? notice : null

  useEffect(() => {
    if (!shown) return
    const timer = setTimeout(clear, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [shown, clear])

  if (!shown) return null

  const total = shown.written.length + shown.rejected.length
  const firstReject = shown.rejected[0]

  return (
    <div className="mem-notice">
      <span className="mem-notice-text">
        {shown.written.length > 0 ? `记住了 ${shown.written.join('、')}` : '这次没有写成记忆'}
        {shown.rejected.length > 0
          ? `；另有 ${shown.rejected.length} 条未写入${firstReject ? `（${firstReject.reason}）` : ''}`
          : ''}
        <span className="mem-notice-hint">（可在右栏「记忆」页签查看或删除）</span>
      </span>
      <button type="button" className="mem-notice-close" onClick={clear} aria-label={`关闭（共 ${total} 条）`}>
        知道了
      </button>
    </div>
  )
}
