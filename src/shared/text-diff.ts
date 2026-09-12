// 文本差异 —— 纯逻辑层（plan13 批 B · B3/B4）
//
// 为什么单独抽一层：**"看到几处改动"与"能退回哪几处"必须是同一份数据**。
// 若界面用一套算法渲染、回滚用另一套算法定位，块序号就会对不上 ——
// 用户点了"第 2 处"，改掉的却是第 3 处。这种错位不会报错，只会默默改错文件。
// 所以本模块是全项目**唯一的 diff 真相源**：界面渲染它、逐块回滚也用它。
//
// 抽成纯函数还有一个实际好处：CI 上没有 Electron 二进制，碰 electron 的代码测不了；
// 而这里的每一条边界（空文件、只有末行没换行、超大文件）都能直接单测。

import { structuredPatch } from 'diff'

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
   * 因超出渲染预算而**只返回了前几块** —— 界面必须如实说出来，不能假装这就是全部。
   *
   * ⚠️ 注意：截断**只影响 `hunks` 这个数组**，`added` / `removed` / `totalHunks`
   * 依然是**全量**统计 —— 否则界面会拿"＋201"冒充"实际 ＋230"，那是在骗用户。
   */
  truncated: boolean
  /** 改动**总处数**（含未显示的那些；界面说"共 N 处，只显示前 M 处"用得上） */
  totalHunks: number
  added: number
  removed: number
  /** 两侧内容完全一致（含"块被删光了"这种情况） */
  identical: boolean
}

/** 上下文行数：与 git diff 默认一致（3 行），多了反而看不出改动边界 */
const CONTEXT_LINES = 3

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
  const patch = structuredPatch('before', 'after', before, after, '', '', {
    context: CONTEXT_LINES
  })

  const hunks: DiffHunk[] = []
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

    if (hunks.length < MAX_HUNKS && totalLines < MAX_TOTAL_LINES) {
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
    } else {
      truncated = true
    }
  }

  return {
    hunks,
    truncated,
    totalHunks: patch.hunks.length,
    added: addedTotal,
    removed: removedTotal,
    identical: hunks.length === 0
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
