// 文本差异 —— 纯逻辑层（plan13 批 B · B3/B4）
//
// 为什么单独抽一层：**"看到几处改动"与"能退回哪几处"必须是同一份数据**。
// 若界面用一套算法渲染、回滚用另一套算法定位，块序号就会对不上 ——
// 用户点了"第 2 处"，改掉的却是第 3 处。这种错位不会报错，只会默默改错文件。
// 所以本模块是全项目**唯一的 diff 真相源**：界面渲染它、逐块回滚也用它。
//
// 抽成纯函数还有一个实际好处：CI 上没有 Electron 二进制，碰 electron 的代码测不了；
// 而这里的每一条边界（空文件、只有末行没换行、超大文件）都能直接单测。

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
  /**
   * 块序号，**从 1 开始**。
   * 界面上的"第 N 处"与"拒绝第 N 处"用的都是它 —— 这就是那个唯一真相源。
   */
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
   *
   * 为什么两套都要留着：`hunks` 是给界面看的（带行号、带类型），
   * 但**退回**必须用原生块 —— 只有它保留了 jsdiff 认识的全部细节
   * （例如"文件末尾没有换行符"这种标注行，我在转成 `hunks` 时把它丢了 ——
   *  那是对的，因为它没有行号；但拿它去写盘就会写错最后一个换行）。
   * 用同一份 diff 的两种视图，"看到第 N 处"与"退回第 N 处"才不会分岔。
   */
  rawHunks: StructuredPatchHunk[]
  /**
   * 因超出渲染预算而**只返回了前几块** —— 界面必须如实说出来，不能假装这就是全部。
   *
   * ⚠️ 注意：截断**只影响 `hunks` / `rawHunks` 这两个数组**，`added` / `removed` / `totalHunks`
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
   *
   * 判据只有一条：jsdiff 超时或超出编辑长度上限 → 它返回 `undefined`。
   * 这时 `hunks` 是空的，但**`identical` 也是 false** —— 界面必须**先看这个标志**，
   * 否则会把"算不动"说成"完全一致"（那是在骗人），或者把"改动太大"说成"文件读不到"。
   */
  degraded: boolean
}

/** 上下文行数：与 git diff 默认一致（3 行），多了反而看不出改动边界 */
const CONTEXT_LINES = 3

/**
 * **算差异的时间预算**（毫秒）。
 *
 * 为什么必须有（独立审查实测出来的，不是我拍脑袋加的）：
 * jsdiff 的 Myers 算法是 **O(编辑距离 × 长度)** —— 全文重写是最坏输入。
 * 实测耗时：2000 行 0.65s → 4000 行 3.1s → 8000 行 12.8s → 12000 行 **32.4s**（都在 48 KB 内！）。
 * 而它**同步跑在渲染进程**：面板一打开，整个界面就僵死（连 IPC 回调都进不来）。
 * 更糟的是 256KB 的读上限**完全挡不住** —— 48 KB 就够瘫了。
 *
 * 而"整份重写一个文件"（换实现 / 重新格式化 / 重新生成 lockfile）是 Agent 的**常见动作**。
 *
 * ⚠️ 这条上限的意思不是"超过就不算"，而是**"超过就承认算不动"**（`degraded`）。
 * 而且它**只把最坏情况从几十秒压到 0.8 秒**：这个函数目前仍同步跑在渲染进程，
 * 那 0.8 秒内界面是卡住的。彻底解决要把计算挪到主进程（门禁/界面都只收结果），
 * 已记入 plan13 的后续项 —— 那时 800 这个数就可以放宽回去。
 */
const DIFF_TIMEOUT_MS = 800

/**
 * **编辑长度上限**的一条硬闸（与超时互为兜底）。
 *
 * ⚠️ jsdiff 在超时/超长时**返回 `undefined` 而不是抛错** ——
 * 所以调用处必须先判它，否则下面读 `patch.hunks` 会直接 TypeError。
 * 这个坑我自己实测过（`timeout:100` → 101ms 后返回 `undefined`）。
 */
const MAX_EDIT_LENGTH = 12000

/** 全项目唯一的 diff 选项 —— 界面与主进程必须用**同一份**，否则块序号会对不上 */
const PATCH_OPTIONS = {
  context: CONTEXT_LINES,
  timeout: DIFF_TIMEOUT_MS,
  maxEditLength: MAX_EDIT_LENGTH
} as const

