import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolBatch } from '@main/agent/tool-batch'
import { resolveToolBatchConcurrency } from '@shared/request-policy'
import {
  peekWatchdogLeases,
  setWatchdogPhase,
  startWatchdog,
  stopWatchdog
} from '@main/watchdog'
import {
  createFileTools,
  isTrustedReadTool
} from '@main/agent/tools/file-tools'
import { createWorkspaceWriter } from '@main/workspace-write'
import { planTrustedReadBatch, runAgentLoop } from '@main/agent/loop'
import type { AgentChatResult, AgentMessage, AgentTool, StagedToolRead, ToolCall, ToolEvent } from '@shared/agent'

/**
 * S3-40A 有界批执行：用可控 Promise/屏障证明峰值与归属，不用固定延时猜并发。
 * 本模块只跑已判定合格的项；资格、路径与读版本属于真实消费者。
 */

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时：条件未达成')
    await new Promise((r) => setTimeout(r, 1))
  }
}

beforeEach(() => {
  // 隔离租约状态；本组不需要停滞告警
  startWatchdog({ intervalMs: 1000, thresholdMs: 1000, heartbeatMs: 0 })
  setWatchdogPhase('idle')
})

afterEach(() => {
  stopWatchdog()
})

describe('S3-40A 批并发纯策略', () => {
  it('普通 1、FAST 合格 2；缺省/未知/非法一律保守回 1', () => {
    expect(resolveToolBatchConcurrency({ mode: 'normal', eligible: true })).toBe(1)
    expect(resolveToolBatchConcurrency({ mode: 'fast', eligible: true })).toBe(2)
    expect(resolveToolBatchConcurrency({ mode: 'fast' })).toBe(1)
    expect(resolveToolBatchConcurrency({ mode: 'fast', eligible: 'true' })).toBe(1)
    expect(resolveToolBatchConcurrency({ mode: 'fast', eligible: 1 })).toBe(1)
    expect(resolveToolBatchConcurrency({ mode: 'turbo', eligible: true })).toBe(1)
    expect(resolveToolBatchConcurrency()).toBe(1)
  })
})

