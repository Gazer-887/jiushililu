import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { McpServerStatus, SkillInfo } from '@shared/ipc'

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  connected: '已连接',
  error: '连接失败',
  disabled: '已关闭'
}

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
  // plan34 S4：「+」面板同步显示**当前开启的**技能与 MCP（两者分开列，只读 —— 管理在设置页）。
  // 数据源即运行时真源：技能走 listSkills−禁用名单，MCP 走 listServers 的 enabled；广播驱动实时一致。
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [mcp, setMcp] = useState<McpServerStatus[] | null>(null)

  useEffect(() => {
    if (!open) return
    const pull = (): void => {
      void window.api.listSkills().then(async (list) => {
        const disabled = await window.api.getSkillsDisabled()
        setSkills(list.filter((s) => !disabled.includes(s.name) && !s.overridden))
      })
      void window.api.mcpListServers().then(setMcp)
    }
    pull()
    return window.api.onSkillsChanged(pull)
    // MCP 的连断/启停由 onMcpChanged 在 mcpListServers 消费方广播；此处 open 内拉一次足够
  }, [open])

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

          {skills !== null && (
            <div className="plus-section">
              <div className="plus-title">当前开启的技能</div>
              {skills.length === 0 ? (
                <div className="plus-empty">无开启的技能</div>
              ) : (
                skills.map((s) => (
                  <div key={s.name} className="plus-item disabled" title="技能由模型按需自动调用；管理在设置页">
                    <span className="plus-check" />
                    <span className="plus-name">{s.name}</span>
                    <span className="plus-desc">{s.descriptionZh ?? s.description}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {mcp !== null && (
            <div className="plus-section">
              <div className="plus-title">当前开启的 MCP</div>
              {mcp.filter((s) => s.config.enabled !== false).length === 0 ? (
                <div className="plus-empty">无开启的 MCP 服务器</div>
              ) : (
                mcp
                  .filter((s) => s.config.enabled !== false)
                  .map((s) => (
                    <div key={s.config.name} className="plus-item disabled" title="MCP 工具每次调用前都会向你确认；管理在设置页">
                      <span className="plus-check" />
                      <span className="plus-name">{s.config.name}</span>
                      <span className="plus-desc">
                        {s.state === 'connected' ? `${s.tools.length} 个工具` : STATE_LABEL[s.state]}
                      </span>
                    </div>
                  ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
