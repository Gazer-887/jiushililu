import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveReflectModel } from '@main/memory/reflection'
import { sumInjectionTax } from '@main/memory/inject'
import { createMemoryStore } from '@main/store/memory-store'
import { createFsConversationsBackend, nodeFsAdapter } from '@main/store/conversations-fs'
import { createConversationsRepo } from '@main/store/conversations-core'
import type { ChatMessage } from '@shared/ipc'

/**
 * K14 / K15 / K16 / K17 的判据。四条同族：**接口声明了、界面格子也建好了，装配那一段没人接**。
 * 这类缺陷的共同点是"任何一道闸都不会红" —— 所以每条都要自己长出红的能力。
 */

const ROOT = process.cwd()
const msgs: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(2200) }]

describe('K14：反思用哪个模型，得真的听设置', () => {
  it('留空 / 全空白 → 跟随对话模型', () => {
    expect(resolveReflectModel('gpt-a', undefined)).toBe('gpt-a')
    expect(resolveReflectModel('gpt-a', null)).toBe('gpt-a')
    expect(resolveReflectModel('gpt-a', '   ')).toBe('gpt-a')
  })

  it('填了模型名 → 覆盖（并且两侧空白都吃掉，别让尾随空格变成另一个模型）', () => {
    expect(resolveReflectModel('gpt-a', 'cheap-mini')).toBe('cheap-mini')
    expect(resolveReflectModel('gpt-a', '  cheap-mini ')).toBe('cheap-mini')
  })

  it('装配点真的调了它 —— 以前 createReflectChat 读都不读这个设置项', () => {
    const src = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    expect(src, 'createReflectChat 没再接反思模型').toMatch(/resolveReflectModel\(base\.model,\s*getReflectionModel\(\)\)/)
  })
})

describe('K15：反思用量要有来源，也要只长不缩', () => {
  it('reflect 把厂商用量随候选一起交出来', async () => {
    const chat = vi.fn(async () => ({
      content: '[]',
      usage: { promptTokens: 120, completionTokens: 30 }
    }))
    const dir = mkdtempSync(join(tmpdir(), 'k15-mem-'))
    try {
      const seen: Array<[string, number]> = []
      // 走装配层那条回调：以前它全仓零调用点
      const store = createMemoryStore(dir, nodeFsAdapter, {
        reflectChat: chat,
        conversationsExists: () => true,
        getConversationForReflect: () => ({ messages: msgs, bodyBytes: 4096 }),
        onReflectionUsage: (id, u) => seen.push([id, u.promptTokens + u.completionTokens])
      })
      store.enqueueReflection('c9')
      await store.runReflection('c9')
      expect(seen, '反思用量没有任何来源 —— 这就是 K15').toEqual([['c9', 150]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落盘：逐字段只长不缩，会话不存在返回 null 且不复活', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k15-repo-'))
    try {
      const repo = createConversationsRepo(createFsConversationsBackend(dir))
      const meta = repo.createConversation({ title: 'T', workspace: '/w' })
      repo.addReflectionUsage(meta.id, { promptTokens: 100, completionTokens: 20 })
      // 晚到的旧快照不许让账倒退，也不许把另一半抹成 0
      const after = repo.addReflectionUsage(meta.id, { promptTokens: 60, completionTokens: 45 })
      expect(after?.reflectionUsage).toEqual({ promptTokens: 100, completionTokens: 45 })
      expect(repo.addReflectionUsage('不存在的那条', { promptTokens: 9, completionTokens: 9 })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('K16 / K17：装配那一段接上了没有（源码结构守卫）', () => {
  /**
   * 这两处的调用点都在真进程里（`runner.ts` 组工具、`ipc.ts` 收尾发 done），单测起不来，
   * 所以退一档查源码：判据挡的是**改着改着又漏掉**，不替代行为测试。
   */
  it('K16：建记忆工具时把本轮原话传下去（纠正识别才有输入）', () => {
    const src = readFileSync(join(ROOT, 'src/main/agent/runner.ts'), 'utf8')
    const at = src.indexOf('createMemoryTools({')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 700)).toContain('lastUserMessage')
  })

  it('K17：注入税 = 记忆段 + 手册段，两边都算', () => {
    const src = readFileSync(join(ROOT, 'src/main/ipc.ts'), 'utf8')
    expect(src).toMatch(/sumInjectionTax\(estimateMemoryTokens\(memoryBlock\),\s*estimatePlaybookTokens\(playbookBlock\)\)/)
  })

  it('sumInjectionTax 自己：负数与非有限值当没有，不许倒扣', () => {
    expect(sumInjectionTax(10, 5)).toBe(15)
    expect(sumInjectionTax(0, 0)).toBe(0)
    expect(sumInjectionTax(-3, 7)).toBe(7)
    expect(sumInjectionTax(Number.NaN, 4)).toBe(4)
  })
})
