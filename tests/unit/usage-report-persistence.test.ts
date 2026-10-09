// 判据13a：真文件系统保存/重装配；只操作本测试创建的统计夹具。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConversationsRepo } from '@main/store/conversations-core'
import { createFsConversationsBackend, metaFilePath } from '@main/store/conversations-fs'
import { addUsage, mergeOptionalMax, mergeUsageHalves } from '@shared/usage'

const roots: string[] = []
const messages = [{ role: 'user' as const, content: '统计来源夹具。' }]

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jsl-usage-persist-'))
  roots.push(root)
  const backend = createFsConversationsBackend(root)
  const repo = createConversationsRepo(backend)
  const conversation = repo.createConversation({
    workspace: root,
    model: 'synthetic-model',
    skills: []
  })
  const reopen = () => createConversationsRepo(createFsConversationsBackend(root))
  return { root, repo, backend, conversation, reopen }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-usage-persist-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('来源与统计字段必须沿保存链重启恢复', () => {
  it('厂商明确报告0：来源与完整性保留，重启后仍是有效0', () => {
    const { repo, conversation, reopen } = setup()
    const stats = {
      usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, reasoningTokens: 0 },
      usageReported: true,
      usageComplete: true
    }
    repo.saveConversation(conversation.id, messages, stats)
    expect(reopen().getConversation(conversation.id)).toMatchObject(stats)
  })

  it('仅本地估算：不造厂商usage，记忆税、节省与档位重启保留', () => {
    const { repo, conversation, reopen } = setup()
    const stats = {
      usageReported: false,
      usageComplete: false,
      avoidedTokens: 99,
      memoryTokens: 321,
      tokenTier: 'light' as const
    }
    repo.saveConversation(conversation.id, messages, stats)
    const restored = reopen().getConversation(conversation.id)
    expect(restored).toMatchObject(stats)
    expect(restored?.usage).toBeUndefined()
  })

  it('重复保存不丢cache/reasoning，按完整快照逐字段取大', () => {
    const { repo, conversation, reopen } = setup()
    repo.saveConversation(conversation.id, messages, {
      usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 2, reasoningTokens: 0 }
    })
    repo.saveConversation(conversation.id, messages, {
      usage: { promptTokens: 20, completionTokens: 3, cachedPromptTokens: 5, reasoningTokens: 1 }
    })
    expect(reopen().getConversation(conversation.id)?.usage).toEqual({
      promptTokens: 20,
      completionTokens: 3,
      cachedPromptTokens: 5,
      reasoningTokens: 1
    })
  })

  it('明确可选0不变成缺字段', () => {
    const { repo, conversation, reopen } = setup()
    repo.saveConversation(conversation.id, messages, {
      usage: { promptTokens: 10, completionTokens: 2 }
    })
    repo.saveConversation(conversation.id, messages, {
      usage: { promptTokens: 20, completionTokens: 3, cachedPromptTokens: 0, reasoningTokens: 0 }
    })
    expect(reopen().getConversation(conversation.id)?.usage).toEqual({
      promptTokens: 20,
      completionTokens: 3,
      cachedPromptTokens: 0,
      reasoningTokens: 0
    })
  })

  it('已观察漏报不被晚到完整标记洗掉，已报合计保持', () => {
    const { repo, conversation, reopen } = setup()
    const partial = {
      usage: { promptTokens: 10, completionTokens: 2 },
      usageReported: true,
      usageComplete: false
    }
    repo.saveConversation(conversation.id, messages, partial)
    const stale = {
      usage: { promptTokens: 8, completionTokens: 1 },
      usageReported: true,
      usageComplete: true
    }
    repo.saveConversation(conversation.id, messages, stale)
    expect(reopen().getConversation(conversation.id)).toMatchObject({
      usage: partial.usage,
      usageReported: true,
      usageComplete: false
    })
  })

  it('不给统计不抹已有来源、估算及档位', () => {
    const { repo, conversation, reopen } = setup()
    const stats = {
      usage: { promptTokens: 7, completionTokens: 1 },
      usageReported: true,
      usageComplete: true,
      memoryTokens: 42,
      avoidedTokens: 2,
      tokenTier: 'rich' as const
    }
    repo.saveConversation(conversation.id, messages, stats)
    repo.saveConversation(conversation.id, [...messages, { role: 'assistant', content: '完成。' }])
    expect(reopen().getConversation(conversation.id)).toMatchObject(stats)
  })

  it('只读旧全0记录不擅自重写数值或迁移schema', () => {
    const { root, repo, backend, conversation } = setup()
    backend.putMeta(conversation.id, {
      ...conversation,
      usage: { promptTokens: 0, completionTokens: 0 },
      memoryTokens: 42
    })
    const before = readFileSync(metaFilePath(root))
    expect(repo.listConversations()[0]?.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
    expect(readFileSync(metaFilePath(root))).toEqual(before)
    expect(JSON.parse(before.toString()).schemaVersion).toBe(2)
  })
})

describe('明确未知不能在快照合并后变成加法单位元', () => {
  it('双方未知保留明确null；双方根本无字段仍是undefined', () => {
    expect(mergeOptionalMax(null, null)).toBeNull()
    expect(mergeOptionalMax(null, undefined)).toBeNull()
    expect(mergeOptionalMax(undefined, undefined)).toBeUndefined()
    expect(mergeOptionalMax(null, 0)).toBe(0)
  })

  it('合并后的未知不能让下一份已知被误称全部累计', () => {
    const unknown = mergeUsageHalves(
      { promptTokens: 10, completionTokens: 0, cachedPromptTokens: null },
      { promptTokens: 0, completionTokens: 3, cachedPromptTokens: null }
    )
    const total = addUsage(unknown, { promptTokens: 5, completionTokens: 1, cachedPromptTokens: 0 })
    expect(total.cachedPromptTokens).toBeNull()
  })
})
