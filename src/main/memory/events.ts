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
  | { kind: 'delete'; conversationId: string | null; name: string; by: 'user' | 'model' }
  | { kind: 'flag'; conversationId: string | null; name: string }
  | { kind: 'inject'; conversationId: string | null; names: string[] }

export type MemoryEvent = MemoryEventPayload & { at: string }

/** 注入去重键：名字集合的稳定串（顺序无关 —— 排序后再拼） */
export function injectionKey(names: string[]): string {
  return [...names].sort().join('\u0000')
}

/** 序列化成**一行**。⛔ 不许出现裸换行 —— 那会让一条事件裂成两行、后面全部错位 */
export function serializeEvent(event: MemoryEvent): string {
  return JSON.stringify(event)
}

const KINDS = new Set(['write', 'recall', 'delete', 'flag', 'inject'])

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

/** 注入段的字节数（写进 `inject` 事件，供注入税核对） */
export function blockBytes(block: string | null): number {
  return block === null ? 0 : new TextEncoder().encode(block).length
}
