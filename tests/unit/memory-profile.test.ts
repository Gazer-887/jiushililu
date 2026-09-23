// 用户画像行为单测（plan25 S1 · 判据 3/4/5/6/7/13/14）。走**内存 backend**（与 memory-core.test.ts 同形状）。
// 画像 = class='profile' 的特殊记忆：全库最多一条、LRU 豁免、正文全量注入、模型不可直写（D-071~073）。

import { describe, expect, it } from 'vitest'
import { MEMORY_LIMITS } from '@shared/memory'
import { createMemoryRepo, parseMemoryFile, serializeMemory } from '@main/memory/memory-core'
import { composeMemoryBlock } from '@main/memory/inject'
import { REFLECTION_SYSTEM_PROMPT } from '@main/memory/reflection-prompt'
import { parseMemoryImport } from '@shared/memory-import'
import { createArchiveMock } from '../helpers/memory-archive-mock'

const ROOT = '/mem/notes'
const ARCH = '/mem/archived'
const FIXED = new Date('2026-09-15T01:00:00.000Z')
const iso = FIXED.toISOString()

/** 内存 backend（含候选目录支持 —— 判据 6 的 approve 覆盖断言需要） */
function memBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const candidates = new Map<string, string>()
  const events: string[] = []
  const arch = createArchiveMock({
    files,
    notesRoot: ROOT,
    archRoot: ARCH,
    fallback: (f) => candidates.get(f) ?? null,
    removeFallback: (f) => candidates.delete(f)
  })
  return {
    files,
    candidates,
    events,
    listFiles: () => [...files.keys()].sort(),
    candidatePathFor: (slug: string) => `${ROOT}/candidates/${slug}.md`,
    listCandidates: () => [...candidates.keys()].sort(),
    write: (f: string, t: string) => {
      if (f.startsWith(`${ROOT}/candidates/`)) candidates.set(f, t)
      else files.set(f, t)
    },
    remove: (f: string) => (f.startsWith(`${ROOT}/candidates/`) ? candidates.delete(f) : files.delete(f)),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line),
    ...arch.backend
  }
}

function makeRepo(seed: Record<string, string> = {}, now = (): Date => FIXED) {
  const backend = memBackend(seed)
  const warnings: string[] = []
  const repo = createMemoryRepo(backend, { now, onWarn: (m) => warnings.push(m), conversationId: () => 'c1' })
  return { repo, backend, warnings }
}

/** 直接落盘一条画像（模拟既有状态；绕过 save 的来源闸 —— 与手改文件等价） */
function profileFile(body: string, updatedAt = iso, name = 'user-profile'): Record<string, string> {
  return {
    [`${ROOT}/${name}.md`]: serializeMemory({
      name,
      description: '对用户的整体画像',
      class: 'profile',
      origin: 'user',
      evidence: null,
      createdAt: iso,
      updatedAt,
      body
    })
  }
}

function normalFile(name: string, cls: string, updatedAt: string): [string, string] {
  return [
    `${ROOT}/${name}.md`,
    serializeMemory({
      name,
      description: `${name} 的摘要`,
      class: cls as 'style' | 'default' | 'knowledge',
      origin: 'user',
      evidence: null,
      createdAt: iso,
      updatedAt,
      body: `${name} 正文`
    })
  ]
}

describe('判据 4：画像正文全量注入，无画像不出现空壳', () => {
  it('有画像：块内出现 <user-profile> 段（正文全量），画像不再出一行索引', () => {
    const { repo } = makeRepo(profileFile('## 身份\n独立开发者。'))
    const block = composeMemoryBlock(repo.list())
    expect(block).toContain('<user-profile>')
    expect(block).toContain('## 身份')
    expect(block).toContain('独立开发者。')
    expect(block).not.toContain('- [画像] user-profile')
  })

  it('有画像 + 其他条目：画像段置顶，其余仍是一行索引', () => {
    const { repo } = makeRepo({
      ...profileFile('画像正文'),
      ...Object.fromEntries([normalFile('k1', 'knowledge', iso)])
    })
    const block = composeMemoryBlock(repo.list())
    const at = block!.indexOf('<user-profile>')
    const line = block!.indexOf('- [知识] k1')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(line).toBeGreaterThan(at)
  })

  it('无画像：不注入空壳（块里没有 <user-profile>）', () => {
    const { repo } = makeRepo(Object.fromEntries([normalFile('k1', 'knowledge', iso)]))
    const block = composeMemoryBlock(repo.list())
    expect(block).toContain('- [知识] k1')
    expect(block).not.toContain('<user-profile>')
  })

  it('只有画像时块也成立（不因索引行为零而返回 null）', () => {
    const { repo } = makeRepo(profileFile('画像正文'))
    const block = composeMemoryBlock(repo.list())
    expect(block).toContain('<user-profile>')
  })
})

