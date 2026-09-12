import { useEffect, useState } from 'react'
import { useAppStore } from '../store'

/**
 * **进行中的目标**（plan12）—— 输入框上方一条，形态对齐 DSH：
 * 图标 + 目标文字 + 暂停/继续 · 编辑 · 完成 · 删除。
 *
 * ## 与待办面板的区别（这是整件事的分界，写在最显眼的地方）
 *
 * | | 待办（TodoPanel，在下面） | 目标（本组件） |
 * |---|---|---|
 * | 回答什么 | **这一轮**干什么 | 我要**持续**达成什么 |
 * | 活多久 | 一轮跑完就清 | 跨轮次、跨重启 |
 * | 谁维护 | Agent 自己刷 | 用户手建 + **Agent 可自建** |
 * | 怎么结束 | 做完自然消失 | **显式**完成（还有"怎么算做到"的判据） |
 *
 * 一句话：**待办是过程，目标是意图。**
 *
 * ## 界面纪律
 *
 * - 只显示**进行中 / 暂停**的（完成与放弃的进历史，不占位置）
 * - 最多 3 条，多的折成"N 条更多"（不许把输入框顶走）
 * - 没有目标时**整条不占位**（空着也要占一行是最招人烦的那种设计）
 */
export default function GoalPanel(): JSX.Element | null {
  const activeId = useAppStore((s) => s.activeId)
  const goals = useAppStore((s) => s.goals)
  const loadGoals = useAppStore((s) => s.loadGoals)
  const createGoal = useAppStore((s) => s.createGoal)
  const actOnGoal = useAppStore((s) => s.actOnGoal)
  const deleteGoal = useAppStore((s) => s.deleteGoal)

  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  // 切换会话 → 目标跟着换（目标是**会话的属性**）—— 与 messages 同一条规矩
  useEffect(() => {
    if (activeId) void loadGoals(activeId)
    setNotice(null)
    setAdding(false)
    setEditing(null)
    setShowAll(false)
  }, [activeId, loadGoals])

  if (!activeId) return null

  const open = goals.filter((g) => g.status === 'active' || g.status === 'paused')
  const done = goals.filter((g) => g.status === 'done' || g.status === 'dropped')
  const shown = showAll ? open : open.slice(0, 3)
  const hiddenCount = open.length - shown.length

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      // 非法转移（如对已完成的目标再点完成）会从主进程抛出**人话**理由 —— 原样显示
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const submitNew = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    await run(() => createGoal(activeId, text))
    setDraft('')
    setAdding(false)
  }

  const submitEdit = async (): Promise<void> => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text) return
    await run(() => actOnGoal(editing.id, 'edit', { text }))
    setEditing(null)
  }

  return (
    <div className="goal-panel">
      <div className="goal-head">
        {/* 语义图标（内联 SVG，不用 emoji）：靶心 = 目标 */}
        <svg className="goal-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden focusable="false">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        </svg>
        <span className="goal-label">目标</span>

        {!adding && (
          <button className="goal-add" onClick={() => setAdding(true)} title="加一条跨轮次的目标">
            ＋ 加目标
          </button>
        )}
        {open.length > 3 && (
          <button className="goal-add" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起' : `${hiddenCount} 条更多`}
          </button>
        )}
        {done.length > 0 && (
          <span className="goal-done-count" title="已完成 / 已放弃的目标">
            已完成 {done.length}
          </span>
        )}
      </div>

      {adding && (
        <div className="goal-input">
          <input
            autoFocus
            value={draft}
            placeholder="要持续达成什么？（一句话，跨轮次存活）"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNew()
              if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
              }
            }}
          />
          <button className="goal-btn goal-btn-go" onClick={() => void submitNew()}>
            加上
          </button>
          <button
            className="goal-btn"
            onClick={() => {
              setAdding(false)
              setDraft('')
            }}
          >
            取消
          </button>
        </div>
      )}

      {shown.map((g) => (
        <div key={g.id} className={`goal-row ${g.status === 'paused' ? 'paused' : ''}`}>
          <span className="goal-state" title={g.status === 'paused' ? '已暂停' : '进行中'}>
            {g.status === 'paused' ? '‖' : '·'}
          </span>

          {editing?.id === g.id ? (
            <input
              className="goal-edit"
              autoFocus
              value={editing?.text ?? ''}
              onChange={(e) => setEditing({ id: g.id, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitEdit()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="goal-text" title={g.doneWhen ? `算做到：${g.doneWhen}` : g.text}>
              {g.text}
              {g.createdBy !== 'user' && <span className="goal-by">（{g.createdBy} 提的）</span>}
            </span>
          )}

          <span className="goal-actions">
            {editing?.id === g.id ? (
              <button className="goal-btn" onClick={() => void submitEdit()}>
                保存
              </button>
            ) : (
              <>
                {g.status === 'active' ? (
                  <button className="goal-btn" title="暂停（先放一放）" onClick={() => void run(() => actOnGoal(g.id, 'pause'))}>
                    暂停
                  </button>
                ) : (
                  <button className="goal-btn" title="继续" onClick={() => void run(() => actOnGoal(g.id, 'resume'))}>
                    继续
                  </button>
                )}
                <button className="goal-btn" onClick={() => setEditing({ id: g.id, text: g.text })}>
                  编辑
                </button>
                <button
                  className="goal-btn goal-btn-go"
                  title="标记完成 —— 显式收尾，不让它变成永不关闭的僵尸"
                  onClick={() => void run(() => actOnGoal(g.id, 'complete'))}
                >
                  完成
                </button>
                <button
                  className="goal-btn goal-btn-del"
                  title="彻底删除（「放弃」会留痕，删除不留）"
                  onClick={() => void run(() => deleteGoal(g.id))}
                >
                  删除
                </button>
              </>
            )}
          </span>
        </div>
      ))}

      {notice && <div className="goal-notice">{notice}</div>}
    </div>
  )
}