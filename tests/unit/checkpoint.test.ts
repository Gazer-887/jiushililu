import { describe, expect, it } from 'vitest'
import {
  backupName,
  compareRunsNewestFirst,
  describeKind,
  isSafeRel,
  normalizeRel,
  planRollback,
  selectChanges,
  summarize,
  toMeta,
  upsertChange,
  type CheckpointRun,
  type CheckpointRunMeta,
  type FileChange
} from '@shared/checkpoint'

// 检查点纯逻辑（plan8 R4）
//
// 这一层的价值在于：回滚的对错全在"记什么、还什么"两件判断上，
// 而这两件事都能脱离文件系统验证。故这里逐条钉死，不依赖真实磁盘。

const mod = (rel: string, bytes = 10, backup = '0.bin'): FileChange => ({
  rel,
  kind: 'modified',
  beforeBytes: bytes,
  backup
})
const created = (rel: string): FileChange => ({
  rel,
  kind: 'created',
  beforeBytes: 0,
  backup: null
})

describe('normalizeRel（路径归一：同一文件必须归一到同一个键）', () => {
  it('反斜杠转正斜杠', () => {
    expect(normalizeRel('src\\main\\index.ts')).toBe('src/main/index.ts')
  })

  it('去掉开头的 ./', () => {
    expect(normalizeRel('./notes/a.md')).toBe('notes/a.md')
  })

  it('混合写法归一后一致', () => {
    expect(normalizeRel('.\\src\\a.ts')).toBe(normalizeRel('src/a.ts'))
  })
})

describe('upsertChange（核心规则：同一文件只记第一次的快照）', () => {
  it('首次记录正常加入', () => {
    const out = upsertChange([], mod('a.txt', 100, '0.bin'))
    expect(out).toHaveLength(1)
    expect(out[0]!.backup).toBe('0.bin')
  })

  it('**同一文件第二次写入不覆盖备份**（否则回滚会还原成模型的中间产物）', () => {
    let changes = upsertChange([], mod('a.txt', 100, '0.bin'))
    // 模拟第二轮写入：备份名变成 1.bin、内容已不是原始
    changes = upsertChange(changes, mod('a.txt', 55, '1.bin'))
    expect(changes).toHaveLength(1)
    expect(changes[0]!.backup).toBe('0.bin') // 仍是第一次的备份
    expect(changes[0]!.beforeBytes).toBe(100) // 仍是原始大小
  })

  it('路径写法不同但指向同一文件 → 也视为同一文件', () => {
    let changes = upsertChange([], mod('src\\a.ts', 100, '0.bin'))
    changes = upsertChange(changes, mod('./src/a.ts', 80, '1.bin'))
    expect(changes).toHaveLength(1)
    expect(changes[0]!.backup).toBe('0.bin')
  })

  it('不同文件各自记录', () => {
    let changes = upsertChange([], mod('a.txt', 1, '0.bin'))
    changes = upsertChange(changes, mod('b.txt', 2, '1.bin'))
    expect(changes.map((c) => c.rel)).toEqual(['a.txt', 'b.txt'])
  })
})

describe('planRollback（改过的写回、新建的删掉）', () => {
  it('modified → restore（带备份文件名）', () => {
    expect(planRollback([mod('a.txt', 9, '0.bin')])).toEqual([
      { rel: 'a.txt', op: 'restore', backup: '0.bin' }
    ])
  })

  it('created → delete（本轮之前不存在，删掉才叫还原）', () => {
    expect(planRollback([created('new.md')])).toEqual([{ rel: 'new.md', op: 'delete' }])
  })

  it('缺少备份名时退化为 delete（宁可删错也不写坏；且这是不可能出现的合法数据）', () => {
    const weird: FileChange = { rel: 'x', kind: 'modified', beforeBytes: 1, backup: null }
    expect(planRollback([weird])).toEqual([{ rel: 'x', op: 'delete' }])
  })

  it('混合场景保持顺序', () => {
    const plan = planRollback([mod('a.txt', 1, '0.bin'), created('b.md')])
    expect(plan.map((p) => p.op)).toEqual(['restore', 'delete'])
  })
})

describe('selectChanges（单文件回滚）', () => {
  const changes = [mod('a.txt', 1, '0.bin'), mod('src\\b.ts', 2, '1.bin')]

  it('不传 rel → 全选', () => {
    expect(selectChanges(changes)).toHaveLength(2)
  })

  it('传 rel → 只选一个，且写法差异不影响匹配', () => {
    expect(selectChanges(changes, 'src/b.ts')).toHaveLength(1)
    expect(selectChanges(changes, './src/b.ts')[0]!.backup).toBe('1.bin')
  })

  it('传不存在的 rel → 空（调用方据此报"没找到"）', () => {
    expect(selectChanges(changes, 'nope.txt')).toEqual([])
  })
})

