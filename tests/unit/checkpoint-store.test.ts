import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckpointStore } from '@main/store/checkpoints'

// 检查点落盘层集成测试（plan8 R4）
//
// 这组测试回答的是产品问题：**Agent 把文件改坏了，双击回滚能不能真的退回去？**
// 用真实临时目录 + 真实文件，不走 mock —— 因为要验证的正是"真的读写对了"。

const dirs: string[] = []

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** 造一个"工作区 + 仓库"的组合 */
function setup(): { ws: string; store: ReturnType<typeof createCheckpointStore> } {
  const ws = tmp('jsl-ws-')
  const store = createCheckpointStore(tmp('jsl-ckpt-'))
  return { ws, store }
}

function write(ws: string, rel: string, content: string): void {
  const abs = join(ws, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

const read = (ws: string, rel: string): string => readFileSync(join(ws, rel), 'utf8')

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

describe('回滚：改坏的文件能退回去', () => {
  it('修改已有文件 → 回滚后内容还原', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', '原始内容')

    const runId = store.begin(ws, '内核默认')
    // 模拟 Agent 写文件：先快照，再写
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    write(ws, 'a.txt', '被改坏了')
    store.finish(runId)

    expect(read(ws, 'a.txt')).toBe('被改坏了') // 改是真改了
    const report = store.rollback(runId)
    expect(report.restored).toEqual(['a.txt'])
    expect(report.failed).toEqual([])
    expect(read(ws, 'a.txt')).toBe('原始内容') // 退回来了
  })

  it('新建文件 → 回滚后文件被删掉（还原成"不存在"）', () => {
    const { ws, store } = setup()

    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, 'new.md', join(ws, 'new.md')) // 此时不存在 → created
    write(ws, 'new.md', '新造的文件')
    store.finish(runId)

    expect(existsSync(join(ws, 'new.md'))).toBe(true)
    const report = store.rollback(runId)
    expect(report.deleted).toEqual(['new.md'])
    expect(existsSync(join(ws, 'new.md'))).toBe(false)
  })

  it('**同一文件一轮内写多次 → 回滚到这一轮开始前**（不是中间状态）', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', '第 0 版')

    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    write(ws, 'a.txt', '第 1 版')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt')) // 第二次：应被忽略
    write(ws, 'a.txt', '第 2 版')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    write(ws, 'a.txt', '第 3 版')
    store.finish(runId)

    expect(read(ws, 'a.txt')).toBe('第 3 版')
    store.rollback(runId)
    expect(read(ws, 'a.txt')).toBe('第 0 版') // 关键：回到最初，不是"第 2 版"
  })

  it('多文件混合（改 + 新建）→ 整轮回滚各自归位', () => {
    const { ws, store } = setup()
    write(ws, 'keep.txt', 'KEEP-原')
    write(ws, 'src/x.ts', 'X-原')

    const runId = store.begin(ws, 'planner')
    for (const rel of ['keep.txt', 'src/x.ts', 'brand-new.md']) {
      store.record(runId, ws, rel, join(ws, rel))
      write(ws, rel, 'MUTATED')
    }
    store.finish(runId)

    const report = store.rollback(runId)
    expect(report.restored.sort()).toEqual(['keep.txt', 'src/x.ts'])
    expect(report.deleted).toEqual(['brand-new.md'])
    expect(read(ws, 'keep.txt')).toBe('KEEP-原')
    expect(read(ws, 'src/x.ts')).toBe('X-原')
    expect(existsSync(join(ws, 'brand-new.md'))).toBe(false)
  })

  it('单文件回滚：只退这一个，另一个保持被改状态', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', 'A-原')
    write(ws, 'b.txt', 'B-原')

    const runId = store.begin(ws, '内核默认')
    for (const rel of ['a.txt', 'b.txt']) {
      store.record(runId, ws, rel, join(ws, rel))
      write(ws, rel, 'MUTATED')
    }
    store.finish(runId)

    const report = store.rollback(runId, 'a.txt')
    expect(report.restored).toEqual(['a.txt'])
    expect(read(ws, 'a.txt')).toBe('A-原')
    expect(read(ws, 'b.txt')).toBe('MUTATED') // 未指定则不退
  })

  it('回滚不触碰工作区外的文件（快照阶段就拒绝）', () => {
    const { ws, store } = setup()
    const outsideDir = tmp('jsl-outside-')
    const outside = join(outsideDir, 'secret.txt')
    writeFileSync(outside, '不应该被记录', 'utf8')

    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, '../secret.txt', outside)
    store.finish(runId)

    expect(store.get(runId)?.changes).toEqual([]) // 越界文件根本没进记录
    expect(readFileSync(outside, 'utf8')).toBe('不应该被记录')
  })
})

