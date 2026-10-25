import { expect, it } from 'vitest'
import { createConversationsRepo, type ConversationsBackend } from '../../src/main/store/conversations-core'
import type { ChatMessage, ConversationMeta } from '../../src/shared/ipc'

it('旧媒体消息没有messageId时，宿主只读返回稳定身份，原存档不改写', () => {
  const metas: Record<string, ConversationMeta> = {}
  const logs: Record<string, ChatMessage[]> = {}
  const backend: ConversationsBackend = {
    readMeta: () => metas, putMeta: (id, value) => { metas[id] = value }, removeMeta: id => { delete metas[id] },
    readMessages: id => logs[id] ?? [], writeMessages: (id, value) => { logs[id] = value }, removeMessages: id => { delete logs[id] }
  }
  const repo = createConversationsRepo(backend)
  const c = repo.createConversation({ workspace: '/owned', model: 'fixture' })
  repo.saveConversation(c.id, [{ role: 'user', content: 'legacy', parts: [{ type: 'image', ref: '20261014T120000-0-abc123.png', mime: 'image/png', bytes: 12 }] }])
  const first = repo.getConversation(c.id)!.messages[0].messageId
  expect(first).toMatch(/^legacy-/)
  expect(repo.getConversation(c.id)!.messages[0].messageId).toBe(first)
  expect(logs[c.id][0].messageId).toBeUndefined()
})
