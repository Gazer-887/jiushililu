// 检查点与回滚的纯逻辑层（plan8 R4；文件读写那半在 checkpoints.ts）。
//
// 抽出来是为了可单测 —— 回滚的正确性全在"记什么、还什么"的判断上，而 CI 无 Electron 二进制。

/** 以**本轮开始前**该文件是否存在为准 */
export type ChangeKind = 'created' | 'modified'

export interface FileChange {
  /** 工作区相对路径，统一 `/` 分隔（见 normalizeRel） */
  rel: string
  kind: ChangeKind
  /** 写之前的字节数；created 恒为 0 */
  beforeBytes: number
  /** 备份文件名（相对 run 目录）；created 无可备份，为 null */
  backup: string | null
}

export interface CheckpointRun {
  runId: string
  /** 开始时间（毫秒时间戳） */
  at: number
  /**
   * 同进程内自增，用于**同毫秒创建的两轮定先后**：`at` 只有毫秒精度，同毫秒时「新的在前」会退化成任意顺序（CI 在 Linux 上抓出过）。历史数据可能没有，故可选。
   */
  seq?: number
  /** 工作区绝对路径 */
  workspace: string
  /** 哪个 Agent 干的（内核默认 / 子代理名） */
  agent: string
  /**
   * 属于**哪条会话**（plan11）：并发下"这轮是谁跑的"决定它出现在哪条会话的变更列表里，也是出事时唯一的追溯线索。历史数据可能没有，故可选。
   */
  conversationId?: string
  changes: FileChange[]
  /**
   * `running` = 这轮**没正常收尾**（崩溃 / 中止 / 断电）。此时 manifest 仍可用：它**增量落盘**，
   * 且快照一律发生在写文件**之前**（"快照了但没写"只是无害的多余备份），用户仍可回滚这轮已发生的改动。
   */
  status: 'running' | 'done'
  /** 已回滚时间；未回滚为 undefined */
  rolledBackAt?: number
}

/** 列表用（不含 changes 明细，避免列表接口过大） */
export interface CheckpointRunMeta {
  runId: string
  at: number
  /** 同进程内自增序号，同毫秒时的先后判定（见 compareRunsNewestFirst） */
  seq?: number
  workspace: string
  agent: string
  /** 属于哪条会话（plan11）；理由见 `CheckpointRun.conversationId`。老 manifest 可能没有 */
  conversationId?: string
  status: 'running' | 'done'
  fileCount: number
  createdCount: number
  modifiedCount: number
  rolledBackAt?: number
}

/** 反斜杠转正斜杠、去掉开头 `./` —— 不归一的话同一文件会因写法不同而重复记录（去重失效） */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 记录一次写前快照 —— **核心规则：同一文件只记第一次**。一轮里模型可能对同一文件写多次，而回滚
 * 要还原的是这一轮**开始前**的样子（覆盖备份就会还原成模型自己的中间产物）—— 本模块最容易写错处。
 * @returns 新增后的数组；该路径已记录则原样返回（不覆盖备份）
 */
export function upsertChange(changes: FileChange[], next: FileChange): FileChange[] {
  const rel = normalizeRel(next.rel)
  if (changes.some((c) => c.rel === rel)) return changes
  return [...changes, { ...next, rel }]
}

/** 文件名用序号而非路径 —— 绕开 Windows 非法字符 / 保留名 / 长路径 */
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
 * 轮次排序：新的在前。三级比较缺一不可 —— `at` 跨会话也正确、`seq` 定**同毫秒**的先后
 * （CI 抓出过不稳定）、`runId` 字符串比较兜底保证**全序**（结果与输入顺序无关）。
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

export type RollbackAction =
  | { rel: string; op: 'restore'; backup: string }
  | { rel: string; op: 'delete' }

/**
 * 计划回滚动作（纯函数，不落盘）：modified → 写回备份；created → 删除文件
 * （本轮之前它不存在，删掉才是"还原"）。
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
 * 从 manifest 里挑出指定文件（不传 rel 则全选）。**两侧都做归一** —— 旧版本写入或人工编辑的
 * manifest 可能带反斜杠，那时单侧归一就会"匹配不上"，回滚静默无事发生。
 */
export function selectChanges(changes: FileChange[], rel?: string): FileChange[] {
  if (rel === undefined) return changes
  const target = normalizeRel(rel)
  return changes.filter((c) => normalizeRel(c.rel) === target)
}

export interface RollbackReport {
  runId: string
  /** 已还原（原本就存在，内容写回） */
  restored: string[]
  /** 已删除（本轮新建，回滚 = 删掉） */
  deleted: string[]
  failed: { rel: string; reason: string }[]
  /** 路径不安全、被拒绝处理 */
  rejected: string[]
}

/**
 * 防御性校验：manifest 里的 rel 必须是**相对路径且不逃逸** —— 回滚会按 rel 拼绝对路径再写文件，
 * manifest 被篡改含 `../../` 就会写到工作区外。
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
   * 任一侧被截断（超 256KB 读上限）。
   * ⚠️ 界面**必须**说明"内容不完整"并**禁止逐块退回** —— 拿半个文件算出的差异去写盘等于把大文件
   * 砍到截断长度（数据丢失）。同 `FilePreviewPane` 那条"截断的文件不给编辑"。
   */
  truncated: boolean
  /**
   * 任一侧**不是合法 UTF-8**（GBK / 二进制）→ 界面必须说明"逐处退回会损坏它"，这类文件只给整份退回（走字节拷贝，安全）。
   */
  lossy: boolean
  /** 当前文件 mtime（逐块退回的冲突基线，防"用户点拒绝的同时 Agent 正在写"）；文件不在则无 */
  mtimeMs?: number
  /** 这一轮还没收尾 —— `running` 时 Agent 可能**正在**写这些文件 */
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
   * **不是合法 UTF-8**（GBK 文本 / 二进制）。
   * ⚠️ 独立审查实测：退回把**整份文本**按 UTF-8 重写，而有损解码的字符再编码回去**不等于原字节** ——
   * GBK 文件只改一行、退一次后没被改的那几行也一起烂掉（13 字节 → 32 字节），**不可逆**，只能整份退回。
   */
  | 'lossy-encoding'
  /** 界面看到的那一份已经**不是**磁盘上的这一份了（Agent 刚改过 / 用户自己编辑过） */
  | 'changed-on-disk'
  /**
   * **这一轮属于另一个工作区**。检查点目录是全局的（`userData/checkpoints`），列表里会有别的工作区的轮次；
   * rel 是**相对路径**，拿当前工作区去拼就会读写**同名的另一个文件**，mtime 阀也拦不住 ——
   * 这是唯一会"静默改错文件"的路径。
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
   * **安全阀，不是优化**：块序号只在"两侧内容与算差异时一致"的前提下才有效 —— 文件在用户看差异期间
   * 被改过（Agent 在跑 / 用户自己编辑）时主进程**必须拒绝**，否则"点第 2 处、改掉第 N 处"。
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