/**
 * 渲染预算：块数与总行数各一条上限。
 *
 * 为什么必须有：一次大重构可以产出上千个块、几万行改动 —— 全部塞进 DOM 会把
 * 面板卡死（这个面板是常驻右侧抽屉，卡的是整个界面）。
 * 超预算时**只截断显示**，不改变 diff 结果本身。
 */
export const MAX_HUNKS = 200
export const MAX_TOTAL_LINES = 4000

/**
 * 计算差异。
 *
 * @param before 改前文本（文件原本不存在时传空串）
 * @param after  改后文本（文件已被删除时传空串）
 */
export function computeHunks(before: string, after: string): DiffResult {
  const patch = structuredPatch('before', 'after', before, after, '', '', PATCH_OPTIONS)

  // ⚠️ **必须判这一下**：jsdiff 在超时或超出编辑长度上限时返回 `undefined`（**不抛错**）。
  //    不判的话，下面读 `patch.hunks` 会直接 TypeError —— 而那是"卡死"变成"崩"，
  //    比原来更糟。降级要**如实说出来**（degraded），不能伪装成"没有改动"。
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
      // `\ No newline at end of file` 这类标注行直接丢弃：
      // 它没有行号、也不是内容，留在 lines 里会让"第 N 行"全部错位。
      // （真要写盘时用的是 jsdiff 自己的 hunk 对象，不经过这里，所以不影响正确性。）
    }

    // ⚠️ 计数**无条件累加**（要遍历全部块），只有"装进数组"受预算限制 ——
    //    否则截断后的加减行数就成了假数字。
    addedTotal += added
    removedTotal += removed

    // ⚠️ 预算必须在 push 之前**把这一块自己也算进去**（审查证伪过这个声明）：
    //    原写法只看"已装进去的总行数"，而第一块天然满足 `0 < 4000` ——
    //    于是一个 8000 行的巨块照进不误，`truncated` 还是 false。
    //    "渲染预算"号称防卡死，实际上只防"块数多"，不防"单块巨大"。
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
    // ⚠️ 判"两侧一样"要看 **jsdiff 算出来的块数**，不是"我们装进数组的块数"！
    //    否则"唯一那一块因为太大被预算挡掉"时，`hunks` 是空的 → 会被说成"完全一致"，
    //    而实际上它改动巨大 —— 那是**把算不动说成没改动**，正是最不能犯的错。
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
 * 差异能不能**逐块退回**。
 *
 * 判据只有一条：**两侧都必须是完整原文**。
 * 截断过的文本算出来的块，其行号与内容对不上真实文件 ——
 * 拿它去写盘就会把大文件砍成截断长度（数据丢失）。这正是 `FilePreviewPane`
 * 那条"截断的文件不给编辑"的同一条原则，在这里必须同样守住。
 */
export function canRevertHunks(opts: {
  truncated: boolean
  kind: 'created' | 'modified'
  hasBefore: boolean
  hasAfter: boolean
}): boolean {
  // created：改前文件压根不存在 —— 它没有"改前的那几行"可还原。
  // 这种文件只能整份退回（= 删掉），不能逐块。
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
 * 把「第 N 处」退回 —— 算出**应用之后的完整文本**，落盘由调用方负责。
 *
 * 为什么这一层只算不写：写盘必须走**统一写入服务**（含写前快照），那是主进程的事。
 * 保持纯函数才能直接单测 —— 而"退回算得对不对"正是最该测的那件事
 * （算错了不是报错，是**默默改坏文件**）。
 *
 * ⚠️ 前提（调用方保证，见 `canRevertHunks` 与 `checkpoint:revert-hunk` 的 mtime 校验）：
 *    `current` 必须**还是**算差异时的那一份文本。变过的话 `applyPatch` 会返回 false
 *    （它不会瞎改），但更早那一层就该把它拦下来，别让用户白点一次。
 */
export function revertHunk(current: string, result: DiffResult, hunkIndex: number): RevertHunkOutcome {
  const raw = result.rawHunks[hunkIndex - 1]
  if (!raw) return { ok: false, reason: 'no-such-hunk' }

  // jsdiff 的 `reversePatch` 收的是**整个 patch**（不是单个块），
  // 所以先把目标块单独包成一个 patch 再反转 —— 反转出来的"旧侧"
  // 正好是当前文本里的那一块，`applyPatch` 才认得出来。
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
