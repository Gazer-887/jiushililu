/**
 * bench:all —— 一条命令聚合基准读数（plan26 S4，判据 8）。
 *
 * 产出（都在 bench/，git 忽略）：
 *   bench-all-<ts>.json   本轮机器可读聚合（vitest bench json + evals 摘要 + 环境对照）
 *   bench-all-latest.md   人话摘要：与上一轮对比；首跑标 baseline；evals 缺席明示「无 evals 读数」
 *
 * ⚠️ 环境对照是**必须项**：本项目实测 Windows Defender 实时防护会把逐文件同步读抬高
 *   ~0.4ms/文件（裸 readFileSync 与产品代码同速），阈值判读必须带着这条看（见 problem.md 09-17）。
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const BENCH = join(ROOT, 'bench')
const TS = new Date().toISOString().replace(/[:.]/g, '-')

function envProbeMsPerFile() {
  const dir = join(tmpdir(), `jsl-env-probe-${TS}`)
  mkdirSync(dir, { recursive: true })
  try {
    for (let i = 0; i < 100; i += 1) writeFileSync(join(dir, `p${i}.md`), '正文。'.repeat(12), 'utf8')
    const files = Array.from({ length: 100 }, (_, i) => join(dir, `p${i}.md`))
    const samples = []
    for (let r = 0; r < 15; r += 1) {
      const t0 = performance.now()
      for (const f of files) readFileSync(f, 'utf8')
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    return Number((samples[7] / 100).toFixed(3))
  } finally {
    try {
      readdirSync(dir).forEach((f) => {
        try { require('node:fs').unlinkSync(join(dir, f)) } catch { /* 留给系统清 */ }
      })
      require('node:fs').rmdirSync(dir)
    } catch { /* 同上 */ }
  }
}

console.log('[bench:all] 1/3 跑 vitest bench（json 报告器）…')
let benchJson = null
try {
  execFileSync('npx', ['vitest', 'run', '--config', 'config/vitest.bench.config.ts',
    '--reporter=json', `--outputFile=bench/bench-all-${TS}.json`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
} catch (err) {
  // 阈值超标会让 bench 以非零退出 —— 读数照收，PASS/FAIL 在报告里体现
  if (!existsSync(join(BENCH, `bench-all-${TS}.json`))) throw err
}
try {
  benchJson = JSON.parse(readFileSync(join(BENCH, `bench-all-${TS}.json`), 'utf8'))
} catch {
  console.error('[bench:all] bench json 读取失败'); process.exit(1)
}

const tests = []
for (const t of benchJson.testResults || []) {
  for (const a of t.assertionResults || []) {
    tests.push({
      file: t.name.replace(/\\/g, '/').split('/').pop(),
      title: a.title,
      status: a.status,
      durationMs: a.duration == null ? null : Math.round(a.duration),
      failFirst: a.status === 'failed' ? String((a.failureMessages || [])[0] || '').split('\n')[0] : null
    })
  }
}

console.log('[bench:all] 2/3 找 evals 最新读数…')
let evals = null
if (existsSync(BENCH)) {
  const reports = readdirSync(BENCH).filter((f) => /^evals-report-.*\.json$/.test(f))
    .map((f) => ({ f, m: statSync(join(BENCH, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (reports.length > 0) {
    try {
      const r = JSON.parse(readFileSync(join(BENCH, reports[0].f), 'utf8'))
      evals = { file: reports[0].f, at: new Date(reports[0].m).toISOString(),
        passed: r.summary?.passed ?? null, scenarios: r.summary?.scenarios ?? null }
    } catch { /* 坏档按缺席处理 */ }
  }
}

console.log('[bench:all] 3/3 环境对照（裸同步读 ms/文件）…')
const envMs = envProbeMsPerFile()

// 上一轮读数（排除本轮）
const prevs = existsSync(BENCH)
  ? readdirSync(BENCH).filter((f) => /^bench-all-.*\.json$/.test(f) && f !== `bench-all-${TS}.json`)
    .map((f) => ({ f, m: statSync(join(BENCH, f)).mtimeMs })).sort((a, b) => b.m - a.m)
  : []
let prevMap = null
if (prevs.length > 0) {
  try {
    const p = JSON.parse(readFileSync(join(BENCH, prevs[0].f), 'utf8'))
    prevMap = new Map((p.tests || []).map((t) => [`${t.file}::${t.title}`, t]))
  } catch { /* 坏档当无上次 */ }
}
const isBaseline = prevMap === null

const aggregate = { ts: TS, envProbeMsPerFile: envMs, baseline: isBaseline, tests, evals }
writeFileSync(join(BENCH, `bench-all-${TS}.json`), JSON.stringify(aggregate, null, 2) + '\n', 'utf8')

const failed = tests.filter((t) => t.status === 'failed')
const lines = []
lines.push(`# bench:all 聚合报告 · ${TS}`, '')
lines.push(`- 环境对照：**裸同步读 ${envMs} ms/文件**（阈值判读先看这条——Defender 实时防护开着时底噪即 ~0.4-0.5）`)
lines.push(isBaseline
  ? '- **baseline（首跑，无上次读数可比）**'
  : `- 对比上次读数：\`${prevs[0].f}\``, '')
lines.push('| 结果 | 用例 | 用时 | 上次 | Δ |')
lines.push('|:--:|---|--:|--:|--:|')
for (const t of tests) {
  const p = prevMap && prevMap.get(`${t.file}::${t.title}`)
  const mark = t.status === 'failed' ? '❌' : '✅'
  const dur = t.durationMs == null ? '-' : `${t.durationMs}ms`
  const pdur = p && p.durationMs != null ? `${p.durationMs}ms` : '-'
  const delta = p && p.durationMs != null && t.durationMs != null
    ? `${t.durationMs >= p.durationMs ? '+' : ''}${(((t.durationMs - p.durationMs) / Math.max(1, p.durationMs)) * 100).toFixed(0)}%`
    : (p && p.status !== t.status ? '状态变化' : '-')
  lines.push(`| ${mark} | ${t.file} ${t.title.slice(0, 40)} | ${dur} | ${pdur} | ${delta} |`)
}
if (failed.length > 0) {
  lines.push('', '## 失败详情')
  for (const f of failed) lines.push(`- **${f.file} ${f.title}**：${f.failFirst}`)
}
lines.push('', '## evals',
  evals ? `最新读数 \`${evals.file}\`（${evals.at}）：pass@k ${evals.passed}/${evals.scenarios}（bench:all 不代跑 evals，需要时 ` + '`npm run evals`）'
    : '**无 evals 读数**（`npm run evals` 产出后自动纳入）', '')
writeFileSync(join(BENCH, 'bench-all-latest.md'), lines.join('\n'), 'utf8')

console.log(`[bench:all] 聚合完成：${tests.length} 条读数，失败 ${failed.length} 条`)
console.log(`[bench:all] 报告：bench/bench-all-${TS}.json · bench/bench-all-latest.md（环境对照 ${envMs} ms/文件${isBaseline ? ' · baseline 首跑' : ''}）`)
process.exit(failed.length > 0 ? 1 : 0)
