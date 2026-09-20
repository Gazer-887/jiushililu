#!/usr/bin/env node
/**
 * 卡顿监测器 —— 真机拟真测试用（plan49 §9.3 方法固化）
 *
 * 为什么要有它：上一次排查我把 `agents:list` 当成了元凶，错在**没先看 crumbs 的时间戳分布**。
 * 事件循环被占死期间程序根本无法记账 ⇒ crumbs 记下的必然是"恢复后的第一拍"。
 * 所以本脚本的**第二步（crumbs 相对时间分布）是硬性前置**，不许跳过。
 *
 * 用法：
 *   node scripts/stall-watch.cjs --follow              # 实时跟踪（长时测试期间挂着）
 *   node scripts/stall-watch.cjs --report              # 对已有日志出报告
 *   node scripts/stall-watch.cjs --report --since <ISO>  # 只统计某时刻之后
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * 应用日志位置 —— 按 Electron 的 userData 口径分平台推。
 * ⚠️ 原先只写 Windows 的 `AppData/Roaming`，换台 mac/Linux 就只会报"日志不存在"，
 * 而那是个**看起来像"这一轮没卡"的空结果** —— 空结果必须有原因，否则读的人分不清"没卡"与"没读到"。
 */
function defaultLogPath() {
  const home = os.homedir()
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'jiushililu')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'jiushililu')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'jiushililu')
  return path.join(dir, 'logs', 'app.log')
}

const LOG = process.env.JSL_LOG || defaultLogPath()

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

/** 一条停滞告警的解析结果 */
function parseLine(line) {
  // 形如: [2026-09-19T13:02:00.014Z] [WARN] [watchdog] 事件循环停滞（...） {"stallMs":1100,...}
  if (!line.includes('[watchdog]')) return null
  const mTs = line.match(/^\[([^\]]+)\]/)
  const mJson = line.match(/\{.*\}\s*$/)
  if (!mTs || !mJson) return null
  let body
  try {
    body = JSON.parse(mJson[0])
  } catch {
    return null
  }
  // ⚠️ 必须按**字段**筛，不能只看 `[watchdog]`：0.13.77 起 watchdog 每 5 分钟还打一条 INFO 心跳
  // （`{blocks,ms,total}`，没有 stallMs）。它会被上一版当成停滞告警收进来 —— 实测 6 条"告警"
  // 全是心跳，于是"累计停滞 0ms / 单次最长 0ms"这种自相矛盾的读数就出来了。
  // 读数器被自己的另一路输出污染，比不读数更糟：它给的是一个**看起来自洽的空结论**。
  if (!Number.isFinite(body.stallMs) || body.stallMs <= 0) return null
  const crumbs = Array.isArray(body.crumbs) ? body.crumbs : []
  // crumb 形如 "1094ms > agents:list" / "1095ms < agents:list 1ms" / "3ms × agents:list 5ms"
  const parsed = crumbs.map((c) => {
    const m = String(c).match(/^(\d+)ms\s+(>|<|×)\s+(\S+)/)
    return m ? { at: Number(m[1]), dir: m[2], ch: m[3] } : null
  }).filter(Boolean)
  const ats = parsed.map((c) => c.at)
  return {
    ts: mTs[1],
    stallMs: Number(body.stallMs) || 0,
    phase: body.phase || '(none)',
    crumbs: parsed,
    // 关键量：crumbs 最早一条相对停滞起点的位置，以及占比
    crumbMin: ats.length ? Math.min(...ats) : null,
    crumbMax: ats.length ? Math.max(...ats) : null,
    // 覆盖比 = 最早 crumb / 停滞总时长。**越接近 1 越说明 crumbs 只覆盖末段**
    coverRatio: ats.length && body.stallMs ? Math.min(...ats) / Number(body.stallMs) : null
  }
}

function readAll(sinceIso) {
  if (!fs.existsSync(LOG)) {
    console.error('日志不存在：' + LOG)
    process.exit(1)
  }
  const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/)
  const out = []
  for (const l of lines) {
    const p = parseLine(l)
    if (!p) continue
    if (sinceIso && p.ts < sinceIso) continue
    out.push(p)
  }
  return out
}

