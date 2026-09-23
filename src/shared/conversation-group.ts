// 会话按工作区分组的**唯一真源**（plan54 #7 → 欠账 K27）。
// 侧栏（渲染进程）与主进程都要这份规则，而渲染层不能 import `src/main`（CI 无 Electron 二进制会炸）
// ⇒ 放 `src/shared/`。之前两边各写一份、注释互称"同一套规则"，实测规则会漂而单测只钉得住一份。

import type { ConversationMeta } from './ipc'

export interface ConversationGroup {
  workspace: string
  label: string
  items: ConversationMeta[]
}

/** 工作区展示名：取路径末段（侧边栏一行放得下），完整路径留给悬停提示 */
export function workspaceLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

/** 按工作区分组：组内按更新时间倒序，组间按各自最新一条倒序（最近用过的排上面） */
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
