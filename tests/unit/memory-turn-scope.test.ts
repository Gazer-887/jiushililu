import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@main/store/memory-store'
import { nodeFsAdapter } from '@main/store/conversations-fs'

const roots: string[] = []
function store(options: Parameters<typeof createMemoryStore>[2] = {}) { const root = mkdtempSync(join(tmpdir(), 'jsl-turn-scope-')); roots.push(root); return createMemoryStore(root, nodeFsAdapter, { ftsPath: null, ...options }) }
// 此组只测归属；公共夹具用不同正文，避免相似度守卫先拒绝保存。
const input = (name: string) => ({ name, description: name, body: name.repeat(30), class: 'default' as const, origin: 'user' as const })
afterEach(() => { for (const root of roots.splice(0)) { expect(resolve(dirname(root))).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^jsl-turn-scope-/); rmSync(root, { recursive: true, force: true }) } })

describe('实际MemoryStore每轮归属', () => {
  it('A/B交错写入，通知与写事件都各归本轮', () => {
    const memory = store(); const index = memory.list()
    const a = memory.beginTurn(index, 'A'); const b = memory.beginTurn(index, 'B')
    expect(a).toBeDefined(); expect(b).toBeDefined()
    expect(a.repo.save(input('公共A')).ok).toBe(true)
    expect(b.repo.save(input('公共B')).ok).toBe(true)
    expect(a.drain().written).toEqual(['公共A'])
    expect(b.drain().written).toEqual(['公共B'])
    expect(a.drain()).toEqual({ written: [], rejected: [] })
    const writes = memory.backend.readEvents().events.filter((e) => e.kind === 'write')
    expect(writes).toEqual(expect.arrayContaining([expect.objectContaining({ name: '公共A', conversationId: 'A' }), expect.objectContaining({ name: '公共B', conversationId: 'B' })]))
  })
  it('同会话两个run和第三会话不会覆盖；关闭A不清B', () => {
    const memory = store(); const a = memory.beginTurn(undefined, 'A'); const b = memory.beginTurn(undefined, 'A'); const c = memory.beginTurn(undefined, 'C')
    expect(a).toBeDefined()
    a.repo.save(input('A一')); b.repo.save(input('A二')); c.repo.save(input('C一'))
    expect(a.drain().written).toEqual(['A一']); expect(c.drain().written).toEqual(['C一']); expect(b.drain().written).toEqual(['A二'])
  })
  it('后台/手动写入不串入正在采集的轮次；拒写也按轮次归属', () => {
    const memory = store(); const a = memory.beginTurn(undefined, 'A'); const b = memory.beginTurn(undefined, 'B')
    expect(a).toBeDefined()
    memory.save(input('手动后台'))
    expect(a.repo.save({ ...input('A拒写'), description: 'x'.repeat(121) }).ok).toBe(false)
    expect(a.drain()).toMatchObject({ written: [], rejected: [expect.objectContaining({ name: 'A拒写' })] })
    expect(b.drain()).toEqual({ written: [], rejected: [] })
    expect(memory.backend.readEvents().events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'write', name: 'A拒写', conversationId: 'A', rejected: true })]))
  })
  it('drain后的延迟写不流到另一个采集槽', () => {
    const memory = store(); const a = memory.beginTurn(undefined, 'A'); const b = memory.beginTurn(undefined, 'B')
    expect(a).toBeDefined(); a.drain(); a.repo.save(input('延迟A'))
    expect(b.drain()).toEqual({ written: [], rejected: [] }); expect(a.drain()).toEqual({ written: [], rejected: [] })
  })
  it('真实反思runner落候选不进入正在采集的聊天通知', async () => {
    const memory = store({
      getConversationForReflect: () => ({ messages: [{ role: 'user', content: '公共反思文本' }], bodyBytes: 3000 }),
      reflectChat: async () => ({ content: JSON.stringify([{ name: '公共后台候选', description: '后台候选摘要', class: 'default', body: '公共后台事实' }]) })
    })
    const a = memory.beginTurn(undefined, 'A'); const b = memory.beginTurn(undefined, 'B')
    expect(memory.enqueueReflection('background')).toBe(true)
    expect(await memory.runReflection('background')).toBe(true)
    expect(memory.backend.readEvents().events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reflection_sample', conversationId: 'background', outcome: 'completed' })]))
    expect(a.drain()).toEqual({ written: [], rejected: [] }); expect(b.drain()).toEqual({ written: [], rejected: [] })
  })
})