describe('中断场景：manifest 增量落盘 → 中断的轮次也能回滚', () => {
  it('未调用 finish（模拟崩溃/中止）时，记录依然在盘上且可回滚', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', '原样')

    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    write(ws, 'a.txt', '崩之前改的')
    // 注意：**故意不调用 store.finish(runId)** —— 模拟应用崩溃

    // 换一个全新的 store 实例（等于重启应用），看还能不能读到这一轮
    const reopened = createCheckpointStore(store.dir)
    const run = reopened.get(runId)
    expect(run).not.toBeNull()
    expect(run!.status).toBe('running') // 状态如实标为未收尾
    expect(run!.changes).toHaveLength(1)

    const report = reopened.rollback(runId)
    expect(report.restored).toEqual(['a.txt'])
    expect(read(ws, 'a.txt')).toBe('原样')
  })

  it('finish 之后状态为 done', () => {
    const { ws, store } = setup()
    const runId = store.begin(ws, '内核默认')
    store.finish(runId)
    expect(store.get(runId)!.status).toBe('done')
  })
})

describe('列表与保留策略', () => {
  /**
   * 建一轮并**产生一个改动** —— list() 会过滤掉"没改任何文件"的轮次
   * （真机实测后补：每轮对话都建检查点，纯闲聊那轮没改动，不过滤会刷屏）。
   */
  function runWithChange(
    store: ReturnType<typeof createCheckpointStore>,
    ws: string,
    agent: string,
    rel = 'a.txt'
  ): string {
    const id = store.begin(ws, agent)
    store.record(id, ws, rel, join(ws, rel))
    store.finish(id)
    return id
  }

  it('列表按时间倒序（新的在前）', () => {
    const { ws, store } = setup()
    runWithChange(store, ws, 'a')
    const second = runWithChange(store, ws, 'b')

    const list = store.list()
    expect(list).toHaveLength(2)
    expect(list[0]!.runId).toBe(second) // 后开的在前
  })

  it('**没改文件的轮次不进列表**（否则纯闲聊会把面板刷屏）', () => {
    const { ws, store } = setup()
    // 三轮：两轮纯聊天（无改动）+ 一轮真写了文件
    store.finish(store.begin(ws, '内核默认'))
    const real = runWithChange(store, ws, '内核默认', 'notes.md')
    store.finish(store.begin(ws, '内核默认'))

    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.runId).toBe(real)
    expect(list.every((m) => m.fileCount > 0)).toBe(true)
    // 空轮次在磁盘上仍在（get 拿得到），只是不展示
    expect(store.list()).toHaveLength(1)
  })

  it('**同一毫秒内开多轮也要有确定顺序**（CI 在 Linux 上抓出的不稳定）', () => {
    const { ws, store } = setup()
    // at 只有毫秒精度，连续 begin 极易落在同一毫秒 → 单靠 at 排序会退化成任意顺序。
    // 这条测试不等时间流逝，直接连开 5 轮 —— 用 seq 保证顺序确定。
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(runWithChange(store, ws, `agent-${i}`, `f${i}.txt`))

    const list = store.list()
    expect(list).toHaveLength(5)
    // 最新的在最前，且顺序完全等于创建顺序的倒序（确定，不依赖运气）
    expect(list.map((m) => m.runId)).toEqual([...ids].reverse())
  })

  it('列表顺序与目录读取顺序无关（全序，非"碰巧"）', () => {
    const { ws, store } = setup()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(runWithChange(store, ws, `a${i}`, `f${i}.txt`))
    // 反复读多次，结果必须完全一致（若排序不满足全序，会出现随机抖动）
    const runs = [0, 1, 2].map(() => store.list().map((m) => m.runId).join(','))
    expect(new Set(runs).size).toBe(1)
    expect(runs[0]).toBe([...ids].reverse().join(','))
  })

  it('列表带计数（界面直接显示"3 个文件（1 新建 / 2 修改）"）', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', 'x')
    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    store.record(runId, ws, 'b.txt', join(ws, 'b.txt'))
    store.record(runId, ws, 'c.txt', join(ws, 'c.txt'))
    store.finish(runId)

    const meta = store.list()[0]!
    expect(meta.fileCount).toBe(3)
    expect(meta.createdCount).toBe(2) // b、c 不存在
    expect(meta.modifiedCount).toBe(1)
  })

  it('回滚后在列表里留下已回滚标记', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', 'x')
    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    write(ws, 'a.txt', 'y')
    store.finish(runId)

    store.rollback(runId)
    expect(store.list()[0]!.rolledBackAt).toBeGreaterThan(0)
  })

  it('没有改动的轮次不报错（空 changes 列表）', () => {
    const { ws, store } = setup()
    const runId = store.begin(ws, '内核默认')
    expect(store.get(runId)!.changes).toEqual([])
    store.finish(runId)
    const report = store.rollback(runId)
    expect(report.restored).toEqual([])
    expect(report.deleted).toEqual([])
    expect(report.failed).toEqual([])
  })

  it('prune 清掉无 manifest 的残留目录', () => {
    const { ws, store } = setup()
    const orphan = join(store.dir, 'orphan-run')
    mkdirSync(join(orphan, 'files'), { recursive: true })

    const removed = store.prune()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(orphan)).toBe(false)
  })

  it('prune 不动有 manifest 的轮次（在保留数以内）', () => {
    const { ws, store } = setup()
    const runId = store.begin(ws, '内核默认')
    store.finish(runId)
    store.prune()
    expect(store.get(runId)).not.toBeNull()
  })
})

