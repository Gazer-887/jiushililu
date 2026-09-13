// 文本差异的纯逻辑层（plan13 批 B · B3/B4），也是全项目**唯一的 diff 真相源**。
//
// 为什么必须唯一：界面渲染与逐块回滚若各用一套算法，块序号就会错位 —— 用户点"第 2 处"
// 却改掉第 3 处，且不报错。抽成纯函数还顺带可单测（CI 无 Electron 二进制）。

import { applyPatch, reversePatch, structuredPatch, type StructuredPatchHunk } from 'diff'

/** 一行的性质：`context` 没变、`del` 只存在于改前、`add` 只存在于改后 */
export type DiffLineType = 'context' | 'del' | 'add'

export interface DiffLine {
  type: DiffLineType
  /** 行内容（**不含**行尾换行符） */
  text: string
  /** 改前文件里的行号（`add` 行没有） */
  oldNo?: number
  /** 改后文件里的行号（`del` 行没有） */
  newNo?: number
}

export interface DiffHunk {
  /** 块序号，**从 1 开始** —— 界面上的"第 N 处"与退回用的都是它（唯一真相源） */
  index: number
  /** 改前起始行（1 基） */
  oldStart: number
  oldLines: number
  /** 改后起始行（1 基） */
  newStart: number
  newLines: number
  lines: DiffLine[]
  /** 本块新增行数 / 删除行数（列表上直接给"＋3 −1"这种摘要） */
  added: number
  removed: number
}

export interface DiffResult {
  hunks: DiffHunk[]
  /**
   * jsdiff 的**原生块**，与 `hunks` **按下标一一对应**（截断方式也一致）。
   * 退回必须用它：只有它保留了 jsdiff 认识的全部细节（例如"文件末尾没有换行符"那种标注行，
   * 转 `hunks` 时已丢弃 —— 它没有行号，但拿它去写盘会写错最后一个换行）。
   */
  rawHunks: StructuredPatchHunk[]
  /**
   * 超出渲染预算，**只返回了前几块** —— 界面必须如实说出来，不能假装这就是全部。
   * ⚠️ 截断**只影响 `hunks` / `rawHunks` 这两个数组**：`added` / `removed` / `totalHunks`
   * 依然是**全量**统计 —— 否则界面会拿"＋201"冒充"实际 ＋230"，那是在骗用户。
   */
  truncated: boolean
  /** 改动**总处数**（含未显示的那些；界面说"共 N 处，只显示前 M 处"用得上） */
  totalHunks: number
  added: number
  removed: number
  /** 两侧内容完全一致（含"块被删光了"这种情况） */
  identical: boolean
  /**
   * **因为太大/太慢而放弃逐行差异**（不是"内容相同"，也不是"显示被截断"）。
   * 判据只有一条：jsdiff 超时或超出编辑长度上限 → 返回 `undefined`；此时 `hunks` 空但 **`identical` 也是 false**。
   * ⚠️ 界面必须**先看这个标志**，否则会把"算不动"说成"完全一致"（骗人）、或把"改动太大"说成"文件读不到"。
   */
  degraded: boolean
}

/** 上下文行数：与 git diff 默认一致（3 行），多了反而看不出改动边界 */
const CONTEXT_LINES = 3

/**
 * **算差异的时间预算**（毫秒）。jsdiff 的 Myers 是 **O(编辑距离 × 长度)**，而"整份重写一个文件"
 * 正是 Agent 的常见动作 —— 实测（Windows / Node，48 KB 内）12000 行要 32.4s；它**同步跑在渲染进程**，
 * 面板一开界面就僵死（连 IPC 回调都进不来），256KB 读上限拦不住。
 * ⚠️ 超限不是"超过就不算"，是"超过就承认算不动"（`degraded`）；它只把最坏情况压到 0.8s（仍会卡），
 * 彻底解决要把计算挪到主进程（见 plan13 后续项）。
 */
const DIFF_TIMEOUT_MS = 800

/**
 * **编辑长度上限**的一条硬闸（与超时互为兜底）。
 * ⚠️ jsdiff 在超时/超长时**返回 `undefined` 而不是抛错** —— 调用处不判它，
 * 下面读 `patch.hunks` 就会直接 TypeError。
 */
const MAX_EDIT_LENGTH = 12000

/** 全项目唯一的 diff 选项 —— 界面与主进程必须用**同一份**，否则块序号会对不上 */
const PATCH_OPTIONS = {
  context: CONTEXT_LINES,
  timeout: DIFF_TIMEOUT_MS,
  maxEditLength: MAX_EDIT_LENGTH
} as const

/**
 * 渲染预算：块数与总行数各一条上限。必须有 —— 一次大重构能产出上千块、几万行改动，
 * 全塞进 DOM 会把面板卡死（这面板是常驻右侧抽屉，卡的是整个界面）。
 * 超预算**只截断显示**，不改变 diff 结果本身。
 */
export const MAX_HUNKS = 200
export const MAX_TOTAL_LINES = 4000

/**
 * 计算差异。
 * @param before 改前文本（文件原本不存在时传空串）
 * @param after  改后文本（文件已被删除时传空串）
 */
