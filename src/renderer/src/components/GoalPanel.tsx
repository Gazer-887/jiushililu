import { useEffect, useState } from 'react'
import { useAppStore } from '../store'

/**
 * **进行中的目标**（plan12）—— 输入框上方一条，形态对齐 DSH：图标 + 目标文字 + 暂停/继续 · 编辑 · 完成 · 放弃 · 删除。
 * 与待办（TodoPanel）的分界：待办答"**这一轮**干什么"、一轮跑完即清、由 Agent 刷；目标答"我要**持续**达成什么"、
 * 跨轮次跨重启、用户可手建且 **Agent 可自建**、**显式**完成并带"怎么算做到"的判据 —— 待办是过程，目标是意图。
 * 界面纪律：只显示进行中/暂停（完成与放弃**折叠**在计数里，展开后可重开 —— 状态机六种动作都要有入口）；
 * 最多 3 条，多的折成"N 条更多"（不许把输入框顶走）；
 * 没有目标时整条不占位 —— 空着也要占一行是最招人烦的那种设计。
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
  // B0b：完成判据与正文同一次提交 —— 超限由主进程 schema 拒，人话进 notice（前端不重复实现 200 字那把尺）
  const [doneWhenDraft, setDoneWhenDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [showEnded, setShowEnded] = useState(false)

  // 目标是**会话的属性**：切会话就跟着换，与 messages 同一条规矩
  useEffect(() => {
    if (activeId) void loadGoals(activeId)
    setNotice(null)
    setAdding(false)
    setEditing(null)
    setDoneWhenDraft('')
    setShowAll(false)
    setShowEnded(false)
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
      // 非法转移（如对已完成的目标再点完成）由主进程抛出**人话**理由 —— 原样显示
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const submitNew = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    const doneWhen = doneWhenDraft.trim()
    await run(() => createGoal(activeId, text, doneWhen ? doneWhen : undefined))
    setDraft('')
    setDoneWhenDraft('')
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
        {/* 内联 SVG 不用 emoji（语义：靶心 = 目标） */}
        <svg className="goal-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden focusable="false">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        </svg>
        <span className="goal-label">目标</span>

        {!adding && (
          <button className="goal-add" onClick={() => setAdding(true)} title="新增一条跨轮次的目标">
            ＋ 新建目标
          </button>
        )}
        {open.length > 3 && (
          <button className="goal-add" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起' : `${hiddenCount} 条更多`}
          </button>
        )}
        {done.length > 0 && (
          <button
            className="goal-add goal-done-count"
            title={showEnded ? '收起已完成与已放弃的目标' : '查看已完成 / 已放弃的目标（可重开）'}
            onClick={() => setShowEnded((v) => !v)}
          >
            已完成 {done.length} {showEnded ? '▴' : '▾'}
          </button>
        )}
      </div>

      {adding && (
        <div className="goal-input">
          <input
            autoFocus
            value={draft}
            placeholder="要持续达成什么"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNew()
              if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
                setDoneWhenDraft('')
              }
            }}
          />
          <input
            className="goal-donewhen"
            value={doneWhenDraft}
            placeholder="完成判据（可选，最多 200 字）"
            title="完成判据随目标保存；超 200 字会被拒绝"
            onChange={(e) => setDoneWhenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNew()
              if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
                setDoneWhenDraft('')
              }
            }}
          />
          <button className="goal-btn goal-btn-go" onClick={() => void submitNew()}>
            添加
          </button>
          <button
            className="goal-btn"
            onClick={() => {
              setAdding(false)
              setDraft('')
              setDoneWhenDraft('')
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
            <span className="goal-text" title={g.doneWhen ? `完成判据：${g.doneWhen}` : g.text}>
              {g.text}
              {g.createdBy !== 'user' && <span className="goal-by">（由 {g.createdBy} 创建）</span>}
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
                  <button className="goal-btn" title="暂停" onClick={() => void run(() => actOnGoal(g.id, 'pause'))}>
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
                  title="标记完成"
                  onClick={() => void run(() => actOnGoal(g.id, 'complete'))}
                >
                  完成
                </button>
                <button
                  className="goal-btn"
                  title="放弃（保留记录，可从「已完成」里重开）"
                  onClick={() => void run(() => actOnGoal(g.id, 'drop'))}
                >
                  放弃
                </button>
                <button
                  className="goal-btn goal-btn-del"
                  title="彻底删除（「放弃」保留记录，删除不保留）"
                  onClick={() => void run(() => deleteGoal(g.id))}
                >
                  删除
                </button>
              </>
            )}
          </span>
        </div>
      ))}

      {showEnded &&
        done.map((g) => (
          <div key={g.id} className="goal-row ended">
            <span className="goal-state" title={g.status === 'done' ? '已完成' : '已放弃'}>
              {g.status === 'done' ? '✓' : '×'}
            </span>
            <span className="goal-text" title={g.doneWhen ? `完成判据：${g.doneWhen}` : g.text}>
              {g.text}
              {g.createdBy !== 'user' && <span className="goal-by">（由 {g.createdBy} 创建）</span>}
            </span>
            <span className="goal-actions">
              <button
                className="goal-btn goal-btn-go"
                title="重开（回到进行中）"
                onClick={() => void run(() => actOnGoal(g.id, 'reopen'))}
              >
                重开
              </button>
              {/* B0b：终态行可删 —— 进行中行早有删除入口，终态行此前只能重开再删，删完计数减一 */}
              <button
                className="goal-btn goal-btn-del"
                title="彻底删除（记录不保留）"
                onClick={() => void run(() => deleteGoal(g.id))}
              >
                删除
              </button>
            </span>
          </div>
        ))}

      {notice && <div className="goal-notice">{notice}</div>}
    </div>
  )
}