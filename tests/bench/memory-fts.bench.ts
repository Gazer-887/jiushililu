// M04手动基准：真文件系统+真SQLite，100条接近4KB正文；不进入CI。
// 跑法：npx vitest run tests/bench/memory-fts.bench.ts --config config/vitest.bench.config.ts
// 门槛沿用既有memory.bench.ts的list45ms/save80ms警报线，首跑前登记，不依测量放宽。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { serializeMemory } from '@main/memory/memory-core'
import { nodeFsAdapter } from '@main/store/conversations-fs'
import { createMemoryStore } from '@main/store/memory-store'
import { MEMORY_LIMITS } from '@shared/memory'
import { percentileR7 } from '../helpers/benchmark-metrics'

const THRESHOLDS = { listP50Ms: 45, saveP50Ms: 80 }
const SAMPLES = 30

function body(turn: number): string {
  const prefix = `量子船坞 ${turn} `
  return prefix + '文'.repeat(Math.floor((MEMORY_LIMITS.maxBodyBytes - Buffer.byteLength(prefix)) / 3))
}

it('完整store满载正文：FTS开关分别量list/save，并保存原始30样本', () => {
  const reports = []
  for (const enabled of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'jsl-fts-bench-'))
    try {
      mkdirSync(join(root, 'notes'))
      for (let i = 0; i < MEMORY_LIMITS.maxEntries; i += 1) {
        writeFileSync(join(root, 'notes', `entry-${i}.md`), serializeMemory({
          name: `entry-${i}`, description: `第${i}条记忆的独立摘要`, class: 'knowledge', origin: 'user',
          evidence: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', body: body(i)
        }))
      }
      const start = performance.now()
      const store = createMemoryStore(root, nodeFsAdapter, enabled ? {} : { ftsPath: null })
      const startupMs = performance.now() - start
      const target = join(root, 'notes', 'entry-0.md')
      const edit = (turn: number) => store.save({
        name: 'entry-0', description: '第0条记忆的独立摘要', class: 'knowledge', origin: 'user',
        body: body(turn), file: target
      })
      expect(store.list().total).toBe(MEMORY_LIMITS.maxEntries)
      store.list()
      expect(edit(-1).ok).toBe(true)
      const list: number[] = []
      const save: number[] = []
      const search: number[] = []
      for (let i = 0; i < SAMPLES; i += 1) {
        let clock = performance.now()
        const index = store.list()
        list.push(performance.now() - clock)
        expect(index.entries.length + index.omitted).toBe(MEMORY_LIMITS.maxEntries)
        clock = performance.now()
        const saved = edit(i + 1000)
        save.push(performance.now() - clock)
        expect(saved.ok).toBe(true)
        clock = performance.now()
        const found = store.searchMemory('量子船坞')
        search.push(performance.now() - clock)
        expect(found.status).toBe(enabled ? 'ready' : 'disabled')
        expect(found.hits.length).toBe(enabled ? 8 : 0)
      }
      reports.push({
        enabled, startupMs, bodyBytes: Buffer.byteLength(body(1000)), entries: MEMORY_LIMITS.maxEntries,
        listP50Ms: percentileR7(list, 50), listP95Ms: percentileR7(list, 95),
        saveP50Ms: percentileR7(save, 50), saveP95Ms: percentileR7(save, 95),
        searchP50Ms: percentileR7(search, 50), searchP95Ms: percentileR7(search, 95), samples: { list, save, search }
      })
    } finally {
      expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
      expect(basename(root).startsWith('jsl-fts-bench-')).toBe(true)
      rmSync(root, { recursive: true, force: true })
    }
  }
  const report = { algorithm: 'R7', samplesPerMode: SAMPLES, node: process.version, platform: process.platform, thresholds: THRESHOLDS, reports }
  console.log('MEMORY_FTS_BENCH ' + JSON.stringify(report))
  const output = process.env['JSL_MEMORY_FTS_BENCH_OUT']
  if (output) writeFileSync(output, JSON.stringify(report, null, 2))
  for (const report of reports) {
    expect(report.listP50Ms).toBeLessThanOrEqual(THRESHOLDS.listP50Ms)
    expect(report.saveP50Ms).toBeLessThanOrEqual(THRESHOLDS.saveP50Ms)
  }
})
