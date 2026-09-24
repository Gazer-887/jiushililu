// 记忆事件流（plan19 §7.1）。纯逻辑：事件形状、单行序列化、坏行解析、注入去重键。
// ⚠️ 为什么必须**批 1 就埋**：事后补不回来 —— 没有历史事件，存活率 / 使用率 / 重复纠正率一个都算不出来。
// ⚠️ 落盘是**追加型**（不是原子写）：半行尾部可容忍（读时跳过坏行即可），与会话正文的取舍不同。

import type { MemoryClass, MemoryOrigin } from '@shared/memory'

/**
 * 事件载荷（不含时间戳）。`conversationId` 允许为 null —— 界面上的手工操作没有"当前会话"。
 * ⚠️ `inject` 带的是**名集合**而不是条数：去重靠它（§7.1 要求"仅在注入集合变化时写"）。
 */
export type MemoryEventPayload =
  | {
      kind: 'write'
      conversationId: string | null
      name: string
      origin: MemoryOrigin
      cls: MemoryClass
    }
  | { kind: 'write'; conversationId: string | null; name: string; rejected: true; reason: string }
  | { kind: 'recall'; conversationId: string | null; name: string; found: boolean }
  | {
      kind: 'delete'
      conversationId: string | null
      name: string
      by: 'user' | 'model' | 'system'
      /**
       * plan55 片④：这条是被**合并稿**吸收掉的（值 = 合并稿的 name）。
       * 有了它，"存活率掉了一截"才答得出为什么 —— 否则合并看起来就像用户删了一批。
       * ⚠️ 记 name 不记 file 路径（与 `conflict` 同一理由：路径含用户名）。
       */
      mergedInto?: string
      /**
       * 被删的是**候选**（从未生效、也从未计入 `written`）⇒ 存活率这笔账里它不该出现。
       * ⚠️ 与 `mergedInto` 分两个字段是有意的：那个答"为什么走的"，这个答"该不该记账"。
       *    合成一个的话，`merge()` 并掉一条**已生效**旧条目时也想标它，就会把真丢失漏掉。
       */
      candidate?: true
    }
  // plan53 片 1：**自动遗忘 = 可逆归档**。与 `delete` 分家是因为存活率把 delete 记成"丢失"，
  // 而一条还能一键恢复的东西不该进那笔账（R4）。用户手删仍记 `delete`。
  | { kind: 'archive'; conversationId: string | null; name: string; by: 'system' | 'user' }
  | { kind: 'flag'; conversationId: string | null; name: string }
  | { kind: 'inject'; conversationId: string | null; names: string[] }
  // 批 2：候选批准（name=新候选 name，oldName=被覆盖的旧记忆 name）
  | { kind: 'approve'; conversationId: string | null; name: string; oldName: string }
  // 批 2：反思发现冲突（name=候选 name，oldName=被撞的旧记忆 name）
  // ⚠️ 只记 name 不记 file 路径（审查 G P2：file 路径含用户名）
  | { kind: 'conflict'; conversationId: string | null; name: string; oldName: string }
  // ── 批 3：Playbook 事件（与 memory 事件同结构，前缀区分；事件文件物理隔离）──
  | { kind: 'playbook_write'; conversationId: string | null; name: string; origin: string; cls: string }
  | { kind: 'playbook_write'; conversationId: string | null; name: string; rejected: true; reason: string }
  | { kind: 'playbook_recall'; conversationId: string | null; name: string; found: boolean }
  | { kind: 'playbook_inject'; conversationId: string | null; names: string[] }
  // ── 批 4：纠正事件 ──
  | { kind: 'correct'; conversationId: string | null; name: string; turnIndex?: number }

export type MemoryEvent = MemoryEventPayload & { at: string }

/** 注入去重键：名字集合的稳定串（顺序无关 —— 排序后再拼） */
export function injectionKey(names: string[]): string {
  return [...names].sort().join('\u0000')
}

/** 序列化成**一行**。⛔ 不许出现裸换行 —— 那会让一条事件裂成两行、后面全部错位 */
export function serializeEvent(event: MemoryEvent): string {
  return JSON.stringify(event)
}

const KINDS = new Set([
  'write', 'recall', 'delete', 'archive', 'flag', 'inject', 'approve', 'conflict',
  'playbook_write', 'playbook_recall', 'playbook_inject',
  'correct'
])

/**
 * 解析一行。坏行一律返回 `null`（读时跳过）—— 追加型日志的半行尾部是**预期内**的，
 * 不是故障。但"跳过"必须被调用方数出来，否则就成了静默丢。
 */
export function parseEventLine(line: string): MemoryEvent | null {
  const text = line.trim()
  if (text.length === 0) return null
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return null
    if (typeof raw['kind'] !== 'string' || !KINDS.has(raw['kind'])) return null
    if (typeof raw['at'] !== 'string') return null
    return raw as unknown as MemoryEvent
  } catch {
    return null
  }
}