describe('isSafeRel（回滚前的路径防线）', () => {
  it('正常相对路径放行', () => {
    expect(isSafeRel('a.txt')).toBe(true)
    expect(isSafeRel('src/main/index.ts')).toBe(true)
  })

  it('拒绝 `..` 逃逸', () => {
    expect(isSafeRel('../secret.txt')).toBe(false)
    expect(isSafeRel('src/../../secret.txt')).toBe(false)
  })

  it('拒绝绝对路径（含 Windows 盘符）', () => {
    expect(isSafeRel('/etc/passwd')).toBe(false)
    expect(isSafeRel('C:/Windows/system32/x.dll')).toBe(false)
    expect(isSafeRel('\\\\server\\share\\x')).toBe(false)
  })

  it('拒绝空串', () => {
    expect(isSafeRel('')).toBe(false)
  })
})

describe('汇总与元信息', () => {
  it('summarize 正确区分新建/修改', () => {
    expect(summarize([mod('a', 1, '0.bin'), created('b'), mod('c', 1, '1.bin')])).toEqual({
      fileCount: 3,
      createdCount: 1,
      modifiedCount: 2
    })
  })

  it('toMeta 带上状态与计数，且不含 changes 明细', () => {
    const run: CheckpointRun = {
      runId: 'r1',
      at: 1000,
      workspace: 'D:/ws',
      agent: '内核默认',
      changes: [mod('a', 1, '0.bin'), created('b')],
      status: 'done'
    }
    const meta = toMeta(run)
    expect(meta).toEqual({
      runId: 'r1',
      at: 1000,
      workspace: 'D:/ws',
      agent: '内核默认',
      status: 'done',
      fileCount: 2,
      createdCount: 1,
      modifiedCount: 1
    })
    expect('changes' in meta).toBe(false)
  })

  it('已回滚的轮次带上 rolledBackAt', () => {
    const run: CheckpointRun = {
      runId: 'r2',
      at: 1,
      workspace: 'w',
      agent: 'a',
      changes: [],
      status: 'done',
      rolledBackAt: 2000
    }
    expect(toMeta(run).rolledBackAt).toBe(2000)
  })

  it('describeKind 给人看的字', () => {
    expect(describeKind('created')).toBe('新建')
    expect(describeKind('modified')).toBe('修改')
  })

  it('备份文件名用序号（不拿路径当文件名，绕开 Windows 非法字符/保留名/长路径）', () => {
    expect(backupName(0)).toBe('0.bin')
    expect(backupName(12)).toBe('12.bin')
  })
})

describe('compareRunsNewestFirst（新的在前，且必须是全序）', () => {
  const mk = (over: Partial<CheckpointRunMeta>): CheckpointRunMeta => ({
    runId: 'r',
    at: 100,
    workspace: 'w',
    agent: 'a',
    status: 'done',
    fileCount: 0,
    createdCount: 0,
    modifiedCount: 0,
    ...over
  })

  it('时间不同 → 按时间倒序', () => {
    const older = mk({ runId: 'old', at: 100 })
    const newer = mk({ runId: 'new', at: 200 })
    expect([older, newer].sort(compareRunsNewestFirst)[0]!.runId).toBe('new')

    // 输入顺序反过来，结果必须一致（全序）——若依赖 at 之差不为 0 就无所谓，这里确保稳定
    expect([newer, older].sort(compareRunsNewestFirst)[0]!.runId).toBe('new')
  })

  it('**时间相同 → 按 seq 定先后**（CI 抓出的同毫秒不稳定）', () => {
    const a = mk({ runId: 'a', at: 500, seq: 1 })
    const b = mk({ runId: 'b', at: 500, seq: 2 })
    expect([a, b].sort(compareRunsNewestFirst)[0]!.runId).toBe('b') // seq 大的更新
    expect([b, a].sort(compareRunsNewestFirst)[0]!.runId).toBe('b')
  })

  it('时间与 seq 都相同 → 退回 runId 比较（保证全序，结果与输入顺序无关）', () => {
    const a = mk({ runId: 'aaa', at: 500, seq: 1 })
    const b = mk({ runId: 'bbb', at: 500, seq: 1 })
    const r1 = [a, b].sort(compareRunsNewestFirst).map((m) => m.runId)
    const r2 = [b, a].sort(compareRunsNewestFirst).map((m) => m.runId)
    expect(r1).toEqual(r2) // 两种输入顺序得到同一结果
  })

  it('缺 seq 的历史数据不炸（按 0 处理）', () => {
    const legacy = mk({ runId: 'legacy', at: 500 })
    const fresh = mk({ runId: 'fresh', at: 500, seq: 3 })
    expect([legacy, fresh].sort(compareRunsNewestFirst)[0]!.runId).toBe('fresh')
  })

  it('toMeta 会带上 seq（供排序用）', () => {
    const run: CheckpointRun = {
      runId: 'r',
      at: 1,
      seq: 7,
      workspace: 'w',
      agent: 'a',
      changes: [],
      status: 'done'
    }
    expect(toMeta(run).seq).toBe(7)
  })
})
