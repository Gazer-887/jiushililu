/**
 * 网络栈兼容探针（plan7 批 F2）—— 回答两件必须先证实的事：
 *
 * ① `net.fetch` 能不能**平替** Node 原生 `fetch`？
 *    模型请求要的不是"拿到响应"而已：POST + 自定义头 + body 要真送达、`res.body.getReader()` 要能
 *    流式读（SSE 全靠它）、非 2xx 要拿得到 status、`AbortSignal` 要能中断（「停止生成」与连接测试
 *    超时都靠它）。四条里断一条，换过去就是把"能聊天"换成"只能聊一半"。
 *
 * ② 设置里配的**自定义代理**对模型请求到底生不生效？
 *    阳性对照：配了代理之后，请求一个**根本不存在的域名**也能拿到响应（响应当然是代理给的）；
 *    阴性对照：切成直连后同一个域名必须失败。两边都成立，才算"配了真生效"。
 *
 * 与 `probe-main-proxy.cjs` 的分工：那个证明"**两条栈存在且不同**"（net 走代理 / Node fetch 不走），
 * 这个证明"**换到 net 之后功能不退化、且自定义档真能生效**"。两者都要，缺一不可。
 *
 * 用法：`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-main-net.cjs`
 *       （本机 ELECTRON_RUN_AS_NODE=1 是全局设着的，不清掉它就变成纯 Node 进程，require('electron') 拿不到 net）
 *
 * ⚠️ 两条纪律：
 *   1. 靶子**不能绑 127.0.0.1** —— Chromium 默认绕过 loopback，绑上去会得到"配了坏代理也照样成功"
 *      的假绿（上一个探针踩过）。这里一律用**局域网 IPv4**。
 *   2. 退出码：任一条不成立即 1。它是**实机验收**工具，不进 CI。
 */

