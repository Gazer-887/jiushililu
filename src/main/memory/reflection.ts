// 反思执行器（批 2）：纯逻辑 —— 不 import electron / electron-store（守卫乙覆盖）。
// 职责：① 调 chat（messages 已组装好，含 system + 历史）② 解析输出 ③ 找冲突填 conflictWith。
// ⚠️ 不组装 system prompt（装配层的事）；不直接 saveCandidate（交装配层）；
//    不留痕（不 import log —— 留痕由调用方做）。

import type { ChatMessage } from '@shared/ipc'
import { MEMORY_CLASSES, type MemoryCandidate, type MemoryClass } from '@shared/memory'
import { historyForModel } from '../agent/context'
import type { MemoryRepo } from './memory-core'

export interface ReflectChat {
  (messages: ChatMessage[]): Promise<{ content: string }>
}

export interface ReflectInput {
  id: string
  messages: ChatMessage[]
  bodyBytes: number
  memory: MemoryRepo
}

export interface ReflectOutput {
  candidates: MemoryCandidate[]
}

/** 前置门阈值：会话正文小于此值不调反思（空话不值得反思） */
const MIN_BODY_BYTES = 2048

export function createReflectionRunner(opts: { chat: ReflectChat }): {
  reflect: (input: ReflectInput) => Promise<ReflectOutput>
} {
  const chat = opts.chat
  return {
    async reflect(input) {
      if (input.bodyBytes < MIN_BODY_BYTES) {
        return { candidates: [] }
      }

      let result: { content: string }
      try {
        // 盘上的正文可能带着被中断那一轮留下的空串，出境前整形 —— 反思不经主循环，那道整形罩不到它
        result = await chat(historyForModel(input.messages))
      } catch {
        // chat 调用失败 → 返回空（留痕由调用方做，本文件不 import log）
        return { candidates: [] }
      }

      let parsed: unknown
      try {
        // 模型可能把 JSON 裹在 ```json ``` 里 —— 剥一下（JSON.parse 不认围栏）
        const text = stripCodeFence(result.content)
        parsed = JSON.parse(text)
      } catch {
        return { candidates: [] }
      }

      if (!Array.isArray(parsed)) return { candidates: [] }

      const candidates: MemoryCandidate[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const c = normalizeCandidate(item as Record<string, unknown>)
        if (c === null) continue
        // 找冲突填 conflictWith（撞名就标，让用户决定是覆盖还是放弃）
        const conflict = input.memory.findConflict(c.name)
        if (conflict) {
          c.conflictWith = conflict.file
        }
        candidates.push(c)
      }
      return { candidates }
    }
  }
}

/** 剥 ```json ... ``` 围栏（模型常加，但 JSON.parse 不认） */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const end = trimmed.lastIndexOf('```')
  if (end <= 3) return trimmed
  const inner = trimmed.slice(3, end)
  // 去掉语言标记（json / jsonc 等）：第一个换行之前是围栏头，之后才是正文
  const newlineAt = inner.indexOf('\n')
  return newlineAt >= 0 ? inner.slice(newlineAt + 1) : inner
}

// plan25 D-071：与 shared 契约同源（含 profile —— 反思可产出画像候选）。
// ⚠️ 此前这里硬编码三类，扩 class 时若不改它，反思通路会把新分类静默降级成 default。
const VALID_CLASSES: ReadonlySet<MemoryClass> = new Set(MEMORY_CLASSES)

/** 把松散的对象收敛成 MemoryCandidate；不合法返回 null */
function normalizeCandidate(raw: Record<string, unknown>): MemoryCandidate | null {
  const name = typeof raw['name'] === 'string' ? raw['name'] : ''
  const description = typeof raw['description'] === 'string' ? raw['description'] : ''
  const body = typeof raw['body'] === 'string' ? raw['body'] : ''
  if (name.length === 0 || description.length === 0 || body.length === 0) return null
  const classRaw = raw['class']
  const cls: MemoryClass = typeof classRaw === 'string' && VALID_CLASSES.has(classRaw as MemoryClass)
    ? (classRaw as MemoryClass)
    : 'default'
  const evidence = normalizeEvidence(raw['evidence'])
  return {
    name,
    description,
    class: cls,
    body,
    ...(evidence ? { evidence } : {})
  }
}

function normalizeEvidence(raw: unknown): { conversationId: string; turnIndex?: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const conversationId = typeof r['conversationId'] === 'string' ? r['conversationId'] : ''
  if (conversationId.length === 0) return null
  const turnRaw = r['turnIndex']
  const turnIndex =
    typeof turnRaw === 'number' && Number.isInteger(turnRaw) && turnRaw >= 0 ? turnRaw : undefined
  return turnIndex === undefined ? { conversationId } : { conversationId, turnIndex }
}
