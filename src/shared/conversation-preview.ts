// 对话内文件预览的共享合同（plan74 执行补充 4.1 / 4.2，唯一真源）。
//
// 为什么单独一个文件：本地预览引用、来源身份、预览能力这些谓词**主进程与渲染层都要用**，
// 且单测要能 import 真实实现（不复制成测试副本）。放在 shared 才能两端共用一份。
//
// 两条铁律贯穿本文件：
//  ① 历史快照用并列字段 `LocalFileRef` 承载，**不扩 ContentPart** —— parts 是模型出境内容，
//     本地文件（PDF/音频/Office）不该变成模型能理解的块；图片/视频的 localFiles 与 parts 引用同一资产。
//  ② 所有数字（50MiB / 1GiB）按 D-232 钉死，单测逐个断言，改动必须同步改测试。

/** 单附件快照上限（D-232）：52428800 字节。图片/视频模型出站限额（5/20MiB）不因此扩大。 */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024

/** 持久附件总预算（D-232）：1GiB。老超限存量保留，超额拒接新附件，不自动淘汰历史。 */
export const MAX_TOTAL_ASSET_BYTES = 1024 * 1024 * 1024

/**
 * 引用来源的三种身份（执行补充 4.2 + 第八区）：
 * - `history`  已发消息的不可变快照：读 attachments 库里的发送时副本，原文件变了也不影响。
 * - `artifact` Agent 产物：读所属会话原工作区的**当前**文件，并标注版本语义。
 * - `draft`    发送前草稿：工作区外显式导入的文件已落受限副本，持有 draftId 作用域。
 */
export type PreviewSourceKind = 'history' | 'artifact' | 'draft'

/** 预览能力位：Gateway 据此告诉渲染层能怎么呈现，不靠猜扩展名。 */
export interface PreviewCapabilities {
  /** 可作图片呈现（缩略图/放大） */
  image?: boolean
  /** 可作文本/代码/Markdown 呈现（带截断标注） */
  text?: boolean
  /** 可作静态 HTML 呈现（断脚本断网） */
  html?: boolean
  /** 可作 PDF 呈现（pdfjs 翻页/缩放） */
  pdf?: boolean
  /** 可作媒体播放（MP4/音频，Range/seek） */
  media?: boolean
  /** 可作 Office 静态解析（docx/xlsx） */
  office?: boolean
}

/**
 * 一条本地文件引用（`ChatMessage.localFiles` 的元素）。
 * 与 `ImageRef/VideoRef`（在 parts 里、要出站）物理分离：这里只描述"本地怎么看"。
 */
export interface LocalFileRef {
  /** 资产身份：attachments 库里的受限文件名。跨会话不可猜，读它才拿得到字节。 */
  assetId: string
  /** 展示名（原文件名）。 */
  name: string
  /** MIME 或格式标识（如 application/pdf、audio/mpeg）。 */
  mime: string
  /** 原文件字节数（呈现与预检用）。 */
  bytes: number
  /** 内容指纹（sha256 前 16  hex）：版本核对用，artifact 变更时比对。 */
  digest?: string
  /** 来源身份：history=发送时快照，artifact=当前文件，draft=发送前草稿。 */
  source: PreviewSourceKind
  /** 发送前由宿主签发的窗口绑定草稿能力；历史存档不保留。 */
  draftId?: string
  /** artifact 专用：所属工作区相对路径（ Gateway 据此解析当前文件）。 */
  workspaceRel?: string
  /** 该文件是否在工作区外（拖入的系统文件）：影响界面标记。 */
  outside?: boolean
}

/** 资产文件名形状：与 attachments 库一致——日期时间-序号-随机hex。只认这一种，防路径穿越。 */
export const ASSET_ID_RE = /^[0-9]{8}T[0-9]{6}-[0-9]{1,3}-[0-9a-f]{6}\.[A-Za-z0-9]{1,8}$/

/** 资产身份合法性校验（Gateway 与单测共用，读 assetId 前必过）。 */
export function isSafeAssetId(id: string): boolean {
  return ASSET_ID_RE.test(id)
}

/** 本地预览支持的格式族（供能力判定与降级提示）。 */
export type PreviewFormat =
  | 'image'
  | 'text'
  | 'code'
  | 'markdown'
  | 'html'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'docx'
  | 'xlsx'
  | 'unknown'

