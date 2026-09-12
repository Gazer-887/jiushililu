import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  backupName,
  compareRunsNewestFirst,
  isSafeRel,
  normalizeRel,
  planRollback,
  selectChanges,
  toMeta,
  upsertChange,
  type CheckpointRun,
  type CheckpointRunMeta,
  type FileChange,
  type RollbackReport
} from '@shared/checkpoint'

// 检查点与回滚 —— 落盘层（plan8 R4）
//
// 存在哪：`userData/checkpoints/<runId>/`
//   manifest.json   这一轮改了哪些文件（**增量落盘**，见下）
//   files/N.bin     编号备份（不用相对路径建目录，绕开 Windows 路径坑）
//
// 两条关键设计：
//   ① **快照发生在写文件之前** → 崩溃时最坏情况是"多备份了一份没改的文件"，无害
//   ② **manifest 增量落盘** → 中断（崩溃/中止）的轮次也能回滚；
//      若等收尾才写 manifest，中断轮次的快照就等于白存了
//
// 为什么不维护一份 index.json 总表：总表会与目录实际内容漂移（多一类 bug）。
// 直接扫目录读 manifest 更笨但更可靠，量级也完全撑得住（保留轮数有上限）。
//
// 本模块**不 import electron**（与 runner 同样的约束）：可被单测直接 import。

/** 保留的轮次上限（超出即从最旧的开始清理） */
const MAX_RUNS = 50

/**
 * 读快照正文的上限（plan13 B3）。
 *
 * 为什么要有：Diff 视图要把快照内容读进内存再算差异。快照是本轮的**真实文件拷贝**，
 * 一个几百 MB 的文件就能把主进程读爆。超过上限就**只读前 256 KB 并标记截断** ——
 * 界面据此说明"不完整"，且**禁止逐块退回**（拿半个文件去写盘就是数据丢失）。
 * 这个值与 `workspace-fs` 的 `MAX_PREVIEW_BYTES` 保持一致，两侧同时截断才谈得上"可比"。
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024

/** 读快照的结果：失败一律给出**可读的原因**，让界面说得清"为什么看不了" */
export type ReadBackupResult =
  | { ok: true; content: string; truncated: boolean; bytes: number }
  | { ok: false; reason: 'run-missing' | 'not-recorded' | 'created' | 'backup-missing' }

export interface CheckpointStore {
  readonly dir: string
  /** 开始一轮（写入 running manifest）→ runId */
  begin(workspace: string, agent: string, conversationId: string): string
  /** 写文件**之前**调用：把原始内容快照下来（同一文件本轮只记第一次） */
  record(runId: string, workspaceRoot: string, rel: string, abs: string): void
  /** 正常收尾：标记 done */
  finish(runId: string): void
  /** 列出所有轮次（新→旧） */
  list(): CheckpointRunMeta[]
  /** 读某一轮明细 */
  get(runId: string): CheckpointRun | null
  /**
   * 读某个文件的**改前快照正文**（plan13 B3：Diff 视图要拿它跟当前内容比）。
   * 只读不写 —— 打开 Diff 视图本身**不产生**任何副作用。
   */
  readBackup(runId: string, rel: string): ReadBackupResult
  /** 回滚：不传 rel = 整轮回滚 */
  rollback(runId: string, rel?: string): RollbackReport
  /** 清理超限的旧轮次 + 残留空目录 */
  prune(): number
  /** 丢弃内存中某轮的状态（测试/异常用） */
  forget(runId: string): void
}