export function computeHunks(before: string, after: string): DiffResult {
  const patch = structuredPatch('before', 'after', before, after, '', '', PATCH_OPTIONS)

  // ⚠️ **必须判这一下**：jsdiff 在超时或超长时返回 `undefined`（**不抛错**），不判就是"卡死"变
  //    "崩"（下面读 `patch.hunks` 直接 TypeError）。降级要**如实说出来**（degraded），不许伪装成"没有改动"。
  if (!patch) {
    return {
      hunks: [],
      rawHunks: [],
      truncated: false,
      totalHunks: 0,
      added: 0,
      removed: 0,
      identical: false, // ← 不是"一样"，是"算不动"，界面靠 degraded 区分
      degraded: true
    }
  }

  const hunks: DiffHunk[] = []
  const rawHunks: StructuredPatchHunk[] = []
  let totalLines = 0
  let truncated = false
  let addedTotal = 0
  let removedTotal = 0

  for (const raw of patch.hunks) {
    let added = 0
    let removed = 0
    const lines: DiffLine[] = []
    // 行号从 hunk 自己声明的起点开始走（不要自己从 1 数，会与上下文行错位）
    let oldNo = raw.oldStart
    let newNo = raw.newStart

    for (const line of raw.lines) {
      const marker = line.charAt(0)
      const text = line.slice(1)
      if (marker === '-') {
        lines.push({ type: 'del', text, oldNo })
        oldNo++
        removed++
      } else if (marker === '+') {
        lines.push({ type: 'add', text, newNo })
        newNo++
        added++
      } else if (marker === ' ') {
        lines.push({ type: 'context', text, oldNo, newNo })
        oldNo++
        newNo++
      }
      // `\ No newline at end of file` 这类标注行直接丢弃：它没有行号、也不是内容，留着会让"第 N 行"错位
      // （写盘用的是 jsdiff 原生 hunk，不经过这里，故不影响正确性）
    }

    // ⚠️ 计数**无条件累加**（要遍历全部块），只有"装进数组"受预算限制 —— 否则截断后的加减行数是假数字。
    addedTotal += added
    removedTotal += removed

    // ⚠️ 预算必须**把这一块自己也算进去**（审查证伪过旧写法）：只看"已装进去的总行数"时，
    //    一个 8000 行的巨块照进不误、`truncated` 还是 false —— 只防了"块数多"，不防"单块巨大"。
    if (hunks.length < MAX_HUNKS && totalLines + lines.length <= MAX_TOTAL_LINES) {
      totalLines += lines.length
      hunks.push({
        index: hunks.length + 1,
        oldStart: raw.oldStart,
        oldLines: raw.oldLines,
        newStart: raw.newStart,
        newLines: raw.newLines,
        lines,
        added,
        removed
      })
      rawHunks.push(raw) // 与 hunks 同进同出，下标才对得上
    } else {
      truncated = true
    }
  }

  return {
    hunks,
    rawHunks,
    truncated,
    totalHunks: patch.hunks.length,
    added: addedTotal,
    removed: removedTotal,
    // ⚠️ 判"两侧一样"要看 **jsdiff 算出来的块数**，不是"装进数组的块数"！否则唯一那一块
    //    因太大被预算挡掉时 `hunks` 是空的 → 被说成"完全一致"，而它改动巨大 —— 最不能犯的错。
    identical: patch.hunks.length === 0,
    degraded: false
  }
}

/** 摘要文案："＋3 −1" / "无改动" */
export function summarizeDiff(result: DiffResult): string {
  if (result.identical) return '无改动'
  const parts: string[] = []
  if (result.added > 0) parts.push(`＋${result.added}`)
  if (result.removed > 0) parts.push(`−${result.removed}`)
  return parts.join(' ')
}

/**
 * 差异能不能**逐块退回**：判据只有一条 —— **两侧都必须是完整原文**。
 * 截断过的文本算出来的块，行号与内容对不上真实文件，拿去写盘会把大文件砍成截断长度（数据丢失）。
 * 同 `FilePreviewPane` 那条"截断的文件不给编辑"。
 */
export function canRevertHunks(opts: {
  truncated: boolean
  kind: 'created' | 'modified'
  hasBefore: boolean
  hasAfter: boolean
}): boolean {
  // created：改前文件压根不存在，没有"改前的那几行"可还原 —— 只能整份退回（= 删掉）
  if (opts.kind === 'created') return false
  if (opts.truncated) return false
  if (!opts.hasBefore || !opts.hasAfter) return false
  return true
}

/** 退回一处的失败原因（成功/失败之外没有第三种） */
export type RevertHunkFailReason = 'no-such-hunk' | 'apply-failed'

export type RevertHunkOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: RevertHunkFailReason }

/**
 * 把「第 N 处」退回 —— 只算出**应用之后的完整文本**，落盘由调用方走**统一写入服务**（含写前快照）。
 * 保持纯函数才能直接单测，而"退回算得对不对"正是最该测的：算错了不是报错，是**默默改坏文件**。
 * ⚠️ 前提由调用方保证（见 `canRevertHunks` 与 `checkpoint:revert-hunk` 的 mtime 校验）：
 *    `current` 必须**还是**算差异时的那一份文本 —— 变过的话 `applyPatch` 返回 false（它不会瞎改），
 *    但更早那一层就该拦下来，别让用户白点一次。
 */
export function revertHunk(current: string, result: DiffResult, hunkIndex: number): RevertHunkOutcome {
  const raw = result.rawHunks[hunkIndex - 1]
  if (!raw) return { ok: false, reason: 'no-such-hunk' }

  // jsdiff 的 `reversePatch` 收的是**整个 patch**（不是单个块），故先把目标块单独包成一个 patch
  // 再反转 —— 反转出来的"旧侧"正好是当前文本里的那一块，`applyPatch` 才认得出来。
  const single = {
    oldFileName: undefined,
    newFileName: undefined,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: [raw]
  }
  try {
    const out = applyPatch(current, reversePatch(single))
    // applyPatch 在"文本对不上"时**返回 false**（不抛错）—— 那是它的契约，不是异常
    if (out === false) return { ok: false, reason: 'apply-failed' }
    return { ok: true, text: out }
  } catch {
    return { ok: false, reason: 'apply-failed' }
  }
}
