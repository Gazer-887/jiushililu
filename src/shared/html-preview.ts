/**
 * HTML 沙箱预览的协议、策略与路径换算（**纯逻辑**，主/渲染共用）—— 不 import electron，可单测。
 *
 * ⚠️ 不用 `srcdoc` / `blob:` / `data:`：三者都算"本地 scheme"，子文档继承父页策略容器 → 应用
 * 自身的 `style-src 'self'` 把预览里的内联样式全砍掉（实测桩页背景全白）；换真实 scheme 后只有本
 * 文件的响应头 CSP 生效。两道锁独立：iframe `sandbox=""` + 响应头 CSP。边界：只读工作区内文件、
 * 只放行网页/样式/图片/字体后缀（**脚本一律不在白名单**），要全保真请用系统浏览器打开。
 */

/** 预览专用协议 */
export const PREVIEW_SCHEME = 'jsl-preview'

/** 协议里的固定主机名（标准 scheme 必须有 host，URL 才解析得正常） */
export const PREVIEW_HOST = 'doc'

/**
 * 预览文档的策略（作为**响应头**下发，比 meta 更硬 —— 文档还没解析就已经生效）。
 * `default-src 'none'` 断网络、`script-src 'none'` 断脚本；`style-src 'unsafe-inline'` 是**唯一**
 * 放宽项（真实网页的样式全是内联，不放等于预览没样式）；`sandbox` 是第二道锁，属性被误删也挡着。
 */
export const PREVIEW_CSP = [
  'sandbox',
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'"
].join('; ')

/** 主窗口 CSP 里要放行的 frame-src（与 `config/electron.vite.config.ts` 保持一致，单测钉住） */
export const PREVIEW_FRAME_SRC = `'self' ${PREVIEW_SCHEME}:`

/** 只有这些后缀值得按网页渲染（`.htm` / `.xhtml` 也算） */
export function isHtmlFile(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name)
}

/**
 * 预览允许取的后缀 → MIME：**故意不含 js / mjs / json 及任何可被 `<script>` 引用的类型** ——
 * 预览不执行工作区代码是本项目红线，白名单是最省事的落实方式。
 */
const PREVIEW_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg'
}

/** 白名单外的后缀返回 null（调用方一律当拒绝处理） */
export function previewContentType(rel: string): string | null {
  const dot = rel.lastIndexOf('.')
  if (dot < 0) return null
  const ext = rel.slice(dot + 1).toLowerCase()
  return PREVIEW_TYPES[ext] ?? null
}

/**
 * 工作区相对路径 → 预览 URL：**逐段** `encodeURIComponent`，目录层级因此保留（相对路径的图片才
 * 解析得到），中文与空格也正确转义。不可预览（绝对路径 / 盘符 / 越界段）返回 **null** —— 调用方
 * 据此**不给**「渲染」开关，而不是给一个注定 404 的白框。
 */
export function workspaceRelToPreviewUrl(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null
  // 反斜杠：Windows 分隔符一律不接受（rel 的约定是正斜杠，混进来就会拼错路径）
  if (rel.includes('\\')) return null
  // 绝对路径 / 盘符 / UNC：预览只服务工作区内的相对路径
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}/${parts.map(encodeURIComponent).join('/')}`
}

/**
 * 预览 URL 的 pathname → 工作区相对路径。这是**不可信输入**（DOM 里谁都能拼一个 URL），
 * 所以先解码再逐段校验，`..` / `.` / 空段 / 反斜杠 / 盘符一律拒。真正落到"文件系统哪一格"由
 * 主进程再走一遍 `resolveInsideWorkspace`（含符号链接防逃逸）—— 两层都要有，任一层单独都不够。
 */
export function previewUrlToWorkspaceRel(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null
  const raw = pathname.slice(1)
  if (raw.length === 0) return null
  let parts: string[]
  try {
    parts = raw.split('/').map((p) => decodeURIComponent(p))
  } catch {
    // 畸形百分号转义（`%zz`）会抛 —— 直接拒，不要放它往下走
    return null
  }
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  if (parts.some((p) => p.includes('\\') || p.includes('/') || p.includes('\0'))) return null
  const rel = parts.join('/')
  if (/^[a-zA-Z]:/.test(rel)) return null
  return rel
}