describe('健壮性：坏数据不致命', () => {
  it('record 到不存在的 runId 静默跳过（不抛错）', () => {
    const { ws, store } = setup()
    expect(() => store.record('not-a-run', ws, 'a.txt', join(ws, 'a.txt'))).not.toThrow()
  })

  it('回滚不存在的轮次 → 报失败而不抛错', () => {
    const { store } = setup()
    const report = store.rollback('nope')
    expect(report.failed.length).toBeGreaterThan(0)
    expect(report.restored).toEqual([])
  })

  it('manifest 损坏时列表跳过它，其余照常', () => {
    const { ws, store } = setup()
    const good = store.begin(ws, 'a')
    store.record(good, ws, 'a.txt', join(ws, 'a.txt')) // 有改动才会进列表
    store.finish(good)
    // 手工塞一个坏 manifest
    const bad = join(store.dir, 'bad-run')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'manifest.json'), '{ 这不是 JSON', 'utf8')

    const list = store.list()
    expect(list.map((m) => m.runId)).toContain(good)
    expect(list.map((m) => m.runId)).not.toContain('bad-run')
  })

  it('备份文件缺失时该条报失败，但不影响其它条目', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', 'A-原')
    write(ws, 'b.txt', 'B-原')

    const runId = store.begin(ws, '内核默认')
    for (const rel of ['a.txt', 'b.txt']) {
      store.record(runId, ws, rel, join(ws, rel))
      write(ws, rel, 'MUTATED')
    }
    store.finish(runId)

    // 手删第一个备份，模拟备份损坏
    rmSync(join(store.dir, runId, 'files', '0.bin'))

    const report = store.rollback(runId)
    expect(report.failed.map((f) => f.rel)).toEqual(['a.txt'])
    expect(report.restored).toEqual(['b.txt']) // 另一个照常还原
    expect(read(ws, 'b.txt')).toBe('B-原')
  })
})

describe('回滚后再次回滚（幂等性）', () => {
  it('连点两次回滚不会把文件弄丢', () => {
    const { ws, store } = setup()
    write(ws, 'a.txt', '原样')

    const runId = store.begin(ws, '内核默认')
    store.record(runId, ws, 'a.txt', join(ws, 'a.txt'))
    write(ws, 'a.txt', '改过')
    store.finish(runId)

    store.rollback(runId)
    store.rollback(runId) // 再点一次
    expect(read(ws, 'a.txt')).toBe('原样') // 仍是原样，没被删也没被清空
  })
})