describe('S3-40A 有界峰值与顺序', () => {
  it('普通模式峰值 1，结果按输入顺序回灌', async () => {
    let active = 0
    let peak = 0
    const started: number[] = []
    const gates = [deferred(), deferred(), deferred()]
    const pending = runToolBatch({
      items: [0, 1, 2],
      mode: 'normal',
      eligible: true,
      run: async (_item, index) => {
        active += 1
        peak = Math.max(peak, active)
        started.push(index)
        await gates[index]!.promise
        active -= 1
        return index * 10
      }
    })
    await waitUntil(() => started.length === 1)
    expect(peak).toBe(1)
    gates[0]!.resolve()
    await waitUntil(() => started.length === 2)
    expect(peak).toBe(1)
    gates[1]!.resolve()
    await waitUntil(() => started.length === 3)
    gates[2]!.resolve()
    const result = await pending
    expect(peak).toBe(1)
    expect(result.startedCount).toBe(3)
    expect(result.results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(result.results.map((r) => r.value)).toEqual([0, 10, 20])
    expect(result.aborted).toBe(false)
  })

  it('FAST 合格模式峰值 2；后发先完成不改变结果顺序', async () => {
    let active = 0
    let peak = 0
    const started: number[] = []
    const gates = [deferred(), deferred(), deferred()]
    const pending = runToolBatch({
      items: [0, 1, 2],
      mode: 'fast',
      eligible: true,
      run: async (_item, index) => {
        active += 1
        peak = Math.max(peak, active)
        started.push(index)
        await gates[index]!.promise
        active -= 1
        return `v${index}`
      }
    })
    await waitUntil(() => started.length === 2)
    expect(peak).toBe(2)
    // 后发（index 1）先完成，腾出的槽位应启动 index 2
    gates[1]!.resolve()
    await waitUntil(() => started.length === 3)
    expect(peak).toBe(2)
    gates[2]!.resolve()
    gates[0]!.resolve()
    const result = await pending
    expect(result.results.map((r) => r.value)).toEqual(['v0', 'v1', 'v2'])
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('超限/非法配置不能放宽成无界起跑', async () => {
    const configs = [
      { mode: 'normal', eligible: true },
      { mode: 'fast' },
      { mode: 'fast', eligible: 'yes' },
      { mode: 'turbo', eligible: true },
      {}
    ]
    for (const config of configs) {
      const gate = deferred()
      let active = 0
      let peak = 0
      let started = 0
      const pending = runToolBatch({
        items: [0, 1],
        ...config,
        run: async () => {
          active += 1
          peak = Math.max(peak, active)
          started += 1
          await gate.promise
          active -= 1
          return 0
        }
      })
      await waitUntil(() => started === 1)
      await new Promise((r) => setTimeout(r, 20))
      expect(peak, JSON.stringify(config)).toBe(1)
      gate.resolve()
      await pending
    }
  })
})

describe('S3-40A 取消、失败与启动守卫', () => {
  it('取消后不再启动排队项；在途结果结算但标 stale，不当成功', async () => {
    const controller = new AbortController()
    const gate = deferred()
    const started: number[] = []
    const pending = runToolBatch({
      items: [0, 1, 2],
      mode: 'normal',
      signal: controller.signal,
      run: async (_item, index) => {
        started.push(index)
        await gate.promise
        return index
      }
    })
    await waitUntil(() => started.length === 1)
    controller.abort()
    gate.resolve()
    const result = await pending
    expect(started).toEqual([0])
    expect(result.aborted).toBe(true)
    expect(result.results[0]).toMatchObject({
      status: 'fulfilled',
      started: true,
      stale: true,
      value: 0
    })
    expect(result.results[1]).toMatchObject({ status: 'skipped', started: false })
    expect(result.results[2]).toMatchObject({ status: 'skipped', started: false })
    expect(result.startedCount).toBe(1)
  })

  it('单项失败保留其他已完成结果，不重跑、不补发', async () => {
    const calls = new Map<number, number>()
    const result = await runToolBatch({
      items: [0, 1, 2],
      mode: 'normal',
      run: async (_item, index) => {
        calls.set(index, (calls.get(index) ?? 0) + 1)
        if (index === 1) throw new Error('boom')
        return index * 2
      }
    })
    expect(result.results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(result.results[0]!.value).toBe(0)
    expect(result.results[2]!.value).toBe(4)
    expect(result.results[1]!.error).toBeInstanceOf(Error)
    expect([...calls.entries()].sort(([a], [b]) => a - b)).toEqual([
      [0, 1],
      [1, 1],
      [2, 1]
    ])
  })

  it('canStart 在每项真正启动前同步调用；拒绝的项不启动、run 不被调用', async () => {
    const events: string[] = []
    const result = await runToolBatch({
      items: ['a', 'b', 'c'],
      mode: 'normal',
      canStart: (item, index) => {
        events.push(`can:${index}`)
        return item !== 'b'
      },
      run: async (_item, index) => {
        events.push(`run:${index}`)
        return index
      }
    })
    expect(events).toEqual(['can:0', 'run:0', 'can:1', 'can:2', 'run:2'])
    expect(result.results[1]).toMatchObject({ status: 'skipped', started: false })
    expect(result.startedCount).toBe(2)
  })

  it('canStart 抛错按不许启动处理，不把异常当已执行', async () => {
    const result = await runToolBatch({
      items: [0, 1],
      mode: 'normal',
      canStart: () => {
        throw new Error('guard failed')
      },
      run: async () => 1
    })
    expect(result.results.every((r) => r.status === 'skipped' && r.started === false)).toBe(true)
    expect(result.startedCount).toBe(0)
  })
})

describe('S3-40C2-R1 提交标记初值', () => {
  it('启动项未提交时 committed 为 false；提交后 started 项为 true，discard 时为 false', async () => {
    const beforeCommit: unknown[] = []
    const insideCommit: unknown[] = []
    const committed = await runToolBatch({
      items: [0, 1],
      mode: 'normal',
      guard: (results) => {
        // 全部在途项已结算、提交门尚未通过：此前的启动对象必须已带 committed: false
        for (const r of results) beforeCommit.push(r.committed)
        return true
      },
      commit: (results) => {
        // 提交回调先于置位执行：回调内仍不得看到 true
        for (const r of results) insideCommit.push(r.committed)
      },
      run: async (_item, index) => index
    })
    expect(beforeCommit).toEqual([false, false])
    expect(insideCommit).toEqual([false, false])
    expect(committed.results.map((r) => r.committed)).toEqual([true, true])
    expect(committed.results.map((r) => r.started)).toEqual([true, true])

    const beforeDiscard: unknown[] = []
    const discarded = await runToolBatch({
      items: [0],
      mode: 'normal',
      guard: () => false,
      discard: (results) => {
        for (const r of results) beforeDiscard.push(r.committed)
      },
      run: async () => 1
    })
    expect(beforeDiscard).toEqual([false])
    expect(discarded.results[0]).toMatchObject({ started: true, stale: true, committed: false })
  })
})

describe('S3-40A 看门狗所有权', () => {
  it('在途项各自持有租约，批结束全部释放', async () => {
    const gates = [deferred(), deferred()]
    const pending = runToolBatch({
      items: [0, 1],
      mode: 'fast',
      eligible: true,
      run: async (_item, index) => {
        await gates[index]!.promise
        return index
      }
    })
    await waitUntil(() => peekWatchdogLeases().length === 2)
    expect(peekWatchdogLeases().map((l) => l.phase)).toEqual(['tool:batch', 'tool:batch'])
    gates[0]!.resolve()
    gates[1]!.resolve()
    await pending
    expect(peekWatchdogLeases()).toHaveLength(0)
  })

  it('单项抛错也释放自己的租约', async () => {
    const result = await runToolBatch({
      items: [0, 1],
      mode: 'fast',
      eligible: true,
      run: async (_item, index) => {
        if (index === 0) throw new Error('boom')
        return index
      }
    })
    expect(result.results[0]!.status).toBe('rejected')
    expect(peekWatchdogLeases()).toHaveLength(0)
  })
})

// ── S3-40B：可信内建读取的阶段结果与有序提交 ─────────────────────────

const readCall = (id: string, path: string): ToolCall => ({
  id,
  name: 'read_file',
  arguments: JSON.stringify({ path })
})

const FAST_POLICY = {
  mode: 'fast' as const,
  maxLocalReadConcurrency: 2 as const,
  requestedServiceTier: 'priority',
  tierSupport: 'supported' as const
}

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsl-40b-'))
  roots.push(root)
  return root
}

function writeText(root: string, rel: string, text: string): string {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
  return abs
}

function toolsFor(root: string): {
  tools: AgentTool[]
  read: AgentTool
  write: AgentTool
  map: Map<string, AgentTool>
} {
  const tools = createFileTools(createWorkspaceWriter(root, { trash: async () => {} }))
  return {
    tools,
    read: tools[0]!,
    write: tools[1]!,
    map: new Map(tools.map((tool) => [tool.schema.name, tool]))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('S3-40B 取消边界补强（40A 回归）', () => {
  it('canStart 同步取消且返回 true：不拿租约、不启动 run、结果 skipped', async () => {
    const controller = new AbortController()
    let runs = 0
    const result = await runToolBatch({
      items: [0, 1],
      mode: 'normal',
      signal: controller.signal,
      canStart: () => {
        controller.abort()
        return true
      },
      run: async () => {
        runs++
        return 1
      }
    })
    expect(runs).toBe(0)
    expect(result.startedCount).toBe(0)
    expect(result.aborted).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({ status: 'skipped', started: false }),
      expect.objectContaining({ status: 'skipped', started: false })
    ])
    expect(peekWatchdogLeases()).toHaveLength(0)
  })
})

describe('S3-40B 可信读取：暂存、提交门与真实版本', () => {
  it('stage 不产生写资格；commit 后才允许覆盖，discard 后原字节不变', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    const abs = writeText(root, 'a.txt', 'original')

    const staged = await read.trustedRead!.stage({ path: 'a.txt' })
    expect(staged.ok).toBe(true)
    expect(staged.receipt).not.toBeNull()
    const refused = await write.execute({ path: 'a.txt', content: 'hacked' })
    expect(refused).toContain('请先用 read_file')
    expect(readFileSync(abs, 'utf8')).toBe('original')

    read.trustedRead!.discard(staged)
    const stillRefused = await write.execute({ path: 'a.txt', content: 'hacked-again' })
    expect(stillRefused).toContain('请先用 read_file')
    expect(readFileSync(abs, 'utf8')).toBe('original')

    const fresh = await read.trustedRead!.stage({ path: 'a.txt' })
    expect(read.trustedRead!.commit(fresh)).toContain('1|original')
    const wrote = await write.execute({ path: 'a.txt', content: 'committed' })
    expect(wrote).toContain('已写入')
    expect(readFileSync(abs, 'utf8')).toBe('committed')
  })

  it('提交门取消：真实读取已完成也整批 discard，write_file 不可利用', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    const a = writeText(root, 'a.txt', 'alpha')
    const b = writeText(root, 'b.txt', 'beta')
    const controller = new AbortController()
    const committed: string[] = []
    const result = await runToolBatch<string, StagedToolRead>({
      items: ['a.txt', 'b.txt'],
      mode: 'fast',
      eligible: true,
      run: (path) => read.trustedRead!.stage({ path }, controller.signal),
      guard: () => {
        controller.abort()
        return false
      },
      commit: (results) => {
        for (const r of results) {
          if (r.value) {
            read.trustedRead!.commit(r.value)
            committed.push(String(r.item))
          }
        }
      },
      discard: (results) => {
        for (const r of results) if (r.value) read.trustedRead!.discard(r.value)
      }
    })
    expect(result.aborted).toBe(true)
    expect(committed).toEqual([])
    expect(result.results.every((r) => r.started && r.stale && !r.committed)).toBe(true)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'b.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(a, 'utf8')).toBe('alpha')
    expect(readFileSync(b, 'utf8')).toBe('beta')
  })

  it('单项读失败保留其他真实成功；失败的读取不产生写资格', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'ok.txt', 'good')
    const bin = join(root, 'bin.dat')
    writeFileSync(bin, Buffer.from([0, 1, 2, 3]))

    const result = await runToolBatch<string, StagedToolRead>({
      items: ['ok.txt', 'bin.dat'],
      mode: 'fast',
      eligible: true,
      run: (path) => read.trustedRead!.stage({ path }),
      commit: (results) => {
        for (const r of results) if (r.value?.receipt) read.trustedRead!.commit(r.value)
      }
    })
    expect(result.results[0]).toMatchObject({ status: 'fulfilled', committed: true, stale: false })
    expect(result.results[1]).toMatchObject({ status: 'fulfilled', committed: true, stale: false })
    expect(result.results[0]!.value!.ok).toBe(true)
    expect(result.results[1]!.value!.ok).toBe(false)
    expect(result.results[1]!.value!.receipt).toBeNull()
    expect(await write.execute({ path: 'ok.txt', content: 'new' })).toContain('已写入')
    expect(await write.execute({ path: 'bin.dat', content: 'text' })).toContain('请先用 read_file')
    expect([...readFileSync(bin)]).toEqual([0, 1, 2, 3])
  })

  it('两个会话的读版本互不污染', async () => {
    const rootA = tempRoot()
    const rootB = tempRoot()
    writeText(rootA, 'same.txt', 'A')
    writeText(rootB, 'same.txt', 'B')
    const a = toolsFor(rootA)
    const b = toolsFor(rootB)

    const staged = await a.read.trustedRead!.stage({ path: 'same.txt' })
    a.read.trustedRead!.commit(staged)
    expect(await a.write.execute({ path: 'same.txt', content: 'A2' })).toContain('已写入')
    expect(await b.write.execute({ path: 'same.txt', content: 'B2' })).toContain('请先用 read_file')
    expect(readFileSync(join(rootB, 'same.txt'), 'utf8')).toBe('B')
  })

  it('取消后晚到的读取结果与 receipt 一起丢弃，原字节不变', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    const abs = writeText(root, 'late.txt', 'late-original')
    const cap = read.trustedRead!
    const original = cap.stage.bind(cap)
    const gate = deferred()
    let stages = 0
    vi.spyOn(cap, 'stage').mockImplementation(async (args, signal, canStart) => {
      stages++
      const staged = await original(args, signal, canStart)
      await gate.promise
      return staged
    })

    const controller = new AbortController()
    const pending = runToolBatch<string, StagedToolRead>({
      items: ['late.txt'],
      mode: 'fast',
      eligible: true,
      signal: controller.signal,
      run: (path) => cap.stage({ path }, controller.signal),
      commit: (results) => {
        for (const r of results) if (r.value) cap.commit(r.value)
      },
      discard: (results) => {
        for (const r of results) if (r.value) cap.discard(r.value)
      }
    })
    await waitUntil(() => stages === 1)
    controller.abort()
    gate.resolve()
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.results[0]).toMatchObject({ started: true, stale: true, committed: false })
    expect(await write.execute({ path: 'late.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(abs, 'utf8')).toBe('late-original')
  })

  it('双在途取消：两个已完成的读取都 stale 且不可写', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    const a = writeText(root, 'a.txt', 'dual-a')
    const b = writeText(root, 'b.txt', 'dual-b')
    const cap = read.trustedRead!
    const original = cap.stage.bind(cap)
    const gate = deferred()
    let stages = 0
    vi.spyOn(cap, 'stage').mockImplementation(async (args, signal, canStart) => {
      stages++
      const staged = await original(args, signal, canStart)
      await gate.promise
      return staged
    })

    const controller = new AbortController()
    const pending = runToolBatch<string, StagedToolRead>({
      items: ['a.txt', 'b.txt'],
      mode: 'fast',
      eligible: true,
      signal: controller.signal,
      run: (path) => cap.stage({ path }, controller.signal),
      commit: (results) => {
        for (const r of results) if (r.value) cap.commit(r.value)
      },
      discard: (results) => {
        for (const r of results) if (r.value) cap.discard(r.value)
      }
    })
    await waitUntil(() => stages === 2)
    controller.abort()
    gate.resolve()
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.results.every((r) => r.started && r.stale && !r.committed)).toBe(true)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'b.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(a, 'utf8')).toBe('dual-a')
    expect(readFileSync(b, 'utf8')).toBe('dual-b')
  })

  it('唯一 canonical 版本键：别名读/commit 后可从另一别名写入；discard 后两个别名都不可写', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'sub/f.txt', 'alias-original')
    symlinkSync(join(root, 'sub'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')

    const staged = await read.trustedRead!.stage({ path: 'link/f.txt' })
    expect(staged.receipt?.key).toBe(await read.trustedRead!.canonicalKey({ path: 'sub/f.txt' }))
    read.trustedRead!.discard(staged)
    expect(await write.execute({ path: 'sub/f.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'link/f.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(join(root, 'sub/f.txt'), 'utf8')).toBe('alias-original')

    const fresh = await read.trustedRead!.stage({ path: 'link/f.txt' })
    read.trustedRead!.commit(fresh)
    expect(await write.execute({ path: 'sub/f.txt', content: 'alias-written' })).toContain('已写入')
    expect(readFileSync(join(root, 'sub/f.txt'), 'utf8')).toBe('alias-written')

    if (process.platform === 'win32') {
      // 大小写别名同样落到同一版本键（POSIX 大小写敏感，不做此断言）
      const caseStaged = await read.trustedRead!.stage({ path: 'sub/f.txt' })
      read.trustedRead!.commit(caseStaged)
      expect(await write.execute({ path: 'SUB/F.TXT', content: 'case-written' })).toContain('已写入')
      expect(readFileSync(join(root, 'sub/f.txt'), 'utf8')).toBe('case-written')
    }
  })

  it('串行 execute 也按 canonical 键登记：别名读取后另一别名可写', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'sub/g.txt', 'serial-alias')
    symlinkSync(join(root, 'sub'), join(root, 'serial-link'), process.platform === 'win32' ? 'junction' : 'dir')

    await read.execute({ path: 'serial-link/g.txt' })
    expect(await write.execute({ path: 'sub/g.txt', content: 'serial-written' })).toContain('已写入')
    expect(readFileSync(join(root, 'sub/g.txt'), 'utf8')).toBe('serial-written')
  })

  it('新建文件与新建多级目录仍可写；覆盖未读文件仍拒绝', async () => {
    const root = tempRoot()
    const { write } = toolsFor(root)
    expect(await write.execute({ path: 'new/dir/n.txt', content: 'n1' })).toContain('已写入')
    expect(readFileSync(join(root, 'new/dir/n.txt'), 'utf8')).toBe('n1')
    expect(await write.execute({ path: 'new/dir/n.txt', content: 'n2' })).toContain('已写入')

    writeText(root, 'existing/unread.txt', 'keep')
    expect(await write.execute({ path: 'existing/unread.txt', content: 'x' })).toContain('请先用 read_file')
    expect(readFileSync(join(root, 'existing/unread.txt'), 'utf8')).toBe('keep')
  })

  it('第二次 canStart 返回 false：stage 透传 blocked，整批不提交', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'a.txt', 'A')
    let calls = 0
    const staged = await read.trustedRead!.stage({ path: 'a.txt' }, undefined, () => {
      calls++
      return calls === 1
    })
    expect(calls).toBe(2)
    expect(staged.blocked).toBe(true)
    expect(staged.receipt).toBeNull()
    expect(staged.text).toBe('')
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
  })

  it('stage 内 canStart 抛错 fail-closed：第 1 项已读、第 2 项 blocked，整批 discard', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'a.txt', 'A')
    writeText(root, 'b.txt', 'B')
    let current = ''
    const result = await runToolBatch<string, StagedToolRead>({
      items: ['a.txt', 'b.txt'],
      mode: 'fast',
      eligible: true,
      run: (path) => {
        current = path
        return read.trustedRead!.stage({ path }, undefined, () => {
          if (current === 'b.txt') throw new Error('guard boom')
          return true
        })
      },
      guard: (results) => results.every((r) => r.value?.blocked !== true),
      commit: (results) => {
        for (const r of results) if (r.value?.receipt) read.trustedRead!.commit(r.value)
      }
    })
    expect(result.aborted).toBe(true)
    expect(result.results.every((r) => r.started)).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'fulfilled', stale: true, committed: false })
    expect(result.results[1]!.value?.blocked).toBe(true)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A')
  })

  it('未启动项阻断整批提交：第 1 项已读也不得留下版本', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'a.txt', 'A')
    writeText(root, 'b.txt', 'B')
    const result = await runToolBatch<string, StagedToolRead>({
      items: ['a.txt', 'b.txt'],
      mode: 'fast',
      eligible: true,
      canStart: (path) => path !== 'b.txt',
      run: (path) => read.trustedRead!.stage({ path }),
      commit: (results) => {
        for (const r of results) if (r.value?.receipt) read.trustedRead!.commit(r.value)
      }
    })
    expect(result.aborted).toBe(true)
    expect(result.results[0]).toMatchObject({ started: true, stale: true, committed: false })
    expect(result.results[1]).toMatchObject({ started: false, status: 'skipped' })
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'b.txt', content: 'hacked' })).toContain('请先用 read_file')
  })

  it('提交门 guard 同步 abort 且返回 true：整批仍 discard，两个真实文件都不可写', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    const a = writeText(root, 'a.txt', 'original-a')
    const b = writeText(root, 'b.txt', 'original-b')
    const controller = new AbortController()
    let commitCalls = 0
    const result = await runToolBatch<string, StagedToolRead>({
      items: ['a.txt', 'b.txt'],
      mode: 'fast',
      eligible: true,
      signal: controller.signal,
      run: (path) => read.trustedRead!.stage({ path }, controller.signal),
      guard: () => {
        controller.abort()
        return true
      },
      commit: (results) => {
        commitCalls++
        for (const r of results) if (r.value) read.trustedRead!.commit(r.value)
      },
      discard: (results) => {
        for (const r of results) if (r.value) read.trustedRead!.discard(r.value)
      }
    })
    expect(commitCalls).toBe(0)
    expect(result.aborted).toBe(true)
    expect(result.results.every((r) => r.started && r.stale && !r.committed)).toBe(true)
    expect(await write.execute({ path: 'a.txt', content: 'hacked-a' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'b.txt', content: 'hacked-b' })).toContain('请先用 read_file')
    expect(readFileSync(a, 'utf8')).toBe('original-a')
    expect(readFileSync(b, 'utf8')).toBe('original-b')
  })

  it('提交门 guard 抛错：整批 discard，其他成功项也不提交', async () => {
    const root = tempRoot()
    const { read, write } = toolsFor(root)
    writeText(root, 'a.txt', 'guard-throw-a')
    writeText(root, 'b.txt', 'guard-throw-b')
    const result = await runToolBatch<string, StagedToolRead>({
      items: ['a.txt', 'b.txt'],
      mode: 'fast',
      eligible: true,
      run: (path) => read.trustedRead!.stage({ path }),
      guard: () => {
        throw new Error('guard down')
      },
      commit: (results) => {
        for (const r of results) if (r.value) read.trustedRead!.commit(r.value)
      }
    })
    expect(result.aborted).toBe(true)
    expect(result.results.every((r) => r.started && r.stale && !r.committed)).toBe(true)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
  })
})

