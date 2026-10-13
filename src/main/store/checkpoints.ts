import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
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

// 检查点与回滚 —— 落盘层（plan8 R4）。存在 `userData/checkpoints/<runId>/`：manifest.json（这一轮改了哪些文件，**增量落盘**）+ files/N.bin（编号备份 —— 不用相对路径建目录，绕开 Windows 路径坑）。
// ⚠️ 本模块**不 import electron**（同 runner 的约束）：可被单测直接 import。
// ① **快照发生在写文件之前** → 崩溃时最坏只是"多备份了一份没改的文件"，无害；② **manifest 增量落盘** → 中断（崩溃 / 中止）的轮次也能回滚。
// 不维护 index.json 总表：总表会与目录实际内容漂移（多一类 bug），直接扫目录更笨但更可靠。

const MAX_RUNS = 50

/** 读快照正文的上限（plan13 B3）。快照是本轮的**真实文件拷贝**，一个几百 MB 的文件就能把主进程读爆；超过就只读前一段并标记截断。
 *  ⚠️ 截断时**禁止逐块退回** —— 拿半个文件去写盘就是数据丢失。此值与 `workspace-fs` 的 `MAX_PREVIEW_BYTES` 一致，两侧同时截断才谈得上可比。 */
const MAX_SNAPSHOT_BYTES = 256 * 1024

export type ReadBackupResult =
  | {
      ok: true
      content: string
      truncated: boolean
      bytes: number
      /** **这份内容不是无损读出来的**（原文不是合法 UTF-8：GBK / 二进制…）。为什么它能救命（独立审查实测）：退回会把**整份文本**按 UTF-8 重写回磁盘，而有损解码出来的字符再编码回去**不等于原字节** ——
       *  实测一个 GBK 文件只改了一行，退一次连**没被改的那几行也一起烂掉**：**不可逆**损坏。 */
      lossy: boolean
    }
  | { ok: false; reason: 'run-missing' | 'not-recorded' | 'created' | 'backup-missing' }

export interface CheckpointStore {
  readonly dir: string
  begin(workspace: string, agent: string, conversationId: string): string
  /** 写文件**之前**调用：把原始内容快照下来（同一文件本轮只记第一次） */
  record(runId: string, workspaceRoot: string, rel: string, abs: string): void
  finish(runId: string): void
  list(): CheckpointRunMeta[]
  get(runId: string): CheckpointRun | null
  readBackup(runId: string, rel: string): ReadBackupResult
/** 回滚**之前**先把"即将被覆盖的当前内容"**逐目标**另存为一轮检查点：不留的话用户退错了就**永远回不去**（Agent 那一版只存在于磁盘上）。
 *  @returns `preRunId` = 备份轮次（一条都没成则 null，不留空轮次）；`failed` = 未能可靠备份的目标及原因
 *          —— 调用方**必须**据此把这些目标排除出本次回滚（不覆盖、不删除），否则就是"没备份却照样恢复、还报告成功" */
  snapshotCurrent(
    runId: string,
    rel: string | undefined,
    label: string,
    owner: string
  ): {
    /** 备份轮次 runId；一条都没备份成则为 null（此时不会留下空轮次） */
    preRunId: string | null
    /** **未能可靠备份的目标及原因** —— 调用方必须把它们排除出本次回滚（不覆盖、不删除） */
    failed: Array<{ rel: string; reason: string }>
  }
  /** @param exclude 本次**不得**恢复/删除的目标（如回滚前备份失败者）；被排除者如实进报告 failed */
  rollback(runId: string, rel?: string, exclude?: readonly string[]): RollbackReport
  prune(): number
  forget(runId: string): void
}

