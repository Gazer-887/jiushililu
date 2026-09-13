// Git 变更解析（plan16 · 源代码管理）。
//
// 放在 `shared/` 的理由：**纯逻辑、不碰 electron**，于是可以单测（CI 上跑得了）。
// 而它又是最该单测的一层 —— 解析错了界面会**静默显示错状态**（"改了"显示成"没改"），
// 既不报错也不崩，只能靠断言守住。
//
// ⚠️ 硬约束：**只解析 git 官方承诺稳定的机器可读格式**（`--porcelain` / `--name-status`）。
//    绝不解析给人看的默认输出（裸 `git status` 那种带颜色、带缩进、措辞会随版本变的）。
//    这是"不引入 simple-git 依赖"这条决策成立的前提（见 PLAN/plan16 §四）。

/** 一条变更的粗分类。字母沿用 git 惯例，界面上要另给中文说明（不假设用户懂 `??`） */
export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'other'

/** `git status --porcelain=v1` 的一行 → 一条变更 */
export interface GitChange {
  /** 工作区相对路径（与其余面板同口径） */
  path: string
  kind: GitChangeKind
  /** 暂存区状态字母（X 位），' ' = 未暂存 */
  staged: string
  /** 工作区状态字母（Y 位），' ' = 与暂存区一致 */
  unstaged: string
}

/**
 * 解析 `git status --porcelain=v1` 的输出。
 *
 * 格式（git 官方承诺稳定）：**每行 = `XY <path>`**，X = 暂存区状态、Y = 工作区状态，
 * 各占一个字符。空格表示"这一侧没变化"。
 *
 * | XY | 含义 |
 * |----|------|
 * | `??` | 未跟踪 |
 * | ` M` | 工作区改了、没暂存 |
 * | `M ` | 改了且已暂存 |
 * | `A ` | 新增且已暂存 |
 * | `D ` | 删除且已暂存 |
 * | ` D` | 工作区删了、没暂存 |
 *
 * 两个坑（都实测确认，不是猜的）：
 * 1. **重命名**（`R  old -> new`）的 path 字段是 `old -> new` 这种**带箭头**的形式，
 *    不能直接当路径用 —— 按 git 惯例取箭头**后面**那个（新路径）。
 * 2. **含空格/中文路径**不加引号（v1 格式不带 `-z` 时就是裸路径），
 *    所以**不能用 split(' ') 取字段**，必须按固定 2 字符切。
 */
export function parseGitStatus(output: string): GitChange[] {
  if (typeof output !== 'string' || output.length === 0) return []
  const out: GitChange[] = []
  for (const rawLine of output.split('\n')) {
    // 去掉结尾 \r（Windows 上 git 输出可能是 CRLF）——不去掉的话每条路径末尾都粘一个 \r
    const line = rawLine.replace(/\r$/, '')
    if (line.length < 4) continue // 最短也得是 "XY p"
    const staged = line[0]
    const unstaged = line[1]
    let path = line.slice(3)
    // 重命名 / 复制：`R  old -> new` → 取箭头后那个（新路径）
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    if (path.length === 0) continue
    out.push({ path, kind: kindOf(staged, unstaged), staged, unstaged })
  }
  return out
}

/** 由 XY 两个状态字母判定粗分类。**先看暂存区、再看工作区**（与用户直觉一致） */
function kindOf(staged: string, unstaged: string): GitChangeKind {
  if (staged === '?' && unstaged === '?') return 'untracked'
  if (staged === 'A') return 'added'
  if (staged === 'D' || unstaged === 'D') return 'deleted'
  if (staged === 'M' || unstaged === 'M') return 'modified'
  if (staged === 'R' || unstaged === 'R') return 'modified'
  return 'other'
}

/** 状态字母 → 中文说明。界面上必须给，"??" 不该指望用户自己懂 */
export const GIT_KIND_LABELS: Record<GitChangeKind, string> = {
  modified: '已修改',
  added: '已新增',
  deleted: '已删除',
  untracked: '未跟踪',
  other: '其他'
}

/** 该条是否已暂存（勾选框的初始态） */
export function isStaged(c: GitChange): boolean {
  return c.staged !== ' ' && c.staged !== '?'
}
