// plan53 片 2：模型直写长期记忆改走「候选」（审批门，D-131 默认开）。
//
// 钉的判据分两组：
// A. 闸门本身 —— 提案不落生效集合、批准才进、拒绝零痕迹、逃生开关关掉退回直写（阳性对照）。
// B. R1 纠正口径 v2（plan53 §四之二）—— 公式不动，**记账时刻从"写入成功"推到"用户批准"**。
//    事件流只追加不删改，把"提案"记成"已纠正"就再也回改不了，所以 B 组每条都要红得起来。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMemoryRepo,
  parseMemoryFile,
  type MemoryBackend,
  type MemoryRepo
} from '@main/memory/memory-core'
import { createMemoryTools } from '@main/agent/tools/memory-tools'
import type { AgentTool } from '@shared/agent'
import { createArchiveMock } from '../helpers/memory-archive-mock'

const ROOT = '/mem/notes'
const ARCH = '/mem/archived'
const CAND = `${ROOT}/candidates`
const FIXED = new Date('2026-09-15T02:00:00.000Z')

const GOOD = { name: 'prefers-tables', description: '回答偏好用表格', class: 'style', body: '正文。' }

/** 已有的一条同名条目（纠正路径的对象）；`origin: 'model'` 是模型先前写的 */
const SEEDED = `---
name: prefers-tables
description: 回答偏好用列表
class: style
origin: model
createdAt: 2026-09-10T00:00:00.000Z
updatedAt: 2026-09-10T00:00:00.000Z
---

旧正文。`

interface Setup {
  repo: MemoryRepo
  files: Map<string, string>
  events: Record<string, unknown>[]
  remember: AgentTool
  /** 确认桥被问了几次、问了什么 */
  asked: string[]
  /** 归档区的**存储本体**（假后端把归档件放这里，不在 files 里） */
  archived: Map<string, string>
  /** 改它 = 模拟"批准发生在另一条会话" */
  setConversation: (id: string) => void
}

function setup(
  opts: { gate?: boolean; turnIndex?: number; lastUser?: string; seed?: boolean; confirm?: boolean } = {}
): Setup {
  const files = new Map<string, string>()
  if (opts.seed === true) files.set(`${ROOT}/prefers-tables.md`, SEEDED)
  const events: Record<string, unknown>[] = []
  const arch = createArchiveMock({ files, notesRoot: ROOT, archRoot: ARCH })
  const backend: MemoryBackend = {
    listFiles: () =>
      [...files.keys()].filter((f) => f.startsWith(`${ROOT}/`) && !f.startsWith(`${CAND}/`)).sort(),
    candidatePathFor: (slug) => `${CAND}/${slug}.md`,
    listCandidates: () => [...files.keys()].filter((f) => f.startsWith(`${CAND}/`)).sort(),
    write: (f, t) => void files.set(f, t),
    remove: (f) => arch.backend.remove(f),
    pathFor: (slug) => `${ROOT}/${slug}.md`,
    appendEvent: (line) => void events.push(JSON.parse(line) as Record<string, unknown>),
    ...arch.backend
  }
  let conversation = 'c1'
  const repo: MemoryRepo = createMemoryRepo(backend, {
    now: () => FIXED,
    onWarn: () => {},
    conversationId: () => conversation,
    ...(opts.gate === undefined ? {} : { modelWritesNeedApproval: () => opts.gate === true })
  })
  const asked: string[] = []
  const tools = createMemoryTools({
    repo,
    asked,
    conversationId: () => conversation,
    ...(opts.confirm === undefined
      ? {}
      : {
          confirm: async (reason: string) => {
            asked.push(reason)
            return opts.confirm === true
          }
        }),
    ...(opts.turnIndex === undefined ? {} : { turnIndex: () => opts.turnIndex as number }),
    ...(opts.lastUser === undefined ? {} : { lastUserMessage: () => opts.lastUser as string })
  })
  return {
    repo,
    files,
    asked,
    archived: arch.archived,
    events,
    remember: tools.find((t) => t.schema.name === 'remember') as AgentTool,
    setConversation: (id) => {
      conversation = id
    }
  }
}

const kinds = (s: Setup): string[] => s.events.map((e) => e['kind'] as string)

