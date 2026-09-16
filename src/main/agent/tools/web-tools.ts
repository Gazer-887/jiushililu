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

/** SSRF 防护：回环 / 私网 / 链路本地 / 保留地址一律拒绝
 *  ⚠️ 边界（已知不变差）：只看 hostname **字面量**，不做 DNS 解析 —— rebinding（域名解析到内网 IP）
 *  挡不住；挡的是字面量与可归一形态。`new URL` 会把 `2130706433`/`0x7f…` 归一成点分十进制，
 *  但 IPv6 映射/NAT64 必须在这里手工展开（安全审查实测 `[::ffff:7f00:1]` 能打到回环）。 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain') || host.endsWith('.home.arpa')) return true
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }
  const embedded = embeddedIpv4InIpv6(host)
  if (embedded) return isBlockedHost(embedded)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  return false
}

/** IPv6 里内嵌的 IPv4：**仅** `::ffff:x[:y]`（映射）与 `64:ff9b::x[:y]`（NAT64）两种前缀，
 *  且必须锚定地址头部 —— `2001:db8::ffff:1` 是合法全局单播，中段出现 ::ffff: 不算（影响面审查实测过杀）
 *  —— 命中返回点分十进制串，否则 null */
function embeddedIpv4InIpv6(host: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/i.exec(host)
  if (!m) return null
  const hi = parseInt(m[1] ?? '0', 16)
  const lo = parseInt(m[2] ?? '0', 16)
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
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

// Firecrawl 熔断（plan32）：密钥源失败（含额度耗尽 402/429）后冷却 10 分钟直接走默认源，
// 避免额度耗尽后每次搜索都要先等一次失败。成功即复位。模块级状态 —— 进程内共享，重启即清。
const FIRECRAWL_COOLDOWN_MS = 10 * 60_000
let firecrawlCooldownUntil = 0

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
      if (firecrawlKey && Date.now() >= firecrawlCooldownUntil) {
        // Firecrawl 源（用户配置了密钥时优先）：POST v1/search，失败**回落**零密钥默认源并如实注明。
        // 免费版额度是真实约束（2026-09-16 用户点破"不能作为唯一依赖"）：
        // 失败后熔断 10 分钟走 DDG —— 额度耗尽（402/429）时不必每次都先等它失败再回落。
        try {
          const res = await httpFetch('https://api.firecrawl.dev/v1/search', {
            method: 'POST',
            headers: { Authorization: `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: max }),
            signal: AbortSignal.timeout(30000)
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const json = await res.json()
          firecrawlCooldownUntil = 0
          return renderSearchResults(parseFirecrawlResults(json, max)).replace('provider=duckduckgo', 'provider=firecrawl')
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          firecrawlCooldownUntil = Date.now() + FIRECRAWL_COOLDOWN_MS
          const fb = await searchDuck(query, max).catch((e2: unknown) => `错误：两个源都失败——Firecrawl：${reason}；默认源：${e2 instanceof Error ? e2.message : String(e2)}`)
          return typeof fb === 'string' && fb.startsWith('错误') ? fb : `（Firecrawl 失败已回落默认源：${reason}；接下来 10 分钟直接用默认源）
${fb}`
        }
      } else if (firecrawlKey && Date.now() < firecrawlCooldownUntil) {
        // 熔断期内：不碰 Firecrawl，直接 DDG（首行注明，让模型知道此刻结果来自默认源）
        const fb = await searchDuck(query, max)
        return fb.startsWith('错误') ? fb : `（Firecrawl 冷却中，本次走默认源）\n${fb}`
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

/** 站点错误页签名（plan38 S2）：HTTP 200 但内容是错误提示 —— "假成功"比报错坏，
 *  模型会拿着一页 UI 文本继续胡说。判定在**提取后的正文**上做（⚠️ 不在原始 HTML 上 ——
 *  SPA 壳的 script/属性里出现这些词很常见，会误杀），且要求「host 命中」或「两句共现」，宁漏不错杀。 */
const ERROR_PAGE_SIGNATURES: { id: string; needles: string[]; hint: string; hostPattern?: RegExp }[] = [
  {
    id: '微信文章不可访问',
    needles: ['参数错误', '该内容已被发布者删除', '此内容因违规无法查看', '此账号已迁移'],
    hostPattern: /(^|\.)weixin\.qq\.com$/i,
    hint: '微信文章链接被截断（查询参数很长）常触发此页；请核对完整链接重试，或改用 browser_navigate 打开后用 browser_read_page 读取'
  }
]
const ERROR_PAGE_MAX_TEXT_CHARS = 2000

/** 命中返回指路文案，未命中返回 null */
export function detectErrorPage(finalUrl: string, text: string): string | null {
  if (text.length > ERROR_PAGE_MAX_TEXT_CHARS) return null
  let host = ''
  try {
    host = new URL(finalUrl).host
  } catch {
    /* 拿不到 host 就只走两句共现档 */
  }
  for (const sig of ERROR_PAGE_SIGNATURES) {
    const hits = sig.needles.filter((n) => text.includes(n)).length
    if (hits === 0) continue
    if ((sig.hostPattern ? sig.hostPattern.test(host) : true) || hits >= 2) {
      return `错误：页面实为「${sig.id}」提示页，不是文章内容。${sig.hint}`
    }
  }
  return null
}

/** 受控跟随重定向上限（plan38 S1） */
const MAX_REDIRECT_HOPS = 3

type FollowedFetch = { res: Response; finalUrl: string; hops: number } | { err: string }

/**
 * 手动逐跳跟随 3xx：每一跳都重新过 `assertHttpUrl`（协议白名单 + SSRF 网）——
 * 自动跟随（redirect:'follow'）会把"合法起点 → 302 到内网"的中间跳藏进栈里，逐跳校验才堵得住。
 * 两条硬约束（安全审查）：**https 起点不许被跳成 http**（降级=明文进上下文）；
 * 报错分流：策略拒绝 / 协议降级 / 无跳转地址 / 超跳数 / 超时 / 网络失败，各说各话。
 */
async function fetchFollowingRedirects(raw: string, init: RequestInit): Promise<FollowedFetch> {
  let url = raw
  let startProto = ''
  for (let hop = 0; ; hop++) {
    let parsed: URL
    try {
      parsed = assertHttpUrl(url)
    } catch (err) {
      // 分流：`new URL` 抛 TypeError = 地址本身不成形；我们的 assert 抛 Error = 策略拒绝。两者出路不同
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof TypeError) return { err: `错误：URL 格式无法解析，需要完整的 http/https 地址：${url.slice(0, 120)}` }
      const via = hop > 0 ? `（第 ${hop} 跳跳转后）` : ''
      return { err: `错误：目标地址被安全策略拒绝——${msg}${via}` }
    }
    if (hop === 0) startProto = parsed.protocol
    let res: Response
    try {
      res = await httpFetch(parsed.toString(), { ...init, redirect: 'manual' })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { err: `错误：抓取超时（30s 总预算耗尽，已跟随 ${hop} 跳）` }
      }
      return { err: `错误：抓取失败——${err instanceof Error ? err.message : String(err)}` }
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { err: `错误：目标返回 ${res.status} 但未给出跳转地址` }
      if (hop >= MAX_REDIRECT_HOPS) return { err: `错误：重定向超过 ${MAX_REDIRECT_HOPS} 跳上限，停在 ${parsed.toString().slice(0, 200)}` }
      let next: URL
      try {
        next = new URL(loc, parsed)
      } catch {
        return { err: `错误：${res.status} 跳转地址无法解析（Location: ${loc.slice(0, 120)}）` }
      }
      if (startProto === 'https:' && next.protocol === 'http:') {
        return { err: `错误：第 ${hop + 1} 跳试图把 https 降级为 http（拒绝，明文传输不安全）。如确需该地址，请显式请求：${next.toString().slice(0, 200)}` }
      }
      url = next.toString()
      continue
    }
    return { res, finalUrl: parsed.toString(), hops: hop }
  }
}

export function createWebTools(deps?: WebSearchDeps): AgentTool[] {
  const firecrawlKey = typeof deps?.firecrawlApiKey === 'string' && deps.firecrawlApiKey.length > 0 ? deps.firecrawlApiKey : null
  const fetch_url: AgentTool = {
    schema: {
      name: 'fetch_url',
      description: '抓取一个网页并返回其纯文本内容（自动去除脚本与标签，正文上限 512KB；同策略内自动跟随重定向 ≤3 跳）',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 http/https 地址' }
        },
        required: ['url']
      }
    },
    async execute(args) {
      const raw = typeof args['url'] === 'string' ? args['url'].trim() : ''
      if (!raw) return '错误：url 不能为空'
      const followed = await fetchFollowingRedirects(raw, {
        signal: AbortSignal.timeout(30000),
        headers: { 'User-Agent': 'jiushililu-agent/0.1' }
      })
      if ('err' in followed) return followed.err
      const { res, finalUrl, hops } = followed
      if (!res.ok) return `错误：HTTP ${res.status} ${res.statusText}`
      let buf: ArrayBuffer
      try {
        buf = await res.arrayBuffer()
      } catch (err) {
        return `错误：读取响应体失败——${err instanceof Error ? err.message : String(err)}`
      }
      const body = new TextDecoder('utf-8').decode(buf.slice(0, MAX_BODY_BYTES))
      const text = htmlToText(body)
      if (text.length === 0) return '（页面无可提取文本）'
      const errPage = detectErrorPage(finalUrl, text)
      if (errPage) return errPage
      // plan8 R9.1：**不再在这里砍一刀**。以前是"前 20000 字符"，而网页正文常在后半段（作者、结论、数据表）——
      // 现在原样交回，形状只在 loop.ts 一处决定；这里只留"请求体太大"的硬上限（512KB，防把整部说明书读进内存）。
      const redirectNote = hops > 0 ? `（经 ${hops} 跳重定向，最终地址 ${finalUrl.slice(0, 200)}）\n` : ''
      if (buf.byteLength > MAX_BODY_BYTES) {
        return `${redirectNote}${text}\n（页面超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB，只取了前一部分）`
      }
      return `${redirectNote}${text}`
    }
  }

  return [fetch_url, webSearchTool(firecrawlKey)]
}
