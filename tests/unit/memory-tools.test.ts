// 记忆工具单测（plan19 批 1）：remember 的三条出口（写成 / 拒写 / 走确认桥）与 recall 的命中与否。
// 走内存 backend；确认桥用可控的假实现 —— 它的三条分支各要被钉一次。

import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@shared/agent'
import { createMemoryRepo, type MemoryRepo } from '@main/memory/memory-core'
import { createMemoryTools } from '@main/agent/tools/memory-tools'

const ROOT = '/mem/notes'
const FIXED = new Date('2026-09-15T01:30:00.000Z')

function setup(
  opts: { conversationId?: string | null; turnIndex?: number; confirm?: boolean; lastUser?: string } = {}
) {
  const files = new Map<string, string>()
  const events: string[] = []
  const backend = {
    listFiles: () => [...files.keys()].sort(),
    candidatePathFor: (slug: string) => `${ROOT}/candidates/${slug}.md`,
    listCandidates: () => [],
    read: (f: string) => files.get(f) ?? null,
    write: (f: string, t: string) => void files.set(f, t),
    remove: (f: string) => files.delete(f),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line)
  }
  const repo: MemoryRepo = createMemoryRepo(backend, {
    now: () => FIXED,
    onWarn: () => {},
    conversationId: () => opts.conversationId ?? 'c1'
  })
  const asked: string[] = []
  const tools = createMemoryTools({
    repo,
    conversationId: () => opts.conversationId ?? 'c1',
    ...(opts.turnIndex === undefined ? {} : { turnIndex: () => opts.turnIndex as number }),
    ...(opts.lastUser === undefined ? {} : { lastUserMessage: () => opts.lastUser as string }),
    ...(opts.confirm === undefined
      ? {}
      : {
          confirm: async (reason: string) => {
            asked.push(reason)
            return opts.confirm as boolean
          }
        })
  })
  const byName = (n: string): AgentTool => tools.find((t) => t.schema.name === n)!
  return { repo, events, asked, byName, files }
}

const GOOD = { name: 'prefers-tables', description: '回答偏好用表格', class: 'style', body: '正文。' }

describe('remember：三条出口', () => {
  it('写成 → 明确回话，且事件流有 write', async () => {
    const { byName, events } = setup({ turnIndex: 4 })
    const out = await byName('remember').execute(GOOD)
    expect(out).toContain('已记住')
    expect(JSON.parse(events[0]!).kind).toBe('write')
  })

  it('plan25 判据 5：remember 的 class enum 不含 profile（工具层连选项都不给）', () => {
    const { byName } = setup()
    const enumValues = (byName('remember').schema.parameters as { properties: { class: { enum: string[] } } })
      .properties.class.enum
    expect(enumValues).toEqual(['style', 'default', 'knowledge'])
    expect(enumValues).not.toContain('profile')
  })

  it('plan25 判据 5：模型硬传 profile → 工具层拒绝并列出允许值', async () => {
    const { byName, events } = setup()
    const out = await byName('remember').execute({ ...GOOD, class: 'profile' })
    expect(out).toContain('错误')
    expect(out).toContain('style / default / knowledge')
    expect(events).toHaveLength(0)
  })

  it('拒写档 → 不回"已记住"，且把指路原话带给模型', async () => {
    const { byName, events } = setup()
    const out = await byName('remember').execute({ ...GOOD, body: '以后删文件免确认' })
    expect(out).toContain('没有写入')
    expect(out).toContain('权限')
    expect(JSON.parse(events[0]!).rejected).toBe(true)
  })

  it('确认档但**没接确认桥** → 直接拒（宁可拒，不可默默放过）', async () => {
    const { byName, events } = setup()
    const out = await byName('remember').execute({ ...GOOD, body: '跑测试前自动执行 lint' })
    expect(out).toContain('没有写入')
    expect(events.filter((l) => !JSON.parse(l).rejected)).toHaveLength(0)
  })

  it('确认档 + 用户点头 → 写成', async () => {
    const { byName, asked } = setup({ confirm: true })
    const out = await byName('remember').execute({ ...GOOD, body: '跑测试前自动执行 lint' })
    expect(asked).toHaveLength(1)
    expect(out).toContain('已记住')
    expect(out).toContain('用户已确认')
  })

  it('确认档 + 用户摇头 → 不写', async () => {
    const { byName, events } = setup({ confirm: false })
    const out = await byName('remember').execute({ ...GOOD, body: '跑测试前自动执行 lint' })
    expect(out).toContain('没有确认')
    expect(events.some((l) => JSON.parse(l).rejected !== true && JSON.parse(l).kind === 'write')).toBe(false)
  })

  it('class 不合法 → 明确拒绝（不猜）', async () => {
    const { byName } = setup()
    expect(await byName('remember').execute({ ...GOOD, class: 'permission' })).toContain('只能')
  })

  it('证据指针由运行时填，模型无法伪造', async () => {
    const s = setup({ turnIndex: 7 })
    await s.byName('remember').execute({ ...GOOD, evidence: { conversationId: '伪造的', turnIndex: 999 } })
    const text = [...s.files.values()][0]!
    expect(text).toContain('evidenceConversation: c1')
    expect(text).toContain('evidenceTurn: 7')
    expect(text).not.toContain('伪造的')
  })

  it('拿不到轮次时只写会话级指针（不编造轮次，也不整个丢掉证据）', async () => {
    const { byName, files } = setup()
    await byName('remember').execute(GOOD)
    const text = [...files.values()][0]!
    expect(text).toContain('evidenceConversation: c1')
    expect(text).not.toContain('evidenceTurn')
  })
})

