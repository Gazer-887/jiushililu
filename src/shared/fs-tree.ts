// 工作区文件树 —— 纯逻辑层（plan7 批 A）：跳过谁 / 怎么排序 / 大小怎么显示这三件判断都在这儿，
// 只吃名字与类型、不碰文件系统，故可单测（CI 无 Electron 二进制，碰 electron 的代码测不了）。

/** 目录展开时默认跳过的项（与 Agent 的 search_files 保持同一套约定） */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'dist-artifacts'])

/** 单层最多返回多少项（防止某些目录把界面卡死） */
export const MAX_ENTRIES = 500

export interface FsEntry {
  name: string
  /** 工作区相对路径，统一 `/` 分隔（跨平台一致，也与检查点清单同一口径） */
  rel: string
  kind: 'file' | 'dir'
  /** 目录不带 */
  size?: number
}

export interface FsListResult {
  ok: boolean
  /** 该层条目（已排序、已过滤） */
  entries: FsEntry[]
  truncated?: boolean
  error?: string
}

export interface FsReadResult {
  ok: boolean
  rel: string
  content: string
  /** 只给前一段 —— 明确告知，不假装读全了 */
  truncated?: boolean
  size: number
  /**
   * 修改时间（毫秒）—— **编辑的冲突基线**：保存时带回主进程比对，对不上说明文件
   * 在"打开之后、保存之前"被改过（Agent 或别的程序）→ **不做静默覆盖**，让用户选；
   * 缺了它，编辑就只能在"盲写"与"永远冲突"之间二选一。
   */
  mtimeMs?: number
  /**
   * **不是无损读出来的**：原文非法 UTF-8（GBK 文本 / 二进制），坏字节会被换成 U+FFFD，
   * 再编码回去 ≠ 原字节 —— 所以"读进来再整份写回去"对这类文件是**不可逆损坏**；
   * 逐处退回（会把整份文本按 UTF-8 重写）必须靠它挡住。（plan13 批 B 独立审查实测）
   */
  lossy?: boolean
  error?: string
}

/**
 * 是否跳过该项：命中跳过名单的目录（噪音且量极大），以及**所有点开头的项** —— `.env` 常含密钥，
 * 列进文件树并允许预览等于把它摊在屏幕上（AGENTS.md"凭证不入 AI 可读路径"的红线精神）；
 * 根目录不适用后者（用户有权看到隐藏文件），由调用方传 rootLevel 区分。
 */
export function shouldSkipEntry(name: string, kind: 'file' | 'dir', rootLevel = false): boolean {
  if (kind === 'dir' && SKIP_DIRS.has(name)) return true
  if (!rootLevel && name.startsWith('.')) return true
  return false
}

/**
 * 排序：**目录在前**，同类型按名称排（中文必须用 localeCompare，按内码排会很乱）。
 * 目录在前是文件管理器的通用约定 —— 用户找目录的频率远高于找文件。
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
 * 「文件树 → 输入框」拖拽携带路径用的自定义 MIME 类型。不用 `text/plain`：拖到别的落点会被当成
 * "一段文字"贴进去，而这里携带的是**工作区相对路径**；自定义类型只有我们自己认，误伤面为零。
 * ⚠️ 生产端（文件树）与消费端（输入框）必须共用这一个常量 —— 各写一份字符串会改一边静默失效。
 */
export const DRAG_PATH_MIME = 'application/x-jiushililu-path'

/** 没有扩展名的也给（Makefile / LICENSE 这类很常见）；误判最坏是乱码，不动数据 */
export function isTextPreviewable(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true // 无扩展名（或点开头）→ 给预览
  return TEXT_EXT.has(name.slice(dot).toLowerCase())
}

// ── 二进制预览（plan7 批 A3）────────────────────────────────────────────

/**
 * 图片预览的体积上限：超过就**只给元信息**。data URL 是 base64（内存约原文件 1.33 倍）
 * 且还要走一次结构化克隆，几十 MB 的图会直接卡住界面，宁可明说"图太大，用系统查看器打开"。
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * 能直接渲染的图片类型（扩展名 → MIME）。⚠️ **安全红线**：SVG 是可执行内容（能带 `<script>`），
 * 只许经 `<img src="data:...">` 渲染（img 上下文不执行脚本）；**禁止** `<object>` / `<iframe>` /
 * 内联 SVG —— 那等于把工作区里的代码执行在我们的界面里。
 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

/** 这个文件名是不是能直接渲染的图片；是就返回 MIME，否则 null */
export function imageMimeOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return IMAGE_MIME[name.slice(dot).toLowerCase()] ?? null
}

/** 读**二进制**文件用于预览的结果（图片 → data URL；其余 → 十六进制头部） */
export interface FsBinaryResult {
  ok: boolean
  rel: string
  size: number
  /** 图片才给（受 `MAX_IMAGE_BYTES` 约束） */
  dataUrl?: string
  /** 非图片二进制：前若干字节的十六进制转储 —— **降级而不是放弃** */
  hexHead?: string
  /** 超过上限：只给元信息，明说而不是假装能显示 */
  tooLarge?: boolean
  error?: string
}

/**
 * 十六进制转储（hexdump 的样子）—— 非图片二进制的降级展示：用户点开一个 `.so` / `.db` 时，
 * 「暂不支持预览」是句废话，而**看文件头**往往就能认出它是什么。
 * 纯函数（只吃 `Uint8Array`，不碰 fs），所以能单测。
 */
export function hexDump(bytes: Uint8Array, maxBytes = 256, perLine = 16): string {
  const n = Math.min(bytes.length, Math.max(0, maxBytes))
  const lines: string[] = []
  for (let off = 0; off < n; off += perLine) {
    const chunk = bytes.subarray(off, Math.min(off + perLine, n))
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0'))
    const left = hex.slice(0, 8).join(' ')
    const right = hex.slice(8).join(' ')
    // 可打印 ASCII 原样显示，其余打点 —— 右侧那栏是"肉眼认出它是什么"的关键
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(
      `${off.toString(16).padStart(8, '0')}  ${left.padEnd(23)} ${right.padEnd(23)} |${ascii}|`
    )
  }
  return lines.join('\n')
}
