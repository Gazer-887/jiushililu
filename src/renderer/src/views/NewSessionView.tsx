import { useEffect, useRef, useState } from 'react'
import { useAppStore, usedTokens } from '../store'
import { userTurnWithImages } from '@shared/attachment-block'
import type { Attachment } from '@shared/ipc'
import InputConsole from '../components/InputConsole'

// 新建任务页（P2）：一个输入控制台 + 技能勾选 —— 技能 / 子 Agent 不直接摆出来，收进「＋」按需选取（用户要求）。
// 输入框与对话页共用 InputConsole，形态完全一致；附件拼接也共用同一份函数（plan57 片①，此前两边各一份）。

export default function NewSessionView(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createConversation = useAppStore((s) => s.createConversation)

  const [model, setModel] = useState('')
  // 主 Agent（plan17）：null = 内核默认；创建时随会话落盘
  const [agent, setAgent] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 拖拽落点 = 整块新建任务页，不只是输入框那一小块
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (settings?.model && !model) setModel(settings.model)
  }, [settings?.model, model])

  const start = async (attachments: Attachment[]): Promise<void> => {
    if (busy) return
    const ws = await window.api.getWorkspace()
    if (!ws.path || !model) return
    // 正文与图片引用一次构造（片③，与对话页同一份 `userTurnWithImages`）
    const turn = userTurnWithImages(input.trim(), attachments)
    const text = turn.content
    setBusy(true)
    try {
      await createConversation({
        workspace: ws.path,
        model,
        ...(agent ? { agentName: agent } : {}),
        ...(text ? { firstMessage: text } : {}),
        ...(text && turn.parts ? { firstParts: turn.parts } : {})
      })
      // 首条输入直接发出去（省一次点击）。
      // ⚠️ skipAppend：首条已由 createConversation({ firstMessage }) 存进会话（还承担标题推导），
      //    这里若再追加，界面重复显示、模型收到 [user, user]（0.13.42 反馈实证）
      // 首条（含图片引用）已由 `createConversation` 落盘，这里只喊一声：`parts` 不再传，免得看着像追加第二条
      if (text) await useAppStore.getState().sendMessage(text, { skipAppend: true })
      setInput('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="new-task" ref={pageRef}>
      {/* 居中容器：用 margin:auto 而非 justify-content:center —— 后者在内容高于容器时会裁掉顶部且滚不上去 */}
      <div className="new-task-center">
        <div className="new-task-hero">
          <h1>行百里者半九十</h1>
          <p>从何来？向何去？</p>
        </div>

        <InputConsole
          autoFocus
          value={input}
          onChange={setInput}
          onSubmit={(atts) => void start(atts)}
          busy={busy}
          placeholder="描述你想做的事…（Enter 开始，Shift+Enter 换行）"
          usedTokens={usedTokens([])}
          selectedAgent={agent}
          onSelectAgent={setAgent}
          showWorkspace
          dropZone={pageRef}
        />

        {agent && <div className="picked-hint">本次会话由「{agent}」负责</div>}
      </div>
    </div>
  )
}