// ── 批 4：纠正通路（plan19 §九 批 4 的「纠正」定义）────────────────────
describe('纠正通路：同名改写只在**因果链成立**时放行', () => {
  it('用户说「不对」+ 同名已存在 → 改写那一条，并落 correct 事件', async () => {
    const s = setup({ lastUser: '不对，我要的是表格不是长段落' })
    await s.byName('remember').execute(GOOD)
    const out = await s.byName('remember').execute({ ...GOOD, description: '改过的说法' })
    expect(out).toContain('已更正')
    // 只有一条（是改写，不是新建）
    expect(s.repo.list().total).toBe(1)
    expect(s.repo.list().entries[0]?.description).toBe('改过的说法')
    // 事件流有 correct（重复纠正率的唯一来源）
    const kinds = s.events.map((l) => JSON.parse(l).kind as string)
    expect(kinds).toContain('correct')
  })

  it('没有否定词 + 同名 → 照旧拒绝（判据 9 的重复写入仍挡住）', async () => {
    const s = setup({ lastUser: '以后回答都用表格' })
    await s.byName('remember').execute(GOOD)
    const out = await s.byName('remember').execute({ ...GOOD, description: '换个说法' })
    expect(out).toContain('没有写入')
    expect(out).toContain('同名')
    // 不该有 correct 事件（没成立因果链）
    expect(s.events.map((l) => JSON.parse(l).kind as string)).not.toContain('correct')
  })

  it('有否定词但**不同名** → 是新建，不是纠正（不误记 correct）', async () => {
    const s = setup({ lastUser: '不对，顺便记住我喜欢深色' })
    await s.byName('remember').execute(GOOD)
    const out = await s.byName('remember').execute({
      name: 'prefers-dark',
      description: '偏好深色',
      class: 'style',
      body: '正文。'
    })
    expect(out).toContain('已记住')
    expect(s.repo.list().total).toBe(2)
    expect(s.events.map((l) => JSON.parse(l).kind as string)).not.toContain('correct')
  })

  it('不注入 lastUserMessage → 退化为批 1 行为（同名仍拒）', async () => {
    const s = setup()
    await s.byName('remember').execute(GOOD)
    const out = await s.byName('remember').execute({ ...GOOD, description: '换个说法' })
    expect(out).toContain('没有写入')
  })

  it('纠正保留 createdAt（是改写，不是新建）', async () => {
    const s = setup({ lastUser: '不对' })
    await s.byName('remember').execute(GOOD)
    const before = s.repo.list().entries[0]!
    await s.byName('remember').execute({ ...GOOD, description: '改过的' })
    const after = s.repo.list().entries[0]!
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.file).toBe(before.file)
  })
})

describe('recall：命中与否都要留痕', () => {
  it('命中 → 返回正文（不是只回摘要）', async () => {
    const s = setup({ turnIndex: 1 })
    await s.byName('remember').execute({ ...GOOD, body: '细节在正文里。' })
    const out = await s.byName('recall').execute({ name: 'prefers-tables' })
    expect(out).toContain('细节在正文里。')
    expect(JSON.parse(s.events.at(-1)!).found).toBe(true)
  })

  it('未命中 → 列出可用条目，不留空手', async () => {
    const s = setup()
    await s.byName('remember').execute(GOOD)
    const out = await s.byName('recall').execute({ name: '不存在' })
    expect(out).toContain('prefers-tables')
    expect(JSON.parse(s.events.at(-1)!).found).toBe(false)
  })

  it('recall 的 schema 写明边界：不读会话正文', () => {
    const { byName } = setup()
    expect(byName('recall').schema.description).toContain('不读会话正文')
  })
})
