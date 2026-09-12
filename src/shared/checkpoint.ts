// 检查点与回滚 —— 纯逻辑层（plan8 R4）
//
// 为什么单独抽一层：回滚的正确性全在"记什么、还什么"这两件判断上，
// 而这两件事都能用纯函数表达。抽出来就能单测（CI 无 Electron 二进制，
// 碰 electron 的代码测不了）。文件读写那半在 checkpoints.ts。

/** 变更类型：本轮之前文件**不存在** = created；存在 = modified */
export type ChangeKind = 'created' | 'modified'

export interface FileChange {
  /** 工作区相对路径（统一 `/` 分隔，跨平台一致） */
  rel: string
  kind: ChangeKind
  /** 写之前的字节数（created 恒为 0） */
  beforeBytes: number
  /** 备份文件名（相对 run 目录）；created 无内容可备份，为 null */
  backup: string | null
}

export interface CheckpointRun {
  runId: string
  /** 开始时间（毫秒时间戳） */
  at: number
  /**
   * 同一进程内的自增序号，用于**同毫秒创建的轮次之间确定先后**。
   * 为什么需要：`at` 只有毫秒精度，同一毫秒内开两轮时 `at` 相同，
   * 「新的在前」就退化成任意顺序（CI 在 Linux 上抓出过这个不稳定）。
   * 历史数据可能没有该字段，故可选。
   */
  seq?: number
  /** 工作区绝对路径 */
  workspace: string
  /** 哪个 Agent 干的（内核默认 / 子代理名） */
  agent: string
  /**
   * 这一轮属于**哪条会话**（plan11）。
   * 并发之后必须可查："这轮是谁跑的"决定它该出现在哪条会话的变更列表里，
   * 也是出事时唯一能追溯的线索。历史数据（本字段之前生成的）可能没有，故可选。
   */
  conversationId?: string
  changes: FileChange[]
  /**
   * 运行状态。
   * `running` 表示这轮**没正常收尾**（应用崩溃 / 用户中止 / 断电）。
   * 这种情况下 manifest 依然是可用的 —— 因为它是**增量落盘**的，
   * 且快照一律发生在写文件**之前**，故"快照了但没写"也只是无害的多余备份。
   * 用户仍可回滚这轮已发生的改动（这正是中断场景下最需要的能力）。
   */
  status: 'running' | 'done'
  /** 已回滚时间；未回滚为 undefined */
  rolledBackAt?: number
}

/** 列表用（不含 changes 明细，避免列表接口过大） */
export interface CheckpointRunMeta {
  runId: string
  at: number
  /** 同进程内自增序号，用于同毫秒时的先后判定（见 compareRunsNewestFirst） */
  seq?: number
  workspace: string
  agent: string
  /**
   * 这一轮属于**哪条会话**（plan11）。
   * 并发之后必须可查："这轮是谁跑的"决定它该出现在哪条会话的变更列表里，
   * 也是出事时唯一能追溯的线索。历史数据的 manifest 里可能没有，故可选。
   */
  conversationId?: string
  status: 'running' | 'done'
  fileCount: number
  createdCount: number
  modifiedCount: number
  rolledBackAt?: number
}

/**
 * 归一化相对路径：反斜杠转正斜杠、去掉开头的 `./`。
 * 保证同一个文件无论模型怎么写路径，都归一到同一个键（否则去重会失效）。
 */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 记录一次写前快照 —— **核心规则：同一文件只记第一次**。
 *
 * 为什么这条最重要：一轮里模型可能对同一文件写 3 次。
 * 回滚要还原的是**这一轮开始前**的样子，也就是写第 1 次之前的状态。
 * 若每次都覆盖备份，回滚会把文件还原成"写第 2 次之前"——那是模型自己的中间产物，
 * 不是用户原本的文件。**这是本模块最容易写错的地方，故单测专门覆盖。**
 *
 * @returns 新增后的数组；若该路径已记录，原样返回（不覆盖备份）
 */
export function upsertChange(changes: FileChange[], next: FileChange): FileChange[] {
  const rel = normalizeRel(next.rel)
  if (changes.some((c) => c.rel === rel)) return changes
  return [...changes, { ...next, rel }]
}

/** 备份文件名：用序号而非路径，绕开 Windows 非法字符/保留名/长路径 */
export function backupName(index: number): string {
  return `${index}.bin`
}

export function summarize(changes: FileChange[]): {
  fileCount: number
  createdCount: number
  modifiedCount: number
} {
  const createdCount = changes.filter((c) => c.kind === 'created').length
  return {
    fileCount: changes.length,
    createdCount,
    modifiedCount: changes.length - createdCount
  }
}

export function toMeta(run: CheckpointRun): CheckpointRunMeta {
  return {
    runId: run.runId,
    at: run.at,
    workspace: run.workspace,
    agent: run.agent,
    status: run.status,
    ...(run.conversationId !== undefined ? { conversationId: run.conversationId } : {}),
    ...(run.seq !== undefined ? { seq: run.seq } : {}),
    ...summarize(run.changes),
    ...(run.rolledBackAt !== undefined ? { rolledBackAt: run.rolledBackAt } : {})
  }
}