function fmt(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms'
}

function report(rows, title) {
  console.log('\n' + '='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
  if (rows.length === 0) {
    console.log('  （无停滞告警 —— 这一轮没有可分析的事件）')
    return
  }

  const total = rows.reduce((s, r) => s + r.stallMs, 0)
  const mx = rows.reduce((a, r) => (r.stallMs > a.stallMs ? r : a), rows[0])
  const first = rows[0].ts
  const last = rows[rows.length - 1].ts
  const spanMs = new Date(last).getTime() - new Date(first).getTime()

  console.log(`  告警条数      ${rows.length}`)
  console.log(`  时间窗        ${first} → ${last}`)
  console.log(`  窗口时长      ${fmt(spanMs)}`)
  console.log(`  累计停滞      ${fmt(total)}`)
  // 只有一条告警时时间窗为 0，"占死比例"会除以 1 变成几万percent —— 那是**假数**，不如明说样本不足
  console.log(
    rows.length >= 2
      ? `  占死比例      ${((total / Math.max(spanMs, 1)) * 100).toFixed(1)}%`
      : '  占死比例      n/a（单条样本算不出占比）'
  )
  console.log(`  单次最长      ${fmt(mx.stallMs)}  @ ${mx.ts}  phase=${mx.phase}`)
  console.log(`  平均值        ${fmt(Math.round(total / rows.length))}`)

  // ── 第二步（硬性前置）：crumbs 相对时间分布 ──────────────────────────
  console.log('\n  【crumbs 相对停滞起点的分布】—— 这一步决定"能不能拿 crumbs 当元凶证据"')
  const withCrumbs = rows.filter((r) => r.coverRatio !== null)
  if (withCrumbs.length === 0) {
    console.log('    没有任何告警带 crumbs（可能这一轮没有 IPC 活动）')
  } else {
    const buckets = { '开头 (<30%)': 0, '前段 (30-60%)': 0, '后段 (60-90%)': 0, '末段 (>90%)': 0 }
    for (const r of withCrumbs) {
      const q = r.coverRatio
      if (q < 0.3) buckets['开头 (<30%)']++
      else if (q < 0.6) buckets['前段 (30-60%)']++
      else if (q < 0.9) buckets['后段 (60-90%)']++
      else buckets['末段 (>90%)']++
    }
    for (const [k, v] of Object.entries(buckets)) {
      const pct = ((v / withCrumbs.length) * 100).toFixed(1)
      console.log(`    ${k.padEnd(16)} ${String(v).padStart(4)}  (${pct}%)`)
    }
    const lastSeg = buckets['末段 (>90%)']
    const ratio = lastSeg / withCrumbs.length
    console.log('')
    if (ratio > 0.8) {
      console.log('    ⚠️ 判定：crumbs 几乎全部落在**末段**（恢复后的第一拍）。')
      console.log('       ⇒ **禁止**用 crumbs 判定"谁占死了事件循环"，那是倒果为因。')
      console.log('       ⇒ 真凶不在 crumbs 覆盖范围内（探针没装在它那条路上）。')
    } else if (ratio < 0.3) {
      console.log('    ✅ 判定：crumbs 覆盖到了停滞**开头** —— 这一次它有可能抓到真凶。')
      console.log('       ⇒ 重点看"只进没出"（有 > 无 <）的那条通道。')
    } else {
      console.log('    ⚠️ 判定：crumbs 分布分散，需逐条看，不能一概而论。')
    }
  }

  // ── 通道分布 ────────────────────────────────────────────────────────
  console.log('\n  【通道出现频次】（注意：高不代表是元凶，见上方判定）')
  const chCount = new Map()
  for (const r of rows) for (const c of r.crumbs) chCount.set(c.ch, (chCount.get(c.ch) || 0) + 1)
  const sorted = [...chCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  for (const [ch, n] of sorted) console.log(`    ${ch.padEnd(28)} ${n}`)

  // ── "只进没出" 检查（真凶的直接特征）────────────────────────────────
  console.log('\n  【"只进没出"的通道】—— 有 > 无配对的 <，这是真凶的直接判据')
  const unpaired = new Map()
  for (const r of rows) {
    const open = new Map()
    for (const c of r.crumbs) {
      if (c.dir === '>') open.set(c.ch, (open.get(c.ch) || 0) + 1)
      else if (c.dir === '<' || c.dir === '×') open.set(c.ch, Math.max(0, (open.get(c.ch) || 0) - 1))
    }
    for (const [ch, n] of open) if (n > 0) unpaired.set(ch, (unpaired.get(ch) || 0) + n)
  }
  if (unpaired.size === 0) {
    console.log('    （无）—— 所有通道都成对，说明占死期间**没有任何 IPC 在跑**，')
    console.log('     真凶大概率是**主进程内部同步任务**（browser 工具 / 同步 FS / agent 读盘），')
    console.log('     这些路径当前**没有埋点**（面包屑只挂 ipcMain.handle）。')
  } else {
    for (const [ch, n] of [...unpaired.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ⚠️ ${ch}  未配对数 ${n}`)
    }
  }

  // ── phase 分布（仅作参考，**不是归属证据**）──────────────────────────
  console.log('\n  【phase 分布】⚠️ phase 是**回溯插值**（拿停滞起点去历史里倒查），')
  console.log('     只能推出"停滞起点落在该阶段窗口内"，**推不出元凶**。仅作线索。')
  const phCount = new Map()
  for (const r of rows) phCount.set(r.phase, (phCount.get(r.phase) || 0) + 1)
  for (const [ph, n] of [...phCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(ph).padEnd(30)} ${n}`)
  }

  // ── 最长若干条逐条打印 ──────────────────────────────────────────────
  console.log('\n  【最长 5 条详情】')
  for (const r of [...rows].sort((a, b) => b.stallMs - a.stallMs).slice(0, 5)) {
    console.log(`    ${r.ts}  ${fmt(r.stallMs)}  phase=${r.phase}  cover=${r.coverRatio === null ? 'n/a' : (r.coverRatio * 100).toFixed(0) + '%'}`)
    for (const c of r.crumbs) console.log(`        ${String(c.at).padStart(6)}ms  ${c.dir} ${c.ch}`)
  }
  console.log('')
}

if (has('--follow')) {
  // 实时跟踪：记录起始偏移，之后增量解析并逐条打印 + 累积统计
  console.log('[stall-watch] 实时监测中：' + LOG)
  console.log('[stall-watch] 每 10 秒检查一次新增内容。Ctrl+C 结束并出汇总。')
  let size = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0
  const seen = []
  const tick = () => {
    if (!fs.existsSync(LOG)) return
    const st = fs.statSync(LOG)
    if (st.size < size) size = 0 // 日志被轮转/截断
    if (st.size === size) return
    const fd = fs.openSync(LOG, 'r')
    const buf = Buffer.alloc(st.size - size)
    fs.readSync(fd, buf, 0, buf.length, size)
    fs.closeSync(fd)
    size = st.size
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const p = parseLine(line)
      if (!p) continue
      seen.push(p)
      const cov = p.coverRatio === null ? 'n/a' : (p.coverRatio * 100).toFixed(0) + '%'
      console.log(`[${new Date().toISOString().slice(11, 19)}] +STALL ${fmt(p.stallMs).padStart(8)}  phase=${String(p.phase).padEnd(22)} cover=${cov.padStart(4)}`)
    }
  }
  tick()
  const iv = setInterval(tick, 10000)
  const bye = () => {
    clearInterval(iv)
    report(seen, `实时监测汇总 · ${seen.length} 条`)
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
} else if (has('--report') || argv.length === 0) {
  const since = valOf('--since')
  const rows = readAll(since)
  report(rows, `卡顿监测报告${since ? ` · since ${since}` : ' · 全量'}`)
} else {
  console.log('用法：node scripts/stall-watch.cjs [--report] [--since <ISO>] [--follow]')
}
