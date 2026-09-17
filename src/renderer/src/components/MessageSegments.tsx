// 助手消息的分段渲染器（plan36 S3）：thinking / 工具 / 正文按真实到达顺序交错渲染。
// 类名沿用旧过程块（.reasoning-block/.tool-log/.tool-item），样式与门禁选择器不另起炉灶。
// 边界（审查坑 5）：正文段独占 .msg-content —— 通路 B「选中即记」读的就是它，
// 思考与工具文本绝不进 .msg-content，免得工具摘要混进记忆候选。

import { useState } from 'react'
import type { MessageSegment, ToolEvent } from '@shared/agent'
import MessageMarkdown from './MessageMarkdown'

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  // 展开态是**每段独立**的（旧版全局 showReasoning 在多段时会一起开关）
  const [open, setOpen] = useState(true)
  return (
    <div className="reasoning-block">
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="reasoning-mark" aria-hidden="true">
          ✻
        </span>
        思考过程
        <span className="reasoning-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <pre className="reasoning-body">{text}</pre>}
    </div>
  )
}

function ToolBlock({ event }: { event: ToolEvent }): JSX.Element {
  // MCP 来源徽标（plan44 决策 5）：mcp__<server>__<tool> 是 D-061 命名法 —— 拆出 server 挂徽标，
  // 名字区只留工具本名；"这是外部服务器的动作"必须一眼可辨
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(event.name)
  const displayName = mcp ? mcp[2] : event.name
  return (
    <div className="tool-log">
      <div className={`tool-item tool-${event.phase}`}>
        <span className="tool-icon">{event.phase === 'start' ? '◌' : event.phase === 'end' ? '✓' : '✗'}</span>
        {mcp && <span className="tool-mcp-badge">MCP·{mcp[1]}</span>}
        <span className="tool-name">{displayName}</span>
        <span className="tool-desc">
          {event.phase === 'start' ? event.detail || '执行中…' : event.summary ?? event.detail ?? ''}
        </span>
      </div>
    </div>
  )
}

export default function MessageSegments({ segments }: { segments: MessageSegment[] }): JSX.Element {
  return (
    <>
      {segments.map((sg, i) =>
        sg.kind === 'text' ? (
          <div className="msg-content" key={i}>
            <MessageMarkdown content={sg.text} />
          </div>
        ) : sg.kind === 'thinking' ? (
          <ThinkingBlock key={i} text={sg.text} />
        ) : (
          <ToolBlock key={i} event={sg.event} />
        )
      )}
    </>
  )
}
