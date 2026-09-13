/**
 * **真机探针**：数据目录引导端到端（plan10 §6.2 存储通道 —— 补单测覆盖不到的「真 Electron 进程 + 真薄壳组装」）。
 *
 * 每个 phase 一个独立 Electron 进程（迁移本来就发生在「下次启动」，两段进程是语义本身）：
 *   phase 1  前向迁移：预写 pending location.json → require 薄壳 → 迁移发生、老目录逐文件哈希不变
 *   phase 2  幂等二次启动：无重复迁移、lastEvent 不被平静启动抹掉、数据零写入
 *   phase 3  回退：pending = 默认目录 → restore-backup-* 挪旧数据 → 反向迁移回位、自定义目录原样保留
 *   phase 4  JSL_DATA_DIR 直达：env 最高优先、不读不写 location.json
 *
 * 沙箱：全在 <root>/.verify-data-dir-probe/ 下（appData 锚点重定向到沙箱，零污染真用户数据）。
 * 断言全部由探针自带的哈希清单完成（**不复用被测代码** —— 用被测实现对账被测行为是自证）。
 *
 * 运行（驱动 bash 串联，exit code 即结论）：
 *   PROBE_PHASE=1 env -u ELECTRON_RUN_AS_NODE npx electron scripts/probe-data-dir.cjs
 *   （phase 2/3/4 同理；全绿后驱动脚本删除沙箱目录）
 */
const { app } = require('electron')
const { createHash } = require('node:crypto')
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { join, sep } = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const PROBE = join(ROOT, '.verify-data-dir-probe')
const BUILD = join(PROBE, 'build')
const PHASE = process.env['PROBE_PHASE'] ?? '1'
const trace = (msg) => console.log('[trace] ' + msg)
trace('probe entry pid=' + process.pid + ' phase=' + PHASE + ' at=' + new Date().toISOString())

// 沙箱路径：T1 = 假 appData；DEFAULT_UD = 默认 userData（= 锚点目录，与真应用同构）；T2/T4 = 目标目录
const T1 = join(PROBE, 'sandbox')
const DEFAULT_UD = join(T1, 'probe-app')
const T2 = join(PROBE, 'custom-target')
const T4 = join(PROBE, 'env-target')
const LOCATION = join(DEFAULT_UD, 'location.json')

// ── 断言器（精简版 checkTrue：!! 布尔化，杜绝「&& 链末位落在对象上」那类严判坑）──
const checks = []
function ok(name, cond, actual) {
  checks.push({ name, pass: !!cond, actual: actual === undefined ? cond : actual })
}
function finish(extra) {
  const failed = checks.filter((c) => !c.pass)
  console.log(
    'PROBE_RESULT=' + JSON.stringify({ phase: PHASE, total: checks.length, failed: failed.length, ...extra })
  )
  for (const c of failed) {
    console.log('FAIL: ' + c.name + '  实际=' + JSON.stringify(c.actual))
  }
  app.exit(failed.length > 0 ? 1 : 0)
}

// ── 探针自带的哈希清单（独立于被测代码）──
function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}
function walkSnapshot(dir, base, excludeTop, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // 顶层条目（文件/目录都可能）排除 —— ⚠️ 必须在分支前判，只判目录分支会漏掉顶层文件
    if (dir === base && excludeTop.includes(e.name)) continue
    if (e.isDirectory()) {
      walkSnapshot(join(dir, e.name), base, excludeTop, out)
    } else {
      const abs = join(dir, e.name)
      const rel = abs.slice(base.length + 1).split(sep).join('/')
      out[rel] = sha256File(abs)
    }
  }
  return out
}
function snapshot(dir, excludeTop) {
  return walkSnapshot(dir, dir, excludeTop ?? [], {})
}
function diffSnap(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const problems = []
  for (const k of keys) {
    if (!(k in a)) problems.push('多出: ' + k)
    else if (!(k in b)) problems.push('丢失: ' + k)
    else if (a[k] !== b[k]) problems.push('变了: ' + k)
  }
  return problems
}

