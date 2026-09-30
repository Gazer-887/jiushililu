import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGoalRepo, type GoalBackend, type GoalLog } from '@main/store/goal-core'
import type { Goal } from '@shared/goal'

/**
 * 目标落盘层的行为基线（plan12 §三 步 1 的出口判据「写→读回一致」，2026-10-01 补）。
 *
 * ⚠️ 这组断言**原来写不出来**：五个入口原先直接挂在模块级 `new Store()`（electron-store）上，
 * 而 `tests/unit/architecture.test.ts` 禁止单测 import 图出现 electron / electron-store。
 * 分层之后语义住在 `goal-core.ts`，接缝是 `GoalBackend` —— 于是这里能拿真文件测它。
 *
 * **测的是哪一层，要写明白**（否则会被当成"产品测过了"引用）：
 * · 这里的 fs backend 走的是**真实 JSON 字节往返**（同一份 `{goals:[…]}` 形状、同一个 userData 文件位），
 *   它能抓住"字段过不了序列化边界"这一整类病；
 * · 它**抓不到** electron-store 自己的那层（键名拼错、`name:'goals'` 起错文件、原子写行为）——
 *   那一条只在真入口里测得到，见 `tests/e2e/goal-store.spec.ts`（真 main 进程 + JSL_DATA_DIR 沙箱）。
 *   两条不是重复，是同一件事的两个深度：**桩能造的形状 ≠ 真入口才造得出的形状**。
 * ⚠️ 上面的豁免只到"键名/文件名/原子写"，**不含错误处理**：`fsBackend` 的读失败分支照 conf 的真实分支写
 *   （ENOENT → undefined；SyntaxError → 抛）。写成"什么异常都兜住"，就会把桩的宽容当成产品的行为 —— 本文件第一版正是这样错的。
 */

function collectingLog(): {
  log: GoalLog
  warns: Array<{ msg: string; meta: Record<string, unknown> }>
  infos: Array<{ msg: string; meta: Record<string, unknown> }>
} {
  const warns: Array<{ msg: string; meta: Record<string, unknown> }> = []
  const infos: Array<{ msg: string; meta: Record<string, unknown> }> = []
  return {
    warns,
    infos,
    log: {
      warn: (msg, meta) => warns.push({ msg, meta }),
      info: (msg, meta) => infos.push({ msg, meta })
    }
  }
}

/** 真文件 backend：落盘形状与 electron-store 写出来的那份一致（`{ goals: [...] }`） */
function fsBackend(file: string): GoalBackend {
  return {
    readRaw(): unknown {
      // ⚠️ 读失败分支必须与真源同一把尺（`node_modules/conf` 的 `get store()`）：
      // · ENOENT（从没建过目标）⇒ conf 返回空对象 ⇒ `.goals` 是 undefined ⇒ 交给 normalizeGoals
      // · 坏 JSON（SyntaxError）⇒ conf 在 `clearInvalidConfig: false`（默认值，electron-store 未覆盖）下**直接抛**
      // 第一版写成"任何异常都当 undefined"，于是下面那条"坏文件不崩"测的是**桩的宽容**而不是产品行为
      //（独立复核抓出 ⇒ 判据见 `NOTEBOOK/learnings.md` 同日「桩的宽容分支」条）。
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { goals?: unknown }).goals
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    },
    writeRaw(goals: Goal[]): void {
      writeFileSync(file, JSON.stringify({ goals }), 'utf8')
    }
  }
}

