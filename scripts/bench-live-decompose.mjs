// plan29 S4 量测脚本 · 分解篇（只测不改）：
//   ① 逐 IPC 直接往返计时（contextBridge 对象只读，不能包装——改为**直接调用并计时**）
//   ② 点击驱动的端到端切换 + Long Task 观察器（量化渲染层长任务）
// 运行：node scripts/bench-live-decompose.mjs [port]
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

  // ⚠️ 必须先把窗口带到前台：遮挡状态下 rAF 节流会把帧间隙与 IPC 计时全部污染（实测 36ms→590ms）
  await send('Page.enable')
  await send('Page.bringToFront', {})
  await new Promise((ok) => setTimeout(ok, 500))

  // 安装 longtask 观察器
  await evalJs(`(() => {
    window.__lt = []
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration }) })
      .observe({ entryTypes: ['longtask'] })
    return 'observer on'
  })()`)

  // 预热
  await evalJs(`(async () => {
    document.querySelectorAll('.conv-item')[1]?.click()
    await new Promise((ok) => setTimeout(ok, 900))
    window.__lt.length = 0
    return 'warm'
  })()`)

  // ① 逐 IPC 直接往返（各 3 次取中位）。saveConversation 用真实当前会话载荷（写临时数据目录）。
  const perIpc = await evalJs(`(async () => {
    const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
    const out = {}
    const t = async (name, fn) => {
      const xs = []
      for (let i = 0; i < 3; i++) { const t0 = performance.now(); await fn(); xs.push(performance.now() - t0) }
      out[name] = med(xs)
    }
    const convs = await window.api.listConversations()
    const id = convs.find((c) => typeof c?.id === 'string')?.id
    let conv = null
    let convErr = null
    try { conv = await window.api.getConversation(id) } catch (e) { convErr = String(e?.message ?? e).slice(0, 120) }
    const convShape = conv ? { id: typeof conv.id, msgType: Array.isArray(conv.messages) ? 'array' : typeof conv.messages, keys: Object.keys(conv).slice(0, 12).join(',') } : 'null' + (convErr ? ' err=' + convErr : '')
    await t('listConversations', () => window.api.listConversations())
    await t('getConversation(50KB 最大会话)', () => window.api.getConversation(id))
    if (conv && typeof conv.id === 'string' && Array.isArray(conv.messages)) {
      try { await t('saveConversation(同一载荷)', () => window.api.saveConversation(conv)) } catch (e) { out['saveConversation 失败'] = String(e?.message ?? e).slice(0, 150) }
    } else {
      out['saveConversation 跳过'] = convShape
    }
    await t('switchConversation', () => window.api.switchConversation(id, convs[1]?.id ?? id))
    await t('setKnownWorkspace', () => window.api.setKnownWorkspace(conv?.workspace ?? '.'))
    await t('getSettings', () => window.api.getSettings())
    out.__convShape = convShape
    return out
  })()`)
  const convShape = perIpc.__convShape
  delete perIpc.__convShape

  // ② 点击切换 ×8：wall + longtask + 帧间隙
  const N = 8
  const runs = []
  for (let i = 0; i < N; i++) {
    const idx = 1 + ((i + 1) % 2)
    const r = await evalJs(`(async () => {
      const els = document.querySelectorAll('.conv-item')
      window.__lt.length = 0
      const gaps = []
      let sampling = true
      let last = performance.now()
      const sampler = (t) => { if (!sampling) return; gaps.push(t - last); last = t; requestAnimationFrame(sampler) }
      requestAnimationFrame(sampler)
      const t0 = performance.now()
      els[${idx}].click()
      await new Promise((ok) => {
        let lastChange = performance.now()
        const iv = setInterval(() => {
          if (performance.now() - lastChange > 250) { clearInterval(iv); ok() }
          lastChange = performance.now() - 0 // 有 longtask 也算变化 —— 由下面兜底超时控制
        }, 40)
        setTimeout(() => { clearInterval(iv); ok() }, 2500)
      })
      sampling = false
      return {
        wall: performance.now() - t0,
        longtasks: window.__lt.slice(),
        frameGaps: gaps.filter((g, gi) => gi > 0)
      }
    })()`)
    runs.push(r)
    await new Promise((ok) => setTimeout(ok, 400))
  }

  const walls = runs.map((r) => r.wall).sort((a, b) => a - b)
  const ltTotal = runs.map((r) => r.longtasks.reduce((a, e) => a + e.dur, 0))
  const ltMax = runs.flatMap((r) => r.longtasks.map((e) => e.dur))
  const gaps = runs.flatMap((r) => r.frameGaps).sort((a, b) => a - b)
  const jank = gaps.filter((g) => g > 32).length

  console.log('\n=== ① 逐 IPC 往返（各 3 次取中位）===')
  for (const [k, v] of Object.entries(perIpc)) console.log(`${k.padEnd(34)} ${(typeof v === "number" ? v.toFixed(1) : String(v)).padStart(7)} ms`)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const chainEstimate =
    num(perIpc['saveConversation(同一载荷)']) +
    num(perIpc['switchConversation']) +
    num(perIpc['getConversation(50KB 最大会话)']) +
    num(perIpc['setKnownWorkspace']) +
    num(perIpc['getSettings']) * 2 // loadSettings = getSettings + setState
  console.log(`（会话载荷形态: ${convShape}）`)
  console.log(`── openConversation 六步串行估算（无渲染）≈ ${chainEstimate.toFixed(0)} ms`)
  console.log('\n=== ② 点击切换端到端（' + N + ' 次）===')
  console.log(`wall 中位 ${walls[N >> 1].toFixed(0)} ms · 最快 ${walls[0].toFixed(0)} · 最慢 ${walls[N - 1].toFixed(0)}`)
  console.log(`longtask 每次切换合计 中位 ${ltTotal.sort((a, b) => a - b)[N >> 1].toFixed(0)} ms · 单个最长 ${(Math.max(...ltMax) || 0).toFixed(0)} ms`)
  console.log(`帧间隙 中位 ${gaps[gaps.length >> 1].toFixed(1)} ms · >32ms 卡顿帧 ${jank} / ${gaps.length}`)
  console.log('\n=== 差值解释（wall − 串行IPC估算 ≈ 渲染/重挂载占比）===')
  const medWall = walls[N >> 1]
  console.log(`${medWall.toFixed(0)} − ${chainEstimate.toFixed(0)} ≈ ${(medWall - chainEstimate).toFixed(0)} ms 归渲染层`)

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('量测失败:', e.message)
  process.exit(1)
})
