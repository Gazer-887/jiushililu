/**
 * 网络代理探针（plan7 批 F2 的前置验证）—— **真组合根**，不跑在替身上。
 *
 * 要回答一个问题（计划里自己写的警告，不先验证就等于做一个"改了没反应"的下拉框）：
 *
 *   `session.defaultSession.setProxy(...)` 到底管不管**模型请求**？
 *
 * 背景：模型请求在 `src/main/providers/*` 里用的是 **Node 原生 fetch**（undici），
 * 而 `setProxy` 只作用于 **Chromium 网络栈**（渲染进程 / WebContentsView / `net` 模块）。
 * 两者不是一条栈 —— 那么"配了代理但模型请求不走代理"就会是一个**静默**的假象：
 * 界面显示已生效、日志无错、请求照直连（然后在国内超时）。
 *
 * 本探针只验证 `net.fetch` 能不能当 `fetch` 的替代品（这是唯一能吃到 session 代理的入口）：
 *   ① 能发请求、拿到状态与头
 *   ② **能流式读**（SSE 逐块到达 —— 聊天全靠它，读不了流式这条路就废了）
 *   ③ 设了坏代理之后**真的失败**（阳性对照：证明它确实在走我们设的代理，
 *      否则"能请求"可能只是它绕开了代理直连成功）
 *
 * 跑法：`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-main-proxy.cjs`
 * ⚠️ 必须 `env -u ELECTRON_RUN_AS_NODE`：本机该变量是全局设着的，不去掉会以纯 node 跑 → `app` 是 undefined。
 */
const { app, session, net } = require('electron')

const log = []
const say = (s) => {
  log.push(s)
  console.log(s)
}

/**
 * 起一个本地 SSE 小服务器当靶子。
 *
 * ⚠️ **必须绑到局域网 IP，不能绑 127.0.0.1**（这是本探针第一版踩到的坑，留着当教训）：
 *    Chromium **默认绕过 loopback**（localhost / 127.0.0.1 永不走代理），
 *    于是"设了坏代理仍然请求成功"—— 那不是"代理没生效"，而是靶子根本没经过代理。
 *    判据说出来是废话，但这个坑会让整段验证**静默假绿**，必须写在这儿。
 *
 * 另注：真需要让 loopback 也走代理时，Chromium 的开关是 `proxyBypassRules: '<-loopback>'`。
 */
function startSseServer() {
  return new Promise((resolve, reject) => {
    const http = require('node:http')
    const os = require('node:os')
    let host = null
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          host = ni.address
          break
        }
      }
      if (host) break
    }
    if (!host) {
      reject(new Error('找不到非 loopback 的 IPv4 地址 —— 换不了靶子，这段验证没法做'))
      return
    }
    const srv = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      let n = 0
      const timer = setInterval(() => {
        n += 1
        res.write(`data: ${JSON.stringify({ n })}\n\n`)
        if (n >= 3) {
          clearInterval(timer)
          res.end()
        }
      }, 40)
    })
    srv.listen(0, host, () => resolve({ srv, host, port: srv.address().port }))
  })
}

async function tryStream(baseUrl, label) {
  const out = { label, ok: false, status: null, chunks: 0, firstChunk: null, error: null }
  try {
    const res = await net.fetch(baseUrl, { method: 'GET' })
    out.status = res.status
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.chunks += 1
      if (out.firstChunk === null) out.firstChunk = dec.decode(value).trim().slice(0, 40)
    }
    out.ok = out.chunks > 0
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  }
  return out
}

app.whenReady().then(async () => {
  const { srv, host, port } = await startSseServer()
  const url = `http://${host}:${port}/sse`
  say(`PROBE_TARGET=${url}`)

  // ① 直连：net.fetch 能不能发 + 能不能流式读
  await session.defaultSession.setProxy({ mode: 'direct' })
  const direct = await tryStream(url, 'direct')
  say('NET_DIRECT=' + JSON.stringify(direct))

  // ② 设一个**故意不可达**的代理（本机 9 端口没人听）→ 必须失败。
  //    这是阳性对照：若它照样成功，说明 net.fetch 绕开了 session 代理，那 setProxy 就是个摆设。
  await session.defaultSession.setProxy({ proxyRules: 'http://127.0.0.1:9' })
  const bad = await tryStream(url, 'bad-proxy')
  say('NET_BAD_PROXY=' + JSON.stringify(bad))

  // ③ 对照组：同一个坏代理下，Node 原生 fetch 会怎样（预期**照样成功** —— 它不走 session 代理）
  let nodeFetchOk = null
  let nodeFetchErr = null
  try {
    const r = await fetch(url)
    nodeFetchOk = r.status
  } catch (err) {
    nodeFetchErr = err && err.message ? err.message : String(err)
  }
  say('NODE_FETCH_UNDER_BAD_PROXY=' + JSON.stringify({ status: nodeFetchOk, error: nodeFetchErr }))

  // 结论：三行一起看才有意义
  const verdict = {
    netFetchStreams: direct.ok === true,
    netFetchHonorsProxy: direct.ok === true && bad.ok === false,
    nodeFetchIgnoresProxy: nodeFetchOk !== null && nodeFetchOk === 200
  }
  say('PROBE_VERDICT=' + JSON.stringify(verdict))
  say(
    verdict.netFetchHonorsProxy && verdict.nodeFetchIgnoresProxy
      ? 'CONCLUSION=net.fetch 走 session 代理且能流式读；Node 原生 fetch 不走 —— 模型请求要吃代理必须改用 net.fetch'
      : 'CONCLUSION=结论与预期不符，别急着改供应商层，先看上面的三行原始输出'
  )

  srv.close()
  app.exit(0)
})
