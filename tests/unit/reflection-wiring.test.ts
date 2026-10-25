import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

describe('K15：反思用量要有来源，落盘要逐次累加', () => {
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

  it('落盘：多次反思逐字段累加，会话不存在返回 null 且不复活', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k15-repo-'))
    try {
      const repo = createConversationsRepo(createFsConversationsBackend(dir))
      const meta = repo.createConversation({ title: 'T', workspace: '/w' })
      repo.addReflectionUsage(meta.id, { promptTokens: 100, completionTokens: 20 })
      // 每次反思报的是**本次**用量，反思过两次就是两次的和（取 max 会把账读成"最大单次"）
      const after = repo.addReflectionUsage(meta.id, { promptTokens: 60, completionTokens: 45 })
      expect(after?.reflectionUsage).toEqual({ promptTokens: 160, completionTokens: 65 })
      expect(repo.addReflectionUsage('不存在的那条', { promptTokens: 9, completionTokens: 9 })).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('装配点的最后一跳：回调真的落到会话元数据（断这一跳时上面两条还是全绿的）', () => {
    const src = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    const at = src.indexOf('onReflectionUsage:')
    expect(at, 'createMemoryStore 又没接 onReflectionUsage —— 用量牌那格会永远是空的').toBeGreaterThan(
      -1
    )
    expect(src.slice(at, at + 200)).toMatch(/addReflectionUsage\(conversationId,\s*usage\)/)
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

// ── S2-20 追加：store 级来源装配与持久化（S2-40 承接，不改原 K14–K17 判据）──────
// 目的：把"执行器绑定 input.id"这条上提到装配层 —— 走真 createMemoryStore + 真隔离临时根，
// 证候选落盘、重建 store 后仍只有真实会话，且用量/出队/事件/失败语义不回归。
describe('S2-20 装配：候选来源由 store 绑定真实会话（伪造来源一律不采信）', () => {
  const msgsBig: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(2200) }]
  const forged = (name: string): Record<string, unknown> => ({
    name,
    description: `${name} 的描述`,
    class: 'default',
    body: `${name} 的正文`,
    evidence: { conversationId: 'forged-c9', turnIndex: 99 }
  })

  /**
   * 隔离临时根 + 收尾断言父目录是系统 tmp、前缀合法（同 memory-runtime 纪律）。
   * ⚠️ 必须 await 内部 Promise 再进 finally：写成同步 `return run(dir)`，async 体一 `await`
   *    就会先跑 finally 把目录删掉，后面整段操作全落空（本单实测踩过）。
   */
  async function withTempRoot<T>(prefix: string, run: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    try {
      return await run(dir)
    } finally {
      expect(resolve(dirname(dir)), '临时根的父目录必须是系统 tmp（判错即抛在删除之前）').toBe(resolve(tmpdir()))
      expect(basename(dir).startsWith(prefix)).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reflect 写入候选：evidence 只能是输入会话 A，且无 turnIndex；多候选逐个绑定', async () => {
    await withTempRoot('s220-wiring-', async (dir) => {
      const chat = vi.fn(async () => ({
        content: JSON.stringify([forged('cand-a'), forged('cand-b')]),
        usage: { promptTokens: 11, completionTokens: 7 }
      }))
      const usage: Array<[string, number]> = []
      const store = createMemoryStore(dir, nodeFsAdapter, {
        reflectChat: chat,
        conversationsExists: () => true,
        getConversationForReflect: () => ({ messages: msgsBig, bodyBytes: 4096 }),
        onReflectionUsage: (id, u) => usage.push([id, u.promptTokens + u.completionTokens])
      })
      expect(store.enqueueReflection('conv-A')).toBe(true)
      const ranResult = await store.runReflection('conv-A')
      expect(ranResult, '反思应真消费掉这一项').toBe(true)

      const cands = store.list().candidates
      expect(cands.map((c) => c.name).sort()).toEqual(['cand-a', 'cand-b'])
      for (const c of cands) {
        expect(c.evidence, `${c.name} 必须绑定真会话 A`).toEqual({ conversationId: 'conv-A' })
        expect(c.evidence?.turnIndex, '模型自报轮次不得写入').toBeUndefined()
      }
      // 出队与用量语义不回归
      expect(store.dequeueReflection(), '队列应已空').toBeNull()
      expect(usage, '用量仍逐次上报').toEqual([['conv-A', 18]])
      // reflection_sample 事件仍在（completed + 候选数）
      const eventsFile = join(dir, 'memory', 'events.jsonl')
      const lines = readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
      const samples = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.kind === 'reflection_sample')
      expect(samples).toHaveLength(1)
      expect(samples[0]).toMatchObject({ conversationId: 'conv-A', outcome: 'completed', candidates: 2 })
    })
  })

  it('重建 store 后来源仍一致（真落盘，不靠内存态）', async () => {
    await withTempRoot('s220-persist-', async (dir) => {
      const chat = vi.fn(async () => ({ content: JSON.stringify([forged('cand-p')]) }))
      const first = createMemoryStore(dir, nodeFsAdapter, {
        reflectChat: chat,
        conversationsExists: () => true,
        getConversationForReflect: () => ({ messages: msgsBig, bodyBytes: 4096 })
      })
      first.enqueueReflection('conv-P')
      await first.runReflection('conv-P')

      const restarted = createMemoryStore(dir, nodeFsAdapter, {})
      const cands = restarted.list().candidates
      expect(cands).toHaveLength(1)
      expect(cands[0]?.evidence).toEqual({ conversationId: 'conv-P' })
      expect(cands[0]?.evidence?.turnIndex).toBeUndefined()
    })
  })

  it('失败语义不回归：reflectChat 抛错 → 不落候选，reflection_sample 记 failed', async () => {
    await withTempRoot('s220-fail-', async (dir) => {
      const chat = vi.fn(async () => {
        throw new Error('network')
      })
      const store = createMemoryStore(dir, nodeFsAdapter, {
        reflectChat: chat,
        conversationsExists: () => true,
        getConversationForReflect: () => ({ messages: msgsBig, bodyBytes: 4096 })
      })
      store.enqueueReflection('conv-F')
      await store.runReflection('conv-F')
      expect(store.list().candidates).toHaveLength(0)
      const eventsFile = join(dir, 'memory', 'events.jsonl')
      const lines = readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
      const samples = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.kind === 'reflection_sample')
      expect(samples).toHaveLength(1)
      expect(samples[0]).toMatchObject({ conversationId: 'conv-F', outcome: 'failed', candidates: 0 })
    })
  })
})