/**
 * 轮次排序：新的在前。
 *
 * 三级比较缺一不可：
 *   ① `at` 毫秒时间戳（跨会话也正确）
 *   ② `seq` 进程内自增（**同毫秒**创建时靠它定先后；CI 抓出过不稳定的坑）
 *   ③ `runId` 字符串比较（最终兜底，保证**全序**——排序结果与输入顺序无关）
 */
export function compareRunsNewestFirst(a: CheckpointRunMeta, b: CheckpointRunMeta): number {
  if (b.at !== a.at) return b.at - a.at
  const seqA = a.seq ?? 0
  const seqB = b.seq ?? 0
  if (seqB !== seqA) return seqB - seqA
  return a.runId.localeCompare(b.runId)
}

export function describeKind(kind: ChangeKind): string {
  return kind === 'created' ? '新建' : '修改'
}

/** 回滚要做的动作 */
export type RollbackAction =
  | { rel: string; op: 'restore'; backup: string }
  | { rel: string; op: 'delete' }

/**
 * 计划回滚动作（纯函数，不落盘）：
 * - modified → 把备份内容写回去
 * - created  → 删掉这个文件（本轮之前它不存在，删掉才是"还原"）
 */
export function planRollback(changes: FileChange[]): RollbackAction[] {
  const actions: RollbackAction[] = []
  for (const c of changes) {
    if (c.kind === 'created' || c.backup === null) {
      actions.push({ rel: c.rel, op: 'delete' })
    } else {
      actions.push({ rel: c.rel, op: 'restore', backup: c.backup })
    }
  }
  return actions
}

/**
 * 从 manifest 里挑出指定文件（不传 rel 则全选）。
 * **两侧都做归一**：存储侧的 rel 正常都是归一的，但若来自旧版本写入或人工编辑的
 * manifest，可能带反斜杠 —— 那时单侧归一就会"匹配不上"，回滚静默无事发生。
 */
export function selectChanges(changes: FileChange[], rel?: string): FileChange[] {
  if (rel === undefined) return changes
  const target = normalizeRel(rel)
  return changes.filter((c) => normalizeRel(c.rel) === target)
}

/** 回滚结果报告（界面展示"还原了几个 / 删了几个 / 哪几个失败"） */
export interface RollbackReport {
  runId: string
  /** 已还原（原本就存在的文件，内容写回） */
  restored: string[]
  /** 已删除（本轮新建的文件，回滚 = 删掉） */
  deleted: string[]
  failed: { rel: string; reason: string }[]
  /** 因路径不安全而拒绝处理的条目 */
  rejected: string[]
}

/**
 * 防御性校验：manifest 里的 rel 必须是**相对路径且不逃逸**。
 * 回滚会按 rel 拼绝对路径再写文件 —— 若 manifest 被篡改含 `../../`，
 * 就会写到工作区外。落盘前必须挡住。
 */
export function isSafeRel(rel: string): boolean {
  const r = normalizeRel(rel)
  if (r === '' || r.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(r)) return false // Windows 绝对路径
  return !r.split('/').includes('..')
}

// ── Diff 视图取两侧内容（plan13 批 B · B3）──────────────────────

/** 取不到时的原因（**枚举进共享层**，界面据此说人话，不自己编文案） */
export type SidesFailReason =
  | 'run-missing'
  | 'not-recorded'
  | 'backup-missing'
  | 'bad-rel'
  /** 这一轮属于**另一个工作区** —— 拿当前工作区去比就会比错文件（见 `RevertFailReason`） */
  | 'other-workspace'

export interface CheckpointSides {
  ok: true
  runId: string
  rel: string
  kind: ChangeKind
  /** **改前**正文（快照）。`created` 文件为 `null` —— 它当轮之前根本不存在 */
  before: string | null
  /** **当前**磁盘正文。本轮改完之后文件又被删掉了则为 `null` */
  after: string | null
  /** 改前字节数（`created` 恒为 0） */
  beforeBytes: number
  afterBytes: number
  /**
   * 任一侧被截断（超过 256KB 读上限）。
   *
   * ⚠️ 界面**必须**说明"内容不完整"，并**禁止逐块退回** ——
   * 拿半个文件算出来的差异去写盘，等于把大文件砍成截断长度（数据丢失）。
   * 这与 `FilePreviewPane` 那条"截断的文件不给编辑"是同一条原则。
   */
  truncated: boolean
  /**
   * 任一侧**不是合法 UTF-8**（GBK / 二进制）→ 界面必须说明"逐处退回会损坏它"。
   * 与 `truncated` 同理：这类文件只给整份退回（那走的是字节拷贝，安全）。
   */
  lossy: boolean
  /** 当前文件 mtime（逐块退回时的冲突基线，防"用户点拒绝的同时 Agent 正在写"）；文件不在则无 */
  mtimeMs?: number
  /** 这一轮是否还没收尾 —— `running` 时 Agent 可能**正在**写这些文件 */
  runStatus: 'running' | 'done'
}

