// 助手消息的分段渲染器（plan36 S3）：thinking / 工具 / 正文按真实到达顺序交错渲染。
// 类名沿用旧过程块（.reasoning-block/.tool-log/.tool-item），样式与门禁选择器不另起炉灶。
// 边界（审查坑 5）：正文段独占 .msg-content —— 通路 B「选中即记」读的就是它，
// 思考与工具文本绝不进 .msg-content，免得工具摘要混进记忆候选。

import { useEffect, useState } from 'react'
import type { MessageSegment, ToolEvent, ToolImageRef } from '@shared/agent'
import type { OutcomeCode, ToolResultState } from '@shared/execution-outcome'
import { toolOutcomeText } from '@shared/exec-events'
import MessageMarkdown from './MessageMarkdown'
import FilePreviewCard from './FilePreviewCard'

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

/**
 * 一张截图（plan44 S2b）。存档里只有**受限文件名**，正文按需用 IPC 取 ——
 * 不把 base64 塞进消息：那等于每存一次档就把图片重写一遍（plan10 分层好不容易压下来的体积会反弹）。
 * 取不到就明说"取不到"，不留一个空白格子让人以为图是透明的。
 */
function ToolShot({ img }: { img: ToolImageRef }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    // 单行调用：结构守卫（no-dead-wiring）按整行匹配，跨行断句会让"渲染层真的调用了"这条判据假红
    void window.api.readMcpArtifact(img.name).then((url) => {
      if (!alive) return
      if (url) setSrc(url)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [img.name])
  const kb = Math.round(img.bytes / 1024)
  if (failed) {
    return <div className="tool-shot tool-shot-missing">截图已不在（{img.name}，{kb} KB）</div>
  }
  if (src === null) {
    return <div className="tool-shot tool-shot-loading">截图加载中…</div>
  }
  return (
    <figure className="tool-shot">
      <img src={src} alt={`${img.name}（${kb} KB）`} loading="lazy" />
      <figcaption>{kb} KB</figcaption>
    </figure>
  )
}

function toolIcon(outcome: ToolResultState, code?: OutcomeCode): string {
  if (outcome === 'succeeded') return '✓'
  if (code === 'token-limit' || code === 'output-limit') return '✂'
  switch (outcome) {
    case 'failed':
      return '✗'
    case 'denied':
    case 'cancelled':
      return '⊘'
    case 'unknown':
      return '?'
    default:
      return '·'
  }
}

export function toolStatus(event: Pick<ToolEvent, 'phase' | 'outcome' | 'code'>): {
  icon: string
  text: string
  className: string
} {
  const text = toolOutcomeText(event.outcome, event.code)
  const icon =
    event.phase === 'start' ? '◌' : event.outcome ? toolIcon(event.outcome, event.code) : event.phase === 'error' ? '✗' : '✓'
  return {
    icon,
    text,
    className: `tool-item tool-${event.phase}${event.outcome ? ` tool-outcome-${event.outcome}` : ''}`
  }
}

function ToolBlock({ event, conversationId }: { event: ToolEvent; conversationId?: string }): JSX.Element {
  // MCP 来源徽标（plan44 决策 5）：mcp__<server>__<tool> 是 D-061 命名法 —— 拆出 server 挂徽标，
  // 名字区只留工具本名；"这是外部服务器的动作"必须一眼可辨
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(event.name)
  const displayName = mcp ? mcp[2] : event.name
  // E28：phase 旧三值保持兼容；有 outcome 时以细分为准，旧事件不推断“肯定成功”。
  const status = toolStatus(event)
  return (
    <div className="tool-log">
      <div className={status.className}>
        <span className="tool-icon">{status.icon}</span>
        {mcp && <span className="tool-mcp-badge">MCP·{mcp[1]}</span>}
        <span className="tool-name">{displayName}</span>
        {status.text && <span className="tool-outcome">{status.text}</span>}
        <span className="tool-desc">
          {event.phase === 'start' ? event.detail || '执行中…' : event.summary ?? event.detail ?? ''}
        </span>
      </div>
      {event.images && event.images.length > 0 ? (
        <div className="tool-shots">
          {event.images.map((img) => (
            <ToolShot key={img.name} img={img} />
          ))}
        </div>
      ) : null}
      {/* plan74 Agent 产物入口：写/建类工具的可信路径 → 就地预览卡（读所属会话工作区当前文件） */}
      {event.phase === 'end' && event.artifactPaths && event.artifactPaths.length > 0 ? (
        <div className="tool-artifacts">
          {event.artifactPaths.map((rel) => (
            <FilePreviewCard
              key={rel}
              conversationId={conversationId}
              file={{
                assetId: '',
                name: rel.split('/').pop() || rel,
                mime: 'text/plain',
                bytes: 0,
                source: 'artifact',
                workspaceRel: rel
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function MessageSegments({
  segments,
  conversationId
}: {
  segments: MessageSegment[]
  conversationId?: string
}): JSX.Element {
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
          <ToolBlock key={i} event={sg.event} conversationId={conversationId} />
        )
      )}
    </>
  )
}
