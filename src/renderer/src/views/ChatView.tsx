import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore, usedTokens } from '../store'
import MessageMarkdown from '../components/MessageMarkdown'
import WorkspaceBar from '../components/WorkspaceBar'
import { ContextMeter, ModelSwitcher } from '../components/InputTools'

export default function ChatView() {
  const messages = useAppStore((s) => s.messages)
  const streaming = useAppStore((s) => s.streaming)
  const streamError = useAppStore((s) => s.streamError)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const stopStreaming = useAppStore((s) => s.stopStreaming)
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeId)
  const [input, setInput] = useState('')
  const [agentMode, setAgentMode] = useState(false)
  const [agentBusy, setAgentBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId])

  // 流式事件订阅：只在挂载时挂一次，卸载时清理
  useEffect(() => {
    const offChunk = window.api.onChatChunk((t) => useAppStore.getState().appendChunk(t))
    const offDone = window.api.onChatDone(() => useAppStore.getState().markDone())
    const offError = window.api.onChatError((m) => useAppStore.getState().markError(m))
    return () => {
      offChunk()
      offDone()
      offError()
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamError])

  const tokens = useMemo(() => usedTokens(messages), [messages])

  const submit = async (): Promise<void> => {
    const text = input
    if (!text.trim()) return
    setInput('')

    // Agent 模式（plan6 D3/D7）：独立上下文执行，单次报告回流
    // 注：本模式开关的取消属 D-032（通道合并），待那批落地后此处一并移除
    if (agentMode) {
      setAgentBusy(true)
      useAppStore.setState((s) => ({
        messages: [...s.messages, { role: 'user', content: `[Agent 任务] ${text}` }]
      }))
      try {
        const res = await window.api.runAgent({ task: text })
        const status =
          res.stopReason === 'completed'
            ? '已完成'
            : res.stopReason === 'error'
              ? '执行失败'
              : '达预算上限被停止'
        const tail = `（Agent：${res.agent} · ${res.rounds} 轮 · ${status}）`
        const content = res.ok ? `${res.output}\n\n${tail}` : `${res.error ?? '执行失败'}\n\n${tail}`
        useAppStore.setState((s) => ({
          messages: [...s.messages, { role: 'assistant', content }]
        }))
      } catch (err) {
        const msg = `Agent 调用失败：${err instanceof Error ? err.message : String(err)}`
        useAppStore.setState((s) => ({ messages: [...s.messages, { role: 'assistant', content: msg }] }))
      } finally {
        setAgentBusy(false)
        await useAppStore.getState().persistActive()
      }
      return
    }

    await sendMessage(text)
  }

  return (
    <div className="chat-view">
      <div className="chat-head">
        <WorkspaceBar />
        {active && (
          <div className="chat-head-meta">
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
      </div>

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
                m.content || (streaming ? '…' : '')
              )}
            </div>
          </div>
        ))}
        {streamError && <div className="chat-error">{streamError}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
        <div className="input-toolbar">
          <button
            className={`btn-mode ${agentMode ? 'active' : ''}`}
            title="Agent 模式：任务在独立上下文执行，可读写工作区（结果单次回流）"
            onClick={() => setAgentMode((v) => !v)}
          >
            {agentMode ? 'Agent 模式' : '对话模式'}
          </button>
          <ModelSwitcher />
          <ContextMeter used={tokens} />
        </div>
        <div className="input-row">
          <textarea
            value={input}
            placeholder={
              agentMode
                ? '描述一个任务，Agent 将独立执行（Enter 派发）'
                : '输入消息，Enter 发送，Shift+Enter 换行'
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!(streaming || agentBusy)) void submit()
              }
            }}
          />
          {streaming ? (
            <button className="btn-stop" onClick={() => void stopStreaming()}>
              停止
            </button>
          ) : agentBusy ? (
            <button className="btn-stop" disabled>
              Agent 执行中…
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