const { app, net, session } = require('electron')
const http = require('node:http')
const os = require('node:os')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`PROBE ${ok ? 'ok  ' : 'FAIL'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

/** 第一个非内网回环 IPv4 —— 用作靶子地址（理由见顶部纪律 1） */
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

const HOST = lanIPv4()

/** 真源站：echo / sse / slow / 404 四条路由 */
function startOrigin() {
  const seen = { method: null, auth: null, body: null, contentType: null }
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/echo')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.method = req.method
        seen.auth = req.headers['authorization'] ?? null
        seen.contentType = req.headers['content-type'] ?? null
        seen.body = body
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, url: req.url }))
      })
      return
    }
    if (req.url.startsWith('/sse')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      for (let i = 1; i <= 3; i++) res.write(`data: ${JSON.stringify({ n: i })}\n\n`)
      res.end()
      return
    }
    if (req.url.startsWith('/slow')) {
      // 先给响应头，再吊着 5 秒 —— 只吊 body 的话 abort 可能压根来不及触发
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      setTimeout(() => res.end('slow-done'), 5000)
      return
    }
    if (req.url.startsWith('/404')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('nope')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('hello')
  })
  return { server, seen }
}

/**
 * 假正向代理：对任何 absolute-URI 请求一律回 `PROXIED:<url>`。
 * 它存在的意义只有一个 —— **证明请求确实经过了它**：目标域名 `nonexistent.invalid` 在 DNS 上不存在，
 * 直连必然失败，能拿到 `PROXIED:` 就只可能是代理给的。
 */
function startProxy() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`PROXIED:${req.url}`)
  })
  return { server, seen }
}

async function main() {
  if (!HOST) {
    console.log('PROBE FAIL no-lan-ipv4 —— 拿不到局域网地址，无法继续（loopback 会被 Chromium 绕过）')
    process.exit(1)
  }

  const origin = startOrigin()
  const proxy = startProxy()
  await new Promise((r) => origin.server.listen(0, '0.0.0.0', r))
  await new Promise((r) => proxy.server.listen(0, '0.0.0.0', r))
  const base = `http://${HOST}:${origin.server.address().port}`
  const proxyAddr = `http://${HOST}:${proxy.server.address().port}`
  console.log(`PROBE_TARGET=${base}`)
  console.log(`PROBE_PROXY=${proxyAddr}`)

  // ── ① POST：method / 头 / body 必须真送达 ──
  try {
    const res = await net.fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-probe' },
      body: JSON.stringify({ hello: 'world' })
    })
    const json = await res.json()
    check(
      'net.post',
      json.ok === true &&
        origin.seen.method === 'POST' &&
        origin.seen.auth === 'Bearer sk-probe' &&
        origin.seen.contentType === 'application/json' &&
        origin.seen.body === '{"hello":"world"}',
      { serverSaw: origin.seen }
    )
  } catch (err) {
    check('net.post', false, { error: String(err) })
  }

  // ── ② 流式：SSE 必须能分帧读出来（模型流式回复全靠这条）──
  try {
    const res = await net.fetch(`${base}/sse`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let chunks = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks++
      text += decoder.decode(value, { stream: true })
    }
    check('net.stream', chunks >= 1 && text.includes('"n":3'), { chunks, text: text.trim() })
  } catch (err) {
    check('net.stream', false, { error: String(err) })
  }

  // ── ③ 非 2xx：status 与 ok 必须对得上（错误映射全靠它）──
  try {
    const res = await net.fetch(`${base}/404`)
    const body = await res.text()
    check('net.status', res.status === 404 && res.ok === false && body === 'nope', {
      status: res.status,
      ok: res.ok
    })
  } catch (err) {
    check('net.status', false, { error: String(err) })
  }

  // ── ④ abort：signal 必须能中断（「停止生成」与连接测试超时都靠它）──
  try {
    const ctrl = new AbortController()
    const started = Date.now()
    const p = net.fetch(`${base}/slow`, { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 300)
    let aborted = false
    try {
      await p
    } catch (err) {
      aborted = true
      check('net.abort', true, { ms: Date.now() - started, error: String(err).slice(0, 80) })
    }
    if (!aborted) check('net.abort', false, { reason: '未被中断，请求照常返回了', ms: Date.now() - started })
  } catch (err) {
    check('net.abort', false, { error: String(err) })
  }

  // ── ⑤ 阴性对照：直连下访问不存在的域名必须失败 ──
  const ghost = 'http://nonexistent.invalid/probe'
  await setProxy({ mode: 'direct' })
  let directFailed = false
  let directError = null
  try {
    await net.fetch(ghost)
  } catch (err) {
    directFailed = true
    directError = String(err).slice(0, 80)
  }
  check('proxy.direct.control', directFailed, { error: directError })

  // ── ⑥ 阳性对照：配了自定义代理后，同一个不存在的域名必须拿到代理的应答 ──
  await setProxy({ mode: 'fixed_servers', proxyRules: proxyAddr, proxyBypassRules: '' })
  let proxied = null
  let proxyError = null
  try {
    const res = await net.fetch(ghost)
    proxied = await res.text()
  } catch (err) {
    proxyError = String(err).slice(0, 120)
  }
  check('proxy.custom.net-fetch', typeof proxied === 'string' && proxied.startsWith('PROXIED:'), {
    body: proxied,
    error: proxyError,
    proxySaw: proxy.seen
  })

  // ── ⑦ 同一档位下 Node 原生 fetch 依然直连（再次坐实"必须换栈"，不是这次配置的偶然）──
  let nodeResult = null
  let nodeError = null
  try {
    const res = await fetch(ghost)
    nodeResult = await res.text()
  } catch (err) {
    nodeError = String(err).slice(0, 120)
  }
  check('proxy.custom.node-fetch-ignores', nodeResult === null, { body: nodeResult, error: nodeError })

  // 收尾：把代理恢复成跟随系统，别把探针的脏配置留给用户
  await setProxy({ mode: 'system' })

  const failed = results.filter((r) => !r.ok)
  console.log(
    `PROBE_SUMMARY=${JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) })}`
  )
  if (failed.length > 0) process.exit(1)
}

/**
 * ⚠️ `setProxy` 是**异步**的且只在 session 就绪后可用 —— 必须 `await`，否则"配了却没生效"会被误读成
 * "net.fetch 不吃代理"（上一个探针就是靠 await 才拿到 ERR_PROXY_CONNECTION_FAILED 这个阳性证据的）。
 */
function setProxy(config) {
  return session.defaultSession.setProxy(config)
}

app.whenReady().then(() => {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.log('PROBE FATAL', err)
      process.exit(1)
    })
})
