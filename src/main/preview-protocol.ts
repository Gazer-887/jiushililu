/**
 * HTML 预览协议（主进程侧）。
 *
 * 路径"长什么样"由 `@shared/html-preview` 定（纯逻辑、可单测）；这里只做两件主进程才能做的事：
 * ① app ready **之前**把协议注册成 standard + secure（顺序错了协议就是个死链）；
 * ② 从**工作区**读文件，配上断网/断脚本的响应头 —— 读盘这条线只有主进程一条，边界也就只有一处
 *    （渲染进程不许 import electron，更不许自己读文件系统）。
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
import { resolveInsideWorkspace } from './agent/guard'

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
        corsEnabled: false
      }
    }
  ])
}

/** 装上真正的处理器：`jsl-preview://doc/<工作区相对路径>` */
export function installPreviewProtocol(getRoot: () => string): void {
  protocol.handle(PREVIEW_SCHEME, async (req) => {
    const url = new URL(req.url)
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
