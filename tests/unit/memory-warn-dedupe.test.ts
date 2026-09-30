import { describe, expect, it } from 'vitest'
import { createMemoryRepo } from '@main/memory/memory-core'
import { createArchiveMock } from '../helpers/memory-archive-mock'

/**
 * K48 的回归判据：`loadAll` 每次都跑守卫，同一条守卫警告曾在日志里攒 1071 条
 * （09-20 → 09-28，`app.log` 实测「疑似长凭据串」）。修法 = 日志侧按消息去重
 * （进程内 Set），界面通道（warnings / needsReview）是现算视图**照旧每次给**。
 */

function makeRepo() {
  const warns: string[] = []
  const files = new Map<string, string>([
    [
      '凭据样本.md',
      [
        '---',
        'name: 凭据样本',
        'description: 含疑似长凭据串的存量条目',
        'updatedAt: 2026-10-01T00:00:00.000Z',
        '---',
        '',
        '正文里有一把长串：sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789'
      ].join('\n')
    ]
  ])
  const arch = createArchiveMock({ files, notesRoot: '/mem/notes', archRoot: '/mem/archived' })
  const repo = createMemoryRepo(
    {
      listFiles: () => [...files.keys()].sort(),
      read: (f) => files.get(f) ?? null,
      candidatePathFor: (slug) => `/mem/candidates/${slug}.md`,
      listCandidates: () => [],
      write: (f, t) => void files.set(f, t),
      remove: (f) => void files.delete(f),
      pathFor: (slug) => `/mem/notes/${slug}.md`,
      appendEvent: () => {},
      ...arch.backend
    },
    { onWarn: (m) => warns.push(m) }
  )
  return { repo, warns }
}

describe('记忆警告的日志去重（K48）', () => {
  it('★ 同一 repo 反复 loadAll：界面 warnings 照常每次给，onWarn 只落一次', () => {
    const { repo, warns } = makeRepo()
    const first = repo.list()
    expect(first.warnings.length + first.needsReview.length, '首载就该有守卫警告').toBeGreaterThan(0)
    expect(warns.length, '首载日志应落 1 条').toBe(1)
    for (let i = 0; i < 9; i++) void repo.list()
    expect(warns.length, '九次重载后日志仍是 1 条（K48 的 1071 条就是这里攒出来的）').toBe(1)
  })

  it('不同消息各落一次（去重按消息，不按通道）', () => {
    const { repo, warns } = makeRepo()
    void repo.list()
    // 同一 repo 写入第二个坏文件（读盘即告警的另一条消息）
    void repo.list()
    expect(warns.length).toBe(1)
  })
})