export function createCheckpointStore(dir: string): CheckpointStore {
  // 运行中的轮次放在内存（收尾时已在盘上），避免每次 record 都重读 manifest
  const active = new Map<string, CheckpointRun>()
  // runId → 已记录的相对路径集合，用于"只记第一次"的快速判定
  const recorded = new Map<string, Set<string>>()

  const runDir = (runId: string): string => join(dir, runId)

  /** 同进程内自增序号：同毫秒开两轮时靠它定先后（详见 compareRunsNewestFirst） */
  let seq = 0

  const ensureDir = (p: string): void => {
    mkdirSync(p, { recursive: true })
  }

  /** manifest 增量落盘：小 JSON，代价可忽略，换来中断可回滚 */
  const flush = (run: CheckpointRun): void => {
    const rd = runDir(run.runId)
    ensureDir(rd)
    writeFileSync(join(rd, 'manifest.json'), JSON.stringify(run, null, 2), 'utf8')
  }

  const makeRunId = (): string =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  const store: CheckpointStore = {
    dir,

    begin(workspace, agent, conversationId) {
      const runId = makeRunId()
      const run: CheckpointRun = {
        runId,
        at: Date.now(),
        seq: ++seq,
        workspace,
        agent,
        conversationId,
        changes: [],
        status: 'running'
      }
      active.set(runId, run)
      recorded.set(runId, new Set())
      ensureDir(runDir(runId))
      flush(run)
      return runId
    },

    record(runId, workspaceRoot, rel, abs) {
      const run = active.get(runId)
      // 没有活动轮次就静默跳过：快照属"锦上添花"，绝不能因为它让写文件失败
      if (!run) return

      const key = normalizeRel(rel)
      const seen = recorded.get(runId)
      if (seen?.has(key)) return // 本轮已记过 → 保留第一次的快照（核心规则）

      // 防御：只快照工作区内的文件
      const root = resolve(workspaceRoot)
      const target = resolve(abs)
      if (target !== root && !target.startsWith(root + sep)) return

      try {
        let change: FileChange
        if (existsSync(target) && statSync(target).isFile()) {
          const index = run.changes.length
          const name = backupName(index)
          ensureDir(join(runDir(runId), 'files'))
          copyFileSync(target, join(runDir(runId), 'files', name))
          change = {
            rel: key,
            kind: 'modified',
            beforeBytes: statSync(target).size,
            backup: name
          }
        } else {
          change = { rel: key, kind: 'created', beforeBytes: 0, backup: null }
        }
        run.changes = upsertChange(run.changes, change)
        seen?.add(key)
        flush(run)
      } catch {
        // 快照失败不能阻断写入（用户仍能改文件，只是这一条回滚不了）
      }
    },

    finish(runId) {
      const run = active.get(runId)
      if (!run) return
      run.status = 'done'
      flush(run)
      active.delete(runId)
      recorded.delete(runId)
      store.prune()
    },

    list() {
      if (!existsSync(dir)) return []
      const out: CheckpointRunMeta[] = []
      for (const name of readdirSync(dir)) {
        const manifest = join(dir, name, 'manifest.json')
        if (!existsSync(manifest)) continue // 跳过无 manifest 的残留目录
        try {
          const run = JSON.parse(readFileSync(manifest, 'utf8')) as CheckpointRun
          if (run.runId !== name) continue
          // 过滤掉「没改动任何文件」的轮次（2026-09-12 真机实测后补）：
          // 每轮对话都会建检查点，包括纯闲聊 —— 不过滤的话面板会被一堆"0 个文件"刷屏，
          // 真正改过文件的那轮反而找不到（实测 5 轮里 4 轮是噪音）。
          // 这类空轮次在磁盘上仍留着（几 KB），由 prune 按上限清理。
          if (run.changes.length === 0) continue
          out.push(toMeta(run))
        } catch {
          // 坏 manifest 跳过（不因一个坏文件让整个列表不可用）
        }
      }
      return out.sort(compareRunsNewestFirst)
    },

    get(runId) {
      // 优先取内存（正在跑，盘上的 change 是同一份，但内存里最新）
      const live = active.get(runId)
      if (live) return live
      const manifest = join(runDir(runId), 'manifest.json')
      if (!existsSync(manifest)) return null
      try {
        return JSON.parse(readFileSync(manifest, 'utf8')) as CheckpointRun
      } catch {
        return null
      }
    },

    readBackup(runId, rel) {
      const run = store.get(runId)
      if (!run) return { ok: false, reason: 'run-missing' }

      const change = selectChanges(run.changes, rel)[0]
      if (!change) return { ok: false, reason: 'not-recorded' }
      // created 没有"改前的样子"可给 —— 它当轮的改前状态就是"文件不存在"。
      // （注意这里**不**退化成"给个空串"：空串会被界面当成"文件本来是空的"，
      //   那是另一回事，而 created 的正确语义是"原来没有这个文件"。）
      if (change.kind === 'created' || change.backup === null) {
        return { ok: false, reason: 'created' }
      }

      const src = join(runDir(runId), 'files', change.backup)
      if (!existsSync(src)) return { ok: false, reason: 'backup-missing' }

      try {
        const fd = openSync(src, 'r')
        try {
          const size = fstatSync(fd).size
          const cap = Math.min(size, MAX_SNAPSHOT_BYTES)
          const buf = Buffer.alloc(cap)
          readSync(fd, buf, 0, cap, 0)
          return {
            ok: true,
            content: buf.toString('utf8'),
            truncated: size > MAX_SNAPSHOT_BYTES,
            bytes: size
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        // 读失败（权限 / 文件被占用）不当成崩溃，交给界面说"看不了"
        return { ok: false, reason: 'backup-missing' }
      }
    },

    rollback(runId, rel) {
      const report: RollbackReport = {
        runId,
        restored: [],
        deleted: [],
        failed: [],
        rejected: []
      }
      const run = store.get(runId)
      if (!run) {
        report.failed.push({ rel: '*', reason: '找不到这一轮的记录' })
        return report
      }

      const targets = selectChanges(run.changes, rel)
      const root = resolve(run.workspace)

      for (const action of planRollback(targets)) {
        // 二次防御：manifest 若被篡改含 `../`，这里必须挡住
        if (!isSafeRel(action.rel)) {
          report.rejected.push(action.rel)
          continue
        }
        const abs = resolve(root, action.rel)
        if (abs !== root && !abs.startsWith(root + sep)) {
          report.rejected.push(action.rel)
          continue
        }

        try {
          if (action.op === 'delete') {
            if (existsSync(abs)) unlinkSync(abs)
            report.deleted.push(action.rel)
          } else {
            const src = join(runDir(runId), 'files', action.backup)
            if (!existsSync(src)) {
              report.failed.push({ rel: action.rel, reason: '备份文件缺失' })
              continue
            }
            ensureDir(dirname(abs))
            copyFileSync(src, abs)
            report.restored.push(action.rel)
          }
        } catch (err) {
          report.failed.push({
            rel: action.rel,
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }

      // 标记已回滚（界面据此显示状态，避免用户重复点）
      if (rel === undefined || report.failed.length === 0) {
        run.rolledBackAt = Date.now()
        if (run.status === 'running') run.status = 'done'
        active.set(runId, run)
        flush(run)
        active.delete(runId)
      }
      return report
    },

    prune() {
      if (!existsSync(dir)) return 0
      let removed = 0

      // ① 清残留空目录（无 manifest = begin 后立刻失败，无内容可回滚）
      const entries: { name: string; meta: CheckpointRunMeta | null }[] = []
      for (const name of readdirSync(dir)) {
        const manifest = join(dir, name, 'manifest.json')
        let meta: CheckpointRunMeta | null = null
        if (existsSync(manifest)) {
          try {
            meta = toMeta(JSON.parse(readFileSync(manifest, 'utf8')) as CheckpointRun)
          } catch {
            meta = null
          }
        }
        entries.push({ name, meta })
      }

      for (const e of entries) {
        if (e.meta) continue
        try {
          rmSync(join(dir, e.name), { recursive: true, force: true })
          removed++
        } catch {
          // 忽略
        }
      }

      // ② 超出上限则从最旧删起（用统一的比较器，避免同毫秒时删错边）
      //
      // ⚠️ **正在跑的那一轮绝不删**（plan11 P0-10）：并发之后，早开的那一轮可能
      //    还在跑而"轮数超限"已经成立 —— 若照删，它的快照目录会在运行中途消失，
      //    等它跑完要回滚时才发现**静默失效**（最难查的一类）。上限的用意是
      //    "防无限增长"，不是"必须立刻删到 50"，所以宁可暂时多留一轮。
      const keep = entries
        .filter((e): e is { name: string; meta: CheckpointRunMeta } => e.meta !== null)
        .sort((a, b) => compareRunsNewestFirst(a.meta, b.meta))
      for (const e of keep.slice(MAX_RUNS)) {
        if (e.meta.status === 'running') continue
        try {
          rmSync(join(dir, e.name), { recursive: true, force: true })
          removed++
        } catch {
          // 忽略
        }
      }
      return removed
    },

    forget(runId) {
      active.delete(runId)
      recorded.delete(runId)
    }
  }

  return store
}
