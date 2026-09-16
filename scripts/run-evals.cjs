/**
 * L2 在线 eval 的**父进程驱动**（plan25 S3 · D-074）—— 四步：
 *   1. esbuild bundle 真源码到 .evals-tmp/（memory 反思链 + 数据目录引导薄壳，external:electron）
 *   2. spawn electron 子进程跑 scripts/evals-worker.cjs
 *      ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE（本机全局设着它，不清 electron 变纯 Node，
 *      require('electron') 拿不到 app/safeStorage —— probe-main-net.cjs 的教训）
 *   3. 按行扫描 stdout 收 `EVALS_RESULT:<json>`（stderr 透传，保留 EVALS:/EVALS_SKIP: 进度可见）
 *   4. 报告落盘 bench/evals-report-<ts>.json
 *
 * 退出码：0 = 跑完拿到报告（场景内 fail 属 eval 结果，看报告不在此处）；
 *        2 = 环境/凭据问题（无 key / safeStorage 不可用，判据 9 的无 key 路径）；
 *        1 = 骨架问题（bundle 失败 / electron 崩溃 / 超时 / 报告缺失）。
 *
 * 跑法：`npm run evals`（= node scripts/run-evals.cjs）；
 *      `--repeat=3` 每场景跑 3 遍（pass@k 口径下 ≥1 次通过即过）；
 *      `--keep` 保留 .evals-tmp（排查 bundle 产物用）。
 * ⚠️ 真跑会调真实模型 API（按激活档案计费）；判分器全代码判分，无 LLM-as-judge（批 4 n=1 教训）。
 */

const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const process = require('node:process')

const ROOT = process.cwd()
const TMP = join(ROOT, '.evals-tmp')
const BENCH = join(ROOT, 'bench')

const ARG = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const REPEAT = Math.max(1, Number(ARG('repeat', '1')))
const KEEP = process.argv.includes('--keep')
const TIMEOUT_MS = Math.max(60000, Number(ARG('timeout', '600000'))) // 默认 10 分钟全局兜底

function die(code, msg) {
  console.error(`[run-evals] ${msg}`)
  process.exit(code)
}

// ── 步骤 1：esbuild bundle 真源码 ──
// esbuild 不是直接依赖（electron-vite 的传递依赖），跨平台稳妥走 `node bin/esbuild`
// （probe-data-dir 用过 exe 直跑先例；这里 node 驱动 JS bin 在 win/mac/linux 都成立）。
const esbuildBin = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
if (!existsSync(esbuildBin)) die(1, `esbuild 不存在：${esbuildBin}（先 npm install）`)

const entries = [
  'src/main/memory/memory-core.ts',
  'src/main/memory/reflection.ts',
  'src/main/memory/reflection-prompt.ts',
  'src/main/providers/url.ts',
  'src/main/bootstrap-data-dir.ts'
]
for (const e of entries) {
  if (!existsSync(join(ROOT, e))) die(1, `入口不存在：${e}`)
}

// ⚠️ esbuild 多入口按公共祖先（src/main）保留子目录结构 —— 路径必须与实际输出一致
const required = [
  '.evals-tmp/memory/memory-core.js',
  '.evals-tmp/memory/reflection.js',
  '.evals-tmp/memory/reflection-prompt.js',
  '.evals-tmp/providers/url.js',
  '.evals-tmp/bootstrap-data-dir.js'
]

console.error('[run-evals] bundling 真源码 → .evals-tmp/ …')
const build = spawnSync(
  process.execPath,
  [
    esbuildBin,
    ...entries,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--alias:@shared=./src/shared',
    '--alias:@main=./src/main',
    '--external:electron',
    `--outdir=${TMP}`,
    '--log-level=warning'
  ],
  { cwd: ROOT, encoding: 'utf8', timeout: 60000 }
)
if (build.status !== 0 || build.error) {
  die(1, `bundle 失败：${build.error || (build.stderr || '').slice(0, 500)}`)
}
for (const f of required) {
  if (!existsSync(join(ROOT, f))) die(1, `产物缺失：${f}（bundle 输出：${(build.stderr || '').slice(0, 300)}）`)
}

// ── 步骤 2 + 3：spawn electron worker，按行收报告 ──
const electronBin = require('electron') // 纯 Node 里返回可执行文件路径（bench 同款）
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 本机全局设着它 —— 不清 electron 变纯 Node（probe-main-net 教训）
env.JSL_EVAL_REPEAT = String(REPEAT)

console.error(`[run-evals] spawn electron（repeat=${REPEAT}）…`)
const child = spawn(electronBin, ['scripts/evals-worker.cjs'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

let resultLine = null
let stdoutBuf = ''
child.stdout.on('data', (chunk) => {
  stdoutBuf += String(chunk)
  let idx
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx)
    stdoutBuf = stdoutBuf.slice(idx + 1)
    if (line.startsWith('EVALS_RESULT:')) resultLine = line.slice('EVALS_RESULT:'.length)
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk)) // EVALS:/EVALS_SKIP: 进度透传

const timer = setTimeout(() => {
  console.error(`[run-evals] 超时（${TIMEOUT_MS}ms），杀掉 electron 子进程`)
  child.kill('SIGKILL')
}, TIMEOUT_MS)

child.on('close', (code, signal) => {
  clearTimeout(timer)
  if (code === 2) {
    // EVALS_SKIP 路径：环境/凭据问题。指引已在 stderr（EVALS_SKIP: 行），这里补一句人话。
    console.error('[run-evals] 未真跑：环境/凭据问题（见上方 EVALS_SKIP 行）。')
    console.error('[run-evals] 配置指引：启动应用 → 设置 → 模型档案，配好 baseURL/model 并保存 API Key 后重试。')
    process.exit(2)
  }
  if (code !== 0) {
    die(1, `electron worker 异常退出（code=${code}${signal ? ` signal=${signal}` : ''}）`)
  }
  if (!resultLine) {
    die(1, 'worker 退出码 0 但没有 EVALS_RESULT 行（报告缺失）')
  }

  // ── 步骤 4：报告落盘 ──
  let report
  try {
    report = JSON.parse(resultLine)
  } catch (err) {
    die(1, `EVALS_RESULT 不是合法 JSON：${String(err).slice(0, 120)}`)
  }
  mkdirSync(BENCH, { recursive: true })
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const out = join(BENCH, `evals-report-${ts}.json`)
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8')

  console.error(`[run-evals] 报告已写入 ${out}`)
  for (const r of report.results || []) {
    console.error(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.passCount}/${r.repeat}  ${r.desc}`)
  }
  console.error(
    `[run-evals] 汇总：${(report.summary && report.summary.passed) ?? '?'}/${(report.summary && report.summary.scenarios) ?? '?'} 场景通过（pass@k）`
  )

  if (!KEEP) {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      // 清理是锦上添花：宿主安全护栏（bulk-delete 阈值）/文件占用都会拦 rm ——
      // 不能让 eval 的成功被收尾失败吞掉。残留 .evals-tmp 已在 .gitignore，下次运行覆盖。
      console.error(`[run-evals] 提示：.evals-tmp 未自动清理（护栏或占用拦截），可手动删除`)
    }
  }
  process.exit(0)
})

child.on('error', (err) => {
  clearTimeout(timer)
  die(1, `spawn electron 失败：${err.message}`)
})