// 自有数据（5 个文件，跨 3 个顶层条目：conversations/ + logs/ + 两个散文件）
const OWN_FILES = [
  'conversations/a.json',
  'conversations/b.json',
  'settings.json',
  'models.json',
  'logs/app.log'
]
function seedOwnData() {
  mkdirSync(join(DEFAULT_UD, 'conversations'), { recursive: true })
  mkdirSync(join(DEFAULT_UD, 'logs'), { recursive: true })
  writeFileSync(join(DEFAULT_UD, 'conversations/a.json'), '{"title":"会话A","messages":[1,2,3]}', 'utf8')
  writeFileSync(join(DEFAULT_UD, 'conversations/b.json'), '{"title":"会话B"}', 'utf8')
  writeFileSync(join(DEFAULT_UD, 'settings.json'), '{"theme":"dark","fontSize":14}', 'utf8')
  writeFileSync(join(DEFAULT_UD, 'models.json'), '{"deepseek":"deepseek-chat"}', 'utf8')
  writeFileSync(
    join(DEFAULT_UD, 'logs/app.log'),
    '2026-09-14T00:00:00Z 启动\n2026-09-14T00:01:00Z 会话创建\n',
    'utf8'
  )
}
function seedChromiumJunk() {
  mkdirSync(join(DEFAULT_UD, 'Cache'), { recursive: true })
  mkdirSync(join(DEFAULT_UD, 'GPUCache'), { recursive: true })
  writeFileSync(join(DEFAULT_UD, 'Cache/data_1'), 'x'.repeat(1024))
  writeFileSync(join(DEFAULT_UD, 'Cache/index'), 'cache-index')
  writeFileSync(join(DEFAULT_UD, 'GPUCache/index'), 'gpu-index')
  writeFileSync(join(DEFAULT_UD, 'Preferences'), '{"download":{"default_directory":"X"}}', 'utf8')
  writeFileSync(join(DEFAULT_UD, 'Local State'), '{"os":{"crypt":{}}}', 'utf8')
}