/** 内存 backend：只测语义时用，省掉 IO 噪声 */
function memBackend(initial: unknown = undefined): GoalBackend & { raw: unknown; writes: number } {
  const box = { raw: initial, writes: 0 }
  return {
    get raw() {
      return box.raw
    },
    get writes() {
      return box.writes
    },
    readRaw: () => box.raw,
    writeRaw: (goals) => {
      box.raw = goals
      box.writes += 1
    }
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsl-goal-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('goal 落盘往返（写→读回一致）', () => {
  it('建一条 → 磁盘上有它 → 换一个 repo 实例读回来，逐字段相等', () => {
    const file = join(dir, 'goals.json')
    const { log } = collectingLog()
    const a = createGoalRepo(fsBackend(file), log)
    const created = a.createGoalFor({
      conversationId: 'c1',
      text: '把附件通路做完',
      createdBy: 'user',
      doneWhen: '片⑤ 装机点验通过'
    })

    // 磁盘上确实是那份字节（不是只在内存里活着）
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { goals: Goal[] }
    expect(onDisk.goals.map((g) => g.id)).toEqual([created.id])

    // 新实例 = 重启进程后第一次读
    const b = createGoalRepo(fsBackend(file), collectingLog().log)
    expect(b.listGoals('c1')).toEqual([created])
  })

  it('★ 没给 `doneWhen` 时，落盘里不该有这一个键（undefined 过不了 JSON 边界，读回也不许冒出 null）', () => {
    const file = join(dir, 'goals.json')
    const repo = createGoalRepo(fsBackend(file), collectingLog().log)
    const g = repo.createGoalFor({ conversationId: 'c1', text: '只要一句话', createdBy: 'user' })
    expect(g.doneWhen).toBeUndefined()

    const rawText = readFileSync(file, 'utf8')
    expect(rawText).not.toContain('doneWhen')

    const back = createGoalRepo(fsBackend(file), collectingLog().log).listGoals('c1')[0]!
    expect('doneWhen' in back).toBe(false)
  })

  it('时间戳是数字毫秒：过一遍真文件不许变成字符串（排序会静默失效）', () => {
    // 播种两份**显式 createdAt** 的目标，而不是连建两条再断言顺序 ——
    // 第一版写成"建两条 ⇒ 新的在前"，在 CI（Linux）上红：两条落在同一毫秒时
    // `sortGoals` 的 `b.createdAt - a.createdAt` 为 0，稳定排序保留插入序 ⇒ 判据依赖墙钟边界，是错的判据。
    const file = join(dir, 'goals.json')
    const seed = (n: number, at: number): Goal => ({
      id: `g-seed-${n}`,
      conversationId: 'c1',
      text: `第 ${n} 条`,
      status: 'active',
      createdBy: 'user',
      createdAt: at,
      updatedAt: at
    })
    const seeded = [seed(1, 1000), seed(2, 2000)]
    // 按**创建序（升序）**落盘：正确的排序必须把它翻成降序 —— 若磁盘已是降序，这条断言就成空转了
    writeFileSync(file, JSON.stringify({ goals: seeded }), 'utf8')

    const back = createGoalRepo(fsBackend(file), collectingLog().log).listGoals('c1')
    expect(back.every((g) => typeof g.createdAt === 'number' && typeof g.updatedAt === 'number')).toBe(true)
    // 新的在前（createdAt 2000 排第一）—— 这里比的是显式时间戳，不比"过了几毫秒"
    expect(back.map((g) => g.createdAt)).toEqual([2000, 1000])
  })
})

describe('坏数据：丢掉并计数 + 留痕 + 回写，绝不整表崩', () => {
  it('一条好 + 两条坏 ⇒ 只回好的、warn 记 dropped=2、文件被洗成只剩好的', () => {
    const file = join(dir, 'goals.json')
    writeFileSync(
      file,
      JSON.stringify({
        goals: [
          { id: 'g1', conversationId: 'c1', text: '好的那条', createdBy: 'user', status: 'active', createdAt: 1, updatedAt: 1 },
          { id: 'g2', conversationId: 'c1' }, // 缺 text / createdBy —— 形状不合格
          '这不是一个目标对象'
        ]
      }),
      'utf8'
    )
    const { log, warns, infos } = collectingLog()
    const repo = createGoalRepo(fsBackend(file), log)

    const got = repo.listGoals('c1')
    expect(got.map((g) => g.id)).toEqual(['g1'])
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('读不懂的条目')
    expect(warns[0]!.meta).toEqual({ dropped: 2, kept: 1 })
    // info 通道不该被这条占用（warn 与 info 混了就没法按档筛日志）
    expect(infos).toHaveLength(0)

    // 回写：再读一次不该重复告警（原行为 —— 否则每次进会话都刷一条）
    const again = createGoalRepo(fsBackend(file), collectingLog().log)
    expect(again.listGoals('c1').map((g) => g.id)).toEqual(['g1'])
    expect((JSON.parse(readFileSync(file, 'utf8')) as { goals: Goal[] }).goals.map((g) => g.id)).toEqual(['g1'])
  })

  it('★ 坏 JSON：真源**没有自愈** —— 读就抛，normalizeGoals 根本没机会介入（欠账另立 ⏳）', () => {
    // 与真源对齐后的形状。产品真路径是"读失败 → IPC reject → 渲染端 catch 兜成空面板、无 WARN、永不修盘"，
    // **不是**"坏条目丢弃 + 计数 + 回写"。那条只治"数组里混进坏元素"（下一条断言就是那个形状）。
    const file = join(dir, 'goals.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const { log, warns } = collectingLog()
    const repo = createGoalRepo(fsBackend(file), log)
    expect(() => repo.listGoals('c1')).toThrow()
    expect(warns).toHaveLength(0)
  })

  it('数组里混进坏元素才是 normalizeGoals 的主场：丢得掉、数得清、洗得回', () => {
    const file = join(dir, 'goals.json')
    writeFileSync(
      file,
      JSON.stringify({
        goals: [
          { id: 'ok', conversationId: 'c1', text: '好的那条', createdBy: 'user', status: 'active', createdAt: 1, updatedAt: 1 },
          { id: 'bad', conversationId: 'c1' }
        ]
      }),
      'utf8'
    )
    const { log, warns } = collectingLog()
    const repo = createGoalRepo(fsBackend(file), log)
    expect(repo.listGoals('c1').map((g) => g.id)).toEqual(['ok'])
    expect(warns).toHaveLength(1)
    expect(warns[0]!.meta).toEqual({ dropped: 1, kept: 1 })
  })

  it('★ 文件还不存在（第一次运行）⇒ **现状会报一条 dropped=1 的 WARN 并空写一次盘**，本批按"语义零变化"原样钉住', () => {
    // 这条断言写的不是"应该这样"，而是"现在就是这样"：`normalizeGoals(undefined)` 把"整份读不懂"计一次 dropped
    //（同文件 09 行的既有单测已钉住 `normalizeGoals(null)` → `dropped: 1`），于是首次启动必出一次
    // 「目标文件里有读不懂的条目」+ 一次空数组落盘 —— 与 K20「新装档案首启即报 dropped:1」同族。
    // 修法（区分"没文件"与"文件坏"）属**行为变更**，不在本次重构里顺手做 ⇒ 已按锚点登记进待办总览。
    const { log, warns } = collectingLog()
    const backend = fsBackend(join(dir, 'never-written.json'))
    const repo = createGoalRepo(backend, log)
    expect(repo.listGoals('c1')).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]!.meta).toEqual({ dropped: 1, kept: 0 })
  })

  it('内存 backend 的初始 undefined 同样走那条路径（证明这与 IO 无关，是 normalizeGoals 的口径）', () => {
    const { log, warns } = collectingLog()
    const repo = createGoalRepo(memBackend(), log)
    expect(repo.listGoals('c1')).toEqual([])
    expect(warns).toHaveLength(1)
  })
})

describe('会话归属：删会话连带清目标，不误伤别条', () => {
  it('removeGoalsOf(A) 只清 A，B 一条不少，且 info 里报了删了几条', () => {
    const backend = memBackend()
    const { log, infos } = collectingLog()
    const repo = createGoalRepo(backend, log)
    repo.createGoalFor({ conversationId: 'A', text: 'A1', createdBy: 'user' })
    repo.createGoalFor({ conversationId: 'A', text: 'A2', createdBy: 'user' })
    repo.createGoalFor({ conversationId: 'B', text: 'B1', createdBy: '内核默认' })

    repo.removeGoalsOf('A')
    expect(repo.listGoals('A')).toEqual([])
    expect(repo.listGoals('B').map((g) => g.text)).toEqual(['B1'])
    expect(infos.at(-1)).toEqual({
      msg: '会话已删，连带清掉它的目标',
      meta: { conversationId: 'A', removed: 2 }
    })
  })

  it('★ 没有匹配时**不写盘**（原行为：`next.length !== all.length` 才落 —— 免得每次删会话都刷一次文件与日志）', () => {
    const backend = memBackend()
    const { log, infos } = collectingLog()
    const repo = createGoalRepo(backend, log)
    repo.createGoalFor({ conversationId: 'A', text: 'A1', createdBy: 'user' })
    const writesBefore = backend.writes
    repo.removeGoalsOf('不存在的那条会话')
    expect(backend.writes).toBe(writesBefore)
    expect(infos.filter((i) => i.msg.includes('会话已删'))).toHaveLength(0)
  })

  it('listGoals 在存储层就按会话分开了（渲染端不串的前提，界面那半见 goal-agent-apply）', () => {
    const backend = memBackend()
    const repo = createGoalRepo(backend, collectingLog().log)
    repo.createGoalFor({ conversationId: 'A', text: '属于 A', createdBy: 'user' })
    repo.createGoalFor({ conversationId: 'B', text: '属于 B', createdBy: 'user' })
    expect(repo.listGoals('A').map((g) => g.text)).toEqual(['属于 A'])
    expect(JSON.stringify(repo.listGoals('A'))).not.toContain('属于 B')
  })
})

describe('非法转移：带人话理由被拒，且盘上一动不动', () => {
  it('已完成的目标再点「完成」⇒ 抛理由，落盘内容不变', () => {
    const backend = memBackend()
    const repo = createGoalRepo(backend, collectingLog().log)
    const g = repo.createGoalFor({ conversationId: 'A', text: '一件事', createdBy: 'user' })
    expect(repo.actOnGoal(g.id, 'complete').status).toBe('done')

    const writesBefore = backend.writes
    expect(() => repo.actOnGoal(g.id, 'complete')).toThrow()
    expect(backend.writes).toBe(writesBefore)
    expect(repo.listGoals('A')[0]!.status).toBe('done')
  })

  it('拒绝理由是**人话**（说清怎么往下走），不是 "invalid state transition"', () => {
    const repo = createGoalRepo(memBackend(), collectingLog().log)
    const g = repo.createGoalFor({ conversationId: 'A', text: '一件事', createdBy: 'user' })
    repo.actOnGoal(g.id, 'complete')
    let reason = ''
    try {
      repo.actOnGoal(g.id, 'complete')
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    expect(reason).toContain('重开')
  })

  it('目标不存在 ⇒ 说清"可能已被删除"（界面上这就是点了没反应的真相）', () => {
    const repo = createGoalRepo(memBackend(), collectingLog().log)
    expect(() => repo.actOnGoal('g-不存在', 'pause')).toThrow('该目标不存在（可能已被删除）')
  })

  it('空文本 ⇒ 带理由拒绝且**不落盘**（一半写进去的目标比报错更糟）', () => {
    const backend = memBackend()
    const repo = createGoalRepo(backend, collectingLog().log)
    expect(() => repo.createGoalFor({ conversationId: 'A', text: '', createdBy: 'user' })).toThrow(
      '目标内容不能为空'
    )
    expect(backend.writes).toBe(0)
    expect(repo.listGoals('A')).toEqual([])
  })

  // ⚠️ 概率性断言：id 随机段是 4 位 base36，单次碰撞约万分之三 ⇒ 万一红要按**抖动**定性（不许复跑洗绿），与 CI `retries: 0` 同口径
  it('同一毫秒连建 30 条 ⇒ id 互不相同（随机段负责，撞了就是互相覆盖）', () => {
    const repo = createGoalRepo(memBackend(), collectingLog().log)
    const ids = new Set<string>()
    for (let i = 0; i < 30; i += 1) {
      ids.add(repo.createGoalFor({ conversationId: 'A', text: `第 ${i} 条`, createdBy: 'user' }).id)
    }
    expect(ids.size).toBe(30)
  })
})
