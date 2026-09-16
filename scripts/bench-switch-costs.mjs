// plan29 S4 量测脚本（只测不改）：会话切换路径上主进程同步 I/O 的真实成本。
// 忠实复刻 store/conversations-fs.ts 的 atomicWrite 四步：
//   mkdirSync → writeFileSync(tmp) → fsyncFile(tmp) → renameSync → fsyncDir
// 载荷：真实会话库（7 个会话，最大 50KB）+ 假想未来规模（0.5/1/5/10MB）。
// 运行：node scripts/bench-switch-costs.mjs
// 说明：脚本自包含、只写系统临时目录，不碰 userData 与仓库文件。
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import { mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

// —— 复刻 fsyncFile / fsyncDir（与 nodeFsAdapter 同口径）——
function fsyncFile(p) {
  const fd = openSync(p, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function fsyncDir(p) {
  // Windows 上打不开目录，实现里吞掉错误 —— 这里同口径
  try {
    const fd = openSync(p, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* 吞掉 */
  }
}
function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, 'utf8')
  fsyncFile(tmp)
  renameSync(tmp, path)
  fsyncDir(dirname(path))
}

// —— 计时器：预热 + 多轮取中位数 ——
function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}
function bench(fn, { rounds = 30, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) fn()
  const t = []
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    fn()
    t.push(performance.now() - t0)
  }
  return median(t)
}

// —— 载荷构造：模拟会话 JSON（嵌套消息数组）——
// 注意：必须**先估条数、一次填充**——若每轮全量重新 stringify 就是 O(n²)，
// 10MB 载荷能拖到分钟级（本脚本初版踩过，已修正）。
function makeConvJson(bytes, pretty) {
  const msg = {
    id: 'm-xxxx',
    role: 'assistant',
    text: '这是条模拟消息文本，用来撑起真实量级的载荷。'.repeat(6),
    toolEvents: [{ kind: 'file', name: 'write_file', at: Date.now(), meta: { path: 'src/x.ts', bytes: 1234 } }],
    ts: Date.now()
  }
  const singleCompact = Buffer.byteLength(JSON.stringify(msg), 'utf8') + 4
  const n = Math.max(1, Math.ceil(bytes / singleCompact))
  const conv = { id: 'bench', title: '载荷', createdAt: Date.now(), messages: [] }
  for (let i = 0; i < n; i++) conv.messages.push({ ...msg, id: `m-${i}` })
  return JSON.stringify(conv, null, pretty ? 2 : 0)
}

const dir = mkdtempSync(join(tmpdir(), 'jsll-bench-'))
const target = join(dir, 'conv.json')
const rows = []
try {
  // ① atomicWrite 在各载荷下的耗时（主进程阻塞时长 = 这个数）
  for (const kb of [2, 8, 50, 100, 512, 1024, 5120, 10240]) {
    const data = makeConvJson(kb * 1024, true)
    const actualKB = (Buffer.byteLength(data, 'utf8') / 1024).toFixed(0)
    const ms = bench(() => atomicWrite(target, data))
    rows.push({ item: 'atomicWrite（写+fsync+改名）', size: `${kb}KB→${actualKB}KB`, ms })
  }
  // ② 全量读（openConversation 的 getConversation 落主进程后的读盘成本）
  for (const kb of [50, 512, 5120]) {
    const data = makeConvJson(kb * 1024, true)
    writeFileSync(target, data, 'utf8')
    const ms = bench(() => readFileSync(target, 'utf8'))
    rows.push({ item: 'readFileSync 全量读', size: `${kb}KB`, ms })
  }
  // ③ 格式化 JSON 的代价：体积膨胀 + stringify 时间
  for (const kb of [50, 1024, 5120]) {
    const data = makeConvJson(kb * 1024, false)
    const obj = JSON.parse(data)
    const compactMs = bench(() => JSON.stringify(obj))
    const prettyMs = bench(() => JSON.stringify(obj, null, 2))
    const compactB = Buffer.byteLength(JSON.stringify(obj))
    const prettyB = Buffer.byteLength(JSON.stringify(obj, null, 2))
    rows.push({
      item: `格式化代价（compact ${compactMs.toFixed(3)}ms vs pretty ${prettyMs.toFixed(3)}ms）`,
      size: `${kb}KB`,
      ms: prettyMs,
      note: `体积 ${(prettyB / compactB).toFixed(1)} 倍`
    })
  }
  // ④ 空操作基线（rename+fsync 的固定开销，不随载荷涨的部分）
  const tiny = makeConvJson(200, true)
  const fixed = bench(() => atomicWrite(target, tiny), { rounds: 50 })
  rows.push({ item: 'atomicWrite 固定开销（≈200B 载荷）', size: '~KB', ms: fixed })

  console.log('\n=== plan29 S4 · 主进程同步 I/O 微基准（中位数，30 轮）===')
  console.log('平台:', process.platform, 'node', process.version)
  for (const r of rows) {
    const ms = typeof r.ms === 'number' ? r.ms.toFixed(2) : r.ms
    console.log(`${r.item.padEnd(46)} ${String(r.size).padEnd(12)} ${ms} ms ${r.note ?? ''}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