// ── 资产预览协议（Gateway 句柄 → 渲染层 URL）────────────────────────────

/** 资产预览协议：复用 jsl-preview scheme，host=asset（与 HTML 预览的 doc/mem 并列同族）。 */
export const ASSET_PREVIEW_SCHEME = 'jsl-preview'
export const ASSET_PREVIEW_HOST = 'asset'

/** 句柄 → 预览 URL。handleId 由 Gateway 签发（不可猜），这里只拼 URL。 */
export function assetPreviewUrl(handleId: string): string {
  return `${ASSET_PREVIEW_SCHEME}://${ASSET_PREVIEW_HOST}/${encodeURIComponent(handleId)}`
}

/** 预览 URL → handleId。畸形返回 null（协议处理器据此 400）。 */
export function assetUrlToHandleId(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null
  const raw = pathname.slice(1)
  if (raw.length === 0 || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * 解析 Range 头为单段 [start, end]（含端点）。非法 / 多段 / 越界返回 null。
 * 纯逻辑、主/渲染共用，单测直接喂字符串。越界由调用方转 416，不静默回全量。
 */
export function parseSingleRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!m) return null
  const [, s, e] = m
  // 两端都空（bytes=-）非法；含逗号的多段上面正则天然不匹配
  if (s === '' && e === '') return null
  let start: number
  let end: number
  if (s === '') {
    // 后缀范围：bytes=-N（最后 N 字节）
    const n = Number(e)
    if (!Number.isInteger(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(s)
    end = e === '' ? size - 1 : Number(e)
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  }
  // 守界：start 在 [0, size)，end ≥ start，end 不越界
  if (start < 0 || start >= size) return null
  if (end < start) return null
  if (end >= size) end = size - 1
  return { start, end }
}

/**
 * 按 MIME 判预览能力（纯逻辑，Gateway 与渲染层共用）。
 * ⚠️ 不靠扩展名：MIME 才是真相。未知格式明确降级，不假装能预览。
 */
export function capabilitiesForMime(mime: string): PreviewCapabilities {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return { image: true }
  if (m.startsWith('video/')) return { media: true }
  if (m.startsWith('audio/')) return { media: true }
  if (m === 'application/pdf') return { pdf: true }
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { office: true }
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return { office: true }
  if (m === 'application/vnd.ms-excel') return { office: true }
  if (m === 'text/html' || m === 'application/xhtml+xml') return { html: true }
  if (m === 'text/markdown') return { text: true }
  if (m.startsWith('text/')) return { text: true }
  if (m === 'application/json' || m === 'application/xml') return { text: true }
  return {}
}

/** 能力 → 人类可读的格式族（降级提示用）。audio/video 需按 MIME 前缀区分，能力位不够。 */
export function formatOfCapabilities(caps: PreviewCapabilities, mime: string): PreviewFormat {
  const m = mime.toLowerCase()
  if (caps.image) return 'image'
  if (caps.pdf) return 'pdf'
  if (caps.media) return m.startsWith('audio/') ? 'audio' : 'video'
  if (caps.office) return m.includes('spreadsheet') ? 'xlsx' : 'docx'
  if (caps.html) return 'html'
  if (caps.text) return 'text'
  return 'unknown'
}

/**
 * 按扩展名探测可本地预览的 MIME（摄取前用）。只认本阶段支持的格式族，
 * 认不出返回 null（调用方据此拒，不硬猜）。⚠️ 仅用于「这个文件值不值得摄取」的预判，
 * 真正的能力判定仍以 capabilitiesForMime 为准（那里不靠扩展名）。
 */
export function previewMimeOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  const TABLE: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    log: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html'
  }
  return TABLE[ext] ?? null
}

/**
 * 未知/PPTX 等明确降级时的提示文案（产品口径：不把系统打开冒充内嵌保真）。
 * 返回 null 表示可预览，无需降级提示。
 */
export function degradeReason(mime: string): string | null {
  const caps = capabilitiesForMime(mime)
  const fmt = formatOfCapabilities(caps, mime)
  if (fmt === 'unknown') return '该格式暂不支持内嵌预览，可选择用系统程序打开'
  return null
}