export function createCheckpointStore(dir: string): CheckpointStore {
  // 运行中的轮次放在内存（收尾时已在盘上），避免每次 record 都重读 manifest
  const active = new Map<string, CheckpointRun>()
  const recorded = new Map<string, Set<string>>()

  /**
   * 逐目标备份的失败原因（runId → rel → 原因）。`record` 吞异常不阻断写入（用户仍能改文件），
   * 但**失败必须留痕**：`snapshotCurrent` 据此把该目标排除出回滚 —— 备份失败的目标不许被覆盖/删除。
   */
  const recordFailures = new Map<string, Map<string, string>>()

  /**
   * 真实路径**严格**解析：只对**明确不存在**（ENOENT）的尾部按需上溯；
   * EACCES/EPERM/未知异常**立即抛**。
   *
   * ⚠️ 为什么不能直接用 guard 的 `realpathDeepest`：它把一切异常都当"不存在"继续爬父目录，
   * 极端情况返回原字符串 —— 真实路径**不可核**（权限/占用/异常联接）时外层收不到错误，
   * 边界检查就退化成字符串比较，恰好放过 junction 这类真实逃逸（增量独审实证）。
   */
  function realpathStrict(abs: string): string {
    const tail: string[] = []
    let cur = abs
    for (;;) {
      try {
        const real = realpathSync.native(cur)
        return tail.length === 0 ? real : join(real, ...tail.reverse())
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        const parent = dirname(cur)
        if (parent === cur) throw err
        tail.push(basename(cur))
        cur = parent
      }
    }
  }

  /** backup 字段必须是纯编号文件名：manifest 被人工改过时不许拼出越界备份源 */
  const isPlainBackupName = (name: string): boolean => /^\d+\.bin$/.test(name)

  /** runId 必须是无分隔编号：防止 `../` 之类把 store 根目录拼逃逸 */
  const isSafeRunId = (id: string): boolean => /^[A-Za-z0-9._-]{1,64}$/.test(id)

  /**
   * 目标的**真实**路径（symlink/junction 解析后）必须落在真实 root 内。
   * ⚠️ 只比字符串前缀不够：工作区里的目录被换成指向外部的联接后，resolve 结果看起来还在工作区内，
   * 读写却会穿到工作区外 —— 独审实测反例（外部私有文件被回滚覆盖）。真实路径核失败一律拒绝（fail-closed）。
   */
  const realInsideRoot = (root: string, abs: string): boolean => {
    try {
      const realRoot = realpathStrict(root)
      const realAbs = realpathStrict(abs)
      return realAbs === realRoot || realAbs.startsWith(realRoot + sep)
    } catch {
      return false
    }
  }

  const runDir = (runId: string): string => join(dir, runId)

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

      const root = resolve(workspaceRoot)
      const target = resolve(abs)
      const fail = (reason: string): void => {
        // 失败**留痕但不阻断写入**（快照属"锦上添花"）：snapshotCurrent 据此把该目标排除出回滚
        let byRel = recordFailures.get(runId)
        if (!byRel) recordFailures.set(runId, (byRel = new Map()))
        byRel.set(key, reason)
      }
      if (target !== root && !target.startsWith(root + sep)) return
      // 真实路径核（含联接解析）：目标穿到工作区外时，不得把外部内容纳入备份（备份来源越界）
      if (!realInsideRoot(root, target)) return fail('目标真实路径越出工作区（含符号联接）')

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
        recordFailures.get(runId)?.delete(key)
      } catch (err) {
        fail(`备份失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    finish(runId) {
      const run = active.get(runId)
      if (!run) return
      run.status = 'done'
      flush(run)
      active.delete(runId)
      recorded.delete(runId)
      recordFailures.delete(runId)
      store.prune()
    },

    list() {
      if (!existsSync(dir)) return []
      const out: CheckpointRunMeta[] = []
      for (const name of readdirSync(dir)) {
        const manifest = join(dir, name, 'manifest.json')
        if (!existsSync(manifest)) continue
        try {
          const run = JSON.parse(readFileSync(manifest, 'utf8')) as CheckpointRun
          if (run.runId !== name) continue
          // 过滤掉「没改动任何文件」的轮次：每轮对话都会建检查点（包括纯闲聊），不过滤面板会被一堆"0 个文件"刷屏，真正改过文件的那轮反而找不到；空轮次在磁盘上仍留着（几 KB），由 prune 按上限清理。
          if (run.changes.length === 0) continue
          out.push(toMeta(run))
        } catch {
          // 坏 manifest 跳过（不因一个坏文件让整个列表不可用）
        }
      }
      return out.sort(compareRunsNewestFirst)
    },

    get(runId) {
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

      // 备份源必须可信：纯编号文件名 + **真实路径仍在受信 checkpoint 根内**（files 目录被换成
      // 外部联接时不得把外部内容当恢复源/预览源——增量独审实测反例）
      if (!isPlainBackupName(change.backup)) return { ok: false, reason: 'backup-missing' }
      const src = join(runDir(runId), 'files', change.backup)
      if (!realInsideRoot(dir, src)) return { ok: false, reason: 'backup-missing' }
      if (!existsSync(src)) return { ok: false, reason: 'backup-missing' }

      try {
        const fd = openSync(src, 'r')
        try {
          const size = fstatSync(fd).size
          const cap = Math.min(size, MAX_SNAPSHOT_BYTES)
          const buf = Buffer.alloc(cap)
          // ⚠️ `readSync` 的返回值**必须接**（审查指出）：短读（网络盘 / 被杀软锁住）时没读满的区域留着 NUL，不接返回值就发现不了它，而 `applyPatch` 照样成功、然后整体回写 → **把 NUL 写进用户的文件**。
          const n = readSync(fd, buf, 0, cap, 0)
          const read = buf.subarray(0, Math.max(0, Math.min(n, cap)))
          const truncated = size > MAX_SNAPSHOT_BYTES || n < cap
          const text = read.toString('utf8')
          return {
            ok: true,
            content: text,
            truncated,
            bytes: size,
            // 有损解码判据（见 ReadBackupResult.lossy）：截断时前缀可能切在多字节字符中间，那时的"不可逆"是假象 → 只在**完整读到**时才可信。
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
      const empty = { preRunId: null, failed: [] as Array<{ rel: string; reason: string }> }
      const run = store.get(runId)
      if (!run) return empty
      const targets = selectChanges(run.changes, rel)
      if (targets.length === 0) return empty

      // 用**那一轮自己记下的工作区**，而不是"当前工作区" —— 用户可能已切过工作区，拿现在这个去拼路径就会指向别处（甚至越界）
      const root = resolve(run.workspace)
      const refused = new Map<string, string>()
      const preRunId = store.begin(run.workspace, label, owner)
      try {
        for (const c of targets) {
          // 两道防御（与 rollback 同源）：manifest 可能来自旧版本或被人工改过
          if (!isSafeRel(c.rel)) {
            refused.set(normalizeRel(c.rel), '路径不安全，已拒绝备份')
            continue
          }
          const abs = resolve(root, c.rel)
          if (abs !== root && !abs.startsWith(root + sep)) {
            refused.set(normalizeRel(c.rel), '路径越出工作区，已拒绝备份')
            continue
          }
          // 真实路径核：目标被换成外部联接时不纳入备份（备份来源越界——把外部内容拷进备份本身就是泄露）
          if (!realInsideRoot(root, abs)) {
            refused.set(normalizeRel(c.rel), '目标真实路径越出工作区（含符号联接），已拒绝备份')
            continue
          }
          store.record(preRunId, run.workspace, c.rel, abs)
        }
      } finally {
        // 失败也 finish：manifest 是增量落盘的，已经记下的那几条仍然可用
        store.finish(preRunId)
      }

      const backed = store.get(preRunId)
      const saved = new Set((backed?.changes ?? []).map((c) => normalizeRel(c.rel)))
      const byRel = recordFailures.get(preRunId)
      const failed = targets
        .filter((c) => !saved.has(normalizeRel(c.rel)))
        .map((c) => {
          const key = normalizeRel(c.rel)
          return { rel: c.rel, reason: refused.get(key) ?? byRel?.get(key) ?? '当前内容备份失败' }
        })

      // ⚠️ **一条都没备份成时必须返回 preRunId=null**：若每条都失败还照交 runId，界面就会显示"已备份"、
      //    文案还在承诺"退错了还能再退" —— 兜底静默消失而界面仍在承诺它。失败原因逐目标带出。
      if (!backed || backed.changes.length === 0) {
        store.forget(preRunId)
        return { preRunId: null, failed }
      }
      return { preRunId, failed }
    },

    rollback(runId, rel, exclude) {
      const report: RollbackReport = {
        runId,
        restored: [],
        deleted: [],
        failed: [],
        rejected: []
      }
      if (!isSafeRunId(runId)) {
        report.failed.push({ rel: '*', reason: '轮次标识不合法，已拒绝' })
        return report
      }
      const run = store.get(runId)
      if (!run) {
        report.failed.push({ rel: '*', reason: '未找到该轮次的记录' })
        return report
      }
      /** 动手之前先记下**这一轮此刻还在不在内存登记里**（收尾时行为不同）：`true` = 正在跑 → 回滚后必须**保持登记**，否则它后续每次写文件都不再留快照；`false` = 崩溃 / 中止残留 → 回滚后从内存里摘掉即可。 */
      const wasActive = active.has(runId)

      const selected = selectChanges(run.changes, rel)
      const excluded = new Set((exclude ?? []).map(normalizeRel))
      // 被排除的目标（回滚前备份失败者）：**不写不删**，并如实计入 failed ——
      // 界面据此不能显示"整轮已恢复"（徽章 + "失败 M 个"是用户读得出的自相矛盾，见下方 rolledBackAt 门槛）
      for (const c of selected) {
        if (excluded.has(normalizeRel(c.rel))) {
          report.failed.push({ rel: c.rel, reason: '回滚前的当前内容备份失败，已保留原样未恢复' })
        }
      }
      const targets = selected.filter((c) => !excluded.has(normalizeRel(c.rel)))
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
        // 真实路径核（含联接解析，fail-closed）：被换成联接的目标一个字节都不许被动（独审实测反例）
        if (!realInsideRoot(root, abs)) {
          report.rejected.push(action.rel)
          continue
        }

        try {
          if (action.op === 'delete') {
            if (existsSync(abs)) unlinkSync(abs)
            report.deleted.push(action.rel)
          } else {
            // 恢复源必须可信：纯编号文件名 + 真实路径仍在受信 checkpoint 根内（files 被换成外部联接即拒）
            const src = join(runDir(runId), 'files', action.backup)
            if (!isPlainBackupName(action.backup) || !realInsideRoot(dir, src) || !existsSync(src)) {
              report.failed.push({ rel: action.rel, reason: '备份文件缺失或不可信' })
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

      // ⚠️ **有失败或拒绝就不打这个标记**（增量独审补 rejected 项）：整轮回滚时原写法只看 `failed`，
      // 全 rejected（如联接越界）也会被标"已回滚"——面板上出现徽章而目标根本没恢复，是用户读得出的假话。
      if (report.failed.length === 0 && report.rejected.length === 0) {
        run.rolledBackAt = Date.now()
        if (run.status === 'running') run.status = 'done'
        active.set(runId, run)
        flush(run)
        // ⚠️ 只有"本来就不在 active 里"（= 崩溃残留的轮次）才摘登记。仍在跑的那一轮被摘掉的话，它**后续每一次写文件都不再进检查点**（`record` 拿不到 run 就直接 return），这是最难查的那种静默失效。
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
      // ⚠️ **正在跑的那一轮绝不删**（plan11 P0-10）：并发之后早开的那一轮可能还在跑而"轮数超限"已经成立 —— 照删会让它的快照目录在运行中途消失，等它跑完要回滚时才发现**静默失效**。上限的用意是"防无限增长"，宁可暂时多留一轮。
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
