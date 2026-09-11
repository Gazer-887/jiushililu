import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  Conversation,
  ConversationCreateInput,
  ConversationMeta
} from '@shared/ipc'
import { deriveTitle } from './conversations-core'

// 会话持久化（P2 侧边栏）：一个「任务」= 一条会话，绑定一个工作区。
// 存储用 electron-store（JSON），按 id 存全量会话（含消息体）。

interface ConversationStore {
  conversations?: Record<string, Conversation>
}

const store = new Store<ConversationStore>({ name: 'conversations' })

function all(): Record<string, Conversation> {
  return store.store.conversations ?? {}
}

function toMeta(c: Conversation): ConversationMeta {
  const { messages, ...meta } = c
  return { ...meta, messageCount: messages.length }
}

export function listConversations(): ConversationMeta[] {
  return Object.values(all()).map(toMeta)
}

export function getConversation(id: string): Conversation | null {
  return all()[id] ?? null
}

export function createConversation(input: ConversationCreateInput): Conversation {
  const now = Date.now()
  const messages: ChatMessage[] = input.firstMessage?.trim()
    ? [{ role: 'user', content: input.firstMessage.trim() }]
    : []
  const conversation: Conversation = {
    id: randomUUID(),
    title: deriveTitle(input.firstMessage),
    workspace: input.workspace,
    model: input.model,
    skills: input.skills,
    createdAt: now,
    updatedAt: now,
    messageCount: messages.length,
    messages
  }
  store.set('conversations', { ...all(), [conversation.id]: conversation })
  return conversation
}

/**
 * 保存消息体。标题为默认值时，用首条用户消息自动补一个（用户没手动改过才覆盖）。
 */
export function saveConversation(id: string, messages: ChatMessage[]): ConversationMeta | null {
  const current = all()[id]
  if (!current) return null
  const firstUser = messages.find((m) => m.role === 'user')?.content
  const shouldRetitle = current.title === '新对话' && Boolean(firstUser)
  const next: Conversation = {
    ...current,
    messages,
    messageCount: messages.length,
    updatedAt: Date.now(),
    title: shouldRetitle ? deriveTitle(firstUser) : current.title
  }
  store.set('conversations', { ...all(), [id]: next })
  return toMeta(next)
}

export function renameConversation(id: string, title: string): ConversationMeta | null {
  const current = all()[id]
  if (!current) return null
  const clean = title.trim().slice(0, 60)
  if (clean.length === 0) return toMeta(current)
  const next: Conversation = { ...current, title: clean, updatedAt: Date.now() }
  store.set('conversations', { ...all(), [id]: next })
  return toMeta(next)
}

export function deleteConversation(id: string): void {
  const rest = all()
  if (!(id in rest)) return
  delete rest[id]
  store.set('conversations', rest)
}

/** 历史会话用过的工作区路径集合——用于收紧 workspace:set-known 的权限面 */
export function knownWorkspaces(): string[] {
  return [...new Set(Object.values(all()).map((c) => c.workspace))]
}
