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

// 检查点与回滚 —— 落盘层（plan8 R4）。存在哪：`userData/checkpoints/<runId>/`，内含 manifest.json（这一轮改了哪些
// 文件，**增量落盘**）与 files/N.bin（编号备份 —— 不用相对路径建目录，绕开 Windows 路径坑）。本模块**不 import
// electron**（同 runner 的约束）：可被单测直接 import。
//
// 两条关键设计：① **快照发生在写文件之前** → 崩溃时最坏只是"多备份了一份没改的文件"，无害；② **manifest 增量落盘**
// → 中断（崩溃 / 中止）的轮次也能回滚；若等收尾才写，中断轮次的快照就白存了。不维护 index.json 总表：总表会与目录
// 实际内容漂移（多一类 bug），直接扫目录更笨但更可靠（保留轮数有上限）。

/** 保留的轮次上限（超出即从最旧的开始清理） */
const MAX_RUNS = 50

/**
 * 读快照正文的上限（plan13 B3）。Diff 视图要把快照读进内存算差异，而快照是本轮的**真实文件拷贝**，
 * 一个几百 MB 的文件就能把主进程读爆；超过就只读前一段并标记截断（界面据此说明"不完整"，**禁止逐块退回**
 * —— 拿半个文件去写盘就是数据丢失）。此值与 `workspace-fs` 的 `MAX_PREVIEW_BYTES` 一致，两侧同时截断才谈得上可比。
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024

/** 读快照的结果：失败一律给出**可读的原因**，让界面说得清"为什么看不了" */
export type ReadBackupResult =
  | {
      ok: true
      content: string
      truncated: boolean
      bytes: number
      /**
       * **这份内容不是无损读出来的**（原文不是合法 UTF-8：GBK / 二进制…）。为什么它能救命（独立审查实测）：
       * 退回会把**整份文本**按 UTF-8 重写回磁盘，而有损解码出来的字符再编码回去**不等于原字节** —— 实测一个
       * GBK 文件只改了一行，退一次连**没被改的那几行也一起烂掉**（13 → 32 字节，全变 `efbfbd`）：**不可逆**损坏。
       */
      lossy: boolean
    }
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
  /** 读某文件的**改前快照正文**（plan13 B3：Diff 视图拿它跟当前内容比）。只读不写 —— 打开 Diff 视图无副作用 */
  readBackup(runId: string, rel: string): ReadBackupResult
  /**
   * 回滚**之前**，先把"即将被覆盖的当前内容"另存为一轮检查点。非有不可：回滚是"把现在的内容换成别的"，
   * 它自己不留快照的话，用户退错了就**永远回不去**（Agent 那一版只存在于磁盘上，一覆盖就没了）——
   * 留了这一份，回滚才是"可逆的动作"，与"写文件前先快照"是同一条规矩。
   * @returns 新轮次的 runId；没有可备份的东西则 `null`（那时不会产生空轮次）
   */
  snapshotCurrent(runId: string, rel: string | undefined, label: string, owner: string): string | null
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
          // 过滤掉「没改动任何文件」的轮次（2026-09-12 真机实测后补）：每轮对话都会建检查点，包括纯闲聊 ——
          // 不过滤的话面板被一堆"0 个文件"刷屏，真正改过文件的那轮反而找不到（实测 5 轮里 4 轮是噪音）；
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
      // created 没有"改前的样子"可给（它当轮的改前状态就是"文件不存在"）。这里**不**退化成给个空串 ——
      // 空串会被界面当成"文件本来是空的"，而 created 的正确语义是"原来没有这个文件"。
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
          const buf = Buffer.alloc(cap) // Buffer.alloc 是**零填充**
          // ⚠️ `readSync` 的返回值**必须接**（审查指出）：短读（网络盘 / 被杀软锁住）时没读满的区域留着 NUL，
          //    不接返回值就发现不了它，而 `applyPatch` 照样能成功、然后整体回写 → **把 NUL 写进用户的文件**。
          const n = readSync(fd, buf, 0, cap, 0)
          const read = buf.subarray(0, Math.max(0, Math.min(n, cap)))
          const truncated = size > MAX_SNAPSHOT_BYTES || n < cap
          const text = read.toString('utf8')
          return {
            ok: true,
            content: text,
            truncated,
            bytes: size,
            // 有损解码判据（见 ReadBackupResult.lossy）：截断时前缀可能切在多字节字符中间，
            // 那时的"不可逆"是切出来的假象 → 只在**完整读到**时才可信。
            lossy: !truncated && !Buffer.from(text, 'utf8').equals(read)
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        // 读失败（权限 / 文件被占用）不当成崩溃，交给界面说"看不了"
        return { ok: false, reason: 'backup-missing' }
      }
    },

    snapshotCurrent(runId, rel, label, owner) {
      const run = store.get(runId)
      if (!run) return null
      const targets = selectChanges(run.changes, rel)
      if (targets.length === 0) return null

      // 用**那一轮自己记下的工作区**，而不是"当前工作区" —— 用户可能已切过工作区，拿现在这个去拼路径就会指向别处（甚至越界）
      const root = resolve(run.workspace)
      const preRunId = store.begin(run.workspace, label, owner)
      try {
        for (const c of targets) {
          // 两道防御（与 rollback 同源）：manifest 可能来自旧版本或被人工改过
          if (!isSafeRel(c.rel)) continue
          const abs = resolve(root, c.rel)
          if (abs !== root && !abs.startsWith(root + sep)) continue
          store.record(preRunId, run.workspace, c.rel, abs)
        }
      } finally {
        // 失败也 finish：manifest 是增量落盘的，已经记下的那几条仍然可用
        store.finish(preRunId)
      }

      // ⚠️ **一条都没备份成时必须返回 null**（审查指出）：`record` 把自己的异常全吞掉（快照失败不该阻断写入，
      // 那条设计是对的），但若每条都失败还照交 preRunId，界面就会显示"已备份"、文案还在承诺"退错了还能再退" ——
      // **兜底静默消失而界面仍在承诺它**。宁可如实说"这次没留兜底"，也不能让用户以为有。
      const backed = store.get(preRunId)
      if (!backed || backed.changes.length === 0) {
        store.forget(preRunId)
        return null
      }
      return preRunId
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
      /**
       * 动手之前先记下：**这一轮此刻还在不在内存登记里**。用来区分两种轮次（收尾时行为不同）：
       * `true` = 它**正在跑** → 回滚后必须**保持登记**，否则它后续每次写文件都不再留快照（`record` 拿不到 run 就 return）；
       * `false` = 崩溃 / 中止残留的轮次 → 回滚后从内存里摘掉即可。
       */
      const wasActive = active.has(runId)

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
      // ⚠️ **有失败就不打这个标记**（审查指出）：整轮回滚时原写法不管 `failed` 照样标记，于是面板上同时出现
      //    「已回滚」徽章和"失败 N 个"的提示 —— 两个互相矛盾的信号，用户会以为退干净了。
      //    不打标记反而正确：他还能再点一次。
      if (report.failed.length === 0) {
        run.rolledBackAt = Date.now()
        if (run.status === 'running') run.status = 'done'
        active.set(runId, run)
        flush(run)
        // ⚠️ 只有"本来就不在 active 里"（= 崩溃残留的轮次）才摘登记。仍在跑的那一轮被摘掉的话，它**后续每一次
        //    写文件都不再进检查点**（`record` 第一句就是 `active.get(runId)`，拿不到就直接 return），面板里也
        //    再不会显示 —— 这是最难查的那种静默失效。
        if (wasActive) active.set(runId, run)
        else active.delete(runId)
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
      // ⚠️ **正在跑的那一轮绝不删**（plan11 P0-10）：并发之后，早开的那一轮可能还在跑而"轮数超限"已经成立 —— 若照删，
      // 它的快照目录会在运行中途消失，等它跑完要回滚时才发现**静默失效**（最难查的一类）。上限的用意是"防无限增长"，
      // 不是"必须立刻删到 50"，所以宁可暂时多留一轮。
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
