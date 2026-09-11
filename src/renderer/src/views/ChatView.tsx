import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, usedTokens } from '../store'
import MessageMarkdown from '../components/MessageMarkdown'
import { ContextMeter, ModelSwitcher } from '../components/InputTools'

// 对话页（D-032：单一通道）——不再有"对话/Agent 模式"开关：
// 用不用工具由模型自己决定；界面负责**让过程可见**（工具执行卡片）。

export default function ChatView() {
  const messages = useAppStore((s) => s.messages)
  const streaming = useAppStore((s) => s.streaming)
  const streamError = useAppStore((s) => s.streamError)
  const toolEvents = useAppStore((s) => s.toolEvents)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const stopStreaming = useAppStore((s) => s.stopStreaming)
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeId)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId])

  // 流式与工具事件订阅：只在挂载时挂一次，卸载时清理
  useEffect(() => {
    const offChunk = window.api.onChatChunk((t) => useAppStore.getState().appendChunk(t))
    const offDone = window.api.onChatDone(() => useAppStore.getState().markDone())
    const offError = window.api.onChatError((m) => useAppStore.getState().markError(m))
    const offTool = window.api.onChatTool((evt) => useAppStore.getState().pushToolEvent(evt))
    return () => {
      offChunk()
      offDone()
      offError()
      offTool()
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamError, toolEvents])

  const tokens = useMemo(() => usedTokens(messages), [messages])

  const submit = async (): Promise<void> => {
    const text = input
    if (!text.trim() || streaming) return
    setInput('')
    await sendMessage(text)
  }

  return (
    <div className="chat-view">
      {active && (
        <div className="chat-head">
          <span className="chat-title" title={active.title}>
            {active.title}
          </span>
          {active.skills.length > 0 && (
            <span className="chat-skills" title={active.skills.join('、')}>
              技能 {active.skills.length}
            </span>
          )}
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <h2>九十里路</h2>
            <p>行百里者半九十。说说你想做什么。</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-role">{m.role === 'user' ? '你' : '助手'}</div>
            <div className="msg-content">
              {m.role === 'assistant' && m.content ? (
                <MessageMarkdown content={m.content} />
              ) : (
                m.content || (streaming && i === messages.length - 1 ? '…' : '')
              )}
            </div>
          </div>
        ))}

        {/* 工具执行活动：执行中转圈，完成折叠一行，失败展开原因 */}
        {toolEvents.length > 0 && (
          <div className="tool-log">
            {toolEvents.map((e) => (
              <div key={e.id} className={`tool-item tool-${e.phase}`}>
                <span className="tool-icon">
                  {e.phase === 'start' ? '◌' : e.phase === 'end' ? '✓' : '✗'}
                </span>
                <span className="tool-name">{e.name}</span>
                <span className="tool-desc">
                  {e.phase === 'start' ? '执行中…' : (e.summary ?? '')}
                </span>
              </div>
            ))}
          </div>
        )}

        {streamError && <div className="chat-error">{streamError}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
        <div className="input-toolbar">
          <ModelSwitcher />
          <ContextMeter used={tokens} />
        </div>
        <div className="input-row">
          <textarea
            value={input}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {streaming ? (
            <button className="btn-stop" onClick={() => void stopStreaming()}>
              停止
            </button>
          ) : (
            <button className="btn-send" disabled={!input.trim()} onClick={() => void submit()}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
