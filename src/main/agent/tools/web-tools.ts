import type { AgentTool } from '@shared/agent'
import { httpFetch } from '../../providers/http-client'

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

// ── web_search（plan31 D-096，规格缺口 4）────────────────────────────
// 检索能力补齐：此前只有 fetch_url（给 URL 能读、没法搜）。
// 源选型受硬约束（不打包模型、不内置任何 API Key）⇒ 用 DuckDuckGo 的 HTML 端点（零密钥）。
// 解析做成**纯函数**（正则抽结果锚点），单测可离线打；端点将来可扩展成可配置 provider。

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/** 解码 DDG 的跳转包装：结果 href 形如 `/l/?uddg=<encodeURIComponent(真实url)>&rut=...` */
export function unwrapDuckHref(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const target = u.searchParams.get('uddg')
    // 只有带 uddg 包装的才算跳转链接；其余（直链/垃圾输入）一律**原样返回**，不做相对解析
    return target ? decodeURIComponent(target) : href
  } catch {
    return href
  }
}

/** 从 DDG HTML 端点响应里抽结果（纯函数，离线可测） */
export function parseDuckResults(html: string, max = 6): WebSearchResult[] {
  const out: WebSearchResult[] = []
  // 结果锚点：<a class="result__a" href="...">标题</a>；摘要在其后的 result__snippet 锚点
  const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippet = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippet.exec(html)) !== null) snippets.push(htmlToText(sm[1] ?? ''))
  let am: RegExpExecArray | null
  while ((am = anchor.exec(html)) !== null && out.length < max) {
    const title = htmlToText(am[2] ?? '')
    const url = unwrapDuckHref(am[1] ?? '')
    if (!title || !url) continue
    // 结果锚点与摘要按下标配对（DDG 两条一一对应；缺就给空串）
    out.push({ title, url, snippet: snippets[out.length] ?? '' })
  }
  return out
}

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q='

function renderSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) return '（无搜索结果——试试换关键词或更通用的表述）'
  const lines = results.map((r, i) => {
    const snip = r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ''
    return `${i + 1}. ${r.title}\n   ${r.url}${snip}`
  })
  return `共 ${results.length} 条结果（provider=duckduckgo，零密钥默认源）：\n${lines.join('\n')}`
}

function webSearchTool(firecrawlKey: string | null): AgentTool {
  return {
    schema: {
      name: 'web_search',
      description:
        '搜索网页并返回结果列表（标题 + 链接 + 摘要）。适合查资料/文档/报错信息；' +
        '拿到具体网址后用 fetch_url 读全文。默认源零密钥，无需配置。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          max_results: { type: 'number', description: '返回条数上限（1~10，默认 6）' }
        },
        required: ['query']
      }
    },
    async execute(args) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
      if (query.length === 0) return '错误：query 不能为空'
      const rawMax = args['max_results']
      let max = 6
      if (rawMax !== undefined && rawMax !== null) {
        const n = typeof rawMax === 'number' ? rawMax : Number(rawMax)
        if (!Number.isFinite(n) || n < 1 || n > 10) return '错误：max_results 允许 1~10'
        max = Math.floor(n)
      }
      if (firecrawlKey) {
        // Firecrawl 源（用户配置了密钥时优先）：POST v1/search，失败**回落**零密钥默认源并如实注明
        try {
          const res = await httpFetch('https://api.firecrawl.dev/v1/search', {
            method: 'POST',
            headers: { Authorization: `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: max }),
            signal: AbortSignal.timeout(30000)
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const json = await res.json()
          return renderSearchResults(parseFirecrawlResults(json, max)).replace('provider=duckduckgo', 'provider=firecrawl')
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          const fb = await searchDuck(query, max).catch((e2: unknown) => `错误：两个源都失败——Firecrawl：${reason}；默认源：${e2 instanceof Error ? e2.message : String(e2)}`)
          return typeof fb === 'string' && fb.startsWith('错误') ? fb : `（Firecrawl 失败已回落默认源：${reason}）
${fb}`
        }
      }
      try {
        return await searchDuck(query, max)
      } catch (err) {
        return `错误：搜索失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

/** DDG 零密钥默认源（Firecrawl 未配置或失败时的回落）。 */
async function searchDuck(query: string, max: number): Promise<string> {
  try {
    const res = await httpFetch(SEARCH_ENDPOINT + encodeURIComponent(query), {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'jiushililu-agent/0.1' }
    })
    if (!res.ok) return `错误：搜索源返回 HTTP ${res.status}`
    const buf = await res.arrayBuffer()
    const html = new TextDecoder('utf-8').decode(buf)
    // 反爬兜底：DDG 偶发返回人机验证页 —— 如实告知而不是当空结果
    if (/anomaly|captcha|verify/i.test(html) && parseDuckResults(html, 1).length === 0) {
      return '错误：搜索源触发了人机验证（反爬）。稍后重试，或改用 fetch_url 直接访问已知来源。'
    }
    return renderSearchResults(parseDuckResults(html, max))
  } catch (err) {
    return `错误：搜索失败——${err instanceof Error ? err.message : String(err)}`
  }
}

/** Firecrawl v1/search 响应解析（纯函数，离线可测）。data[] 里 title/description 可缺。 */
export function parseFirecrawlResults(json: unknown, max = 6): WebSearchResult[] {
  const data = (json as { data?: Array<{ title?: string; url?: string; description?: string; title_?: string }> })?.data
  if (!Array.isArray(data)) return []
  const out: WebSearchResult[] = []
  for (const d of data) {
    if (out.length >= max) break
    const url = typeof d.url === 'string' ? d.url : ''
    if (!url) continue
    out.push({
      title: (d.title ?? url).slice(0, 200),
      url,
      snippet: (d.description ?? '').slice(0, 300)
    })
  }
  return out
}

export interface WebSearchDeps {
  /** Firecrawl 密钥（safeStorage 解密后由组合根传入）；有 = 用 Firecrawl，无 = 零密钥默认源 DDG */
  firecrawlApiKey?: string | null
}

export function createWebTools(deps?: WebSearchDeps): AgentTool[] {
  const firecrawlKey = typeof deps?.firecrawlApiKey === 'string' && deps.firecrawlApiKey.length > 0 ? deps.firecrawlApiKey : null
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
        // ⚠️ 传 `toString()` 而不是 `URL` 对象：`net.fetch` 的入参只认 string / Request。
        //    协议白名单已在 `assertHttpUrl` 里验过，这里换回字符串不会重新打开 SSRF 的口子。
        const res = await httpFetch(url.toString(), {
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

  return [fetch_url, webSearchTool(firecrawlKey)]
}
