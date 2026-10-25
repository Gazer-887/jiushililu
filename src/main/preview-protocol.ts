/**
 * 对话内预览协议（主进程侧）—— `jsl-preview://` 的**唯一**处理器。
 *
 * ⚠️ 同一 scheme 只能装一个 `protocol.handle`：旧 HTML 预览（doc/mem）与新资产预览（asset）
 *    曾各装一个，真实 Electron 在第二个安装处抛 `Failed to register protocol: jsl-preview`，
 *    且位于主窗口创建之前 ⇒ 产品起不来（Spec R1）。**修法：一个 handler 按 host 集中分发。**
 *
 * 路径"长什么样"由 `@shared/html-preview`（doc/mem）与 `@shared/conversation-preview`（asset）
 * 定（纯逻辑、可单测）；这里只做主进程才能做的事：app ready **之前**注册 standard + secure，
 * 从**工作区 / 资产库**读文件，配上断网/断脚本的响应头。读盘这条线只有主进程一条。
 */
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import {
  PREVIEW_CSP,
  PREVIEW_HOST,
  PREVIEW_SCHEME,
  previewContentType,
  previewUrlToWorkspaceRel
} from '@shared/html-preview'
import { MEM_PREVIEW_HOST, isMemPreviewToken } from '@shared/office-preview'
import { memPreviews } from './office-preview'
import { resolveInsideWorkspace } from './agent/guard'
import { ASSET_PREVIEW_HOST, assetUrlToHandleId, parseSingleRange } from '@shared/conversation-preview'
import { openSync, fstatSync, closeSync, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { MAX_ASSET_BYTES } from '@shared/conversation-preview'
import { previewFileSource, fileSourceStamp, type PreviewHandle } from './preview-gateway'

/** 句柄表：handleId → 字节源。Gateway 签发，协议层消费。装配层持有这份表。 */
export type HandleTable = Map<string, PreviewHandle>

/**
 * ⚠️ 必须在 `app.whenReady()` **之前**调用：迟了协议拿不到 standard/secure 语义，
 * URL 解析退化成不透明路径（相对路径的图片也跟着解析不了）。
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        // 预览页不需要 fetch / 跨源 —— 能力越小越好，干脆不给
        supportFetchAPI: false,
        corsEnabled: false,
        // 大媒体要按 Range 供给，必须允许流式响应（asset 分支需要）
        stream: true
      }
    }
  ])
}

/** 装上真正的处理器：`jsl-preview://doc/<工作区相对路径>` + `jsl-preview://mem/<token>` + `jsl-preview://asset/<handleId>` */
export function installPreviewProtocol(getRoot: () => string, handles: HandleTable): void {
  protocol.handle(PREVIEW_SCHEME, async (req) => {
    const url = new URL(req.url)

    // ── host=asset：对话内资产预览（plan74），句柄 → 字节（含 Range 流式）────────────────
    if (url.host === ASSET_PREVIEW_HOST) return serveAsset(req, url, handles)

    // ── 内存预览（docx/xlsx 解析产物）：host=mem，token 查表，不碰文件系统 ──
    // ⚠️ token 必须形状校验 + 不可猜（crypto.randomBytes）：DOM 里的 URL 谁都看得见，
    //    能猜到才能读到；形状不对直接 400，查无此 token 一律 404（不区分"没注册过"和"过期"）。
    if (url.host === MEM_PREVIEW_HOST) {
      const token = url.pathname.slice(1)
      if (!isMemPreviewToken(token)) return new Response(null, { status: 400 })
      const html = memPreviews.get(token)
      if (html === null) return new Response(null, { status: 404 })
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // 与文档预览同一套锁：断脚本、断网络 —— 内容来自用户文件，一个字都不许执行
          'content-security-policy': PREVIEW_CSP,
          'cache-control': 'no-store'
        }
      })
    }

    if (url.host !== PREVIEW_HOST) return new Response(null, { status: 404 })

    // ① 语法层：畸形 / 越界 / 编码绕过的写法在这里就被拒
    const rel = previewUrlToWorkspaceRel(url.pathname)
    if (rel === null) return new Response(null, { status: 400 })

    // ② 类型白名单：脚本与其它可执行类型**根本不在名单里**
    const type = previewContentType(rel)
    if (type === null) return new Response(null, { status: 403 })

    // ③ 真实边界：复用 Agent 那一套（含符号链接防逃逸），边界规则只该有一份
    const abs = resolveInsideWorkspace(getRoot(), rel)
    if (abs === null) return new Response(null, { status: 403 })

    try {
      const body = await readFile(abs)
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': type,
          // 响应头比 meta 更硬：文档还没开始解析就已经生效
          'content-security-policy': PREVIEW_CSP,
          // 保存后要看到新内容，别让引擎拿缓存糊弄人
          'cache-control': 'no-store'
        }
      })
    } catch {
      // 读不到（不存在 / 无权限）—— 404 而不是抛异常，免得把整个协议处理器带崩
      return new Response(null, { status: 404 })
    }
  })
}

