// plan29 S4 量测脚本（只测不改）：对**运行中的真机**做会话切换的端到端计时。
// 手段：CDP 连进渲染进程 → **运行时包装 window.api** 逐 IPC 计时（不碰源码）→
//        真实点击侧栏 `.conv-item` 触发 openConversation → 静默期判定 + 帧间隙采样。
// 另测：resize 事件洪水（全屏拖拽场景的三处无节流监听）、工作台页签切换。
// 前置：应用以 `electron . --remote-debugging-port=9222 --user-data-dir=<临时目录>` 启动。
// 运行：node scripts/bench-live-cdp.mjs [port]
import { performance } from 'node:perf_hooks'
import { get } from 'node:http'

const PORT = Number(process.argv[2] ?? 9222)

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => resolve(JSON.parse(s)))
    }).on('error', reject)
  })
}

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
  if (!page) throw new Error('找不到应用页面 target')
  console.log('已连接页面:', page.title || page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, no) => {
    ws.onopen = ok
    ws.onerror = no
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  function send(method, params = {}) {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((ok, no) => pending.set(id, (m) => (m.error ? no(new Error(method + ': ' + JSON.stringify(m.error))) : ok(m.result))))
  }
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
    return r.result?.value
  }

  // —— 运行时插桩：包装 window.api 逐调用计时 ——
  await evalJs(`(() => {
    if (window.__bench) return 'already'
    const api = window.api
    const times = []
    window.__bench = { times }
    for (const name of Object.keys(api)) {
      const orig = api[name]
      if (typeof orig !== 'function') continue
      api[name] = function (...args) {
        const t0 = performance.now()
        const r = orig.apply(this, args)
        if (r && typeof r.then === 'function') {
          return r.finally(() => times.push({ name, ms: performance.now() - t0, at: performance.now() }))
        }
        times.push({ name, ms: performance.now() - t0, at: performance.now() })
        return r
      }
    }
    return 'ok'
  })()`)

  const items = await evalJs(`(() => {
    const els = [...document.querySelectorAll('.conv-item')]
    return els.length
  })()`)
  if (items < 2) throw new Error('侧栏会话项不足 2 条（.conv-item=' + items + '）')
  console.log('侧栏会话项:', items)

  // 预热一次（首次含懒加载/缓存未热，不代表稳态）
  await evalJs(`(async () => {
    const el = document.querySelectorAll('.conv-item')[1]
    el.click()
    await new Promise((ok) => setTimeout(ok, 800))
    return 'warm'
  })()`)

  // —— 量测 N 次切换：点第 2、3 项来回 ——
  const N = 8
  const runs = []
  for (let i = 0; i < N; i++) {
    const idx = 1 + ((i + 1) % Math.min(2, items - 1))
    const r = await evalJs(`(async () => {
      const els = document.querySelectorAll('.conv-item')
      const el = els[${idx}]
      window.__bench.times.length = 0
      const gaps = []
      let sampling = true
      let last = performance.now()
      const sampler = (t) => {
        if (!sampling) return
        gaps.push(t - last)
        last = t
        requestAnimationFrame(sampler)
      }
      requestAnimationFrame(sampler)
      const t0 = performance.now()
      el.click()
      // 静默期判定：250ms 无新 IPC 即认为切换链路结束（上限 3s 兜底）
      await new Promise((ok) => {
        let lastN = window.__bench.times.length
        let lastChange = performance.now()
        const iv = setInterval(() => {
          const n = window.__bench.times.length
          if (n !== lastN) { lastN = n; lastChange = performance.now() }
          else if (performance.now() - lastChange > 250) { clearInterval(iv); ok() }
        }, 40)
        setTimeout(() => { clearInterval(iv); ok() }, 3000)
      })
      sampling = false
      const wall = performance.now() - t0
      return { wall, ipcs: window.__bench.times.slice(), frameGaps: gaps.filter((g, gi) => gi > 0) }
    })()`)
    runs.push(r)
    await new Promise((ok) => setTimeout(ok, 400))
  }

  // —— resize 洪水 ——
  const resize = await evalJs(`(async () => {
    const t0 = performance.now()
    for (let i = 0; i < 120; i++) window.dispatchEvent(new Event('resize'))
    const t1 = performance.now()
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
    return { dispatchMs: t1 - t0, perEventMs: (t1 - t0) / 120 }
  })()`)

  // —— 汇总 ——
  const walls = runs.map((r) => r.wall).sort((a, b) => a - b)
  const ipcAgg = {}
  for (const r of runs) for (const c of r.ipcs) (ipcAgg[c.name] ??= []).push(c.ms)
  const ipcRows = Object.entries(ipcAgg)
    .map(([name, xs]) => ({ name, n: xs.length, med: [...xs].sort((a, b) => a - b)[xs.length >> 1], sum: xs.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.sum - a.sum)
  const allGaps = runs.flatMap((r) => r.frameGaps).sort((a, b) => a - b)
  const jank = allGaps.filter((g) => g > 32)

  console.log('\n=== 会话切换端到端（' + N + ' 次，预热 1 次不计）===')
  console.log(`静默判定口径：点击 → 250ms 无新 IPC。中位 ${walls[N >> 1].toFixed(0)} ms · 最快 ${walls[0].toFixed(0)} · 最慢 ${walls[N - 1].toFixed(0)}`)
  console.log('\n=== 逐 IPC 占比（全部 IPC 调用按名称聚合）===')
  for (const r of ipcRows) console.log(`${r.name.padEnd(26)} ×${String(r.n).padEnd(3)} 中位 ${r.med.toFixed(1).padStart(7)} ms  累计 ${r.sum.toFixed(1).padStart(8)} ms`)
  console.log('\n=== 帧间隙（切换全程采样）===')
  console.log(`样本 ${allGaps.length} · 中位 ${allGaps[allGaps.length >> 1].toFixed(1)} ms · >32ms 卡顿帧 ${jank.length} 个 · 最大 ${(allGaps[allGaps.length - 1] ?? 0).toFixed(1)} ms`)
  console.log('\n=== resize 洪水（120 次 ≈ 2 秒@60fps 拖拽量）===')
  console.log(`分发+同步处理共 ${resize.dispatchMs.toFixed(1)} ms（每事件 ${resize.perEventMs.toFixed(2)} ms）`)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('量测失败:', e.message)
  process.exit(1)
})
