/**
 * HTML 沙箱预览 —— 协议、策略与路径换算（**纯逻辑**，主/渲染共用）。
 *
 * ## 为什么要搞一条自定义协议，而不是直接 `srcdoc`
 *
 * 这是**实测**出来的（不是推测）：`srcdoc` / `blob:` / `data:` 三种写法都属于
 * 「本地 scheme」，**子文档会继承父页的策略容器** —— 于是应用自身的
 * `style-src 'self'` 会把预览里所有内联样式一起砍掉：
 * 桩页把背景刷成品红，三种写法采出来**全是白**，控制台一排
 * `Refused to apply inline style ... "style-src 'self'"`。
 * 也就是说：**预览会渲染，但渲染成一片没样式的骨架** —— 对一个预览功能等于没做。
 *
 * 换成**真实 scheme**（本协议）之后，子文档拿到的是**全新的策略容器**，
 * 只有我们自己发的响应头 CSP 生效，实测同一桩页：品红 45288/45288 像素全中，
 * 脚本一行没跑（连**不带** `sandbox` 属性的那一帧也没跑 —— 响应头里的 `sandbox` 兜住了）。
 *
 * 两条锁互相独立，缺一不可：
 *   ① iframe 的 `sandbox=""`（空值）—— 不执行脚本、不透明源（读不到父页，父页也读不到它）
 *   ② 本文件这个响应头 CSP —— `script-src 'none'` 断脚本、`default-src 'none'` 断网络
 *
 * ## 边界
 *
 * 预览**只读工作区内**的文件（复用 Agent 那套 `resolveInsideWorkspace`），
 * 且只放行「网页 / 样式 / 图片 / 字体」这几类后缀 —— **脚本一律不在白名单里**。
 * 工作区的 JS 永远不会被执行：预览要的是"长什么样"，不是"跑起来"。
 * 想要全保真（含脚本与外链资源）请用系统浏览器打开那个文件 —— 那时代码跑在浏览器沙箱里，
 * 不在应用里。
 */

/** 预览专用协议 */
export const PREVIEW_SCHEME = 'jsl-preview'

/** 协议里的固定主机名（标准 scheme 必须有 host，URL 才解析得正常） */
export const PREVIEW_HOST = 'doc'

/**
 * 预览文档的策略（作为**响应头**下发，比 meta 更硬 —— 文档还没解析就已经生效）。
 *
 * - `sandbox`                ：与 iframe 的 `sandbox=""` 等价，作为第二道锁（属性被误删也还挡着）
 * - `default-src 'none'`     ：不发任何网络请求（外链图片/字体/CDN 全部拦掉）
 * - `script-src 'none'`      ：不执行任何脚本（连内联也不给）
 * - `style-src 'unsafe-inline' 'self'`：**唯一**放宽的一项 —— 真实网页的样式全是内联的，
 *   不放就等于预览没样式；'self' 额外允许同目录的 `.css`
 * - `img-src 'self' data: blob:`：允许同目录图片，于是相对路径的本地图片能显示
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
 * 预览允许取的后缀 → MIME。
 * **故意不含 js / mjs / json / 任何可执行或可被 `<script>` 引用的类型** ——
 * 预览不执行工作区代码，这是本项目红线，白名单是最省事的落实方式。
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
 * 工作区相对路径 → 预览 URL。
 *
 * 逐段 `encodeURIComponent`：这样目录层级被保留（相对路径的图片才解析得到，
 * 例如 `页面/首页.html` 里的 `../图/logo.png`），中文与空格也被正确转义。
 * 目录结构被主进程按同样规则还原，两边是一份约定。
 *
 * 不可预览（绝对路径 / 盘符 / 含越界段）时返回 **null** —— 调用方据此**不给**「渲染」开关，
 * 而不是给一个注定 404 的白框。
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
 * 预览 URL 的 pathname → 工作区相对路径；不合法返回 null。
 *
 * 这是**不可信输入**（DOM 里谁都能拼一个 URL 出来），所以：
 * 先解码再逐段校验，`..` / `.` / 空段 / 反斜杠 / 盘符一律拒。
 * 真正落到"文件系统哪一格"由主进程再走一遍 `resolveInsideWorkspace`（含符号链接防逃逸），
 * 这里只做**语法层**的收口 —— 两层都要有，任一层单独都不够。
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
