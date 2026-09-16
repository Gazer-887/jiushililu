import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '@main/providers/http-client'
import { createWebTools, detectErrorPage, htmlToText, isBlockedHost } from '@main/agent/tools/web-tools'

// fetch_url 的 plan38 回归：受控跟随重定向（S1）+ 错误页假成功检测（S2）。
// 出口经 setHttpFetch 注入假网络（http-client 的可注入设计正是为这条测试链留的）。

type Step = { status: number; headers?: Record<string, string>; body?: string }

/** 假网络：按序吐步骤；记录每次请求的 url 与 init（init 必须能断言 —— redirect:'manual' 被删掉时测试要变红） */
function fakeNetwork(steps: (Step | Error)[]): { calls: string[]; inits: RequestInit[] } {
  const calls: string[] = []
  const inits: RequestInit[] = []
  let i = 0
  setHttpFetch(async (url, init) => {
    calls.push(url)
    inits.push(init)
    const s = steps[i++]
    if (!s) throw new Error(`测试网络桩步骤用尽（第 ${i} 次请求 ${url}）`)
    if (s instanceof Error) throw s
    return Promise.resolve(new Response(s.body ?? '', { status: s.status, headers: s.headers }))
  })
  return { calls, inits }
}

const fetchTool = () => {
  const t = createWebTools().find((x) => x.schema.name === 'fetch_url')
  if (!t) throw new Error('fetch_url 工具不在册')
  return t
}
const get = (url: string) => fetchTool().execute({ url })

afterEach(() => setHttpFetch(null))

describe('fetch_url · 受控跟随重定向（plan38 S1）', () => {
  it('302（相对 Location）→ 逐跳跟随到终页，正文带回且注明跳数与最终地址；每一跳都显式 manual', async () => {
    const net = fakeNetwork([
      { status: 302, headers: { location: '/s?__biz=abc&mid=1' } },
      { status: 200, body: '<article>真正的文章正文</article>' }
    ])
    const out = await get('https://mp.weixin.qq.com/s?short')
    expect(out).toContain('真正的文章正文')
    expect(out).toContain('经 1 跳重定向')
    expect(net.calls).toHaveLength(2)
    expect(net.calls[1]).toBe('https://mp.weixin.qq.com/s?__biz=abc&mid=1')
    // 跟随是我们自己逐跳做的，栈必须始终 manual（否则 SSRF 中间跳绕过校验）
    expect(net.inits.every((init) => init.redirect === 'manual')).toBe(true)
  })

  it('跳转到内网地址 → 逐跳 SSRF 校验拦下，报错带「第几跳」', async () => {
    fakeNetwork([{ status: 302, headers: { location: 'https://127.0.0.1:5000/latest/meta-data' } }])
    const out = await get('https://ok.example.com/start')
    expect(out).toContain('安全策略拒绝')
    expect(out).toContain('第 1 跳')
    expect(out).toContain('127.0.0.1')
  })

  it('IPv6 映射回环（::ffff:7f00:1）→ 展开后拦下（安全审查实测形态）', async () => {
    fakeNetwork([{ status: 302, headers: { location: 'https://[::ffff:7f00:1]:9200/' } }])
    const out = await get('https://ok.example.com/start')
    expect(out).toContain('安全策略拒绝')
    expect(out).toContain('::ffff:7f00:1')
  })

  it('https 起点被跳到 http → 拒绝降级并提示显式请求', async () => {
    fakeNetwork([{ status: 302, headers: { location: 'http://mirror.example.com/page' } }])
    const out = await get('https://secure.example.com/start')
    expect(out).toContain('降级')
    expect(out).toContain('http://mirror.example.com/page')
  })

  it('http 起点跳 https（升级）→ 放行', async () => {
    fakeNetwork([
      { status: 302, headers: { location: 'https://secure.example.com/final' } },
      { status: 200, body: '<p>升级后的内容</p>' }
    ])
    const out = await get('http://secure.example.com/start')
    expect(out).toContain('升级后的内容')
  })

  it('超过 3 跳上限 → 停下并报告滞留地址（不进死循环）', async () => {
    const loop = { status: 302, headers: { location: '/next' } }
    fakeNetwork([loop, loop, loop, loop, loop])
    const out = await get('https://a.example.com/x')
    expect(out).toContain('超过 3 跳上限')
  })

  it('302 无 Location → 如实报「未给出跳转地址」', async () => {
    fakeNetwork([{ status: 302 }])
    const out = await get('https://a.example.com/x')
    expect(out).toContain('未给出跳转地址')
  })

  it('网络失败与超时各说各话（超时带已跟随跳数）', async () => {
    const toErr = new Error('The operation was aborted due to timeout')
    toErr.name = 'TimeoutError'
    fakeNetwork([toErr])
    expect(await get('https://a.example.com/x')).toContain('抓取超时（30s 总预算耗尽，已跟随 0 跳）')
    fakeNetwork([new Error('Redirect was cancelled')])
    expect(await get('https://a.example.com/x')).toContain('抓取失败——Redirect was cancelled')
  })

  it('垃圾地址说「格式无法解析」，不冒充安全策略；空 url 直说', async () => {
    fakeNetwork([])
    expect(await get('abc')).toContain('URL 格式无法解析')
    expect(await get('   ')).toBe('错误：url 不能为空')
  })
})