export type CheckpointSidesResult = CheckpointSides | { ok: false; reason: SidesFailReason }

/** 失败原因的说人话版本（界面直接显示，**不许**把裸枚举名甩给用户） */
export function describeSidesFailure(reason: SidesFailReason): string {
  switch (reason) {
    case 'run-missing':
      return '找不到这一轮的记录（可能已被清理）'
    case 'not-recorded':
      return '这一轮的记录里没有这个文件'
    case 'backup-missing':
      return '这一轮的快照已不在了（检查点只保留最近若干轮），看不了改前的内容'
    case 'bad-rel':
      return '路径不合法，拒绝读取'
    case 'other-workspace':
      return '这一轮属于另一个工作区 —— 现在打开的不是它，看到的差异会对不上，已拒绝'
  }
}

// ── 逐处退回（plan13 批 B · B4）────────────────────────────────

export type RevertFailReason =
  | 'bad-input'
  | 'bad-rel'
  | 'run-missing'
  | 'not-recorded'
  | 'created'
  | 'backup-missing'
  | 'missing-current'
  | 'truncated'
  /**
   * **这个文件不是合法 UTF-8**（GBK 文本 / 二进制）。
   *
   * 为什么必须拦（独立审查实测）：退回会把**整份文本**按 UTF-8 重写回磁盘，
   * 而有损解码出来的字符再编码回去 **不等于原字节** ——
   * 实测一个 GBK 文件只改了一行，退一次之后**没被改的那几行也一起烂掉**
   * （13 字节 → 32 字节）。这是**不可逆**的损坏，只能整份退回。
   */
  | 'lossy-encoding'
  /** 界面看到的那一份已经**不是**磁盘上的这一份了（Agent 刚改过 / 用户自己编辑过） */
  | 'changed-on-disk'
  /**
   * **这一轮属于另一个工作区**。
   *
   * 为什么必须拦：检查点目录是全局的（`userData/checkpoints`），列表里会有别的工作区的轮次；
   * 而 rel 是**相对路径** —— 拿当前工作区去拼，就会读到/写到**同名的另一个文件**，
   * 而且 mtime 阀拦不住（它就是那个文件的当前状态）。这是唯一会"静默改错文件"的路径。
   */
  | 'other-workspace'
  | 'no-such-hunk'
  | 'apply-failed'
  | 'write-failed'

export interface RevertHunkInput {
  runId: string
  rel: string
  /** 1 基的块序号 —— 就是界面上的「第 N 处」 */
  hunkIndex: number
  /**
   * 界面读到"当前内容"时的 mtime。
   *
   * **这条参数是安全阀，不是优化**：块序号只在"两侧内容与算差异时一致"的前提下才有效。
   * 文件若在用户看差异的这段时间被改过（Agent 在跑 / 用户自己编辑），
   * 主进程**必须拒绝**并让用户重看一遍 —— 否则就是"点了第 2 处、改掉第 N 处"。
   */
  expectedMtimeMs: number
}

export type RevertHunkResult =
  | { ok: true; rel: string; hunkIndex: number; message: string; mtimeMs?: number }
  | { ok: false; reason: RevertFailReason }

/** 退回失败的说人话版本 */
export function describeRevertFailure(reason: RevertFailReason): string {
  switch (reason) {
    case 'bad-input':
    case 'bad-rel':
      return '请求不合法（路径或参数有问题），已拒绝'
    case 'run-missing':
      return '找不到这一轮的记录（可能已被清理）'
    case 'not-recorded':
      return '这一轮的记录里没有这个文件'
    case 'created':
      return '新建的文件没有"改前的内容"可还原 —— 只能整份退回（= 删除）'
    case 'backup-missing':
      return '这一轮的快照已不在了（检查点只保留最近若干轮），退不了'
    case 'missing-current':
      return '这个文件现在读不到了（可能已被删掉），退不了'
    case 'truncated':
      return '文件太大，只读到了一部分 —— 逐处退回会把文件写坏，请用整份退回'
    case 'lossy-encoding':
      return '这个文件不是 UTF-8 编码（可能是 GBK 或二进制）—— 逐处退回会把整份内容写坏且不可恢复，只能用整份退回'
    case 'changed-on-disk':
      return '文件在你看差异之后被改过（Agent 或别的程序），为避免退错，请重新看一遍差异再退'
    case 'other-workspace':
      return '这一轮属于另一个工作区 —— 现在打开的工作区不是它，退回会改到同名的另一个文件，已拒绝'
    case 'no-such-hunk':
      return '这一处改动已经不在了（可能刚被退回过），请重新看一遍差异'
    case 'apply-failed':
      return '这一处改动和文件当前内容对不上，没法安全地退回去'
    case 'write-failed':
      return '退回算出来了，但写盘失败'
  }
}
