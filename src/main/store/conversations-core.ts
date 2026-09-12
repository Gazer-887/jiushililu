import type { ChatMessage, ConversationMeta } from '@shared/ipc'

// 会话列表的**纯逻辑**（不依赖 electron / fs，便于单测）：
// 标题推导、工作区标签、按工作区分组与排序、存盘前的消息规整。

/**
 * 存盘前规整消息：**把"没有内容"的消息丢掉**。
 *
 * 这不是防御性编程，而是一个**真实存在的数据丢失渠道**：
 * 渲染端在用户按下发送时**立刻**塞一条 `{ role:'assistant', content:'' }` 的占位
 * （流式回复往它身上长，见 `renderer/src/store.ts` 的 `sendMessage`）。而落盘校验
 * 要求 `content` 至少 1 个字符 —— 于是「流式还没吐字就切会话 / 点停止 / 关窗口」
 * 这几条路**保存必然被拒**；调用方又写的是 `void persistActive()`，
 * 界面上一个字都不会出现，用户只会觉得"我这段对话怎么没存上"。
 *
 * 空内容消息在契约里本来就是非法的（发给模型那条路早就把它 filter 掉了），
 * 所以这里不是"放宽校验"，而是**在存储边界把不合法的东西挡在门外**：
 * 先规整、再上严格校验，两道各司其职。
 */
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.content.trim().length > 0)
}

/** 从首条消息推导会话标题：取首个非空行、去 Markdown 标记、截断 */
export function deriveTitle(firstMessage: string | undefined | null): string {
  const line = (firstMessage ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return '新对话'
  const cleaned = line
    .replace(/[#*`>_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
  const text = cleaned.length > 0 ? cleaned : '新对话'
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

/** 工作区展示名：取路径末段（侧边栏一行放得下），完整路径留给悬停提示 */
export function workspaceLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

export interface ConversationGroup {
  workspace: string
  label: string
  items: ConversationMeta[]
}

/** 按工作区分组：组内按更新时间倒序，组间按各自最新时间倒序（最近用过的排上面） */
export function groupByWorkspace(list: ConversationMeta[]): ConversationGroup[] {
  const map = new Map<string, ConversationMeta[]>()
  for (const c of list) {
    const bucket = map.get(c.workspace)
    if (bucket) bucket.push(c)
    else map.set(c.workspace, [c])
  }
  return [...map.entries()]
    .map(([workspace, items]) => ({
      workspace,
      label: workspaceLabel(workspace),
      items: [...items].sort((a, b) => b.updatedAt - a.updatedAt)
    }))
    .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0))
}