// 薄壳打包：**不能用 esbuild 的 JS API** —— 它靠 stdio 与 esbuild.exe 子进程通信，在 Electron 主进程里
// 与探针自己的 stdout 管道互扰（实测：偶发整进程挂死、产物双执行）。改 spawnSync 直跑 esbuild.exe 二进制。
function buildShell() {
  mkdirSync(BUILD, { recursive: true })
  const exe = join(ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
  const res = spawnSync(
    exe,
    [
      join(ROOT, 'src/main/bootstrap-data-dir.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:electron',
      '--outfile=' + join(BUILD, 'bootstrap-data-dir.cjs'),
      // ⚠️ 决定性插桩：banner 在产物文件最顶部 —— 模块体（文件顶层）每被评估一次就打一次。
      //    若薄壳在同一进程被执行两次，这里会出现两行 bundle-evaluated。
      '--banner:js=console.log(\'[trace] bundle module evaluated pid=\' + process.pid + \' at=\' + new Date().toISOString())',
      '--log-level=warning'
    ],
    { encoding: 'utf8', timeout: 60000 }
  )
  if (res.status !== 0 || res.error) {
    console.log(
      'PROBE_RESULT=' + JSON.stringify({ phase: PHASE, esbuild: 'failed', stderr: (res.stderr || '').slice(0, 500) })
    )
    app.exit(1)
    return null
  }
  return join(BUILD, 'bootstrap-data-dir.cjs')
}

/** 薄壳 require 前的沙箱重定向（顺序铁律：先 setName/setPath，后 require —— 薄壳模块体自执行） */
function redirectToSandbox() {
  app.setName('probe-app')
  app.setPath('appData', T1)
}

// ─────────────────────────────────────────────────────────────
// phase 1：前向迁移（默认 → 自定义，pending 驱动）
// ─────────────────────────────────────────────────────────────
function phase1() {
  rmSync(PROBE, { recursive: true, force: true })
  mkdirSync(DEFAULT_UD, { recursive: true })
  seedOwnData()
  seedChromiumJunk()

  const M0 = snapshot(DEFAULT_UD, ['location.json'])
  writeFileSync(LOCATION, JSON.stringify({ pendingDataDir: T2 }), 'utf8')

  const shell = buildShell()
  redirectToSandbox()
  trace('phase1 before require at=' + new Date().toISOString())
  const boot = require(shell)
  trace('phase1 after require at=' + new Date().toISOString())
  ok('薄壳把 userData 指向新目录（后续 store 全部落新目录）', app.getPath('userData') === T2, app.getPath('userData'))
  const oc = boot.getBootstrapOutcome()
  ok(
    'outcome：activeDir=T2 / custom / 非 env / 迁移成功 5 文件非零字节',
    oc.activeDir === T2 && oc.custom === true && oc.envOverride === false &&
      oc.migrated !== null && oc.migrated.ok === true &&
      oc.migrated.filesCopied === 5 && oc.migrated.bytesCopied > 0,
    oc.migrated ? { activeDir: oc.activeDir, custom: oc.custom, migrated: oc.migrated } : oc
  )
  for (const rel of OWN_FILES) {
    const abs = join(T2, rel.split('/').join(sep))
    ok('新目录自有文件逐字节一致：' + rel, existsSync(abs) && sha256File(abs) === M0[rel], {
      exists: existsSync(abs)
    })
  }
  ok(
    '新目录无 Chromium 残留（排除法迁移：Cache/GPUCache/Preferences/Local State 留在原处）',
    !existsSync(join(T2, 'Cache')) && !existsSync(join(T2, 'GPUCache')) &&
      !existsSync(join(T2, 'Preferences')) && !existsSync(join(T2, 'Local State')),
    readdirSync(T2)
  )
  ok('新目录无 location.json（锚点不随迁）', !existsSync(join(T2, 'location.json')))
  ok('新目录有 data.lock（数据目录锁已落位）', existsSync(join(T2, 'data.lock')))

  const M1 = snapshot(DEFAULT_UD, ['location.json'])
  ok('老目录逐文件哈希不变（原目录保留作为回退点）', diffSnap(M0, M1).length === 0, diffSnap(M0, M1))

  const cfg = JSON.parse(readFileSync(LOCATION, 'utf8'))
  ok(
    'location.json：dataDir=T2、pending 已清、lastEvent=ok 且文本含新路径',
    cfg.dataDir === T2 && cfg.pendingDataDir === undefined &&
      cfg.lastEvent && cfg.lastEvent.kind === 'ok' && cfg.lastEvent.text.indexOf(T2) >= 0,
    cfg
  )
  boot.releaseBootstrapLock()
  finish({ customTarget: T2 })
}

// ─────────────────────────────────────────────────────────────
// phase 2：幂等二次启动（沿用 phase 1 的盘上状态）
// ─────────────────────────────────────────────────────────────
function phase2() {
  const shell = buildShell()
  const M2a = snapshot(T2, ['data.lock', 'location.json'])
  redirectToSandbox()
  trace('phase2 before require at=' + new Date().toISOString())
  const boot = require(shell)
  trace('phase2 after require at=' + new Date().toISOString())
  const oc = boot.getBootstrapOutcome()

  ok(
    '二次启动：activeDir=T2 / custom / 无重复迁移 / 非 env',
    oc.activeDir === T2 && oc.custom === true && oc.envOverride === false && oc.migrated === null,
    oc
  )
  ok('userData 仍是 T2', app.getPath('userData') === T2, app.getPath('userData'))

  const M2b = snapshot(T2, ['data.lock', 'location.json'])
  ok('平静启动对数据零写入（逐文件哈希不变）', diffSnap(M2a, M2b).length === 0, diffSnap(M2a, M2b))

  const cfg = JSON.parse(readFileSync(LOCATION, 'utf8'))
  ok(
    'lastEvent 不被平静启动抹掉（「最近一次」语义）',
    cfg.lastEvent && cfg.lastEvent.kind === 'ok' && cfg.lastEvent.text.indexOf(T2) >= 0 && cfg.dataDir === T2,
    cfg
  )
  boot.releaseBootstrapLock()
  finish({})
}

// ─────────────────────────────────────────────────────────────
// phase 3：回退（自定义 → 默认，pending === 默认目录）
// ─────────────────────────────────────────────────────────────
function phase3() {
  console.log('[trace] phase3 start pid=' + process.pid + ' ppid=' + process.ppid + ' at=' + new Date().toISOString())
  const shell = buildShell()
  console.log('[trace] built at=' + new Date().toISOString())
  const M3 = snapshot(T2, ['data.lock', 'location.json'])
  writeFileSync(LOCATION, JSON.stringify({ dataDir: T2, pendingDataDir: DEFAULT_UD }), 'utf8')

  redirectToSandbox()
  console.log('[trace] before require at=' + new Date().toISOString())
  const boot = require(shell)
  console.log('[trace] after require at=' + new Date().toISOString())
  const oc = boot.getBootstrapOutcome()

  ok(
    '回退：activeDir=默认 / 非自定义 / 迁移成功',
    oc.activeDir === DEFAULT_UD && oc.custom === false && oc.migrated !== null && oc.migrated.ok === true,
    oc.migrated ? { activeDir: oc.activeDir, custom: oc.custom, migrated: oc.migrated } : oc
  )
  ok(
    'movedAside = 4 个顶层条目（conversations/settings.json/models.json/logs）',
    Array.isArray(oc.movedAside) && oc.movedAside.length === 4 &&
      ['conversations', 'settings.json', 'models.json', 'logs'].every((n) => oc.movedAside.includes(n)),
    oc.movedAside
  )
  const rbName = readdirSync(DEFAULT_UD).find((n) => n.startsWith('restore-backup-'))
  ok('默认目录出现 restore-backup-* 目录', !!rbName, readdirSync(DEFAULT_UD))
  if (rbName) {
    const rb = join(DEFAULT_UD, rbName)
    ok(
      'restore-backup 内旧数据原样（settings.json 与自定义目录当前内容同哈希）',
      existsSync(join(rb, 'settings.json')) && sha256File(join(rb, 'settings.json')) === sha256File(join(T2, 'settings.json')),
      { rb: rbName }
    )
  }
  for (const rel of OWN_FILES) {
    const dAbs = join(DEFAULT_UD, rel.split('/').join(sep))
    const tAbs = join(T2, rel.split('/').join(sep))
    ok('回位后内容与自定义目录一致：' + rel, existsSync(dAbs) && sha256File(dAbs) === sha256File(tAbs))
  }
  const M3b = snapshot(T2, ['data.lock', 'location.json'])
  ok('自定义目录原样保留（回退点不丢）', diffSnap(M3, M3b).length === 0, diffSnap(M3, M3b))

  const cfg = JSON.parse(readFileSync(LOCATION, 'utf8'))
  ok(
    'location.json：回到默认档（dataDir/pending 清空、lastEvent=ok 含「回退」）',
    cfg.dataDir === undefined && cfg.pendingDataDir === undefined &&
      cfg.lastEvent && cfg.lastEvent.kind === 'ok' && cfg.lastEvent.text.indexOf('回退') >= 0,
    cfg
  )
  boot.releaseBootstrapLock()
  finish({})
}

// ─────────────────────────────────────────────────────────────
// phase 4：JSL_DATA_DIR 直达（env 最高优先，location.json 有指针也不读不写）
// ─────────────────────────────────────────────────────────────
function phase4() {
  const shell = buildShell()
  // 模拟自定义档（有指针）：如果薄壳错误地读了 location.json，activeDir 就会是 T2 而不是 T4
  writeFileSync(LOCATION, JSON.stringify({ dataDir: T2 }), 'utf8')
  const cfgBefore = readFileSync(LOCATION, 'utf8')
  process.env['JSL_DATA_DIR'] = T4

  redirectToSandbox()
  const boot = require(shell)
  const oc = boot.getBootstrapOutcome()

  ok(
    'env 直达：activeDir=T4 / envOverride / custom / 无迁移',
    oc.activeDir === T4 && oc.envOverride === true && oc.custom === true && oc.migrated === null,
    oc
  )
  ok('userData = T4', app.getPath('userData') === T4, app.getPath('userData'))
  ok('T4 已创建且有 data.lock', existsSync(T4) && existsSync(join(T4, 'data.lock')))
  ok('location.json 不被 env 分支改动（不读不写）', readFileSync(LOCATION, 'utf8') === cfgBefore)
  boot.releaseBootstrapLock()
  finish({ envTarget: T4 })
}

const RUNNERS = { '1': phase1, '2': phase2, '3': phase3, '4': phase4 }
const runner = RUNNERS[PHASE]
if (!runner) {
  console.log('PROBE_RESULT=' + JSON.stringify({ phase: PHASE, error: 'unknown PROBE_PHASE' }))
  app.exit(1)
} else {
  runner()
}