describe('判据 5：模型不许直写画像（save 层兜底闸）', () => {
  it("origin='model' 的 profile 被拒，理由指路", () => {
    const { repo } = makeRepo()
    const r = repo.save({
      name: 'user-profile',
      description: '画像',
      class: 'profile',
      body: '正文',
      origin: 'model'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('画像')
  })

  it("origin='model' 缺省（不传）同样被拒", () => {
    const { repo } = makeRepo()
    const r = repo.save({ name: 'user-profile', description: '画像', class: 'profile', body: '正文' })
    expect(r.ok).toBe(false)
  })

  it("origin='user' 放行（用户手动编辑画像合法）", () => {
    const { repo } = makeRepo()
    const r = repo.save({
      name: 'user-profile',
      description: '画像',
      class: 'profile',
      body: '正文',
      origin: 'user'
    })
    expect(r.ok).toBe(true)
  })
})

describe('判据 3：LRU 遗忘豁免 profile', () => {
  it('达上限时 profile 不被遗忘，最旧的普通条目被删', () => {
    const seed: Record<string, string> = {
      ...profileFile('画像正文', iso),
      ...Object.fromEntries(
        Array.from({ length: MEMORY_LIMITS.maxEntries - 1 }, (_, i) =>
          normalFile(`n${String(i).padStart(3, '0')}`, 'default', new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString())
        )
      )
    }
    const later = new Date(FIXED.getTime() + 60_000)
    const { repo } = makeRepo(seed, () => later)
    const r = repo.save({
      name: 'new-entry',
      description: '新条目',
      class: 'default',
      body: '正文',
      origin: 'user'
    })
    expect(r.ok).toBe(true)
    // 画像仍在
    expect(repo.list().entries.some((e) => e.class === 'profile')).toBe(true)
    // 最旧的普通条目 n000 被遗忘
    expect(repo.list().entries.some((e) => e.name === 'n000')).toBe(false)
  })

  it('只剩画像 + 风格时拒写并说明', () => {
    // 构造满库且全部是豁免类：99 条 style + 1 条 profile
    const seed: Record<string, string> = {
      ...profileFile('画像正文', iso),
      ...Object.fromEntries(
        Array.from({ length: MEMORY_LIMITS.maxEntries - 1 }, (_, i) =>
          normalFile(`s${String(i).padStart(3, '0')}`, 'style', iso)
        )
      )
    }
    const later = new Date(FIXED.getTime() + 60_000)
    const { repo } = makeRepo(seed, () => later)
    const r = repo.save({
      name: 'new-entry',
      description: '新条目',
      class: 'default',
      body: '正文',
      origin: 'user'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('风格/画像')
  })
})

describe('判据 6：画像候选批准 = 原地覆盖（无二选一）；覆盖分支只对反思来源开放', () => {
  it('reflection 候选 user-profile 撞旧画像 → approve 直接覆盖，画像仍只有一条', () => {
    const { repo, backend } = makeRepo(profileFile('旧画像', iso))
    const candidateFile = backend.candidatePathFor('user-profile')
    backend.write(
      candidateFile,
      serializeMemory({
        name: 'user-profile',
        description: '对用户的整体画像',
        class: 'profile',
        origin: 'reflection',
        evidence: { conversationId: 'c1' },
        createdAt: iso,
        updatedAt: iso,
        body: '新画像（反思产出）',
        conflictWith: `${ROOT}/user-profile.md`
      })
    )
    const r = repo.approveCandidate(candidateFile)
    expect(r.ok).toBe(true)
    // 覆盖生效 + 候选已删 + 画像仍只有一条
    const entries = repo.list().entries
    const profiles = entries.filter((e) => e.class === 'profile')
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.body).toBe('新画像（反思产出）')
    expect(repo.list().candidates).toHaveLength(0)
  })

  it('候选来源不是 reflection（如手改成 model）→ 覆盖被拒绝', () => {
    const { repo, backend } = makeRepo(profileFile('旧画像', iso))
    const candidateFile = backend.candidatePathFor('user-profile')
    backend.write(
      candidateFile,
      serializeMemory({
        name: 'user-profile',
        description: '对用户的整体画像',
        class: 'profile',
        origin: 'model',
        evidence: null,
        createdAt: iso,
        updatedAt: iso,
        body: '新画像',
        conflictWith: `${ROOT}/user-profile.md`
      })
    )
    const r = repo.approveCandidate(candidateFile)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('反思')
  })
})

describe('判据 13：手改防线（重复画像消解 / 破损进 warnings）', () => {
  it('手建第二条画像 → 取 updatedAt 新者，旧者从注入集移除并进 warnings', () => {
    const older = '2026-09-14T00:00:00.000Z'
    const seed = {
      ...profileFile('新画像', iso),
      ...profileFile('旧画像', older, 'user-profile-copy')
    }
    const { repo, warnings } = makeRepo(seed)
    const view = repo.list()
    const profiles = view.entries.filter((e) => e.class === 'profile')
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.body).toBe('新画像')
    expect(view.warnings.some((w) => w.includes('画像重复'))).toBe(true)
    expect(warnings.some((w) => w.includes('画像重复'))).toBe(true)
  })

  it('frontmatter 破损的画像文件 → 不进注入集，warnings 留痕（既有机制复核）', () => {
    const { repo } = makeRepo({ [`${ROOT}/broken.md`]: '没有 frontmatter 的正文' })
    const view = repo.list()
    expect(view.entries).toHaveLength(0)
    expect(view.warnings.length).toBeGreaterThan(0)
  })
})

describe('判据 7：反思 system prompt 含画像维护指令', () => {
  it('prompt 含固定画像 name、完整画像非增量补丁、整体覆盖语义', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('"user-profile"')
    expect(REFLECTION_SYSTEM_PROMPT).toContain('class="profile"')
    expect(REFLECTION_SYSTEM_PROMPT).toContain('完整画像')
    expect(REFLECTION_SYSTEM_PROMPT).toContain('不是增量补丁')
    expect(REFLECTION_SYSTEM_PROMPT).toContain('整体覆盖')
  })
})

describe('判据 14：导入不支持画像，给专门拒绝语', () => {
  it("分类「画像」→ 拒绝并指路（不是笼统的无法识别）", () => {
    const r = parseMemoryImport(
      ['### 技能清单', '摘要: 我的技能', '分类: 画像', '正文:', '内容'].join('\n')
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('画像不支持导入')
  })

  it('分类「profile」→ 同样拒绝', () => {
    const r = parseMemoryImport(
      ['### 技能清单', '摘要: 我的技能', '分类: profile', '正文:', '内容'].join('\n')
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('画像不支持导入')
  })
})

describe('判据 1（补充）：含 profile 的旧文件正常解析（向后兼容的是旧数据不含 profile）', () => {
  it('旧三类文件解析不受影响；profile 文件解析 class 正确', () => {
    const old = parseMemoryFile(serializeMemory({
      name: 'k1',
      description: 'd',
      class: 'knowledge',
      origin: 'user',
      evidence: null,
      createdAt: iso,
      updatedAt: iso,
      body: 'b'
    }))
    expect(old.ok).toBe(true)
    const p = parseMemoryFile(serializeMemory({
      name: 'user-profile',
      description: '画像',
      class: 'profile',
      origin: 'user',
      evidence: null,
      createdAt: iso,
      updatedAt: iso,
      body: 'b'
    }))
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.parsed.class).toBe('profile')
  })
})
