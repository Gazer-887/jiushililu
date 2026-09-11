import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import type { SkillInfo, WorkspaceInfo } from '@shared/ipc'

// 新建任务页（P2）：一个简洁的初始选择页——工作区、模型、内置技能，
// 参考 opencode 的交互：中央输入框 + 下方一排可选 chips，选好直接开跑。

export default function NewTaskView(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createConversation = useAppStore((s) => s.createConversation)

  const [workspace, setWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getWorkspace().then((ws: WorkspaceInfo) => setWorkspace(ws.path))
    void window.api.listSkills().then(setSkills)
  }, [])

  useEffect(() => {
    if (settings?.model && !model) setModel(settings.model)
  }, [settings?.model, model])

  const pickDir = async (): Promise<void> => {
    const ws = await window.api.pickWorkspace()
    if (ws) setWorkspace(ws.path)
  }

  const toggleSkill = (name: string): void => {
    setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]))
  }

  const start = async (): Promise<void> => {
    if (busy) return
    if (!workspace || !model) return
    setBusy(true)
    try {
      const text = input.trim()
      await createConversation({
        workspace,
        model,
        skills: picked,
        ...(text ? { firstMessage: text } : {})
      })
      // 首条输入直接发出去（省一次点击）
      if (text) await useAppStore.getState().sendMessage(text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="new-task">
      <div className="new-task-hero">
        <h1>新建任务</h1>
        <p>行百里者半九十。选好工作区与模型，说清你想做的事。</p>
      </div>

      <div className="new-task-box">
        <textarea
          autoFocus
          value={input}
          placeholder="描述你想做的事…（Enter 开始，Shift+Enter 换行）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void start()
            }
          }}
        />

        <div className="new-task-controls">
          <button className="chip chip-ws" title={workspace} onClick={() => void pickDir()}>
            <span className="chip-label">工作区</span>
            <span className="chip-value">
              {workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : '选择目录'}
            </span>
            <span className="chip-caret">▾</span>
          </button>

          <label className="chip chip-model">
            <span className="chip-label">模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {settings?.model && <option value={settings.model}>{settings.model}</option>}
              {model && model !== settings?.model && <option value={model}>{model}</option>}
            </select>
          </label>

          <button className="start-btn" disabled={busy || !workspace || !model} onClick={() => void start()}>
            {busy ? '创建中…' : '开始'}
          </button>
        </div>
      </div>

      <div className="skill-picker">
        <div className="skill-title">技能（可多选，本会话启用）</div>
        {skills.length === 0 ? (
          <div className="skill-empty">未发现可用技能定义</div>
        ) : (
          <div className="skill-list">
            {skills.map((s) => (
              <label key={s.name} className={`skill-item ${picked.includes(s.name) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={picked.includes(s.name)}
                  onChange={() => toggleSkill(s.name)}
                />
                <span className="skill-name">{s.name}</span>
                <span className="skill-desc">{s.description}</span>
                {s.source === 'user' && <span className="skill-tag">自建</span>}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