describe('isBlockedHost · 扩展拦截面（安全审查后补，plan38）', () => {
  it('mDNS/内部域后缀拦', () => {
    expect(isBlockedHost('printer.local')).toBe(true)
    expect(isBlockedHost('db.internal')).toBe(true)
    expect(isBlockedHost('host.home.arpa')).toBe(true)
  })
  it('CGNAT 100.64/10 拦，相邻段不拦', () => {
    expect(isBlockedHost('100.64.0.1')).toBe(true)
    expect(isBlockedHost('100.127.255.255')).toBe(true)
    expect(isBlockedHost('100.63.255.255')).toBe(false)
    expect(isBlockedHost('100.128.0.1')).toBe(false)
  })
  it('IPv6 映射/NAT64 展开判定；全局单播含 ::ffff: 中段不误伤', () => {
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true) // → 127.0.0.1
    expect(isBlockedHost('64:ff9b::a00:1')).toBe(true) // → 10.0.0.1
    expect(isBlockedHost('::ffff:1')).toBe(true) // → 0.0.0.1
    expect(isBlockedHost('2001:db8::ffff:1')).toBe(false) // 合法全局单播（过杀回归钉）
    expect(isBlockedHost('nas.fritz.box')).toBe(false)
  })
})

describe('fetch_url · 错误页假成功检测（plan38 S2）', () => {
  const wechatErrPage = '<html><body><div class="weui-msg__title">参数错误：</div><ul><li>视频</li><li>小程序</li><li>赞</li></ul></body></html>'

  it('HTTP 200 的微信「参数错误」页 → 返回指路文案，不吐错误页正文', async () => {
    fakeNetwork([{ status: 200, body: wechatErrPage }])
    const out = await get('https://mp.weixin.qq.com/s?truncated')
    expect(out).toContain('页面实为「微信文章不可访问」提示页')
    expect(out).toContain('核对完整链接')
    expect(out).not.toContain('小程序')
  })

  it('非微信站点的短页只含「参数错误」一词 → 不误杀（host 不命中且不足两句）', async () => {
    fakeNetwork([{ status: 200, body: '<div>本文示例：参数错误的排查思路</div>' }])
    const out = await get('https://blog.example.com/tip')
    expect(out).toContain('排查思路')
    expect(out).not.toContain('提示页')
  })

  it('SPA 壳：script 里含签名词但正文干净 → 不误杀（判定只看提取后正文）', async () => {
    fakeNetwork([{ status: 200, body: `<script>var msg="参数错误；该内容已被发布者删除"</script><div>${'正常文章内容。'.repeat(3)}</div>` }])
    const out = await get('https://mp.weixin.qq.com/r/spa')
    expect(out).toContain('正常文章内容')
    expect(out).not.toContain('提示页')
  })

  it('长文章里出现「参数错误」字样 → 不误伤（短页门控）', async () => {
    const long = '<article>' + ('这是一篇讲解微信接口错误处理的技术文章，参数错误是最常见的分支。'.repeat(80)) + '</article>'
    fakeNetwork([{ status: 200, body: long }])
    const out = await get('https://mp.weixin.qq.com/s/long-article')
    expect(out).toContain('技术文章')
    expect(out).not.toContain('提示页')
  })

  it('detectErrorPage 纯函数：host 命中 / 两句共现 / 单词非微信 host 三态', () => {
    expect(detectErrorPage('https://mp.weixin.qq.com/s/x', htmlToText(wechatErrPage))).toContain('微信文章不可访问')
    expect(detectErrorPage('https://elsewhere.example/x', '参数错误：该内容已被发布者删除')).toContain('微信文章不可访问')
    expect(detectErrorPage('https://elsewhere.example/x', '参数错误')).toBeNull()
    expect(detectErrorPage('https://mp.weixin.qq.com/x', 'x'.repeat(3000) + '参数错误')).toBeNull()
  })
})