describe('A 组：审批门把模型直写拦在候选区', () => {
  it('闸门开 → remember 不落 notes，落 candidates，回话说"待确认"而不是"已记住"', async () => {
    const s = setup({ gate: true })
    const out = await s.remember.execute(GOOD)
    expect(s.files.has(`${ROOT}/prefers-tables.md`)).toBe(false)
    expect(s.files.has(`${CAND}/prefers-tables.md`)).toBe(true)
    expect(out).toContain('待确认')
    expect(out).not.toContain('已记住')
  })

  it('提案不落 write 事件 —— 还没生效的东西不许进"写入总数"那笔账', async () => {
    const s = setup({ gate: true })
    await s.remember.execute(GOOD)
    expect(kinds(s)).not.toContain('write')
    expect(s.repo.list().total).toBe(0)
  })

  it('未批准的候选不进注入索引，但在 candidates 里且带 model 来源（界面徽标的依据）', async () => {
    const s = setup({ gate: true })
    await s.remember.execute(GOOD)
    const view = s.repo.list()
    expect(view.entries.map((e) => e.name)).not.toContain('prefers-tables')
    expect(view.candidates).toHaveLength(1)
    expect(view.candidates[0]?.origin).toBe('model')
  })

  it('批准后生效：进 entries、候选删掉、来源记成 user（批准=用户认可）', async () => {
    const s = setup({ gate: true })
    await s.remember.execute(GOOD)
    const candFile = s.repo.list().candidates[0]?.file as string
    expect(typeof candFile).toBe('string')
    const res = s.repo.approveCandidate(candFile)
    expect(res.ok).toBe(true)
    expect(s.repo.list().entries.map((e) => e.name)).toContain('prefers-tables')
    expect(s.repo.list().candidates).toHaveLength(0)
    expect(s.files.has(`${CAND}/prefers-tables.md`)).toBe(false)
    expect(s.repo.get(`${ROOT}/prefers-tables.md`)?.origin).toBe('user')
  })

  it('拒绝后不留痕迹：候选文件删了、条目不存在、事件流一条不落', async () => {
    const s = setup({ gate: true })
    await s.remember.execute(GOOD)
    const candFile = s.repo.list().candidates[0]?.file as string
    // 先钉住"候选真在那儿" —— 否则 rejectCandidate(undefined) 走幂等分支返 true，这条就空转了
    expect(typeof candFile).toBe('string')
    expect(s.repo.rejectCandidate(candFile)).toBe(true)
    expect(s.files.size).toBe(0)
    expect(s.repo.list().entries).toHaveLength(0)
    expect(s.events).toHaveLength(0)
  })

  it('阳性对照：逃生开关关掉 → 直写照旧生效并落 write（回到片 2 之前的行为）', async () => {
    const s = setup({ gate: false })
    const out = await s.remember.execute(GOOD)
    expect(out).toContain('已记住')
    expect(s.files.has(`${ROOT}/prefers-tables.md`)).toBe(true)
    expect(s.files.has(`${CAND}/prefers-tables.md`)).toBe(false)
    expect(kinds(s)).toContain('write')
  })

  it('D-073 第一层（工具 enum）：模型连 profile 这个选项都拿不到', async () => {
    const s = setup({ gate: true })
    const out = await s.remember.execute({ ...GOOD, class: 'profile' })
    expect(out).toContain('错误')
    expect(s.files.size).toBe(0)
  })

  it('D-073 第二层（save 兜底）在**改道候选之前**就拒：画像混不进候选区', () => {
    // 顺序是承重的：若闸门先改道，画像就会以"待批准候选"的身份进到候选区，
    // 而批准一条画像候选 = 整份档案被换 —— 那道兜底闸就等于没建。
    const s = setup({ gate: true })
    const res = s.repo.save({ ...GOOD, class: 'profile', origin: 'model' })
    expect(res.ok).toBe(false)
    expect(s.repo.list().candidates).toHaveLength(0)
    expect(s.files.size).toBe(0)
  })

  it('阳性对照：用户手动写（origin=user）不受闸门管 —— 关掉格子不该剥夺亲手记一条的能力', async () => {
    const s = setup({ gate: true })
    const res = s.repo.save({ ...GOOD, origin: 'user' })
    expect(res.ok).toBe(true)
    expect(s.files.has(`${ROOT}/prefers-tables.md`)).toBe(true)
  })

  it('候选被手改成 `fromCorrection: yes` → 解析直接拒（不许静默读成"没纠正"）', () => {
    const s = setup({ gate: true, seed: true })
    s.files.set(
      `${CAND}/prefers-tables.md`,
      ['---', 'name: prefers-tables', 'description: d', 'class: style', 'origin: reflection',
        'createdAt: 2026-09-15T02:00:00.000Z', 'updatedAt: 2026-09-15T02:00:00.000Z',
        'fromCorrection: yes', `conflictWith: ${ROOT}/prefers-tables.md`, '---', '', '正文。'].join('\n')
    )
    const r = s.repo.approveCandidate(`${CAND}/prefers-tables.md`)
    expect(r.ok).toBe(false)
    // 旧条目没被动过（拒了就什么都别改）
    expect(s.repo.get(`${ROOT}/prefers-tables.md`)?.description).toBe('回答偏好用列表')
  })

  it('满库时批准一条全新候选 → 挤掉的是**归档**而非硬删（片 2 不能把片 1 的可逆性吃回去）', () => {
    // 批准走的是 `save()` ⇒ 与手动新建同一条通路，也会撞 100 条上限。
    // 这条钉的是"批准一条不许悄悄丢另一条"——丢的那条必须还在归档区、还能恢复。
    const s = setup({ gate: true })
    for (let i = 0; i < 100; i++) {
      s.files.set(`${ROOT}/seed-${i}.md`,
        ['---', `name: seed-${i}`, 'description: d', 'class: default', 'origin: user',
          `createdAt: 2026-09-01T00:00:00.00${i % 10}0.000Z`,
          `updatedAt: 2026-09-0${(i % 9) + 1}T00:00:00.000Z`, '---', '', '正文'].join('\n'))
    }
    s.files.set(`${CAND}/new-one.md`,
      ['---', 'name: new-one', 'description: 新加的一条', 'class: default', 'origin: model',
        'createdAt: 2026-09-15T02:00:00.000Z', 'updatedAt: 2026-09-15T02:00:00.000Z', '---', '', '正文'].join('\n'))
    const before = s.repo.list().total
    const r = s.repo.approveCandidate(`${CAND}/new-one.md`)
    expect(r.ok).toBe(true)
    const after = s.repo.list()
    expect(after.total).toBe(before) // 一进一出，总数不涨
    expect(after.entries.map((e) => e.name)).toContain('new-one')
    expect(after.archived.length).toBe(1) // 被挤掉的那条在归档区，没被硬删
  })

  it('直写模式 + 命中确认档 + 用户在确认桥点头 → 纠正仍落 correct（v1 语义一字不动）', async () => {
    // 复核抓出来的一支：我重写 `remember` 出口时把"确认桥通过后再落 correct"那半段丢了。
    // 关掉逃生开关的用户走的就是这条路，少这一笔，重复纠正率会偏而**没有任何一条判据会红**。
    const s = setup({ gate: false, seed: true, lastUser: '不对，改成表格吧', turnIndex: 6, confirm: true })
    // 命中确认档靠正文里的授权语义；沿用工具自己的判定，这里只验"点头之后账要落"
    const out = await s.remember.execute({ ...GOOD, body: '跑测试前自动执行 lint' })
    expect(s.asked).toHaveLength(1) // 先问过一句
    expect(out).toContain('用户已确认')
    expect(s.events.map((e) => e.kind)).toContain('correct')
    expect(s.events.map((e) => e.kind)).toContain('correct')
  })

  it('批准与拒绝都只认候选区：递一个归档件进去，不许被提升成条目、也不许被静默删掉', () => {
    // `insideMemory` 认三个区（notes / candidates / archived），所以"读得出来"不等于"是候选"。
    // 少了这道断言：`memory:reject` 收到 `archived/*.md` 就是**删掉一份可恢复数据且连 delete 都不落**。
    const s = setup({ gate: true })
    const archFile = `${ARCH}/2026-09-20T08-30-12-456Z__forgotten.md`
    s.repo.save({ ...GOOD, origin: 'user' })
    s.archived.set(archFile, [
      '---', 'name: forgotten', 'description: 被挤掉的一条', 'class: default', 'origin: user',
      'createdAt: 2026-09-10T00:00:00.000Z', 'updatedAt: 2026-09-10T00:00:00.000Z', '---', '', '归档正文。'
    ].join(String.fromCharCode(10)))
    const before = s.repo.list()
    const approve = s.repo.approveCandidate(archFile)
    expect(approve.ok).toBe(false)
    expect(s.repo.rejectCandidate(archFile)).toBe(false)
    expect(s.repo.list().archived.map((a) => a.file)).toContain(archFile)
    expect(s.repo.list().entries.map((e) => e.name)).not.toContain('forgotten')
    expect(before.archived).toHaveLength(1)
  })

  it('正文命中确认档的候选**批准得动**（批准本身就是那句确认）', async () => {
    // 两问分工：确认桥问的是**内容风险**（当场问，与 v1 一致），审批门问的是**要不要现在生效**。
    // 复核抓出的不对称在第二问之后：候选过了桥、落了盘，批准时不撞名的分支会再跑一次 `save()` ——
    // 不带 `confirmed` 就被确认档再拦一次，用户点了批准只收到一句"需要你确认"，这条候选永远批不动。
    const s = setup({ gate: true, confirm: true })
    const out = await s.remember.execute({ ...GOOD, body: '跑测试前自动执行 lint' })
    expect(s.asked).toHaveLength(1) // 先过了内容那一问
    expect(out).toContain('待确认') // 门又把它改成了提案
    const file = s.repo.list().candidates[0]?.file as string
    expect(typeof file).toBe('string')
    const r = s.repo.approveCandidate(file)
    expect(r.ok).toBe(true)
    expect(s.repo.list().entries.map((e) => e.name)).toContain('prefers-tables')
  })

  it('闸门开着时撞名仍当场拒（不许变成一条永远批不动的候选）', async () => {
    const s = setup({ gate: true, seed: true })
    const out = await s.remember.execute(GOOD) // 没有否定词 ⇒ 不是纠正，就是重复写
    expect(out).toContain('已存在同名条目')
    expect(s.files.size).toBe(1) // 只有原来那条，没有多出候选
    expect(s.repo.list().candidates).toHaveLength(0)
  })

  it('组合根必须把设置里的开关接上（漏接=整道门静默失效，四道闸都抓不到）', () => {
    const index = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    // 只查"存在"不够 —— 写成 `modelWritesNeedApproval: () => false` 也算存在，那时门在真应用里是死的，
    // 而单测各自注入开关，四道闸一条都不会红。判据钉的是**接的是设置里那个读数**。
    expect(/modelWritesNeedApproval:\s*\(\)\s*=>\s*getMemoryApprovalGate\(\)/.test(index)).toBe(true)
  })
})