describe('S3-40B 资格：canonical key 与真实对象身份', () => {
  it('不同文件可成批；同文件与相对/绝对别名判不独立', async () => {
    const root = tempRoot()
    const { read, map } = toolsFor(root)
    writeText(root, 'one.txt', '1')
    writeText(root, 'two.txt', '2')

    const plan = await planTrustedReadBatch(
      [readCall('c1', 'one.txt'), readCall('c2', join(root, 'two.txt'))],
      map
    )
    expect(plan).not.toBeNull()
    expect(plan!.keys).toHaveLength(2)

    expect(
      await planTrustedReadBatch(
        [readCall('c1', 'one.txt'), readCall('c2', join(root, '.', 'one.txt'))],
        map
      )
    ).toBeNull()
    // 重复调用 id 无法配对回原调用：保守串行
    expect(
      await planTrustedReadBatch([readCall('c1', 'one.txt'), readCall('c1', 'two.txt')], map)
    ).toBeNull()
    expect(isTrustedReadTool(read)).toBe(true)
  })

  it('大小写与 junction 别名识别为同一文件；平台差异显式断言', async () => {
    const root = tempRoot()
    const { read, map } = toolsFor(root)
    writeText(root, 'Case.txt', 'case')
    const cap = read.trustedRead!

    if (process.platform === 'win32') {
      expect(await cap.canonicalKey({ path: 'Case.txt' })).toBe(await cap.canonicalKey({ path: 'case.txt' }))
      expect(
        await planTrustedReadBatch([readCall('c1', 'Case.txt'), readCall('c2', 'case.txt')], map)
      ).toBeNull()
    } else {
      // POSIX 大小写敏感：不同名即不同文件；后者不存在 → realpath 未知 → 保守串行
      expect(await cap.canonicalKey({ path: 'case.txt' })).toBeNull()
      expect(
        await planTrustedReadBatch([readCall('c1', 'Case.txt'), readCall('c2', 'case.txt')], map)
      ).toBeNull()
    }

    mkdirSync(join(root, 'sub'))
    writeText(root, 'sub/f.txt', 'junction')
    symlinkSync(join(root, 'sub'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await cap.canonicalKey({ path: 'sub/f.txt' })).toBe(await cap.canonicalKey({ path: 'link/f.txt' }))
    expect(
      await planTrustedReadBatch([readCall('c1', 'sub/f.txt'), readCall('c2', 'link/f.txt')], map)
    ).toBeNull()
  })

  it('同名冒充、混合读写与 realpath 未知一律串行', async () => {
    const root = tempRoot()
    const { map } = toolsFor(root)
    writeText(root, 'a.txt', 'a')

    let fakeStageCalls = 0
    const fake: AgentTool = {
      schema: { name: 'read_file', description: '', parameters: {} },
      execute: async () => 'fake',
      trustedRead: {
        // 每条调用给不同键：若 loop 只按名字/结构信任，这里就会真的进入批路径
        canonicalKey: async (args) => `fake-key:${String(args['path'])}`,
        stage: async () => {
          fakeStageCalls++
          return { text: 'fake', ok: true, receipt: { abs: 'fake', revision: 'r', key: 'fake-key' }, key: 'fake-key' }
        },
        commit: () => 'fake',
        discard: () => {}
      }
    }
    expect(isTrustedReadTool(fake)).toBe(false)
    const fakeMap = new Map([['read_file', fake]])
    expect(
      await planTrustedReadBatch([readCall('c1', 'a.txt'), readCall('c2', 'b.txt')], fakeMap)
    ).toBeNull()
    expect(fakeStageCalls).toBe(0)

    expect(
      await planTrustedReadBatch(
        [
          readCall('c1', 'a.txt'),
          { id: 'c2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'x' }) }
        ],
        map
      )
    ).toBeNull()
    expect(
      await planTrustedReadBatch([readCall('c1', 'missing.txt'), readCall('c2', 'a.txt')], map)
    ).toBeNull()
  })
})

describe('S3-40B loop 入口：有序回灌、版本、租约与取消', () => {
  it('FAST 双读真实执行：完成逆序但工具 ID/消息顺序不变，版本提交后可用', async () => {
    const root = tempRoot()
    const { read, write, tools } = toolsFor(root)
    writeText(root, 'a.txt', 'A-content')
    writeText(root, 'b.txt', 'B-content')
    const cap = read.trustedRead!
    const original = cap.stage.bind(cap)
    const slow = deferred()
    const completed: string[] = []
    let stageCalls = 0
    vi.spyOn(cap, 'stage').mockImplementation(async (args, signal, canStart) => {
      stageCalls++
      const path = String(args['path'])
      const staged = await original(args, signal, canStart)
      if (path === 'a.txt') await slow.promise
      completed.push(path)
      return staged
    })

    const calls = [readCall('call_a', 'a.txt'), readCall('call_b', 'b.txt')]
    const events: ToolEvent[] = []
    let seen: AgentMessage[] = []
    let chatCalls = 0
    const loop = runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      requestPolicy: FAST_POLICY,
      maxRounds: 3,
      onToolEvent: (e) => events.push(e),
      chat: async (messages): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: calls }
        seen = messages
        return { text: 'done', toolCalls: [] }
      }
    })

    await waitUntil(() => completed.includes('b.txt'))
    expect(completed).toEqual(['b.txt'])
    await waitUntil(() => peekWatchdogLeases().length === 1)
    expect(stageCalls).toBe(2)
    expect(peekWatchdogLeases().map((lease) => lease.phase)).toEqual(['tool:read_file'])
    slow.resolve()
    const result = await loop

    expect(result.stopReason).toBe('completed')
    expect(stageCalls).toBe(2)
    expect(chatCalls).toBe(2)
    expect(completed).toEqual(['b.txt', 'a.txt'])
    const toolMsgs = seen.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['call_a', 'call_b'])
    expect(toolMsgs[0]!.content).toContain('1|A-content')
    expect(toolMsgs[1]!.content).toContain('1|B-content')
    const starts = events.filter((e) => e.phase === 'start').map((e) => e.id)
    const ends = events.filter((e) => e.phase !== 'start').map((e) => e.id)
    expect(starts).toEqual(['call_a', 'call_b'])
    expect(ends).toEqual(['call_a', 'call_b'])
    expect(peekWatchdogLeases()).toHaveLength(0)
    expect(await write.execute({ path: 'a.txt', content: 'A2' })).toContain('已写入')
  })

  it('普通模式仍走原串行 execute：不调用 stage，读版本照常成立', async () => {
    const root = tempRoot()
    const { read, write, tools } = toolsFor(root)
    writeText(root, 'a.txt', 'A')
    writeText(root, 'b.txt', 'B')
    let stageCalls = 0
    vi.spyOn(read.trustedRead!, 'stage').mockImplementation(async () => {
      stageCalls++
      return { text: '', ok: false, receipt: null, key: null }
    })

    let seen: AgentMessage[] = []
    let chatCalls = 0
    await runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: { ...FAST_POLICY, mode: 'normal', maxLocalReadConcurrency: 1, requestedServiceTier: null },
      chat: async (messages): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: [readCall('n1', 'a.txt'), readCall('n2', 'b.txt')] }
        seen = messages
        return { text: 'done', toolCalls: [] }
      }
    })
    expect(stageCalls).toBe(0)
    expect(seen.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['n1', 'n2'])
    expect(await write.execute({ path: 'a.txt', content: 'A2' })).toContain('已写入')
  })

  it('混合读写整批串行：read 后 write 仍受读版本保护', async () => {
    const root = tempRoot()
    const { read, tools } = toolsFor(root)
    writeText(root, 'a.txt', 'A')
    let stageCalls = 0
    vi.spyOn(read.trustedRead!, 'stage').mockImplementation(async () => {
      stageCalls++
      return { text: '', ok: false, receipt: null, key: null }
    })

    let seen: AgentMessage[] = []
    let chatCalls = 0
    await runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      chat: async (messages): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) {
          return {
            text: null,
            toolCalls: [
              readCall('m1', 'a.txt'),
              { id: 'm2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'written' }) }
            ]
          }
        }
        seen = messages
        return { text: 'done', toolCalls: [] }
      }
    })
    expect(stageCalls).toBe(0)
    const toolMsgs = seen.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['m1', 'm2'])
    expect(toolMsgs[1]!.content).toContain('已写入')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('written')
  })

  it('伪 read_file（同名 + 自述 trustedRead）串行执行，不进入批路径', async () => {
    let fakeStages = 0
    let executeCalls = 0
    let active = 0
    let peak = 0
    const fake: AgentTool = {
      schema: { name: 'read_file', description: '', parameters: {} },
      execute: async () => {
        executeCalls++
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return 'fake-read'
      },
      trustedRead: {
        canonicalKey: async (args) => `k:${String(args['path'])}`,
        stage: async () => {
          fakeStages++
          return { text: 'fake', ok: true, receipt: { abs: 'x', revision: 'r', key: 'k' }, key: 'k' }
        },
        commit: () => 'fake',
        discard: () => {}
      }
    }
    let chatCalls = 0
    await runAgentLoop({
      systemPrompt: '',
      history: [],
      tools: [fake],
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      chat: async (): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: [readCall('f1', 'a.txt'), readCall('f2', 'b.txt')] }
        return { text: 'done', toolCalls: [] }
      }
    })
    expect(fakeStages).toBe(0)
    expect(executeCalls).toBe(2)
    expect(peak).toBe(1)
  })

  it('批内单项读取失败保留其他成功结果，失败项无写资格', async () => {
    const root = tempRoot()
    const { tools, write } = toolsFor(root)
    writeText(root, 'ok.txt', 'good')
    const bin = join(root, 'bin.dat')
    writeFileSync(bin, Buffer.from([0, 1, 2, 3]))

    let seen: AgentMessage[] = []
    let chatCalls = 0
    await runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      chat: async (messages): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: [readCall('r1', 'ok.txt'), readCall('r2', 'bin.dat')] }
        seen = messages
        return { text: 'done', toolCalls: [] }
      }
    })
    const toolMsgs = seen.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['r1', 'r2'])
    expect(toolMsgs[0]!.content).toContain('1|good')
    expect(toolMsgs[1]!.content).toContain('二进制')
    expect(await write.execute({ path: 'ok.txt', content: 'new' })).toContain('已写入')
    expect(await write.execute({ path: 'bin.dat', content: 'text' })).toContain('请先用 read_file')
    expect([...readFileSync(bin)]).toEqual([0, 1, 2, 3])
  })

  it('loop 提交门同步取消：两次读取已暂存才 abort，暂停且无写资格', async () => {
    const root = tempRoot()
    const { read, write, tools } = toolsFor(root)
    const a = writeText(root, 'a.txt', 'gate-a')
    const b = writeText(root, 'b.txt', 'gate-b')
    const controller = new AbortController()
    const cap = read.trustedRead!
    const original = cap.stage.bind(cap)
    let staged = 0
    vi.spyOn(cap, 'stage').mockImplementation(async (args, signal, canStart) => {
      const result = await original(args, signal, canStart)
      staged++
      return result
    })

    // 前 6 次：两项批启动 2 + stage 预检 2 + readCore 预检 2；第 7 次只能是最终提交门
    let calls = 0
    let gateStaged = -1
    const canStart = (): boolean => {
      calls++
      if (calls === 7) {
        gateStaged = staged
        controller.abort()
        return true
      }
      return true
    }

    let chatCalls = 0
    let seen: AgentMessage[] = []
    const loop = runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      signal: controller.signal,
      canStart,
      chat: async (messages): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: [readCall('c1', 'a.txt'), readCall('c2', 'b.txt')] }
        seen = messages
        return { text: 'done', toolCalls: [] }
      }
    })
    await expect(loop).rejects.toThrow()
    expect(gateStaged).toBe(2)
    expect(calls).toBeGreaterThanOrEqual(7)
    expect(chatCalls).toBe(1)
    expect(seen).toEqual([])
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'b.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(a, 'utf8')).toBe('gate-a')
    expect(readFileSync(b, 'utf8')).toBe('gate-b')
  })

  it('loop 批内后续项 canStart 拒绝：整轮暂停，已启动项的读取也不留版本', async () => {
    const root = tempRoot()
    const { read, write, tools } = toolsFor(root)
    const a = writeText(root, 'a.txt', 'A')
    const b = writeText(root, 'b.txt', 'B')
    writeText(root, 'c.txt', 'C')
    const cap = read.trustedRead!
    const original = cap.stage.bind(cap)
    let deny = false
    vi.spyOn(cap, 'stage').mockImplementation(async (args, signal, canStart) => {
      const staged = await original(args, signal, canStart)
      deny = true
      return staged
    })

    let chatCalls = 0
    const loop = runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      canStart: () => !deny,
      chat: async (): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) {
          return {
            text: null,
            toolCalls: [readCall('u1', 'a.txt'), readCall('u2', 'b.txt'), readCall('u3', 'c.txt')]
          }
        }
        return { text: 'done', toolCalls: [] }
      }
    })
    await expect(loop).rejects.toThrow(/未提交|守卫/)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(await write.execute({ path: 'b.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(a, 'utf8')).toBe('A')
    expect(readFileSync(b, 'utf8')).toBe('B')
  })

  it('串行路径也在启动前核 canStart：拒绝时工具不执行、run 暂停', async () => {
    const root = tempRoot()
    const { read, write, tools } = toolsFor(root)
    writeText(root, 'a.txt', 'serial-guard')
    let executes = 0
    const original = read.execute.bind(read)
    vi.spyOn(read, 'execute').mockImplementation(async (args) => {
      executes++
      return original(args)
    })

    let chatCalls = 0
    const loop = runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: { ...FAST_POLICY, mode: 'normal', maxLocalReadConcurrency: 1, requestedServiceTier: null },
      canStart: () => false,
      chat: async (): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: [readCall('s1', 'a.txt')] }
        return { text: 'done', toolCalls: [] }
      }
    })
    await expect(loop).rejects.toThrow(/守卫/)
    expect(executes).toBe(0)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
  })

  it('取消发生在读取启动前：run 中止，不留任何写资格', async () => {
    const root = tempRoot()
    const { write, tools } = toolsFor(root)
    const abs = writeText(root, 'a.txt', 'original')
    writeText(root, 'b.txt', 'B')
    const controller = new AbortController()
    let chatCalls = 0
    const loop = runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      signal: controller.signal,
      chat: async (): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) {
          queueMicrotask(() => controller.abort())
          return { text: null, toolCalls: [readCall('x1', 'a.txt'), readCall('x2', 'b.txt')] }
        }
        return { text: 'done', toolCalls: [] }
      }
    })
    await expect(loop).rejects.toThrow()
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(abs, 'utf8')).toBe('original')
  })

  it('异步准备后 guard 失效：整批 discard 并暂停，不留写资格', async () => {
    const root = tempRoot()
    const { read, write, tools } = toolsFor(root)
    const abs = writeText(root, 'a.txt', 'guard-original')
    writeText(root, 'b.txt', 'B')
    const cap = read.trustedRead!
    const original = cap.stage.bind(cap)
    let allowed = true
    vi.spyOn(cap, 'stage').mockImplementation(async (args, signal, canStart) => {
      allowed = false
      return original(args, signal, canStart)
    })

    let chatCalls = 0
    const loop = runAgentLoop({
      systemPrompt: '',
      history: [],
      tools,
      maxRounds: 3,
      requestPolicy: FAST_POLICY,
      canStart: () => allowed,
      chat: async (): Promise<AgentChatResult> => {
        chatCalls++
        if (chatCalls === 1) return { text: null, toolCalls: [readCall('g1', 'a.txt'), readCall('g2', 'b.txt')] }
        return { text: 'done', toolCalls: [] }
      }
    })
    await expect(loop).rejects.toThrow(/未提交|守卫/)
    expect(await write.execute({ path: 'a.txt', content: 'hacked' })).toContain('请先用 read_file')
    expect(readFileSync(abs, 'utf8')).toBe('guard-original')
  })
})
