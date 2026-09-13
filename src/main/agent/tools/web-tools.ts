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
  if (isBlockedHost(url.hostname)) {
    throw new Error(`拒绝访问内网/回环地址「${url.hostname}」`)
  }
  return url
}

/** SSRF 防护：回环 / 私网 / 链路本地 / 保留地址一律拒绝 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
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
          // 不跟随重定向：避免"合法起点 → 302 到内网/元数据服务"的 SSRF 绕过
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
          headers: { 'User-Agent': 'jiushililu-agent/0.1' }
        })
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location') ?? '（未给出位置）'
          return `错误：目标返回重定向 ${res.status} → ${loc}。出于安全策略不自动跟随，请直接请求最终地址。`
        }
        if (!res.ok) return `错误：HTTP ${res.status} ${res.statusText}`
        const buf = await res.arrayBuffer()
        const body = new TextDecoder('utf-8').decode(buf.slice(0, MAX_BODY_BYTES))
        const text = htmlToText(body)
        if (text.length === 0) return '（页面无可提取文本）'
        // plan8 R9.1：**不再在这里砍一刀**。以前是"前 20000 字符"，而网页正文常在后半段（作者、结论、数据表）——
        // 现在原样交回，形状只在 loop.ts 一处决定；这里只留"请求体太大"的硬上限（512KB，防把整部说明书读进内存）。
        if (buf.byteLength > MAX_BODY_BYTES) {
          return `${text}\n（页面超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB，只取了前一部分）`
        }
        return text
      } catch (err) {
        return `错误：抓取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return [fetch_url]
}