describe('B 组：R1 纠正口径 v2（记批准，不记提案）', () => {
  it('撞名的提案：候选带上 conflictWith 与 fromCorrection，**写入时刻不落 correct**', async () => {
    const s = setup({ gate: true, seed: true, lastUser: '不对，我要的是表格', turnIndex: 4 })
    await s.remember.execute(GOOD)
    const text = s.files.get(`${CAND}/prefers-tables.md`)
    expect(text).toBeDefined()
    const parsed = parseMemoryFile(text as string)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.parsed.conflictWith).toBe(`${ROOT}/prefers-tables.md`)
    expect(parsed.parsed.fromCorrection).toBe(true)
    expect(kinds(s)).not.toContain('correct')
  })

  it('批准覆盖成功才落 correct，且指针取**来源那一轮**（批准发生在别的会话也一样）', async () => {
    const s = setup({ gate: true, seed: true, lastUser: '这条不对，改一下', turnIndex: 4 })
    await s.remember.execute(GOOD)
    const candFile = s.repo.list().candidates[0]?.file as string
    expect(typeof candFile).toBe('string')
    s.setConversation('c2') // 三天后在另一条会话点的批准
    s.repo.approveCandidate(candFile)
    const correct = s.events.filter((e) => e['kind'] === 'correct')
    expect(correct).toHaveLength(1)
    expect(correct[0]?.['conversationId']).toBe('c1')
    expect(correct[0]?.['turnIndex']).toBe(4)
    // 同批的 approve 事件记的是批准现场 —— 两笔账各归各的时刻
    const approve = s.events.find((e) => e['kind'] === 'approve')
    expect(approve?.['conversationId']).toBe('c2')
  })

  it('反向判据：拒绝候选 ⇒ 一条 correct 都不落（事件流只追加，记错了再也回改不了）', async () => {
    const s = setup({ gate: true, seed: true, lastUser: '不对不对', turnIndex: 2 })
    await s.remember.execute(GOOD)
    const candFile = s.repo.list().candidates[0]?.file as string
    s.repo.rejectCandidate(candFile)
    expect(kinds(s)).not.toContain('correct')
    // 旧条目原样还在，没被提案污染
    expect(s.repo.get(`${ROOT}/prefers-tables.md`)?.description).toBe('回答偏好用列表')
  })

  it('没有撞对象的提案不算纠正：fromCorrection 不许落到无 conflictWith 的候选上', async () => {
    const s = setup({ gate: true, lastUser: '不对，别这样', turnIndex: 1 })
    await s.remember.execute(GOOD) // 库里没有同名条目
    const parsed = parseMemoryFile(s.files.get(`${CAND}/prefers-tables.md`) as string)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.parsed.conflictWith).toBeUndefined()
    expect(parsed.parsed.fromCorrection).toBeUndefined()
  })

  it('批准一条不撞名的提案 → 走"新建"分支，同样不落 correct', async () => {
    const s = setup({ gate: true, lastUser: '不对', turnIndex: 1 })
    await s.remember.execute(GOOD)
    s.repo.approveCandidate(s.repo.list().candidates[0]?.file as string)
    expect(kinds(s)).not.toContain('correct')
  })

  it('阳性对照：直写模式下纠正仍在"写入成功那一刻"落 correct（v1 语义一字不动）', async () => {
    const s = setup({ gate: false, seed: true, lastUser: '不对，我要表格', turnIndex: 7 })
    const out = await s.remember.execute(GOOD)
    expect(out).toContain('已更正')
    const correct = s.events.filter((e) => e['kind'] === 'correct')
    expect(correct).toHaveLength(1)
    expect(correct[0]?.['turnIndex']).toBe(7)
  })

  it('反思候选（撞名、用户没否过）批准 → 覆盖生效但**不落 correct**', () => {
    // v2 条件 ② 仍在把关：反思/模型主动改写同名条目不等于"用户否过"。少了这条，
    // 纠正率会把每次自我更新都算成被用户纠正 —— 读数虚高，且查不出是哪一笔撑起来的。
    const s = setup({ gate: true, seed: true })
    s.files.set(
      `${CAND}/prefers-tables.md`,
      [
        '---',
        'name: prefers-tables',
        'description: 回答偏好用表格',
        'class: style',
        'origin: reflection',
        'createdAt: 2026-09-15T02:00:00.000Z',
        'updatedAt: 2026-09-15T02:00:00.000Z',
        `conflictWith: ${ROOT}/prefers-tables.md`,
        '---',
        '',
        '反思提炼的新正文。'
      ].join('\n')
    )
    expect(s.repo.approveCandidate(`${CAND}/prefers-tables.md`).ok).toBe(true)
    expect(kinds(s)).toContain('approve')
    expect(kinds(s)).not.toContain('correct')
    expect(s.repo.get(`${ROOT}/prefers-tables.md`)?.body).toBe('反思提炼的新正文。')
  })

  it('有否定词但库里没同名条目 → 直写模式也不落 correct（保住 v1 的保守性）', async () => {
    const s = setup({ gate: false, lastUser: '不对', turnIndex: 3 })
    await s.remember.execute(GOOD)
    expect(kinds(s)).not.toContain('correct')
  })

  it('人写通路（memory:save）来源钉死 user：载荷连 origin 字段都不收', () => {
    // 结构守卫（handler 要起 electron 才跑得动）。钉的是**这条通道的两处**：
    // schema 不收 `origin`（收了又不听 = 骗人），且保存前强制覆写成 user。
    // 挡的坏法：让渲染层能自称 model —— 那等于给"手动编辑被审批门拦成候选"和
    // "条目被伪装成模型写的"各留一把钥匙。
    const ipc = readFileSync(join(__dirname, '../../src/main/ipc.ts'), 'utf8')
    const schema = ipc.slice(ipc.indexOf('const memorySaveSchema'), ipc.indexOf('ipcMain.handle(IPC.memorySave'))
    expect(schema).not.toContain('origin:')
    expect(/memorySaveSchema, raw\)[\s\S]{0,400}origin: 'user'/.test(ipc)).toBe(true)
  })
})
