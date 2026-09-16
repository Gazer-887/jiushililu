// 消息分段的纯函数构建器（plan36 S2）：流式事件按到达顺序长成 segments 数组。
// 放 shared 的理由：store 与 ChatView 两侧都要用，且纯函数才能不进 electron 地单测。
// ⚠️ 全部返回新数组/新对象——快照浅拷贝别名坑（plan36 §六.1），任何"就地改"都会让切走的会话被串改。

import type { ChatMessage } from './ipc'
import type { MessageSegment, ToolEvent } from './agent'

/** 追加 text 段：尾部同为 text 则合并（流式增量不产生碎段） */
export function appendSegmentText(segments: MessageSegment[] | undefined, text: string): MessageSegment[] {
  const list = segments ? segments.slice() : []
  const tail = list[list.length - 1]
  if (tail && tail.kind === 'text') list[list.length - 1] = { kind: 'text', text: tail.text + text }
  else list.push({ kind: 'text', text })
  return list
}

/** 追加 thinking 段：同上，同类相邻合并 */
export function appendSegmentThinking(segments: MessageSegment[] | undefined, text: string): MessageSegment[] {
  const list = segments ? segments.slice() : []
  const tail = list[list.length - 1]
  if (tail && tail.kind === 'thinking') list[list.length - 1] = { kind: 'thinking', text: tail.text + text }
  else list.push({ kind: 'thinking', text })
  return list
}

/** 工具段按 event.id 就地覆盖（start→end 是同一条卡片，不堆两条）；无同 id 则追加 */
export function upsertSegmentTool(segments: MessageSegment[] | undefined, event: ToolEvent): MessageSegment[] {
  const list = segments ? segments.slice() : []
  const idx = list.findIndex((sg) => sg.kind === 'tool' && sg.event.id === event.id)
  if (idx >= 0) list[idx] = { kind: 'tool', event }
  else list.push({ kind: 'tool', event })
  return list
}

/** 合同不变式：content 恒等于全部 text 段拼接（模型侧与旧渲染只看 content） */
export function textFromSegments(segments: MessageSegment[] | undefined): string {
  if (!segments) return ''
  return segments.filter((sg): sg is { kind: 'text'; text: string } => sg.kind === 'text').map((sg) => sg.text).join('')
}

/** 锚定"最后一条消息是 assistant"才更新（与 appendToTail 同语义：占位没种上就不落字） */
function updateTailAssistant(messages: ChatMessage[], fn: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return messages
  const next = messages.slice()
  next[next.length - 1] = fn(last)
  return next
}

/** 旧数据就地迁移：无 segments 但有 content 的消息，把 content 视为首个 text 段（合同自此恒成立） */
function ensureSegments(m: ChatMessage): MessageSegment[] {
  return m.segments ?? (m.content ? [{ kind: 'text', text: m.content }] : [])
}

export function applyAssistantChunk(messages: ChatMessage[], text: string): ChatMessage[] {
  return updateTailAssistant(messages, (m) => ({
    ...m,
    content: m.content + text,
    segments: appendSegmentText(ensureSegments(m), text)
  }))
}

export function applyAssistantThinking(messages: ChatMessage[], text: string): ChatMessage[] {
  return updateTailAssistant(messages, (m) => ({ ...m, segments: appendSegmentThinking(ensureSegments(m), text) }))
}

export function applyAssistantTool(messages: ChatMessage[], event: ToolEvent): ChatMessage[] {
  return updateTailAssistant(messages, (m) => ({ ...m, segments: upsertSegmentTool(ensureSegments(m), event) }))
}
