// 逐处退回 · **全链路**单测（plan13 批 B · B4）。
//
// 为什么必须抽出来测：三道闸原先长在 `src/main/ipc.ts` 的 handler 里，而 handler import 了
// electron —— CI 上没有 Electron 二进制就跑不了，整段逻辑一条测试都没有（"把 mtime 阀删掉，
// 所有测试仍然全绿"）；而那道阀是唯一防"点了第 2 处、改掉第 N 处"的东西。抽到
// `src/main/revert-flow.ts` 并注入依赖后，才能用**真实临时目录**端到端跑。
// 判据不落在"返回了 ok"：① 磁盘内容真的变成退完那一处的样子；② 这次退回自己留下一轮检查点、
// 回滚它能拿回 Agent 那一版；③ 被拦下的每种情形，文件一个字都没被碰过。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckpointStore, type CheckpointStore } from '@main/store/checkpoints'
import { createWorkspaceWriter } from '@main/workspace-write'
import { revertOneHunk, samePath, type RevertDeps } from '@main/revert-flow'

const dirs: string[] = []

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

const read = (ws: string, rel: string): string => readFileSync(join(ws, rel), 'utf8')

/** 造两处**相隔很远**的改动（第 2 行、第 17 行），保证切成 2 块 */
function pair(): { before: string; after: string } {
  const b: string[] = []
  const a: string[] = []
  for (let i = 1; i <= 20; i++) {
    if (i === 2) {
      b.push('const x = 1')
      a.push('const x = 42')
    } else if (i === 17) {
      b.push('const y = 2')
      a.push('const y = 3')
    } else {
      b.push(`line ${i}`)
      a.push(`line ${i}`)
    }
  }
  return { before: b.join('\n'), after: a.join('\n') }
}

interface Harness {
  ws: string
  store: CheckpointStore
  runId: string
  writeRuns: string[]
  deps: RevertDeps
  /** 当前磁盘 mtime（用来当"界面看到时"的基线） */
  mtime: () => number
}

/** 搭一套与 `ipc.ts` 同形的依赖：真实文件 + 真实检查点 + **真实统一写入服务** */
function harness(opts: {
  before: string
  after: string
  rel?: string
  /** 覆盖"当前工作区"，模拟切了工作区 */
  workspaceRootOverride?: string
}): Harness {
  const rel = opts.rel ?? 'a.txt'
  const ws = tmp('jsl-rv-ws-')
  const store = createCheckpointStore(tmp('jsl-rv-ckpt-'))

  mkdirSync(join(ws, 'sub'), { recursive: true })
  writeFileSync(join(ws, rel), opts.before, 'utf8')

  // 模拟 Agent 写文件：**先快照，再写**
  const runId = store.begin(ws, '内核默认', 'c1')
  store.record(runId, ws, rel, join(ws, rel))
  writeFileSync(join(ws, rel), opts.after, 'utf8')
  store.finish(runId)

  const writeRuns: string[] = []
  const writeThrough = async (target: string, content: string): Promise<string> => {
    // 与 `runFsOp` 同形：开一轮 → 写前快照 → 写 → 收尾
    const wRunId = store.begin(ws, '界面：退回', 'ui')
    writeRuns.push(wRunId)
    const writer = createWorkspaceWriter(ws, {
      beforeChange: (r, abs) => store.record(wRunId, ws, r, abs),
      trash: async () => undefined
    })
    try {
      return await writer.write(target, content)
    } finally {
      store.finish(wRunId)
    }
  }

  const readCurrent: RevertDeps['readCurrent'] = async (target) => {
    const abs = join(ws, target)
    if (!existsSync(abs)) return null
    const st = statSync(abs)
    const buf = readFileSync(abs)
    return { content: buf.toString('utf8'), mtimeMs: st.mtimeMs }
  }

  return {
    ws,
    store,
    runId,
    writeRuns,
    mtime: () => statSync(join(ws, rel)).mtimeMs,
    deps: {
      store,
      workspaceRoot: opts.workspaceRootOverride ?? ws,
      readCurrent,
      writeThrough
    }
  }
}

