import { describe, expect, it } from 'vitest'
import { runScenario, seedEntry } from './harness'

describe('场景端态取景器', () => {
  it('多条遗忘归档按名称排序，且正文随对应名称保留', async () => {
    const seed = {
      ...seedEntry({
        name: 'z-first',
        cls: 'default',
        body: '先归档的正文',
        updatedAt: '2026-09-01T00:00:00.000Z'
      }),
      ...seedEntry({
        name: 'a-second',
        cls: 'default',
        body: '后归档的正文',
        updatedAt: '2026-09-02T00:00:00.000Z'
      })
    }
    for (let i = 0; i < 98; i += 1) {
      Object.assign(seed, seedEntry({ name: `keep-${i}`, cls: 'default', body: `保留正文 ${i}` }))
    }
    const world = await runScenario({
      id: 'harness-archive-order',
      desc: '满库连续写两条，归档时间顺序与名称顺序相反',
      level: 'complex',
      seed,
      steps: [
        {
          act: 'capture',
          name: 'fresh-one',
          description: '新条目一',
          cls: 'default',
          body: '新正文一'
        },
        {
          act: 'capture',
          name: 'fresh-two',
          description: '新条目二',
          cls: 'default',
          body: '新正文二'
        }
      ],
      expect: () => {}
    })

    const archived = world.archived()
    expect(archived.map((entry) => entry.slug)).toEqual(['a-second', 'z-first'])
    expect(archived[0]!.text).toContain('后归档的正文')
    expect(archived[1]!.text).toContain('先归档的正文')
    expect(world.fileText('a-second')).toBeNull()
    expect(world.fileText('z-first')).toBeNull()
    expect(world.view().total).toBe(100)
  })
})
