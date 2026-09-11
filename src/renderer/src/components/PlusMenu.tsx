import { useEffect, useRef, useState } from 'react'
import type { SkillInfo } from '@shared/ipc'

// 「＋」号拓展面板（P2）：新建任务页与对话页共用的能力入口。
// 设计原则（用户要求）：初始页面越简洁越好——技能 / 子 Agent 不直接摊在页面上，
// 收进这里按需选取。后续文件、图片、MCP 也挂这里（当前标为待做）。

export interface PlusMenuProps {
  picked: string[]
  /** 不传则只提供附件能力（对话页的技能由会话创建时决定） */
  onToggle?: (name: string) => void
  /** 选择文件作为上下文附件 */
  onAttach?: () => void
}

export default function PlusMenu({ picked, onToggle, onAttach }: PlusMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!onToggle) return // 不需要技能列表时不必拉取
    void window.api.listSkills().then(setSkills)
  }, [onToggle])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="plus-wrap" ref={boxRef}>
      <button
        className={`plus-btn ${open ? 'open' : ''}`}
        title="添加能力（技能 / 子 Agent）"
        onClick={() => setOpen((v) => !v)}
      >
        ＋
        {picked.length > 0 && <span className="plus-badge">{picked.length}</span>}
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
              <span className="plus-desc">引用工作区文件进上下文（限 64KB）</span>
            </button>
            <div className="plus-item disabled">
              <span className="plus-check" />
              <span className="plus-name">图片</span>
              <span className="plus-desc">需模型支持视觉（待做）</span>
            </div>
          </div>

          {onToggle && (
            <div className="plus-section">
              <div className="plus-title">技能 / 子 Agent</div>
              {skills.length === 0 ? (
                <div className="plus-empty">未发现可用定义</div>
              ) : (
                skills.map((s) => (
                  <button
                    key={s.name}
                    className={`plus-item ${picked.includes(s.name) ? 'on' : ''}`}
                    onClick={() => onToggle(s.name)}
                  >
                    <span className="plus-check">{picked.includes(s.name) ? '✓' : ''}</span>
                    <span className="plus-name">{s.name}</span>
                    <span className="plus-desc">{s.description}</span>
                    {s.source === 'user' && <span className="plus-tag">自建</span>}
                  </button>
                ))
              )}
            </div>
          )}

          <div className="plus-section plus-soon">
            <div className="plus-title">更多</div>
            <div className="plus-item disabled">
              <span className="plus-check" />
              <span className="plus-name">MCP 连接器</span>
              <span className="plus-desc">接入外部工具（P3 生态）</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