/** asset 分支：句柄 → 字节（含 Range 流式）。句柄表来自 Gateway，权限裁定不在此重做。 */
function serveAsset(req: Request, url: URL, handles: HandleTable): Response {
  // 句柄身份解析复用共享层（畸形 → null → 400）
  const handleId = assetUrlToHandleId(url.pathname)
  if (handleId === null) return new Response(null, { status: 400 })
  const handle = handles.get(handleId)
  if (!handle) return new Response(null, { status: 404 })
  if (handle.expiresAt !== undefined && handle.expiresAt <= Date.now()) {
    for (const token of handle.memTokens ?? []) memPreviews.release(token)
    for (const stream of handle.streams ?? []) stream.destroy()
    handles.delete(handleId)
    return new Response(null, { status: 404 })
  }

  const commonHeaders: Record<string, string> = {
    'content-type': handle.mime,
    // 预览内容不缓存：改了要能看到新的（产物刷新同理）
    'cache-control': 'no-store',
    // 断网：预览资源只来自本地资产库，不接受远程
    'content-security-policy': handle.mime === 'text/html' || handle.mime === 'application/xhtml+xml'
      ? PREVIEW_CSP
      : "default-src 'none'; media-src 'self'; img-src 'self' data: blob:"
  }

  // stream 类（媒体/PDF）：支持 Range，按需供给，不一次读全
  if (handle.kind === 'stream') {
    let fd = -1
    try {
      const source = previewFileSource(handle)
      fd = openSync(source.path, 'r')
      const st = fstatSync(fd)
      const size = st.size
      if (!st.isFile() || size !== handle.bytes || size > MAX_ASSET_BYTES) throw new Error('预览源已变化')
      if (handle.sourceStamp && fileSourceStamp(st) !== handle.sourceStamp) throw new Error('产物已变化')
      const rangeHeader = req.headers.get('range')
      const range = parseSingleRange(rangeHeader, size)
      if (rangeHeader !== null && range === null) {
        // 带了 Range 却解析不出（越界/多段）→ 416，不静默回全量
        closeSync(fd); fd = -1
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      const headers = { ...commonHeaders, 'accept-ranges': 'bytes', 'content-length': String(size ? end - start + 1 : 0),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) }
      if (size === 0 || req.method === 'HEAD') {
        closeSync(fd); fd = -1
        return new Response(null, { status: range ? 206 : 200, headers })
      }
      // Range和无Range均按64KiB带背压供给；不先整份readFile再slice。
      const stream = createReadStream(source.path, { fd, start, end, highWaterMark: 64 * 1024, autoClose: true })
      fd = -1 // 文件流从此负责关闭描述符。
      ;(handle.streams ??= new Set()).add(stream)
      stream.once('close', () => handle.streams?.delete(stream))
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
    } catch {
      if (fd >= 0) { try { closeSync(fd) } catch { /* 失败已拒绝 */ } }
      return new Response(null, { status: 404 })
    }
  }

  // bytes 类（图片/文本/Office 解析产物）：整份
  if (handle.kind === 'bytes' && handle.buf) {
    return new Response(new Uint8Array(handle.buf), {
      status: 200,
      headers: { ...commonHeaders, 'content-length': String(handle.buf.length) }
    })
  }

  return new Response(null, { status: 404 })
}
