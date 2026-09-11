import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import type { ConversationMeta } from '@shared/ipc'

// 侧边栏（P2）：新建任务入口 + 按工作区分组的会话历史 + 左下角齿轮设置。
// 显隐由顶栏控制（open 受控）；品牌名在顶栏，这里不再重复。
// 交互参考：opencode 的新建流程、WorkBuddy 的分组历史（去掉专家/连接器等花哨项）。

interface Group {
  workspace: string
  label: string
  items: ConversationMeta[]
}

/** 分组（与主进程同一套规则：组内按更新时间倒序） */
function groupConversations(list: ConversationMeta[]): Group[] {
  const map = new Map<string, ConversationMeta[]>()
  for (const c of list) {
    const bucket = map.get(c.workspace)
    if (bucket) bucket.push(c)
    else map.set(c.workspace, [c])
  }
  return [...map.entries()]
    .map(([workspace, items]) => ({
      workspace,
      label: workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? workspace,
      items: [...items].sort((a, b) => b.updatedAt - a.updatedAt)
    }))
    .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0))
}

export default function Sidebar({ open, width }: { open: boolean; width: number }): JSX.Element {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeId)
  const newSession = useAppStore((s) => s.newSession)
  const openConversation = useAppStore((s) => s.openConversation)
  const renameConversation = useAppStore((s) => s.renameConversation)
  const removeConversation = useAppStore((s) => s.removeConversation)
  const setView = useAppStore((s) => s.setView)

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)

  const groups = groupConversations(conversations)

  // 点击别处关闭三点菜单
  useEffect(() => {
    if (!menuFor) return
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement
      if (!el.closest('.conv-menu') && !el.closest('.conv-more')) setMenuFor(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuFor])

  const commitRename = async (): Promise<void> => {
    if (!editing) return
    await renameConversation(editing.id, editing.draft)
    setEditing(null)
  }

  return (
    <aside className={`sidebar ${open ? '' : 'closed'}`} style={open ? { width } : undefined}>
      <button className="new-task-btn" onClick={newSession}>
        <span className="plus">＋</span> 新建任务
      </button>

      <div className="conv-scroll">
        <div className="section-label">工作区</div>
        {groups.length === 0 && <div className="conv-empty">还没有会话。点「新建任务」开始。</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed[g.workspace] ?? false
          return (
            <div key={g.workspace} className="conv-group">
              <div className="group-head">
                <button
                  className="group-toggle"
                  title={g.workspace}
                  onClick={() => setCollapsed((c) => ({ ...c, [g.workspace]: !isCollapsed }))}
                >
                  <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="group-name">{g.label}</span>
                </button>
                <button
                  className="group-add"
                  title="在此工作区新建任务"
                  onClick={() => newSession()}
                >
                  ＋
                </button>
              </div>

              {!isCollapsed &&
                g.items.map((c) => (
                  <div
                    key={c.id}
                    className={`conv-item ${c.id === activeId ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => void openConversation(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void openConversation(c.id)
                    }}
                  >
                    {editing?.id === c.id ? (
                      <input
                        className="conv-rename"
                        autoFocus
                        value={editing.draft}
                        onChange={(e) => setEditing({ id: c.id, draft: e.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="conv-title">{c.title}</span>
                    )}
                    <button
                      className="conv-more"
                      title="更多"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuFor(menuFor === c.id ? null : c.id)
                      }}
                    >
                      ⋯
                    </button>
                    {menuFor === c.id && (
                      <div className="conv-menu">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditing({ id: c.id, draft: c.title })
                            setMenuFor(null)
                          }}
                        >
                          重命名
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            void window.api.revealWorkspace(c.workspace)
                            setMenuFor(null)
                          }}
                        >
                          打开工作区目录
                        </button>
                        <button
                          className="danger"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuFor(null)
                            void removeConversation(c.id)
                          }}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <button
          className={`gear-btn ${view === 'settings' ? 'active' : ''}`}
          title="设置"
          onClick={() => setView('settings')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M12 2.6v2.6M12 18.8v2.6M4.35 7.3l2.25 1.3M17.4 15.4l2.25 1.3M4.35 16.7l2.25-1.3M17.4 8.6l2.25-1.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <span className="foot-text">会自己长经验的工作台</span>
      </div>
    </aside>
  )
}