describe('逐处退回 · 全链路（真实文件 + 真实检查点 + 统一写入服务）', () => {
  it('**退第 1 处：磁盘上的内容真的变了，第 2 处一个字没动**', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })

    const r = await revertOneHunk(h.deps, {
      runId: h.runId,
      rel: 'a.txt',
      hunkIndex: 1,
      expectedMtimeMs: h.mtime()
    })

    expect(r.ok).toBe(true)
    const text = read(h.ws, 'a.txt')
    expect(text).toContain('const x = 1') // 第 1 处：退回来了
    expect(text).not.toContain('const x = 42')
    expect(text).toContain('const y = 3') // 第 2 处：**不许被顺手改掉**
    expect(text.split('\n')).toHaveLength(20) // 行数不变
  })

  it('**这次退回自己留下了一轮检查点，而且回滚它能拿回 Agent 那一版**（"退错了还能再退"）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })

    await revertOneHunk(h.deps, {
      runId: h.runId,
      rel: 'a.txt',
      hunkIndex: 1,
      expectedMtimeMs: h.mtime()
    })

    expect(h.writeRuns).toHaveLength(1)
    const wRunId = h.writeRuns[0]!
    expect(h.store.get(wRunId)?.changes.map((c) => c.rel)).toEqual(['a.txt'])

    // 写前快照 = 即将被覆盖的内容，所以 `beforeBytes` 是 **Agent 改后那一版**的大小，不是"改前"那版
    const wChange = h.store.get(wRunId)?.changes[0]
    expect(wChange?.kind).toBe('modified')
    expect(wChange?.beforeBytes).toBe(Buffer.byteLength(after, 'utf8'))

    const report = h.store.rollback(wRunId)
    expect(report.failed).toEqual([])
    expect(read(h.ws, 'a.txt')).toBe(after)
  })

  it('退第 2 处 → 第 1 处保留（序号真的被用了，不是"恒退第一块"）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })

    const r = await revertOneHunk(h.deps, {
      runId: h.runId,
      rel: 'a.txt',
      hunkIndex: 2,
      expectedMtimeMs: h.mtime()
    })

    expect(r.ok).toBe(true)
    const text = read(h.ws, 'a.txt')
    expect(text).toContain('const x = 42') // 第 1 处保留
    expect(text).toContain('const y = 2') // 第 2 处退回来了
    expect(text).not.toContain('const y = 3')
  })
})

