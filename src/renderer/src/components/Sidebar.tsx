import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import { groupByWorkspace } from '@shared/conversation-group'

// 侧边栏（P2）：新建任务 + 按工作区分组的会话历史 + 齿轮设置。显隐由顶栏控制（open 受控），品牌名在顶栏不重复。
// 交互参考：opencode 的新建流程、WorkBuddy 的分组历史（去掉专家/连接器等花哨项）。

export default function Sidebar({ open, width }: { open: boolean; width: number }): JSX.Element {
  // 界面骨架文案走 i18next（plan52 S1）；命名空间按界面区切，默认 ns = common
  const { t } = useTranslation(['common', 'sidebar'])
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeId)
  const newSession = useAppStore((s) => s.newSession)
  const openConversation = useAppStore((s) => s.openConversation)
  const renameConversation = useAppStore((s) => s.renameConversation)
  const removeConversation = useAppStore((s) => s.removeConversation)
  /** **正在跑的会话集合**（plan11）：当前那条看顶层 `streaming`，后台那几条看各自存档里的 —— 合起来才是"谁在跑"的全貌 */
  const runtimes = useAppStore((s) => s.runtimes)
  const activeStreaming = useAppStore((s) => s.streaming)
  const runningIds = new Set<string>([
    ...Object.entries(runtimes)
      .filter(([, r]) => r.streaming)
      .map(([id]) => id),
    ...(activeId && activeStreaming ? [activeId] : [])
  ])

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)

  // 分组规则只有一份，在 `@shared/conversation-group`（K27）：两边各写一份会漂，而漂了没有一道闸会红
  const groups = groupByWorkspace(conversations)

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
        <span className="plus">＋</span> {t('newTask')}
      </button>

      <div className="conv-scroll">
        <div className="section-label">{t('sidebar:workspace')}</div>
        {groups.length === 0 && <div className="conv-empty">{t('sidebar:emptyConversations')}</div>}
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
                    {/* 并发下要一眼看出**哪几条**在生成（plan11）—— 没有这个标记，用户会以为切走的那条已经停了 */}
                    {runningIds.has(c.id) && (
                      <span className="conv-running" title="这条会话正在生成">
                        正在生成
                      </span>
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
        {/* 设置入口（09-18 用户：齿轮不直观，改文字框）。⚠️ 无 `.active` 选中态：
            设置是浮在上面的独立窗口，"已打开"由窗口自己表达，侧栏再高亮一次是重复信号。 */}
        <button className="settings-entry-btn" onClick={() => void window.api.openSettingsWindow()}>
          {t('sidebar:settings')}
        </button>
        <span className="foot-text">{t('sidebar:tagline')}</span>
      </div>
    </aside>
  )
}
