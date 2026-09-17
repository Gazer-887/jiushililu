import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'

// 「＋」号拓展面板（P2）：新建任务页与对话页共用的能力入口。
// plan17 D1：「技能 / 子 Agent」多选改造成「主 Agent」**单选** —— 多选没有执行语义
// （plan6 的模型是模型自决派发子代理，预选清单派不出任务书），且旧链路 chat:send 不带它 = 选了不生效。
// "技能"概念归还 F6（.skills 运行时）。

export interface PlusMenuProps {
  /** 当前选中的主 Agent；null = 内核默认 */
  selectedAgent: string | null
  /** 不传则只提供附件能力（如对话页由上层决定要不要给选择区） */
  onSelectAgent?: (name: string | null) => void
  onAttach?: () => void
}

export default function PlusMenu({ selectedAgent, onSelectAgent, onAttach }: PlusMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const agentsView = useAppStore((s) => s.agentsView)
  const refreshAgents = useAppStore((s) => s.refreshAgents)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!onSelectAgent) return // 不需要选择区就不拉取
    void refreshAgents()
  }, [onSelectAgent, refreshAgents])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 生效集合 = 全量视图里未被覆盖的条目（含内置）；被覆盖的不出现在选择器里
  const effective = (agentsView?.entries ?? []).filter((e) => !e.overridden)

  return (
    <div className="plus-wrap" ref={boxRef}>
      <button
        className={`plus-btn ${open ? 'open' : ''}`}
        title="添加能力"
        onClick={() => setOpen((v) => !v)}
      >
        ＋
        {selectedAgent && <span className="plus-badge">A</span>}
      </button>

      {open && (
        <div className="plus-menu">
          <div className="plus-section">
            <div className="plus-title">添加</div>
            <button
              className="plus-item"
              onClick={() => {
                setOpen(false)
                onAttach?.()
              }}
            >
              <span className="plus-check" />
              <span className="plus-name">文件</span>
              <span className="plus-desc">上限 64KB</span>
            </button>
            <div className="plus-item disabled">
              <span className="plus-check" />
              <span className="plus-name">图片</span>
              <span className="plus-desc">尚未实现</span>
            </div>
          </div>

          {onSelectAgent && (
            <div className="plus-section">
              <div className="plus-title">主 Agent</div>
              <button
                className={`plus-item ${!selectedAgent ? 'on' : ''}`}
                onClick={() => {
                  onSelectAgent(null)
                  setOpen(false)
                }}
              >
                <span className="plus-check">{!selectedAgent ? '✓' : ''}</span>
                <span className="plus-name">内核默认</span>
                <span className="plus-desc">九十里路的内置 Agent</span>
              </button>
              {effective.map((s) => (
                <button
                  key={s.file}
                  className={`plus-item ${selectedAgent === s.name ? 'on' : ''}`}
                  onClick={() => {
                    onSelectAgent(s.name)
                    setOpen(false)
                  }}
                >
                  <span className="plus-check">{selectedAgent === s.name ? '✓' : ''}</span>
                  <span className="plus-name">{s.name}</span>
                  <span className="plus-desc">{s.description}</span>
                  <span className="plus-tag">{s.source === 'user' ? '自建' : '内置'}</span>
                </button>
              ))}
              {agentsView && agentsView.warnings.length > 0 && (
                <div className="plus-empty">部分定义加载失败：{agentsView.warnings.length} 条（设置页可查看）</div>
              )}
            </div>
          )}

          <div className="plus-section plus-soon">
            <div className="plus-title">更多</div>
            <div className="plus-item disabled">
              <span className="plus-check" />
              <span className="plus-name">MCP 连接器</span>
              <span className="plus-desc">尚未实现</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