describe('逐处退回 · 被拦下的情形：**文件一个字都不许被碰**', () => {
  /** 每种被拦下的情形都必须满足：返回对应原因 + 磁盘内容原样 + 没有开新轮次 */
  async function expectRefused(
    h: Harness,
    input: { hunkIndex: number; expectedMtimeMs: number },
    reason: string
  ): Promise<void> {
    const beforeText = read(h.ws, 'a.txt')
    const r = await revertOneHunk(h.deps, { runId: h.runId, rel: 'a.txt', ...input })
    expect(r).toEqual({ ok: false, reason })
    expect(read(h.ws, 'a.txt')).toBe(beforeText)
    expect(h.writeRuns).toHaveLength(0)
  }

  it('**mtime 对不上 → changed-on-disk**（这道阀就是"点了第 2 处、改掉第 N 处"的唯一防线）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    // 模拟"用户看差异期间，文件被 Agent 又改了一次"
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() - 5000 }, 'changed-on-disk')
  })

  it('**差 0.5 毫秒也要拒**（审查指出：留 1ms 容差就留了一个"退错块"的窄窗口）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    // ⚠️ 留 1ms 容差就是留一个"退错块"的静默窗口（容差写法会让这条绿着通过），所以必须精确比较、不同值一律拒
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() + 0.5 }, 'changed-on-disk')
  })

  it('**不是合法 UTF-8 → lossy-encoding**（整份重写会把没被退的行也一起弄烂，且不可逆）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    h.deps.readCurrent = async () => ({ content: after, mtimeMs: h.mtime(), lossy: true })
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() }, 'lossy-encoding')
  })

  it('**快照侧有损（GBK 备份）→ 也拒**', async () => {
    const ws = tmp('jsl-rv-ws-')
    const store = createCheckpointStore(tmp('jsl-rv-ckpt-'))
    // 造一个真的 GBK 文件当"改前内容"：`toString('utf8')` 出来的字符串再编码回去**不等于原字节**
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xba, 0xc3, 0x0a, 0xc4, 0xe3, 0xba, 0xc3])
    writeFileSync(join(ws, 'gbk.txt'), gbk)
    const runId = store.begin(ws, '内核默认', 'c1')
    store.record(runId, ws, 'gbk.txt', join(ws, 'gbk.txt'))
    writeFileSync(join(ws, 'gbk.txt'), 'ASCII 改动\n', 'utf8')
    store.finish(runId)

    // 前置：读快照必须自己认出"有损"（这条判据是整条防线的前提）
    const snap = store.readBackup(runId, 'gbk.txt')
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.lossy).toBe(true)

    const r = await revertOneHunk(
      {
        store,
        workspaceRoot: ws,
        readCurrent: async () => ({
          content: 'ASCII 改动\n',
          mtimeMs: statSync(join(ws, 'gbk.txt')).mtimeMs
        }),
        writeThrough: async () => 'should-not-happen'
      },
      {
        runId,
        rel: 'gbk.txt',
        hunkIndex: 1,
        expectedMtimeMs: statSync(join(ws, 'gbk.txt')).mtimeMs
      }
    )
    expect(r).toEqual({ ok: false, reason: 'lossy-encoding' })
    expect(readFileSync(join(ws, 'gbk.txt'), 'utf8')).toBe('ASCII 改动\n')
  })

  it('**拿不到 mtime → 也拒**（读不到时间戳就意味着说不清它变没变，不该赌）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    // `mtimeMs` 在类型上本来就是可选的 —— 用它来测这条分支
    h.deps.readCurrent = async () => ({ content: after })
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() }, 'changed-on-disk')
  })

  it('**序号越界 → no-such-hunk**（不许默不作声退成别处）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    await expectRefused(h, { hunkIndex: 99, expectedMtimeMs: h.mtime() }, 'no-such-hunk')
  })

  it('**新建的文件 → created**（它没有"改前的那几行"可还原）', async () => {
    const ws = tmp('jsl-rv-ws-')
    const store = createCheckpointStore(tmp('jsl-rv-ckpt-'))
    const runId = store.begin(ws, '内核默认', 'c1')
    store.record(runId, ws, 'new.txt', join(ws, 'new.txt')) // 此刻还不存在 → created
    writeFileSync(join(ws, 'new.txt'), '新建的内容', 'utf8')
    store.finish(runId)

    const writeRuns: string[] = []
    const r = await revertOneHunk(
      {
        store,
        workspaceRoot: ws,
        readCurrent: async () => ({ content: '新建的内容', mtimeMs: statSync(join(ws, 'new.txt')).mtimeMs }),
        writeThrough: async () => {
          writeRuns.push('x')
          return 'should-not-happen'
        }
      },
      { runId, rel: 'new.txt', hunkIndex: 1, expectedMtimeMs: statSync(join(ws, 'new.txt')).mtimeMs }
    )
    expect(r).toEqual({ ok: false, reason: 'created' })
    expect(read(ws, 'new.txt')).toBe('新建的内容')
    expect(writeRuns).toHaveLength(0)
  })

  it('**当前内容被截断 → truncated**（拿半个文件算出来的块去写盘 = 把文件砍坏）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    h.deps.readCurrent = async () => ({ content: after.slice(0, 10), mtimeMs: h.mtime(), truncated: true })
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() }, 'truncated')
  })

  it('**快照侧被截断 → truncated**', async () => {
    const big = 'x'.repeat(256 * 1024 + 100)
    const h = harness({ before: big, after: big + '\nTAIL' })
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() }, 'truncated')
  })

  it('**属于另一个工作区 → other-workspace**（这是唯一会"静默改错文件"的路径）', async () => {
    const { before, after } = pair()
    const other = tmp('jsl-rv-other-')
    const h = harness({ before, after, workspaceRootOverride: other })
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() }, 'other-workspace')
  })

  it('**快照被清理掉了 → backup-missing**（如实说看不了，不假装文件是空的）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    rmSync(join(h.store.dir, h.runId, 'files', '0.bin'), { force: true })
    await expectRefused(h, { hunkIndex: 1, expectedMtimeMs: h.mtime() }, 'backup-missing')
  })

  it('**轮次不存在 → run-missing**、**这一轮没记录过它 → not-recorded**', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    const bad = await revertOneHunk(h.deps, {
      runId: '不存在',
      rel: 'a.txt',
      hunkIndex: 1,
      expectedMtimeMs: h.mtime()
    })
    expect(bad).toEqual({ ok: false, reason: 'run-missing' })

    const notRec = await revertOneHunk(h.deps, {
      runId: h.runId,
      rel: 'never.txt',
      hunkIndex: 1,
      expectedMtimeMs: h.mtime()
    })
    expect(notRec).toEqual({ ok: false, reason: 'not-recorded' })
    expect(h.writeRuns).toHaveLength(0)
  })

  it('**路径越界 → bad-rel**（`../` 一律拒绝，绝不拼到工作区外）', async () => {
    const { before, after } = pair()
    const h = harness({ before, after })
    const r = await revertOneHunk(h.deps, {
      runId: h.runId,
      rel: '../../evil.txt',
      hunkIndex: 1,
      expectedMtimeMs: h.mtime()
    })
    expect(r).toEqual({ ok: false, reason: 'bad-rel' })
    expect(h.writeRuns).toHaveLength(0)
  })
})

describe('samePath —— 工作区判据（路径等价性）', () => {
  // ⚠️ 别用 `'D:\\a\\b'` 这种硬编码 Windows 路径写断言（CI 教我的一课）：Linux 上 `\` 不是路径分隔符、
  //    只是普通字符，`'D:\a\b\'` 与 `'D:\a\b'` 是两个不同路径 —— 本地全绿、CI 红一条；要验"尾部分隔符不算区别"就用**本平台真实的分隔符**（`base + sep`）去构造。
  const base = join(tmpdir(), 'jsl-same-path')

  it('同一个路径的不同写法算同一个（尾部分隔符不算区别）', () => {
    expect(samePath(base, base + sep)).toBe(true)
  })

  it('不同路径不算同一个', () => {
    expect(samePath(base, join(tmpdir(), 'jsl-other-path'))).toBe(false)
  })

  it('Windows 上大小写不同也算同一个；POSIX 上不算（大小写敏感）', () => {
    expect(samePath(base, base.toUpperCase())).toBe(process.platform === 'win32')
  })
})
