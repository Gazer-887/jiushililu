// 工作区文件树 —— 纯逻辑层（plan7 批 A）
//
// 抽出来的是"列目录时哪些该跳过、怎么排序、大小怎么显示"这三件判断。
// 它们与文件系统无关（只吃名字和类型），所以能单测：
// CI 无 Electron 二进制，碰 electron 的代码测不了（沿用既有的分层惯例）。

/** 目录展开时默认跳过的项（与 Agent 的 search_files 保持同一套约定） */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'dist-artifacts'])

/** 单层最多返回多少项（防止某些目录把界面卡死） */
export const MAX_ENTRIES = 500

export interface FsEntry {
  name: string
  /** 工作区相对路径，统一 `/` 分隔（跨平台一致，也与检查点清单同一口径） */
  rel: string
  kind: 'file' | 'dir'
  /** 文件字节数；目录不带 */
  size?: number
}

/** 列一层目录的结果 */
export interface FsListResult {
  ok: boolean
  /** 该层条目（已排序、已过滤） */
  entries: FsEntry[]
  /** 是否有条目被 MAX_ENTRIES 截断 */
  truncated?: boolean
  error?: string
}

/** 读文件用于预览的结果 */
export interface FsReadResult {
  ok: boolean
  rel: string
  content: string
  /** 是否因超限被截断（只给前一段）—— 明确告知，不假装读全了 */
  truncated?: boolean
  size: number
  error?: string
}

/**
 * 是否跳过该项。
 *
 * 两条规则：
 *   ① 命中跳过名单的目录（node_modules / .git / 产物目录）——
 *      它们是噪音且量极大，列出来只会淹没真正的工作文件
 *   ② **所有点开头的项**（.gitignore / .env / .vscode …）——
 *      注意这里有个真实风险：`.env` 常常含密钥，在文件树里列出来并允许预览
 *      等于把它摊在屏幕上（AGENTS.md 有"凭证不入 AI 可读路径"的红线精神）
 *
 * 但"根目录"不适用第 ② 条：工作区根下若真有点开头的文件，用户有权看到。
 * 由调用方传 rootLevel=true 区分。
 */
export function shouldSkipEntry(name: string, kind: 'file' | 'dir', rootLevel = false): boolean {
  if (kind === 'dir' && SKIP_DIRS.has(name)) return true
  if (!rootLevel && name.startsWith('.')) return true
  return false
}

/**
 * 排序：**目录在前**，同类型按名称排（中文用 localeCompare，否则按内码排会很乱）。
 * 目录在前是文件管理器的通用约定——用户找目录的频率远高于找文件。
 */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/** 人看的大小（1 KB = 1024 B；只保留一位小数，够用且不啰嗦） */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** 预览是否能给（文本判定：按扩展名白名单，避免把二进制糊到界面上） */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less', '.html', '.htm',
  '.vue', '.svelte', '.py', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.xml', '.csv', '.env',
  '.gitignore', '.editorconfig', '.log'
])

/**
 * 是否按文本预览。**没有扩展名的也给**（Makefile / LICENSE / .gitignore 这类很常见），
 * 真正的二进制有扩展名占比极高，所以这个白名单够用；误判的最坏结果是显示乱码，不影响数据。
 */
export function isTextPreviewable(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true // 无扩展名（或点开头）→ 给预览
  return TEXT_EXT.has(name.slice(dot).toLowerCase())
}
