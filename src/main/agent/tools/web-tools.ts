import type { AgentTool } from '@shared/agent'

// 网页获取工具（P1 工具层补全）：抓取一个网页并粗提纯文本。
// 边界：仅 http/https；正文上限 512KB；30s 超时；粗去标签（script/style 剔除）。

const MAX_BODY_BYTES = 512 * 1024

/** 协议白名单：file:/data:/javascript: 一律拒绝 */
export function assertHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，拒绝协议「${url.protocol}」`)
  }
  return url
}

/** 粗提纯文本：去 script/style 与标签，压缩空白 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createWebTools(): AgentTool[] {
  const fetch_url: AgentTool = {
    schema: {
      name: 'fetch_url',
      description: '抓取一个网页并返回其纯文本内容（自动去除脚本与标签，正文上限 512KB）',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 http/https 地址' }
        },
        required: ['url']
      }
    },
    async execute(args) {
      const raw = typeof args['url'] === 'string' ? args['url'] : ''
      let url: URL
      try {
        url = assertHttpUrl(raw)
      } catch (err) {
        return `错误：${err instanceof Error ? err.message : String(err)}`
      }
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(30000),
          headers: { 'User-Agent': 'jiushililu-agent/0.1' }
        })
        if (!res.ok) return `错误：HTTP ${res.status} ${res.statusText}`
        const buf = await res.arrayBuffer()
        const body = new TextDecoder('utf-8').decode(buf.slice(0, MAX_BODY_BYTES))
        const text = htmlToText(body)
        if (text.length === 0) return '（页面无可提取文本）'
        const truncated = text.length > 20000 ? `${text.slice(0, 20000)}\n（已截断，原文 ${text.length} 字符）` : text
        return truncated
      } catch (err) {
        return `错误：抓取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return [fetch_url]
}
