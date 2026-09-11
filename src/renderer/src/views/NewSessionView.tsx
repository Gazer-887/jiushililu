import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import WorkspaceChip from '../components/WorkspaceChip'
import PlusMenu from '../components/PlusMenu'

// 新建会话页（P2）：极简初始页——一个输入框 + 工作区/模型 + ＋号拓展。
// 设计原则（用户要求）：技能 / 子 Agent 不直接摆出来，收进「＋」按需选取；
// 页面上只保留"说清要做什么"必需的元素。

export default function NewSessionView(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createConversation = useAppStore((s) => s.createConversation)

  const [model, setModel] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (settings?.model && !model) setModel(settings.model)
  }, [settings?.model, model])

  const toggleSkill = (name: string): void => {
    setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]))
  }

  const start = async (): Promise<void> => {
    if (busy) return
    const ws = await window.api.getWorkspace()
    if (!ws.path || !model) return
    setBusy(true)
    try {
      const text = input.trim()
      await createConversation({
        workspace: ws.path,
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
        <h1>新建会话</h1>
        <p>行百里者半九十。说清你想做的事。</p>
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
          <PlusMenu picked={picked} onToggle={toggleSkill} />

          <WorkspaceChip />

          <label className="chip chip-model">
            <span className="chip-label">模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {settings?.model && <option value={settings.model}>{settings.model}</option>}
              {model && model !== settings?.model && <option value={model}>{model}</option>}
            </select>
          </label>

          <button className="start-btn" disabled={busy || !model} onClick={() => void start()}>
            {busy ? '创建中…' : '开始'}
          </button>
        </div>
      </div>

      {picked.length > 0 && (
        <div className="picked-hint">
          已启用能力：{picked.join('、')}
        </div>
      )}
    </div>
  )
}
