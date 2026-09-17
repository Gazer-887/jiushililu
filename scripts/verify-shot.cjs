/**
 * **真实渲染门禁**：先 npm run build，再 node scripts/verify-shot.cjs → 量几何尺寸 → 截图（产出 verify-*.png）。
 * 本脚本独立于应用主进程，故自行 stub 全部 IPC handler —— 它验的是布局几何，不是数据流。
 * ⚠️ 嵌入片段（executeJavaScript 的模板字符串）里不许出现反引号，见下面的自检函数。
 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')

const ROOT = process.cwd()

/** 自检：模板字符串（executeJavaScript 的嵌入片段）里不许出现反引号 —— 它会提前结束模板，而 node --check
 *  查不出来，只在运行时炸出与现场无关的 ReferenceError。判据：模板内部注释行上出现反引号即违规。 */
function selfCheckEmbeddedBackticks() {
  const lines = readFileSync(__filename, 'utf8').split('\n')
  // ⚠️ 不能用反引号字面量去数反引号：函数自己的源码里出现一个就会打乱状态机、误报大半个文件，
  //    取这个字符一律走 charCode。
  const TICK = String.fromCharCode(96)
  const countTicks = (s) => s.split(TICK).length - 1
  const bad = []
  let inTemplate = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const ticks = countTicks(line)
    if (!inTemplate) {
      if (ticks % 2 === 1) inTemplate = true
      continue
    }
    if (ticks > 0 && line.includes('//')) bad.push(i + 1)
    if (ticks % 2 === 1) inTemplate = false
  }
  if (bad.length > 0) {
    console.log('BACKTICK_SELFCHECK=failed at lines ' + bad.join(', '))
    for (const n of bad) console.log('  ' + n + ': ' + lines[n - 1].trim())
    console.log('==== 模板字符串里的注释不许写反引号：它会把模板提前结束，')
    console.log('     而 node --check 查不出来，只在运行时炸出一句和现场无关的 ReferenceError ====')
    process.exit(1)
  }
  console.log('BACKTICK_SELFCHECK=ok')
}
selfCheckEmbeddedBackticks()

/** 守卫：构建产物比源码旧就立刻退出 —— 忘了 build 只会拿旧界面把断言全跑一遍，结果与真回归一模一样。
 *  判据：out/ 里最新的文件必须比 src/ 里最新的源文件新（盯单个文件会变成永久假阳性）。
 *  逃生舱：SKIP_FRESH=1（结论不能当回归依据）。 */
function assertBuildFresh() {
  if (process.env.SKIP_FRESH === '1') {
    console.log('FRESH_CHECK=skipped')
    return
  }
  const outputs = [
    join(ROOT, 'out', 'main', 'index.js'),
    join(ROOT, 'out', 'preload', 'index.js'),
    join(ROOT, 'out', 'renderer', 'index.html')
  ]
  const missing = outputs.filter((p) => !existsSync(p))
  if (missing.length > 0) {
    console.log('FRESH_CHECK=missing ' + JSON.stringify(missing))
    console.log('==== 先跑 `npm run build` 再跑门禁 ====')
    process.exit(1)
  }

  let newestSrc = 0
  const newestIn = (dir, tag) => {
    let newest = 0
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) newest = Math.max(newest, newestIn(p, tag))
      else if (tag.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs)
    }
    return newest
  }
  const srcDir = join(ROOT, 'src')
  // ⚠️ 别漏掉 .html：src/renderer/index.html 改了不 build，跑出来的照样是旧界面
  if (existsSync(srcDir)) newestSrc = newestIn(srcDir, /\.(ts|tsx|css|html)$/)
  const viteCfg = join(ROOT, 'config', 'electron.vite.config.ts')
  if (existsSync(viteCfg)) newestSrc = Math.max(newestSrc, statSync(viteCfg).mtimeMs)

  const outDir = join(ROOT, 'out')
  const newestOut = newestIn(outDir, /.*/)

  if (newestSrc > newestOut) {
    const stale = Math.round((newestSrc - newestOut) / 1000)
    console.log(`FRESH_CHECK=stale by ${stale}s`)
    console.log('==== 构建产物比源码旧：现在跑出来的是**旧界面**，结果不能当依据 ====')
    console.log('==== 先跑 `npm run build` 再跑门禁（确要用旧包：SKIP_FRESH=1）====')
    process.exit(1)
  }
  console.log('FRESH_CHECK=ok')
}
assertBuildFresh()
/** 截图统一落 Photo/（用户要求"项目下的图片建档收录"）：验证产出不散在项目根 */
const SHOTS = join(ROOT, 'Photo')
mkdirSync(SHOTS, { recursive: true })
const OUT = join(SHOTS, 'verify-shot.png')

// ⚠️ 每次跑之前必须清空 userData：残留的 Chromium Preferences/Cache 会让拖拽那族探针整片红，
//    而功能没坏 —— 验证工具本身必须可重复，这是它的底线。
const VERIFY_UD = join(ROOT, '.verify-userdata')
try {
  rmSync(VERIFY_UD, { recursive: true, force: true })
} catch (err) {
  console.log(
    'VERIFY_UD_RESET_FAILED=' + (err && err.message ? err.message : String(err))
  )
}
app.setPath('userData', VERIFY_UD)

// ⚠️ 预览协议必须赶在 ready 之前注册（真应用 src/main/index.ts 同位置），迟了拿不到 standard/secure 语义、
//    相对路径解析不了。下面是契约副本（本进程只加载 out/renderer）：真源在 src/shared/html-preview.ts。
protocol.registerSchemesAsPrivileged([
  { scheme: 'jsl-preview', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }
])

// ── 断言器：check(名字, 实际, 期望) / checkTrue(名字, 条件[, 实际值])，结尾一律 reportAndExit() ──
// 原则：只断言“确定的” —— 没有期望值比对的 console.log 等于一把没有刻度的尺子（有 FAIL → exit(1)）。
const checks = []

/** 记录“带 workbench 的 ui-prefs 写盘”调用：拖拽过程一帧都不该写盘，松手后合并写一次 */
const wbSetCalls = []

// ── 造一张真实可解码的 PNG：假 base64 解码失败会让 naturalWidth 恒为 0，故手搓 IHDR + IDAT(zlib) + IEND ──
const zlib = require('node:zlib')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let p = 0
  for (let y = 0; y < h; y++) {
    raw[p++] = 0 // 每行的 filter 字节：0 = none
    for (let x = 0; x < w; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0
      raw[p++] = on ? 0xb0 : 0x3a
      raw[p++] = on ? 0x3a : 0x28
      raw[p++] = on ? 0x28 : 0x6b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型：truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const PNG_BYTES = makePng(48, 32)

// HTML 沙箱预览的测谎仪桩：背景先刷品红、脚本把它改成纯红 —— 像素采样于是能分出三种结局：
// 品红 = 渲染成功 + 脚本被拦（要的就是这个）；纯红 = 脚本真跑了；白/灰 = 根本没渲染出来。
const HTML_STUB = [
  '<!doctype html>',
  '<html lang="zh">',
  '<head><meta charset="utf-8"><title>沙箱预览桩</title></head>',
  '<body style="margin:0;min-height:100vh;background:#ff00aa">',
  '<h1 style="margin:0;padding:24px;font:20px/1.4 sans-serif;color:#111">HTML 沙箱预览桩</h1>',
  "<script>document.body.style.background = '#ff0000'</script>",
  '</body>',
  '</html>'
].join('\n')

function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push({ name, pass, actual, expected })
  return pass
}

function checkTrue(name, cond, actual) {
  const pass = cond === true
  checks.push({ name, pass, actual: actual === undefined ? cond : actual, expected: true })
  return pass
}

function reportAndExit() {
  const failed = checks.filter((c) => !c.pass)
  console.log('CHECKS=' + JSON.stringify({ total: checks.length, failed: failed.length }))
  for (const c of failed) {
    console.log(
      'FAIL: ' + c.name + '  实际=' + JSON.stringify(c.actual) + '  期望=' + JSON.stringify(c.expected)
    )
  }
  if (failed.length > 0) {
    console.log('==== verify-shot 失败：' + failed.length + ' / ' + checks.length + ' 项不匹配 ====')
    app.exit(1)
    return
  }
  console.log('==== verify-shot 通过：' + checks.length + ' 项断言全绿 ====')
  app.exit(0)
}

// 脚本内部抛异常时 Electron 会挂着不退出（表现是“卡到超时”），故显式接住、转成一次带堆栈的失败退出
process.on('unhandledRejection', (err) => {
  console.log('FAIL: 脚本内部异常 → ' + (err && err.stack ? err.stack : String(err)))
  console.log('CHECKS=' + JSON.stringify({ total: checks.length, failed: checks.length + 1 }))
  console.log('==== verify-shot 失败：脚本自身异常 ====')
  app.exit(1)
})

// ⚠️ 同步异常也要接：上面只接了 Promise 链上的拒绝，`uncaughtException` 走的是另一条路，
//    没接住的话 Electron 同样会挂着不退（2026-09-13 实测：一个诊断任务因此空转 1h56m，
//    门禁主进程与两个子进程一直躺在进程表里，直到被外部 taskkill 才消失）。
process.on('uncaughtException', (err) => {
  console.log('FAIL: 脚本内部未捕获异常 → ' + (err && err.stack ? err.stack : String(err)))
  console.log('CHECKS=' + JSON.stringify({ total: checks.length, failed: checks.length + 1 }))
  console.log('==== verify-shot 失败：脚本自身异常 ====')
  app.exit(1)
})

// ⚠️ **看门狗**：门禁最怕的不是失败，是"挂着不动"——失败有 FAIL 行可查，挂着只会空转。
//    触发场景：某个 await 永远不 resolve（窗口没开出来、IPC 没人回、渲染进程卡死）。
//    到点无论卡在哪都带现场退出，保证"跑门禁 = 一定会结束"。
//    正常全量跑约 2 分钟，故 10 分钟是宽裕的安全阈值（不追求精确，只求不会僵尸）。
const WATCHDOG_MS = 10 * 60 * 1000
setTimeout(() => {
  console.log('FAIL: 门禁超时（' + WATCHDOG_MS / 60000 + ' 分钟未结束）—— 有 await 永远没返回')
  console.log(
    'CHECKS=' + JSON.stringify({ total: checks.length, failed: checks.length + 1, done: checks.length })
  )
  console.log('==== verify-shot 失败：看门狗超时 ====')
  app.exit(1)
}, WATCHDOG_MS).unref()

/** 模型档案的公共字段：三条假档案共用一份，只改 id / 名字 / 来源 / Key（复制三份必然漂移） */
const FAKE_PROFILE_BASE = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.deepseek.com',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 200,
  supportsImages: false,
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now()
}

/** 一条假端点：端点 + 模型目录（一把 Key 能调好几个模型），三条模型只描述一次 */
function fakeEndpoint(id, name, firstModel, source, hasApiKey) {
  return {
    ...FAKE_PROFILE_BASE,
    id,
    name,
    source,
    hasApiKey,
    apiKeyMasked: hasApiKey ? 'sk-…abcd' : '',
    models: [
      { id: `${id}-e1`, model: firstModel },
      { id: `${id}-e2`, model: `${firstModel}-mini`, name: '小号' },
      { id: `${id}-e3`, model: `${firstModel}-vision` }
    ],
    activeModelId: `${id}-e1`
  }
}

const settingsView = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 120000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 200,
  supportsImages: false,
  hasApiKey: true,
  apiKeyMasked: 'sk-***'
}

const FAKE_GOALS = [
  {
    id: 'g1',
    conversationId: 'c1',
    text: '把工作台做成每天都能用的东西',
    status: 'active',
    createdBy: 'user',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 3600000
  },
  {
    id: 'g2',
    conversationId: 'c1',
    text: '给核心模块补上端到端测试',
    status: 'paused',
    createdBy: '内核默认',
    createdAt: Date.now() - 7200000,
    updatedAt: Date.now() - 1800000
  }
]

const FAKE_TODOS = [
  { id: 't1', text: '读取工作区里的紫水晶采购清单', status: 'completed' },
  { id: 't2', text: '汇总各品类数量并核对单位', status: 'completed' },
  { id: 't3', text: '生成采购建议文档', status: 'in_progress' },
  { id: 't4', text: '把结果写入工作区并回报', status: 'pending' }
]

const FAKE_SUBAGENTS = [
  {
    runId: 'sub-fake',
    name: 'reviewer',
    index: 0,
    phase: 'end',
    task: '审阅 src/main 下的文件，指出错误处理上的问题',
    startedAt: 1000,
    endedAt: 4200,
    rounds: 3,
    summary: '发现 2 处未捕获异常，已在报告中列出。'
  },
  {
    runId: 'sub-fake',
    name: 'planner',
    index: 1,
    phase: 'start',
    task: '把这批需求拆成可执行的步骤',
    startedAt: 5000
  },
  {
    runId: 'sub-fake',
    name: 'reviewer',
    index: 2,
    phase: 'error',
    task: '审阅构建脚本',
    startedAt: 1000,
    endedAt: 2100,
    error: '模型通道超时'
  }
]

/** 写操作调用流水（验证界面是否真的把动作发下去了，而不只是画了个菜单） */
const fsOpLog = []

/** attach:path 载荷流水 —— 这条通道两个来源共用（文件树给相对路径、系统资源管理器给绝对路径） */
const attachPathCalls = []

const convRollbackCalls = []
const convUndoCalls = []

/** Markdown 轻编辑：fs:write 收到的载荷（要验"冲突基线有没有带上来"） */
const fsWritePayloads = []

/** 逐处退回的调用流水 —— 界面只说退第几处、内容由主进程算，故连 expectedMtimeMs 一起记 */
const revertCalls = []
/** 退过一次之后，`checkpoint:sides` 要回一份"那一处已经不见了"的内容（验界面有没有重取） */
let appHunkOneReverted = false

// 终端假会话：⚠️ 门禁跑不了真 shell，而“重放”必须能验，故 stub 要记住推过什么（只回固定快照 = 自证式断言）
const termChunks = [{ seq: 1, data: 'PS D:\\jsllworkplace_for_test> ' }]
let termSeq = 2
let termStatus = 'running'
/** 会话号：`restart` 会把它 +1 —— 这是"真重启"与"幂等的 start"唯一的可观测差别 */
let termSessionNo = 1
/** 有没有会话：`kill` 之后置 false（`terminal:snapshot` 要据此回 null） */
let termHasSession = true
/** 权限档（门禁可以把它切成 read-only，验"拒绝 + 说明原因"那条路） */
let termPermission = 'write'
let termRestartCalls = 0
/** `terminal:start` 被调用的次数（只读档断言要用它证明"界面试过启动"） */
let termStartCalls = 0
const termSessionId = () => (termSessionNo === 1 ? 'term-probe' : `term-probe-${termSessionNo}`)

// 系统集成（plan7 批 F1）。⚠️ 契约副本：`SystemView` 加字段必须同步加，否则渲染端静默拿到 undefined。
// 做成**可变对象 + 收到的载荷流水**：① 界面勾了要能验载荷与回显；② 翻成"不支持"就能验禁用分支（真主进程里
// 开发态就是这条），而这段只有"重进分区重取真值"才验得到（故渲染端取数挂在 section 上）。
let systemStub = {
  keepRunning: false,
  keepRunningActive: false,
  keepRunningError: null,
  openAtLogin: false,
  openAtLoginActive: false,
  openAtLoginSupported: true,
  openAtLoginReason: null,
  openAtLoginError: null
}
const systemSetCalls = []
/** `system:get` 被调用次数 —— 没有它，"取数失败回落到 `setSys(null)`（未勾选+禁用）"与"存根返回 false"在断言层不可区分 */
let systemGetCalls = 0

// 网络代理（plan7 批 F2）。⚠️ 契约副本：`NetworkView` 加字段必须同步加，否则渲染端静默拿到 undefined。
// 桩**必须有状态、且要复刻真主进程的三条行为**，否则一条都验不到：
//   ① 改档之后「当前生效」要跟着变（代理功能唯一的硬证据就是这一行）；
//   ② 手动档不填地址 = 体检不通过 → 不落盘、不应用、给原因；
//   ③ 地址里的 user:pass 要被**剥走**、界面只回显剥过的地址（凭据不回显）。
let netStub = {
  proxyMode: 'system',
  proxyRules: '',
  hasCredentials: false,
  effective: 'PROXY 127.0.0.1:7897; DIRECT',
  effectiveFor: 'https://api.openai.com',
  effectiveError: null,
  applied: true,
  error: null
}
const netSetCalls = []
/** `net-proxy:get` 调用次数 —— 与 system 同理：没有它就分不清"取到了"与"界面默认值" */
let netGetCalls = 0
/** 系统字体枚举桩（plan7 批 F3）：给一小把有代表性的名字 —— 含中文 family 与空 message */
let fontsStub = { ok: true, fonts: ['Arial', 'Consolas', 'Microsoft YaHei', '微软雅黑'], message: null }
/** ui-prefs 桩改成**有状态**（plan7 批 F3）：字号/字体断言要看"写进去了什么"，无状态桩只能验返回值 */
let uiPrefsStub = {
  sidebarWidth: 248,
  dockWidth: 360,
  theme: 'qingkong',
  fontScale: 'md',
  uiFont: '',
  workbench: { schemaVersion: 1, panes: [] },
  workbenchSizes: { paneWidths: [] }
}
const uiPrefsSetCalls = []
// ── 工作区桩（plan7 批 F4）改**有状态**：恢复默认的断言要看"切过去又切回来"，无状态桩只能验返回值 ──
const WS_STUB_DEFAULT = { path: 'D:\\jsllworkplace_for_test', custom: false }
let wsStub = { ...WS_STUB_DEFAULT }
/** 下一次「选择目录」的结果（null = 取消，对齐真实对话框的默认行为）；断言段先置值再点 */
let wsPickNext = null
const wsResetCalls = []
// ── 存储位置桩（plan10 C 批）：与工作区桩同一套"有状态 + 断言段先置值"的手法 ──
const STORAGE_STUB_DEFAULT = {
  current: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu',
  custom: false,
  pendingDir: null,
  pendingKind: null,
  lastEvent: null
}
let storageStub = { ...STORAGE_STUB_DEFAULT }
let storagePickNext = null
let storagePickCalls = 0
const storageResetCalls = []
const storageUndoCalls = []
/** 让下一次 `system:set` 回一个**载荷没要的值**：只有这样才能证明界面跟着返回值走，而不是乐观更新 */
let systemForceNextSet = null
const makeTermSnapshot = () => ({
  id: termSessionId(),
  cwd: 'D:\\jsllworkplace_for_test',
  workspaceRoot: 'D:\\jsllworkplace_for_test',
  shell: 'PowerShell（未加载 profile）',
  status: termStatus,
  startedAt: Date.now() - 60000,
  cols: 80,
  rows: 24,
  chunks: termChunks.slice(),
  nextSeq: termSeq,
  truncated: false
})

/** 会话保存的调用流水（要验"在别的页面期间流出来的内容有没有被存下来"） */
const convSaveCalls = []

/** 后台任务样例：覆盖 running（带终止按钮）与 done（带退出码）两种渲染 */
const FAKE_BG_TASKS = [
  {
    id: 'bg-1',
    command: 'npm run build',
    cwd: 'D:\\jsllworkplace_for_test',
    agent: '内核默认',
    startedAt: Date.now() - 10000,
    endedAt: Date.now() - 5800,
    status: 'done',
    exitCode: 0,
    output: '> electron-vite build\n✓ built in 1.2s\n',
    truncated: false
  },
  {
    id: 'bg-2',
    command: 'npm run dev',
    cwd: 'D:\\jsllworkplace_for_test',
    agent: '内核默认',
    startedAt: Date.now() - 4200,
    status: 'running',
    output: 'VITE v5.4.21  ready in 320 ms\n',
    truncated: false
  }
]

/** 设置独立窗口的桩：在 whenReady 里赋值（需要 win 已存在），STUBS 表按名调用 */
let openSettingsWinStub = () => Promise.resolve({ ok: true })
let closeSettingsWinStub = () => true

// —— 语音输入（plan45）的桩状态与假音频设备 ——
// ⚠️ 契约副本：真源是 `src/main/voice/transcribe.ts` + store/settings 的 VoiceConfig 形状。
const voiceStubCfg = { endpoint: 'http://127.0.0.1:7101/v1', model: '', language: 'auto', disclosureAccepted: false, hasApiKey: false }
const devEnvStub = {
  groups: [
    { id: 'node', label: 'Node.js', main: [], others: [] },
    {
      id: 'python',
      label: 'Python',
      main: [
        { language: 'python', path: 'D:\\MiniConda3\\envs\\ai_env\\python.exe', version: '3.12.13', alias: 'ai_env', source: 'conda', onPath: false },
        { language: 'python', path: 'D:\\MiniConda3\\python.exe', version: '3.13.13', alias: 'base', source: 'conda', onPath: false },
        { language: 'python', path: 'D:\\hermes-agent\\venv\\Scripts\\python.exe', version: '3.11.15', source: 'venv', onPath: false },
        { language: 'python', path: 'C:\\Program Files\\LibreOffice\\program\\python.exe', version: '3.12.13', source: 'system', onPath: true }
      ],
      others: [{ language: 'python', path: 'D:\\weird\\python.exe', version: '3.8.0', source: 'other', onPath: false }]
    },
    {
      id: 'uv',
      label: 'uv',
      main: [{ language: 'uv', path: 'C:\\Users\\Gazer\\.local\\bin\\uv.exe', version: '0.12.3', source: 'system', onPath: true }],
      others: []
    }
  ],
  selected: { python: 'D:\\MiniConda3\\envs\\ai_env\\python.exe' }
}
const devEnvSelectCalls = []
const mcpStubServers = []
const mcpSaveCalls = []
// R8（Electron 麦克风链路）在 headless 门禁里没法用真麦 —— 用 Chromium 假设备：
// getUserMedia 拿到的是一段可持续产帧的静音音轨，权限弹窗自动放行。
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')

// ── 源代码管理（plan16）的桩：必须是**有状态的** ──
// 返回固定值的桩验不了这条链路：要验的是「勾选 → 这条进『已暂存』组 → 提交 → 列表清空」，
// 也就是**第二次拉到的和第一次不一样**。固定值桩会让每一步都"看起来对"，却一条也没真验到。
// ⚠️ 契约副本：真源是 `src/main/store/git-info.ts` + `src/shared/git-status.ts`
//    （stage 后 X 位从 ' ' 变 'M'/'A'；未跟踪 add 之后是 `A ` 不是 `M `；commit 后列表清空、ahead +1）。
// ── 记忆（plan19 批 1）的桩状态 ──
// ⚠️ **必须有状态**：固定值验不了"保存后列表可见""删除后消失""广播后自动重拉"这条链
//    （照 `git:*` 的口径；那种只记一下调用的全局变量不算桩）。
let memoryBroadcast = () => 0
/** 护栏 2 的推送（D-043）：与 memory:changed 同族，但**带载荷** —— 面板要显示"写了哪几条" */
let memoryNoticeBroadcast = () => 0
// 批 2：候选条目（待批准）。⚠️ 与 memoryEntries 物理分开 —— 候选不进注入索引段
let memoryCandidates = [
  {
    name: 'likes-dark-mode',
    description: '偏好深色界面',
    class: 'style',
    origin: 'reflection',
    evidence: null,
    createdAt: '2026-09-15T02:00:00.000Z',
    updatedAt: '2026-09-15T02:00:00.000Z',
    body: '从历史会话提炼：用户多次切换到深色主题。',
    file: '/mem/candidates/likes-dark-mode.md'
  }
]
let memoryEntries = [
  {
    name: 'prefers-tables',
    description: '回答偏好用表格',
    class: 'style',
    origin: 'user',
    evidence: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    body: '正文。',
    file: '/mem/notes/prefers-tables.md'
  },
  {
    name: 'uses-pnpm',
    description: '本项目包管理用 pnpm',
    class: 'knowledge',
    origin: 'model',
    evidence: { conversationId: 'c1' },
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    body: '正文。',
    file: '/mem/notes/uses-pnpm.md'
  }
]
let memoryWarnings = []
const memorySaveCalls = []
const memoryDeleteCalls = []
/** 批 4：标记「这条不对」的调用流水 */
const memoryFlagCalls = []
// 记忆开关（plan19 批 1）的桩状态；`warnOnNextEnable` 用来模拟"主进程判定这是最大风险组合"
let memorySwitch = false
let memoryWarnOnNextEnable = false
const memorySwitchCalls = []
// ── Playbook（plan19 批 3）的桩状态 ──
let playbookEntries = [
  {
    name: 'edit-react-component',
    description: '编辑 React 组件的标准流程',
    tags: ['file-edit', 'react'],
    origin: 'model',
    createdAt: '2026-09-15T02:00:00.000Z',
    updatedAt: '2026-09-15T02:00:00.000Z',
    body: '正文。',
    file: '/evo/playbooks/edit-react-component.md'
  }
]
const playbookSaveCalls = []
const playbookDeleteCalls = []

// ── 执行事件流（plan26 S2）的桩状态 ──
// 契约副本（真源 src/main/agent/exec-events.ts 的 ExecEvent + main/ipc.ts 的 exec-events:list）：
// 六种 kind 全覆盖 + 一条 sub 作用域 + 一条拒绝审批。时间戳相对现在（相对时间列才渲染得出来）。
const execEventsBase = Date.now()
const FAKE_EXEC_EVENTS = [
  { at: new Date(execEventsBase - 9000).toISOString(), kind: 'run_start', conversationId: 'c1', agentScope: 'main', agentName: '内核默认' },
  { at: new Date(execEventsBase - 8000).toISOString(), kind: 'tool_call', conversationId: 'c1', agentScope: 'main', tool: 'read_file' },
  { at: new Date(execEventsBase - 7500).toISOString(), kind: 'tool_result', conversationId: 'c1', agentScope: 'main', tool: 'read_file', ok: true, ms: 120, bytes: 4096 },
  { at: new Date(execEventsBase - 7000).toISOString(), kind: 'tool_call', conversationId: 'c1', agentScope: 'sub', tool: 'grep' },
  { at: new Date(execEventsBase - 6500).toISOString(), kind: 'tool_result', conversationId: 'c1', agentScope: 'sub', tool: 'grep', ok: false, ms: 30, bytes: 12 },
  { at: new Date(execEventsBase - 5000).toISOString(), kind: 'approve', conversationId: 'c1', agentScope: 'main', tool: 'run_command', allowed: false, reason: 'user' },
  { at: new Date(execEventsBase - 3000).toISOString(), kind: 'trim', conversationId: 'c1', agentScope: 'main', droppedCount: 12, bytes: 65536, summarized: true },
  { at: new Date(execEventsBase - 1000).toISOString(), kind: 'run_end', conversationId: 'c1', agentScope: 'main', rounds: 3, durationMs: 8800, stopReason: 'completed' },
  { at: new Date(execEventsBase - 500).toISOString(), kind: 'run_start', conversationId: 'c2', agentScope: 'main', agentName: '内核默认' }
]
/** exec-events:list 的最后一次入参 —— 「本会话/全部」切换要断言 query 真的变了（不是只改了本地状态） */
let lastExecEventsQuery = null


/** chat:send 的载荷流水 —— "新会话首条不重复"要断言模型只收到一条 user */
const chatSendCalls = []
/** models:set-entry 的调用流水 —— 模型分组下拉「点模型即切」要断言真的发起了切换 */
const modelEntryCalls = []
/** models:fetch-available 的调用流水（plan47 S1）—— 免保存拉取要断言「真的发起了、入参是表单草稿」 */
const fetchAvailableCalls = []
/** 电脑控制开关的当前值与调用流水（2026-09-15 用户需求） */
let ccEnabled = false
const ccCalls = []

let gitBroadcast = () => 0
let gitMode = 'repo' // 'repo' | 'not-repo'
let gitAhead = 0
let gitChanges = [
  { path: 'src/renderer/src/App.tsx', kind: 'modified', staged: ' ', unstaged: 'M' },
  { path: 'README.md', kind: 'modified', staged: ' ', unstaged: 'M' },
  { path: 'docs/新建的笔记.md', kind: 'untracked', staged: '?', unstaged: '?' }
]
const gitStageCalls = []
const gitUnstageCalls = []
const gitCommitCalls = []

/** 复刻 `git add` 对 XY 两位的改写（未跟踪 → `A `，已改 → `M `） */
function applyStage(rels) {
  for (const rel of rels) {
    const hit = gitChanges.find((c) => c.path === rel)
    if (!hit) continue
    if (hit.staged === '?') {
      hit.staged = 'A'
      hit.unstaged = ' '
      hit.kind = 'added'
    } else {
      hit.staged = hit.staged === 'D' ? 'D' : 'M'
      hit.unstaged = ' '
      hit.kind = hit.staged === 'D' ? 'deleted' : 'modified'
    }
  }
}

// ── 子 Agent 管理（plan17）的桩状态：save/delete 后 list 必须看得见（照 git:* 的"有状态"纪律）──
let agentsBroadcast = () => 0
const agentEntries = [
  {
    name: 'planner',
    description: '规划员：把目标拆成有序步骤与验收标准',
    tools: ['read_file'],
    systemPrompt: '做计划。',
    source: 'builtin',
    file: 'C:\\Program Files\\jiushililu\\resources\\agents\\planner.md',
    overridden: false
  },
  {
    name: 'word-smith',
    description: '文案专家：只写文案，不写代码',
    tools: [],
    systemPrompt: '你只写文案。',
    source: 'user',
    file: join(VERIFY_UD, 'agents', 'word-smith.md'),
    overridden: false
  }
]
const agentSaveCalls = []
const agentDeleteCalls = []

/** 复刻 `git restore --staged`（**只动暂存区** —— 工作区的改动还在，故 Y 位回到 'M'） */
function applyUnstage(rels) {
  for (const rel of rels) {
    const hit = gitChanges.find((c) => c.path === rel)
    if (!hit) continue
    if (hit.staged === 'A') {
      hit.staged = '?'
      hit.unstaged = '?'
      hit.kind = 'untracked'
    } else {
      hit.staged = ' '
      hit.unstaged = 'M'
      hit.kind = 'modified'
    }
  }
}

/** 假 unified diff：一带 - 一带 + 一个 @@ 头，够验"增删行有没有被着色" */
const fakeDiff = (rel) =>
  [
    `diff --git a/${rel} b/${rel}`,
    '--- a/' + rel,
    '+++ b/' + rel,
    '@@ -12,3 +12,4 @@',
    ' 这一行没动',
    '-被删掉的这一行',
    '+新增的这一行',
    '+另一行新增'
  ].join('\n')

const STUBS = {
  // 待办清单：面板挂载时拉一次 —— 验的是面板渲染与位置，不是 Agent 会不会调 update_todos
  'todo:get': () => FAKE_TODOS,
  // 目标（plan12）：契约副本 —— 一条进行中 + 一条暂停（覆盖两种状态的行内外观）
  'goal:list': () => [FAKE_GOALS[0], FAKE_GOALS[1]],
  'goal:create': (input) => ({ ...FAKE_GOALS[0], id: 'g-new', text: input?.text ?? '新目标' }),
  'goal:action': (input) => ({ ...FAKE_GOALS[0], id: input?.id ?? 'g1', status: 'done' }),
  'goal:delete': () => undefined,
  // 子代理运行记录（plan7 批 D）：同上，覆盖 start / end / error 三种渲染分支
  'subagent:get': () => FAKE_SUBAGENTS,
  'bg:list': () => FAKE_BG_TASKS,
  'bg:kill': () => true,
  'settings:get': () => settingsView,
  'voice:get-config': () => voiceStubCfg,
  'voice:set-config': (patch) => {
    if (typeof patch?.endpoint === 'string') voiceStubCfg.endpoint = patch.endpoint
    if (typeof patch?.model === 'string') voiceStubCfg.model = patch.model
    if (patch?.language === 'auto' || patch?.language === 'zh' || patch?.language === 'en') voiceStubCfg.language = patch.language
    if (typeof patch?.disclosureAccepted === 'boolean') voiceStubCfg.disclosureAccepted = patch.disclosureAccepted
    if (typeof patch?.apiKey === 'string') voiceStubCfg.hasApiKey = patch.apiKey.length > 0
    else if (patch?.apiKey === null) voiceStubCfg.hasApiKey = false
    return voiceStubCfg
  },
  'voice:transcribe': () => ({ ok: true, text: '语音转写测试文本' }),
  'voice:test': () => ({ ok: true, text: '端点可达，返回格式正确' }),
  // 开发环境（plan43）：⚠️ 契约副本 —— 真源 `src/shared/dev-env.ts` + runtime-detect；
  // 形态按 §2.4 本机实测基线（conda 带别名 / venv / system / other 折叠 / node 空组验「未检测到」）
  'dev-env:detect': () => ({ ...devEnvStub, detectedAt: new Date().toISOString() }),
  'dev-env:select': (language, path) => {
    if (path === null) delete devEnvStub.selected[language]
    else devEnvStub.selected[language] = path
    devEnvSelectCalls.push([language, path])
    return { ...devEnvStub.selected }
  },
  'settings:save': () => settingsView,
  // computer-use 推荐卡片（plan44 S3）：⚠️ 契约副本 —— 真源 mcp-manager listServers/mcpSaveServer
  'mcp:list': () => mcpStubServers.map((config) => ({ config, state: 'connected', tools: [] })),
  'mcp:save': (config) => {
    if (!config?.name) return { ok: false, error: 'name 必填' }
    const i = mcpStubServers.findIndex((s) => s.name === config.name)
    if (i >= 0) mcpStubServers[i] = config
    else mcpStubServers.push(config)
    mcpSaveCalls.push(config)
    return { ok: true }
  },
  'settings:test': () => ({ ok: true, message: 'ok' }),
  'settings:set-model': () => settingsView,
  // 设置独立窗口：齿轮 -> 开新窗 / 窗口内 × -> 关自己。
  // ⚠️ 这里必须**真的建出第二个 BrowserWindow**（不能返回 undefined 了事）—— 下面那一整段设置探针
  //    都靠「找到除 win 之外的窗口」定位目标；桩里不建窗，整段会集体红，且红得像产品坏了。
  // ⚠️ 契约副本：真源 src/main/index.ts 的 openSettingsWindow（900x660、parent、幂等 focus、loadFile + hash）。
  // ⚠️ 参数顺序：处理器统一是 `fn(...args, event)` —— event 在**最后**（close 桩要用它取发起方）。
  'settings:open-window': () => openSettingsWinStub(),
  'settings:close-window': (_unused, event) => closeSettingsWinStub(event),
  // ── 源代码管理（plan16）── 见上方 `gitChanges` 一处：桩是**有状态**的（固定值验不了暂存→提交这条链）
  'git:status': () => {
    if (gitMode !== 'repo') {
      return {
        ok: false,
        view: null,
        message: '当前工作区不是 Git 仓库（或没有提交过） —— 可在终端里执行 git init，或换一个工作区'
      }
    }
    return { ok: true, view: { branch: 'master', changes: gitChanges.map((c) => ({ ...c })), ahead: gitAhead } }
  },
  'git:diff': (rel) => (gitMode === 'repo' ? fakeDiff(rel) : ''),
  'git:stage': (rels) => {
    gitStageCalls.push(rels)
    applyStage(rels ?? [])
    gitBroadcast()
    return { ok: true }
  },
  'git:unstage': (rels) => {
    gitUnstageCalls.push(rels)
    applyUnstage(rels ?? [])
    gitBroadcast()
    return { ok: true }
  },
  'git:commit': (message) => {
    gitCommitCalls.push(message)
    const staged = gitChanges.filter((c) => c.staged !== ' ' && c.staged !== '?')
    if (staged.length === 0) return { ok: false, summary: '', message: 'nothing to commit, working tree clean' }
    gitChanges = gitChanges.filter((c) => c.staged === ' ' || c.staged === '?')
    gitAhead += 1
    gitBroadcast()
    return { ok: true, summary: `[master ${'a1b2c3d'}] ${String(message).split('\n')[0]}` }
  },
  // ── 记忆（plan19 批 1）── 契约副本（真源 `src/main/ipc.ts` 的四个 handler）；
  //    ⚠️ save / delete 必须**改状态 + 广播**，否则下面的"广播后自动重拉"与"删除后消失"两条断言绿得没有意义
  'memory:list': () => ({
    entries: memoryEntries.map((e) => ({ ...e })),
    total: memoryEntries.length,
    omitted: 0,
    warnings: memoryWarnings.slice(),
    candidates: memoryCandidates.map((c) => ({ ...c }))
  }),
  'memory:read': (file) => memoryEntries.find((e) => e.file === file) ?? null,
  'memory:save': (input) => {
    memorySaveCalls.push(input)
    const file = input?.file ?? `/mem/notes/${input?.name ?? 'x'}.md`
    const at = '2026-09-15T02:00:00.000Z'
    const entry = {
      name: input?.name ?? '',
      description: input?.description ?? '',
      class: input?.class ?? 'style',
      origin: input?.origin ?? 'model',
      evidence: input?.evidence ?? null,
      createdAt: at,
      updatedAt: at,
      body: input?.body ?? '',
      file
    }
    memoryEntries = memoryEntries.filter((e) => e.file !== file).concat([entry])
    memoryBroadcast()
    return { ok: true, file, guard: { action: 'allow' } }
  },
  'memory:delete': (file) => {
    memoryDeleteCalls.push(file)
    const before = memoryEntries.length
    memoryEntries = memoryEntries.filter((e) => e.file !== file)
    memoryBroadcast()
    return memoryEntries.length !== before
  },
  // ── 记忆开关（plan19 批 1）── 判据 14 的**界面契约**：真实判定在 src/main/ipc.ts
  //    （关→开 且 permissionPreset === 'full-access'）；门禁不加载它，故用 memoryWarnOnNextEnable 直接给值
  'memory:get-switch': () => memorySwitch,
  'memory:set-switch': (enabled) => {
    const before = memorySwitch
    memorySwitch = enabled
    memorySwitchCalls.push(enabled)
    return { enabled, warnFullAccess: memoryWarnOnNextEnable && enabled && !before }
  },
  // ── 批 2：候选通路（plan19）── approve = 从候选提升到正式条目；reject = 删候选
  'memory:approve': (file) => {
    const cand = memoryCandidates.find((c) => c.file === file)
    if (!cand) return { ok: false, reason: '候选文件不存在' }
    if (cand.conflictWith) {
      // 覆盖旧记忆
      memoryEntries = memoryEntries.map((e) =>
        e.file === cand.conflictWith
          ? { ...cand, file: e.file, origin: e.origin, createdAt: e.createdAt, updatedAt: '2026-09-15T02:01:00.000Z' }
          : e
      )
    } else {
      // 全新提升
      memoryEntries.push({ ...cand, file: `/mem/notes/${cand.name}.md`, origin: 'user' })
    }
    memoryCandidates = memoryCandidates.filter((c) => c.file !== file)
    memoryBroadcast()
    return { ok: true, file: cand.conflictWith ?? `/mem/notes/${cand.name}.md`, guard: { action: 'allow' } }
  },
  'memory:reject': (file) => {
    const before = memoryCandidates.length
    memoryCandidates = memoryCandidates.filter((c) => c.file !== file)
    return memoryCandidates.length !== before
  },
  'memory:stats': () => ({ survivalRate: 0.8, usageRate: 0.3, written: 5, alive: 4, recalled: 1, correctedCount: 2, repeatCorrectedCount: 1, flaggedCount: 1, repeatCorrectionRate: 0.5, falsePositiveRate: 0.2 }),
  // 批 4：用户标记「这条不对」—— 只落事件 + 统计跟着变（契约副本）
  'memory:flag': (name) => {
    memoryFlagCalls.push(name)
    return true
  },
  // ── 会话切换通知（批 2）── 桩只返回 undefined，不触发副作用
  'conv:switch': () => undefined,
  // ── 执行事件流（plan26 S2）── 有状态桩：记录查询入参；按 query 过滤（倒序 = 最新在前）
  'exec-events:list': (query) => {
    lastExecEventsQuery = query ?? null
    const filtered = query?.conversationId
      ? FAKE_EXEC_EVENTS.filter((e) => e.conversationId === query.conversationId)
      : FAKE_EXEC_EVENTS.slice()
    return { events: filtered.slice().reverse(), skipped: 0 }
  },
  // ── Playbook（plan19 批 3）── 有状态桩：save/delete 改状态 + 广播
  'playbook:list': () => ({
    entries: playbookEntries.map((e) => ({ ...e })),
    total: playbookEntries.length,
    omitted: 0,
    warnings: []
  }),
  'playbook:save': (input) => {
    playbookSaveCalls.push(input)
    const file = input?.file ?? `/evo/playbooks/${input?.name ?? 'x'}.md`
    const at = '2026-09-15T02:00:00.000Z'
    const entry = {
      name: input?.name ?? '',
      description: input?.description ?? '',
      tags: input?.tags ?? [],
      origin: input?.origin ?? 'model',
      createdAt: at,
      updatedAt: at,
      body: input?.body ?? '',
      file
    }
    playbookEntries = playbookEntries.filter((e) => e.file !== file).concat([entry])
    return { ok: true, file }
  },
  'playbook:delete': (file) => {
    playbookDeleteCalls.push(file)
    const before = playbookEntries.length
    playbookEntries = playbookEntries.filter((e) => e.file !== file)
    return playbookEntries.length !== before
  },
  // ── 电脑控制开关（2026-09-15 用户需求）── 真值判定在 src/main/ipc.ts；桩同样给"设了就记住"的契约副本
  'computer-control:get': () => ccEnabled,
  'computer-control:set': (enabled) => {
    ccEnabled = enabled
    ccCalls.push(enabled)
    return enabled
  },
  // ── 多模型管理（plan7 F5）—— 契约副本：形态照用户给的那张图（一个官方来源 + 两个自定义）──
  'models:list': () => ({
    profiles: [
      fakeEndpoint('m1', 'DeepSeek-V4 Flash', 'deepseek-v4-flash', 'deepseek', true),
      fakeEndpoint('m2', 'agnes-2.5-flash', 'agnes-2.5-flash', 'custom', false),
      fakeEndpoint('m3', 'deepseek-flash', 'deepseek-flash', 'custom', false)
    ],
    activeId: 'm1',
    filePath: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu\\models.json'
  }),
  // plan47 S1/S2：免保存拉取的契约桩。带状态（记入参）；地址含 ark.cn-beijing 时演 404 档 ——
  // 验「失败给人话 + 指路手填」真的上屏，而不是静默空列表。
  'models:fetch-available': (input) => {
    fetchAvailableCalls.push(input)
    if (String(input?.baseURL || '').includes('ark.cn-beijing')) {
      return { ok: false, message: '此端点不提供模型列表（HTTP 404）：请手动填写模型 ID', models: [] }
    }
    return { ok: true, message: '获取到 2 个模型', models: ['glm-4.5-air', 'glm-4.6'] }
  },
  'models:set-entry': (input) => {
    modelEntryCalls.push({ profileId: input?.profileId, entryId: input?.entryId })
    return {
      profiles: [fakeEndpoint('m1', 'DeepSeek-V4 Flash', 'deepseek-v4-flash', 'deepseek', true)],
      activeId: 'm1',
      filePath: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu\\models.json'
    }
  },
  'models:save': (input) => ({
    ...FAKE_PROFILE_BASE,
    id: input?.id ?? 'm-new',
    name: input?.name || input?.settings?.model || '新模型',
    model: input?.settings?.model ?? 'new-model',
    source: 'custom',
    hasApiKey: Boolean(input?.apiKey),
    apiKeyMasked: input?.apiKey ? 'sk-…new' : ''
  }),
  'models:delete': () => undefined,
  'models:set-active': (id) => ({
    profiles: [
      { ...FAKE_PROFILE_BASE, id: 'm1', name: 'DeepSeek-V4 Flash', model: 'deepseek-v4-flash', source: 'deepseek', hasApiKey: true, apiKeyMasked: 'sk-…abcd' },
      { ...FAKE_PROFILE_BASE, id: 'm2', name: 'agnes-2.5-flash', model: 'agnes-2.5-flash', source: 'custom', hasApiKey: false, apiKeyMasked: '' },
      { ...FAKE_PROFILE_BASE, id: 'm3', name: 'deepseek-flash', model: 'deepseek-flash', source: 'custom', hasApiKey: false, apiKeyMasked: '' }
    ],
    activeId: id,
    filePath: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu\\models.json'
  }),
  'models:test': () => ({ ok: true, message: '连接正常', latencyMs: 42 }),
  'chat:send': (payload) => {
    // 记载荷："新会话首条不重复"要断言发给模型的 messages 里 user 角色只有一条
    chatSendCalls.push(payload)
    return undefined
  },
  'chat:abort': () => undefined,
  'agent:run': () => ({ ok: true, output: '', rounds: 0, stopReason: 'completed', agent: 'x' }),
  'workspace:get': () => ({ ...wsStub }),
  'workspace:pick': () => {
    if (!wsPickNext) return null
    wsStub = { ...wsPickNext }
    wsPickNext = null
    return { ...wsStub }
  },
  'workspace:set-known': () => null,
  // 恢复内置默认（plan7 批 F4）：真办事的桩 —— 改状态、计数，回显新值
  'workspace:reset': () => {
    wsResetCalls.push(Date.now())
    wsStub = { ...WS_STUB_DEFAULT }
    return { ...wsStub }
  },
  'workspace:reveal': () => undefined,
  // ── 存储位置桩（plan10 C 批）：同样有状态 —— pending 写入/撤销/回退都要看"状态跟着走" ──
  'storage:get': () => ({ ...storageStub }),
  'storage:pick': () => {
    storagePickCalls += 1
    if (!storagePickNext) return { canceled: true }
    const res = storagePickNext
    storagePickNext = null
    if (res.canceled) return { canceled: true }
    if (!res.ok) return { ok: false, reason: res.reason }
    storageStub = res.info
    return { ok: true, info: { ...storageStub } }
  },
  'storage:reset': () => {
    storageResetCalls.push(Date.now())
    storageStub = {
      ...storageStub,
      pendingDir: storageStub.custom ? 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu' : null,
      pendingKind: storageStub.custom ? 'restore' : null
    }
    return { ok: true, info: { ...storageStub } }
  },
  'storage:undo-pending': () => {
    storageUndoCalls.push(Date.now())
    storageStub = { ...storageStub, pendingDir: null, pendingKind: null }
    return { ok: true, info: { ...storageStub } }
  },
  'conv:list': () => [
    {
      id: 'c1',
      title: '打个招呼',
      workspace: 'D:\\jsllworkplace_for_test',
      model: 'deepseek-flash',
      skills: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 2
    },
    // plan11 步骤 6：**第二条会话** —— 并发验收需要真的能"两条一起跑"
    {
      id: 'c2',
      title: '查点资料',
      workspace: 'D:\\jsllworkplace_for_test',
      model: 'deepseek-flash',
      skills: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0
    }
  ],
  'conv:get': (id) => {
    const which = id === 'c2' ? 'c2' : 'c1'
    return {
      id: which,
      title: which === 'c2' ? '查点资料' : '打个招呼',
      workspace: 'D:\\jsllworkplace_for_test',
      model: 'deepseek-flash',
      skills: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: which === 'c2' ? 0 : 2,
      // c2 从空会话开始（“并发时第二条会话刚开”正是要验的）；c1 给一条真实消息流，位置断言才有得验
      messages:
        which === 'c2'
          ? []
          : [
              { role: 'user', content: '把工作区里的三个文件汇总成一份报告' },
              {
                role: 'assistant',
                content: '# 汇总报告\n\n- 紫水晶采购清单已归档\n- 预算草案待复核\n'
              }
            ]
    }
  },
  'conv:create': (input) => ({
    id: 'x',
    // ⚠️ 契约副本（真源 `conversations-core.ts` 的 createConversation）：firstMessage 会**播种成
    //    第一条用户消息**并推导标题。"新会话首条不重复"那条断言靠这份桩成立
    title: (input?.firstMessage ?? '新对话').slice(0, 20),
    messages: input?.firstMessage?.trim()
      ? [{ role: 'user', content: input.firstMessage.trim() }]
      : []
  }),
  // 记流水：要验「在别的页面期间流出来的内容有没有被存下来」+ 用量账本有没有跟着走
  // agentName（plan17）：一并记下 —— G2 的"渲染侧载荷带主 Agent"断言靠它（它只护渲染侧，真生效由 runner 单测钉）
  'conv:save': ({ id, messages, usage, agentName }) => {
    convSaveCalls.push({ id, messages, usage, agentName })
    return null
  },
  // 记下调用与载荷，并回一份权威会话 —— 渲染端必须用它覆盖内存（回滚后与撤销后的条数刻意不同）
  'conv:rollback': (arg) => {
    convRollbackCalls.push(arg)
    return {
      conversation: {
        id: 'c1',
        title: '打个招呼',
        workspace: 'D:\\jsllworkplace_for_test',
        model: 'deepseek-flash',
        skills: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 1,
        messages: [{ role: 'user', content: '把工作区里的三个文件汇总成一份报告' }]
      },
      canUndo: true,
      total: 4
    }
  },
  'conv:undo-rollback': () => {
    convUndoCalls.push(1)
    return {
      conversation: {
        id: 'c1',
        title: '打个招呼',
        workspace: 'D:\\jsllworkplace_for_test',
        model: 'deepseek-flash',
        skills: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 4,
        messages: [
          { role: 'user', content: '把工作区里的三个文件汇总成一份报告' },
          { role: 'assistant', content: '好，我先读一遍。' },
          { role: 'user', content: '顺便看看预算' },
          { role: 'assistant', content: '预算草案在这里。' }
        ]
      },
      canUndo: false,
      total: 4
    }
  },
  'conv:rename': () => null,
  'conv:delete': () => undefined,
  'skills:list': () => [
    { name: 'planner', description: '规划员：把目标拆成有序步骤', source: 'builtin' },
    { name: 'reviewer', description: '审查员：只读审查', source: 'builtin' }
  ],
  // ── 子 Agent 管理（plan17）── 桩**有状态**（save 后 list 能看见），照 git:* 先例；
  // 撞名分级与覆盖标记都要能在断言里走到。file 用路径形状与真源一致（用户层绝对路径）。
  'agents:list': () => ({
    entries: agentEntries.map((e) => ({ ...e })),
    warnings: ['[builtin 层] broken.md：name 缺失或非法（需小写字母/数字/- 组成，1~64 字符）']
  }),
  'agents:read': (file) => {
    const e = agentEntries.find((x) => x.file === file)
    if (!e) return null
    return {
      name: e.name,
      description: e.description,
      tools: e.tools ?? [],
      ...(e.model ? { model: e.model } : {}),
      systemPrompt: e.systemPrompt,
      file: e.file
    }
  },
  'agents:save': (input) => {
    agentSaveCalls.push(JSON.parse(JSON.stringify(input ?? {})))
    // 撞名分级（与 agents-store 同口径）：新建撞用户层同名拒；编辑（带 file）放行
    const clash = !input?.file && agentEntries.some((x) => x.source === 'user' && x.name === input?.name)
    if (clash) return { ok: false, reason: '已存在同名定义，请在列表中编辑它，或换一个名字' }
    const target = input?.file ? agentEntries.find((x) => x.file === input.file) : null
    let savedFile
    if (target) {
      target.name = input.name
      target.description = input.description
      target.tools = input.tools
      target.model = input.model
      target.systemPrompt = input.systemPrompt
      savedFile = target.file
    } else {
      savedFile = join(VERIFY_UD, 'agents', `${input?.name ?? 'new-agent'}.md`)
      agentEntries.push({
        name: input?.name ?? 'new-agent',
        description: input?.description ?? '',
        tools: input?.tools ?? [],
        ...(input?.model ? { model: input.model } : {}),
        systemPrompt: input?.systemPrompt ?? '',
        source: 'user',
        file: savedFile,
        overridden: false
      })
    }
    agentsBroadcast()
    return {
      ok: true,
      file: savedFile,
      // 撞内置名带覆盖提示（与真源同口径），让断言能走到这一分支
      ...(input?.name === 'planner' && !input?.file ? { notice: '已存在同名内置定义：此定义生效后将覆盖内置版本' } : {})
    }
  },
  'agents:delete': (file) => {
    agentDeleteCalls.push(file)
    const i = agentEntries.findIndex((x) => x.file === file)
    if (i >= 0) agentEntries.splice(i, 1)
    agentsBroadcast()
    return { ok: true }
  },
  'permission:get': () => 'write',
  'permission:set': () => 'write',
  // Token Saver 档位：set 回显传入值（与真主进程一致，界面拿返回值更新显示，故 mock 不存状态）
  'token-tier:get': () => 'balanced',
  'token-tier:set': (tier) => tier,
  // 系统集成（plan7 批 F1）：set 记流水并真的改存根状态 —— 与真主进程一致（界面拿返回值回显）
  'system:get': () => {
    systemGetCalls += 1
    return { ...systemStub }
  },
  'system:set': (patch) => {
    systemSetCalls.push({ ...(patch ?? {}) })
    systemStub = { ...systemStub, ...(patch ?? {}) }
    if (systemForceNextSet) {
      systemStub = { ...systemStub, ...systemForceNextSet }
      systemForceNextSet = null
    }
    systemStub.keepRunningActive = systemStub.keepRunning === true
    return { ...systemStub }
  },
  // 网络代理（plan7 批 F2）：与 `system:set` 同一口径 —— 改状态、回新状态，界面拿返回值回显
  'fonts:list': () => ({ ...fontsStub, fonts: [...fontsStub.fonts] }),
  'net-proxy:get': () => {
    netGetCalls += 1
    return { ...netStub }
  },
  'net-proxy:set': (patch) => {
    const p = patch ?? {}
    netSetCalls.push({ ...p })
    const mode = p.proxyMode ?? netStub.proxyMode
    let rules = p.proxyRules !== undefined ? String(p.proxyRules) : netStub.proxyRules
    // 体检不通过：手动档必须填地址 —— **不落盘、不应用**，只回原因（真主进程同款行为）
    if (mode === 'custom' && rules.trim().length === 0) {
      return {
        ...netStub,
        proxyMode: 'custom',
        proxyRules: rules,
        applied: false,
        error: '手动配置需要填写代理地址（示例：127.0.0.1:7897）'
      }
    }
    let hasCredentials = netStub.hasCredentials
    if (p.proxyUser !== undefined || p.proxyPass !== undefined) {
      hasCredentials = p.proxyUser !== null && String(p.proxyUser ?? '').length > 0
    }
    // 从地址里剥出凭据：界面只回显剥过的地址，明文**不回传**
    const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/@\s]+):([^/@\s]*)@(.+)$/.exec(rules)
    if (m) {
      hasCredentials = true
      rules = (m[1] || 'http://') + m[4]
    }
    const bare = rules.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@]*@/, '')
    const effective =
      mode === 'direct' ? 'DIRECT' : mode === 'custom' ? 'PROXY ' + bare : 'PROXY 127.0.0.1:7897; DIRECT'
    netStub = {
      ...netStub,
      proxyMode: mode,
      proxyRules: rules,
      hasCredentials,
      effective,
      effectiveFor: 'https://api.openai.com',
      effectiveError: null,
      applied: true,
      error: null
    }
    return { ...netStub }
  },
  'git:info': () => ({ branch: 'master', dirty: false }),
  'attach:file': () => null,
  'prompt:polish': () => 'polished',
  'browser:state': () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
  'browser:navigate': () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
  'browser:back': () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
  'browser:forward': () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
  'browser:reload': () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
  'browser:set-visible': () => undefined,
  'browser:set-bounds': () => undefined,
  'logs:info': () => ({
    dir: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu\\logs',
    files: ['app.log', 'app.1.log']
  }),
  'logs:open': () => true,
  // 界面布局偏好（含工作台分栏）。⚠️ 契约复制品：UIPrefs 加字段必须同步加，否则渲染端静默漏掉 undefined
  // ⚠️ 有状态（plan7 批 F3）：set 合并进 uiPrefsStub 再返回 —— 渲染端拿返回值回显，桩要像真主进程一样"记住"
  'ui-prefs:get': () => ({ ...uiPrefsStub }),
  'ui-prefs:set': (patch) => {
    if (patch && patch.workbench) wbSetCalls.push(Date.now())
    uiPrefsSetCalls.push({ ...patch })
    uiPrefsStub = { ...uiPrefsStub, ...patch }
    return { ...uiPrefsStub }
  },
  'ui-prefs:reset': () => {
    uiPrefsStub = {
      sidebarWidth: 248,
      dockWidth: 360,
      theme: 'qingkong',
      fontScale: 'md',
      uiFont: '',
      workbench: { schemaVersion: 1, panes: [] },
      workbenchSizes: { paneWidths: [] }
    }
    return { ...uiPrefsStub }
  },
  // ③ 文件拖进会话：按路径取附件（文件选择框走 attach:file）。⚠️ 这里的路径规则是主进程 readAttachment
  //    那套两层边界的复制品（绝对路径原样；相对拼工作区根；区外带 outside 标记）—— 主进程改了这里必须跟着改。
  'attach:path': (p) => {
    const s = typeof p === 'string' ? p : ''
    attachPathCalls.push(s)
    const ws = 'D:\\jsllworkplace_for_test'
    const abs = /^[a-zA-Z]:[\\/]/.test(s) ? s.replace(/\//g, '\\') : ws + '\\' + s.replace(/\//g, '\\')
    const name = abs.split(/[\\/]/).pop() || 'a.txt'
    return {
      name,
      path: abs,
      content: '氧化铈粉 120kg\n碳酸钠 45kg',
      truncated: false,
      ...(abs.toLowerCase().startsWith(ws.toLowerCase() + '\\') ? {} : { outside: true })
    }
  },
  'fs:read-binary': (arg) => {
    const rel = typeof arg === 'string' ? arg : ''
    if (rel.endsWith('示例截图.png')) {
      return {
        ok: true,
        rel,
        size: PNG_BYTES.length,
        dataUrl: 'data:image/png;base64,' + PNG_BYTES.toString('base64')
      }
    }
    if (rel.endsWith('超大图.png')) {
      // 超过上限：**只给元信息、不给数据**（不该把几十 MB 塞进 IPC）
      return { ok: true, rel, size: 12 * 1024 * 1024, tooLarge: true }
    }
    if (rel.endsWith('固件镜像.bin')) {
      return {
        ok: true,
        rel,
        size: 4096,
        hexHead: '00000000  7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00  |.ELF............|\n00000010  03 00 3e 00 01 00 00 00 40 10 00 00 00 00 00 00  |..>.....@.......|'
      }
    }
    if (rel.endsWith('产品演示.pptx')) {
      // pptx 不支持内嵌预览 → 十六进制头 + 「用系统程序打开」（ZIP 魔数可认出它是 OOXML）
      return {
        ok: true,
        rel,
        size: 20480,
        hexHead: '00000000  50 4b 03 04 14 00 06 00 08 00 00 00 21 00 d4 d3  |PK..........!...|\n00000010  03 00 00 00 00 00 00 00 00 00 00 00 00 00 13 00  |................|'
      }
    }
    return { ok: false, rel, size: 0, error: '不支持的预览类型' }
  },
  // Office 内嵌预览：桩只回「沙箱 URL」的形状（解析真链路由 tests/unit/office-preview.test.ts
  // 喂真实字节覆盖；门禁验的是渲染端的**分发与容器**——iframe 装上、按钮组能切、失败会降级）
  'office:preview': (rel) => {
    const r = typeof rel === 'string' ? rel : ''
    if (r.endsWith('会议纪要.docx')) {
      return { ok: true, rel: r, size: 10240, kind: 'docx', url: `jsl-preview://mem/${'a'.repeat(32)}` }
    }
    if (r.endsWith('库存表.xlsx')) {
      return {
        ok: true,
        rel: r,
        size: 8192,
        kind: 'sheet',
        clipped: false,
        sheetCount: 2,
        sheets: [
          { name: '一月', url: `jsl-preview://mem/${'b'.repeat(32)}` },
          { name: '二月', url: `jsl-preview://mem/${'c'.repeat(32)}` }
        ]
      }
    }
    return { ok: false, rel: r, size: 0, error: '解析失败：文件可能已损坏或不是标准 Office 格式' }
  },
  'fs:open-in-system': (payload) => {
    fsOpLog.push(`open-in-system:${typeof payload === 'string' ? payload : ''}`)
    return { ok: true }
  },
  // plan7 批 A：工作区文件树（stub 数据；真实文件系统由 tests/unit/fs-tree.test.ts 覆盖）
  'fs:list': (arg) => {
    const rel = typeof arg === 'string' ? arg : ''
    if (rel === '') {
      return {
        ok: true,
        entries: [
          { name: '归档', rel: '归档', kind: 'dir' },
          { name: '2026年度预算草案.md', rel: '2026年度预算草案.md', kind: 'file', size: 365 },
          { name: '紫水晶采购清单.txt', rel: '紫水晶采购清单.txt', kind: 'file', size: 341 },
          { name: 'README.md', rel: 'README.md', kind: 'file', size: 128 },
          { name: '预览桩.html', rel: '预览桩.html', kind: 'file', size: HTML_STUB.length },
          { name: '示例截图.png', rel: '示例截图.png', kind: 'file', size: PNG_BYTES.length },
          { name: '超大图.png', rel: '超大图.png', kind: 'file', size: 12 * 1024 * 1024 },
          { name: '固件镜像.bin', rel: '固件镜像.bin', kind: 'file', size: 4096 },
          // Office 内嵌预览（2026-09-14）：docx/xlsx 走内存沙箱；pptx 不支持内嵌 → 十六进制 + 系统打开
          { name: '会议纪要.docx', rel: '会议纪要.docx', kind: 'file', size: 10240 },
          { name: '库存表.xlsx', rel: '库存表.xlsx', kind: 'file', size: 8192 },
          { name: '产品演示.pptx', rel: '产品演示.pptx', kind: 'file', size: 20480 }
        ]
      }
    }
    if (rel === '归档') {
      return { ok: true, entries: [{ name: '旧版说明.txt', rel: '归档/旧版说明.txt', kind: 'file', size: 264 }] }
    }
    return { ok: true, entries: [] }
  },
  'fs:read': (rel) => {
    if (String(rel).endsWith('.html')) {
      return { ok: true, rel, content: HTML_STUB, size: HTML_STUB.length, mtimeMs: 222222 }
    }
    if (String(rel).endsWith('.md')) {
      return {
        ok: true,
        rel,
        content: '# 九十里路\n\n- 第一点\n- 第二点\n\n**加粗** 与 `行内代码`\n',
        size: 60,
        // 编辑要用它当**冲突基线**：保存时带回去，主进程比对 mtime
        mtimeMs: 111111
      }
    }
    return {
      ok: true,
      rel: '紫水晶采购清单.txt',
      content:
        '紫水晶采购清单（2026-09-12 起草）\n\n1. 乌拉尔产紫水晶原石 —— 12 公斤\n2. 巴西产紫水晶碎石 —— 40 公斤\n3. 抛光用氧化铈粉 —— 3 罐\n4. 恒温展示柜（带锁）—— 2 台\n',
      size: 341
    }
  },
  // 写操作：stub 只回人话、不真写（真实落盘由 tests/unit/workspace-write.test.ts 覆盖）
  'fs:write': (payload) => {
    fsOpLog.push(`write:${payload.rel}`)
    // plan7 批 A3 范围②：记下**冲突基线**有没有一起带上来（编辑保存必须带）
    fsWritePayloads.push(payload)
    return { ok: true, message: `已写入 ${payload.rel}（0 字节）`, mtimeMs: 222222 }
  },
  'fs:mkdir': (payload) => {
    fsOpLog.push(`mkdir:${payload.rel}`)
    return { ok: true, message: `已创建目录 ${payload.rel}` }
  },
  'fs:rename': (payload) => {
    fsOpLog.push(`rename:${payload.rel}->${payload.nextRel}`)
    return { ok: true, message: `已重命名 ${payload.rel} → ${payload.nextRel}` }
  },
  'fs:delete': (payload) => {
    fsOpLog.push(`delete:${payload.rel}`)
    return { ok: true, message: `已删除 ${payload.rel}（已移入回收站）` }
  },
  'fs:reveal': () => undefined,
  'checkpoint:list': () => [
    {
      runId: 'run-1',
      at: Date.now() - 120000,
      workspace: 'D:\\jsllworkplace_for_test',
      agent: '内核默认',
      status: 'done',
      fileCount: 4,
      createdCount: 1,
      modifiedCount: 3
    },
    {
      runId: 'run-2',
      at: Date.now() - 60000,
      workspace: 'D:\\jsllworkplace_for_test',
      agent: 'planner',
      status: 'done',
      fileCount: 1,
      createdCount: 0,
      modifiedCount: 1,
      rolledBackAt: Date.now() - 30000
    }
  ],
  'checkpoint:get': () => ({
    runId: 'run-1',
    at: Date.now() - 120000,
    workspace: 'D:\\jsllworkplace_for_test',
    agent: '内核默认',
    status: 'done',
    changes: [
      { rel: 'src/notes.md', kind: 'modified', beforeBytes: 128, backup: '0.bin' },
      { rel: 'src/app.ts', kind: 'modified', beforeBytes: 640, backup: '1.bin' },
      { rel: 'src/brand-new.md', kind: 'created', beforeBytes: 0, backup: null },
      // plan13 B3：超大文件 —— 验"截断必须说出来、且不给逐处退回"
      { rel: 'src/huge.log', kind: 'modified', beforeBytes: 3145728, backup: '3.bin' }
    ]
  }),
  'checkpoint:rollback': () => ({
    runId: 'run-1',
    restored: ['src/notes.md', 'src/app.ts'],
    deleted: ['src/brand-new.md'],
    failed: [],
    rejected: []
  }),

  // Diff 两侧内容 —— fixture 刻意设计：app.ts 两处相隔很远（否则“块数==2”写成恒等于 1 也能绿）；notes.md 两侧一致（阴性对照）
  'checkpoint:sides': ({ runId, rel }) => {
    const APP_BEFORE = [
      "import { a } from './a'",
      'const x = 1',
      'function f() {',
      '  return x',
      '}',
      '// section A',
      'const u1 = 0',
      'const u2 = 0',
      'const u3 = 0',
      'const u4 = 0',
      'const u5 = 0',
      'const u6 = 0',
      'const u7 = 0',
      'const u8 = 0',
      'const u9 = 0',
      '// section B',
      'const y = 2',
      'export { f, x }'
    ].join('\n')
    // 改动 ①：第 2 行  ②：第 17 行起（并把 `const z = y * 2` 插成第 18 行）
    const APP_AFTER = [
      "import { a } from './a'",
      'const x = 42',
      'function f() {',
      '  return x',
      '}',
      '// section A',
      'const u1 = 0',
      'const u2 = 0',
      'const u3 = 0',
      'const u4 = 0',
      'const u5 = 0',
      'const u6 = 0',
      'const u7 = 0',
      'const u8 = 0',
      'const u9 = 0',
      '// section B',
      'const y = 3',
      'const z = y * 2',
      'export { f, x, z }'
    ].join('\n')

    const base = {
      ok: true,
      runId: runId ?? 'run-1',
      kind: 'modified',
      beforeBytes: 0,
      afterBytes: 0,
      truncated: false,
      mtimeMs: 111111,
      runStatus: 'done'
    }

    if (rel === 'src/notes.md') {
      const same = '这一轮看过这个文件，内容没变过\n'
      return { ...base, rel, before: same, after: same }
    }    if (rel === 'src/brand-new.md') {
      return {
        ...base,
        rel,
        kind: 'created',
        before: null, // created **没有**快照侧
        after: ['# 新建的说明', '', '这一轮把它造出来的。'].join('\n')
      }
    }
    if (rel === 'src/huge.log') {
      return {
        ...base,
        rel,
        before: 'old line\n',
        after: 'new line\n',
        truncated: true, // 两侧只读了前 256KB —— 界面必须说出来
        beforeBytes: 1024 * 1024 * 3,
        afterBytes: 1024 * 1024 * 4
      }
    }
    return {
      ...base,
      rel,
      before: APP_BEFORE,
      // 退过一次后第 1 处已还原，差异应只剩 1 处 —— 不重取数的话界面仍显示 2 处，断言立刻红
      after: appHunkOneReverted ? APP_AFTER.replace('const x = 42', 'const x = 1') : APP_AFTER
    }
  },

  // 内置终端存根。⚠️ 门禁里不起真 shell（真机验证在 terminal-session.test.ts），这里验界面那条链路
  'terminal:start': () => {
    termStartCalls += 1
    // 只读档在启动处就拒绝（与主进程同口径）。⚠️ 哨兵串证明界面那句话来自 IPC 返回值，而不是模板里写死的
    if (termPermission === 'read-only') {
      return {
        ok: false,
        reason: 'read-only',
        message: '当前是「只读」权限档：该档下终端不执行任何命令 JSL_RO_9Z'
      }
    }
    termHasSession = true
    return { ok: true, session: makeTermSnapshot() }
  },
  // 真重启：换会话号 + 清缓冲。走幂等的 start 会拿回同一会话、屏幕内容不变（死按钮）
  'terminal:restart': () => {
    if (termPermission === 'read-only') {
      return {
        ok: false,
        reason: 'read-only',
        message: '当前是「只读」权限档：该档下终端不执行任何命令'
      }
    }
    termRestartCalls += 1
    termSessionNo += 1
    termChunks.length = 0
    termChunks.push({ seq: 1, data: 'PS D:\\jsllworkplace_for_test> ' })
    termSeq = 2
    termStatus = 'running'
    termHasSession = true
    return { ok: true, session: makeTermSnapshot() }
  },
  // ⚠️ **故意慢 400ms** —— 它是"订阅 ↔ 重放那个缝"的**制造器**：不慢的话帧永远在重放之后才到，
  //    "实时帧顺序"那条断言就成了摆设（老协议下也会绿）。
  'terminal:snapshot': async () => {
    await new Promise((r) => setTimeout(r, 400))
    return termHasSession ? makeTermSnapshot() : null
  },
  'terminal:write': () => ({ ok: true }),
  'terminal:resize': () => undefined,
  // 背压回执 / 重对齐：不做真流控，但这两个通道必须能吃下（否则渲染层会抛 unhandled rejection）
  'terminal:ack': () => undefined,
  'terminal:resync': () => undefined,
  'terminal:kill': () => {
    termStatus = 'killed'
    termHasSession = false
    return true
  },

  // plan13 B4：逐处退回。**只记流水 + 改状态**，真正的写盘由主进程负责（门禁里不需要真写）。
  'checkpoint:revert-hunk': (input) => {
    revertCalls.push(input)
    if (input.rel === 'src/app.ts' && input.hunkIndex === 1) appHunkOneReverted = true
    return {
      ok: true,
      rel: input.rel,
      hunkIndex: input.hunkIndex,
      message: `已写入 ${input.rel}`
    }
  }
  // 注意：'confirm:respond' 不在这里 —— 需要记录收到的答复，单独注册（见下）
}

app.whenReady().then(async () => {
  for (const [channel, fn] of Object.entries(STUBS)) {
    // 透传参数：像 fs:list 这种需要知道"列哪个目录"的通道必须拿得到实参。
    // ⚠️ 首参透传 event：`settings:close-window` 要按"发起方"关窗（真源同款 —— 用 fromWebContents 取自己），
    //    不透传就只能靠猜哪个窗口该关。参数个数不影响其余桩（多余实参被 JS 忽略）。
    ipcMain.handle(channel, (event, ...args) => fn(...args, event))
  }

  // 危险操作确认（plan8 R5）：记录界面回传的答复，用于判断点击是否真的生效
  const confirmResponses = []
  ipcMain.handle('confirm:respond', (_e, payload) => {
    confirmResponses.push(payload)
  })

  // Agent 提问回执：同样要**记流水** —— "界面画了按钮"与"按钮真的把值发下去了"是两件事。
  // ⚠️ 返回值必须是 true：界面靠它区分"主进程认领了"与"已超时/被中断"，恒回 undefined 会让界面永远说"没送到"。
  const askResponses = []
  ipcMain.handle('ask:respond', (_e, payload) => {
    askResponses.push(payload)
    return true
  })

  // HTML 预览协议：契约副本（真实现见 src/main/preview-protocol.ts），只回桩页、不读盘；previewHits 是“帧加载没加载”的唯一可信证据
  const previewHits = []
  protocol.handle('jsl-preview', (req) => {
    previewHits.push(new URL(req.url).pathname)
    return new Response(HTML_STUB, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'",
        'cache-control': 'no-store'
      }
    })
  })

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(ROOT, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // ⚠️ 必须与真机一致（src/main/index.ts 的 createWindow 就是 sandbox: true）：写成 false 等于在另一个环境里验真机
      sandbox: true,
      /** ⚠️ 必须关掉后台节流：窗口 show: false 会被 Chromium 节流、rAF 被压到极低频 → Monaco 渲染不出来
       *  （.view-line 高在 0 和 16 之间跳）；红的是后面那 9 条，真凶却在更早的某一帧，最难查。 */
      backgroundThrottling: false
    }
  })

  // CSP 违规捕获：必须在 loadFile 之前挂监听，否则漏掉加载期错误
  let modelCatalog = null
  let fetchNewEndpoint = null
  let agentsMgr = null
  const cspViolations = []
  win.webContents.on('console-message', (...a) => {
    // 兼容新旧签名：Electron 33 是 (event, level, message, ...)，35+ 是 (event, details)
    const msg = typeof a[2] === 'string' ? a[2] : (a[0] && a[0].message) || ''
    if (/Content Security Policy|Refused to/i.test(msg)) {
      // ⚠️ 必须记来源：同一条指令可能来自不同文档（index.html、jsl-preview 子文档、monaco/xterm 注入），
      //    不记来源时“谁在违反 CSP”只能靠猜。⚠️ sourceId 可能给成 URL 对象，判 string 会静默退化成未知。
      const raw = a[4] ?? (a[0] && (a[0].sourceId ?? a[0].sourceURL))
      const src = raw ? String(raw) : '(来源未知)'
      cspViolations.push(`[${src}] ${msg}`)
    }
  })

  // ── 设置独立窗口的桩实现（契约副本；真源见 src/main/index.ts openSettingsWindow）──
  // Git 广播用与真源同款的语义：**发给所有窗口**（Git 状态是工作区级的，真源见 window-registry.sendToAll）
  gitBroadcast = () => {
    let n = 0
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue
      try {
        w.webContents.send('git:changed')
        n += 1
      } catch {
        // 单个窗口发失败不该影响其余（典型场景：窗口正在销毁）
      }
    }
    return n
  }
  // 记忆广播（plan19 批 1）：与 git:changed 同语义 —— 发给所有窗口，各窗自己重读。
  // ⚠️ 这条**不能省**：没有它，"面板靠订阅自动重拉"那条断言就是空的（而空态看起来完全正常）
  memoryBroadcast = () => {
    let n = 0
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue
      try {
        w.webContents.send('memory:changed')
        n += 1
      } catch {
        // 单个窗口发失败不该影响其余
      }
    }
    return n
  }
  // 护栏 2 的推送（plan19 批 1 / D-043）：**带载荷**，不是"变了"信号
  memoryNoticeBroadcast = (payload) => {
    let n = 0
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue
      try {
        w.webContents.send('memory:notice', payload)
        n += 1
      } catch {
        // 同上：单窗失败不影响其余
      }
    }
    return n
  }
  // Agent 定义广播（plan17 D8）：与 git:changed 同语义 —— 发给所有窗口，各窗自己重读
  agentsBroadcast = () => {
    let n = 0
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue
      try {
        w.webContents.send('agents:changed')
        n += 1
      } catch {
        // 同上：单个窗口失败不影响其余
      }
    }
    return n
  }
  // 为什么必须真建窗：主窗口与设置窗口是**两个渲染进程**，设置探针全都要打到后者身上。
  // 刻意**不装**任何 flush 拦截（真源也不装）——保证"设置窗口开着时主窗口仍能正常关掉"这条能验。
  const settingsWins = []
  openSettingsWinStub = async () => {
    // 幂等：已开则聚焦（真源同款）——门禁里连点两次必须只有一个窗口
    const live = settingsWins.find((w) => !w.isDestroyed())
    if (live) {
      live.focus()
      return { ok: true, reused: true }
    }
    settingsWins.push(
      new BrowserWindow({
        width: 900,
        height: 660,
        show: false,
        parent: win,
        webPreferences: {
          preload: join(ROOT, 'out/preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      })
    )
    // ⚠️ `{ hash: '/settings' }` 是独立窗口的唯一标记：渲染入口 main.tsx 靠它分叉出设置外壳
    await settingsWins[settingsWins.length - 1].loadFile(
      join(ROOT, 'out/renderer/index.html'),
      { hash: '/settings' }
    )
    return { ok: true, reused: false }
  }
  closeSettingsWinStub = (event) => {
    // 按发起方关窗（真源同款：fromWebContents(event.sender)）——关错窗口会连带毁掉后续探针
    const sender = event && event.sender
    const target =
      (sender && BrowserWindow.fromWebContents(sender)) || settingsWins.find((w) => !w.isDestroyed())
    if (target && !target.isDestroyed()) target.close()
    return true
  }

  await win.loadFile(join(ROOT, 'out/renderer/index.html'))
  await new Promise((r) => setTimeout(r, 3000))

  const measure = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
        };
        return {
          winW: window.innerWidth,
          view: pick('.chat-view') ? 'chat' : (pick('.new-task') ? 'new-task' : (pick('.settings-view') ? 'settings' : '?')),
          sidebar: pick('.sidebar'),
          content: pick('.content'),
          chatInput: pick('.chat-input'),
          console: pick('.console'),
          textarea: pick('.console-input'),
          toolbar: pick('.console-toolbar'),
          workspaceRow: pick('.console-workspace')
        };
      })()
    `)

  const enterChat = async () => {
    await win.webContents.executeJavaScript(`
      (() => {
        const item = document.querySelector('.conv-item');
        if (item) item.click();
        return !!item;
      })()
    `)
    await new Promise((r) => setTimeout(r, 900))
  }

  await enterChat()
  const m1 = await measure()

  // —— plan17 G2：输入框「主 Agent」单选（切换真的写进会话保存载荷 —— 它只护渲染侧，真生效由 runner 单测 + 冒烟钉）——
  const convSaveCallsBefore = convSaveCalls.length
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.plus-btn');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const agentMenu = await win.webContents.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('.plus-menu .plus-item'));
      return {
        menuOpen: !!document.querySelector('.plus-menu'),
        // ⚠️ 菜单里有多个 .plus-title（添加 / 主 Agent / 更多）：断言要的是"主 Agent 这一节在"
        titles: Array.from(document.querySelectorAll('.plus-menu .plus-title')).map((t) => t.textContent.trim()),
        names: items.map((i) => i.querySelector('.plus-name')?.textContent?.trim() ?? ''),
        checkedNow: (() => {
          const on = items.find((i) => i.classList.contains('on'));
          return on ? on.querySelector('.plus-name')?.textContent?.trim() ?? null : null;
        })()
      };
    })()
  `)
  console.log('AGENT_MENU=' + JSON.stringify(agentMenu))
  await win.webContents.executeJavaScript(`
    (() => {
      const item = Array.from(document.querySelectorAll('.plus-menu .plus-item'))
        .find((i) => i.querySelector('.plus-name')?.textContent?.trim() === 'word-smith');
      if (item) item.click();
      return !!item;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const agentPicked = await win.webContents.executeJavaScript(`
    (() => ({
      badge: document.querySelector('.chat-agent')?.textContent?.trim() ?? null,
      menuClosed: !document.querySelector('.plus-menu')
    }))()
  `)
  console.log('AGENT_PICKED=' + JSON.stringify(agentPicked))
  const agentSaveCall = convSaveCalls.slice(convSaveCallsBefore).find((c) => c.agentName !== undefined)
  console.log('AGENT_SAVE_CALL=' + JSON.stringify(agentSaveCall ? { agentName: agentSaveCall.agentName } : null))

  // —— 过程可见：工具调用详情 + 思考流（推送 → preload → store → 组件 这段是真实链路，只有数据由这里伪造）——
  win.webContents.send('chat:tool', {
    conversationId: 'c1',
    payload: {
      id: 'probe-tool',
      name: 'read_file',
      phase: 'start',
      detail: 'src/main/index.ts'
    }
  })
  // plan44 S2：桌面派工具事件 —— 徽标（MCP·server）与动作回显（坐标明文）的素材
  win.webContents.send('chat:tool', {
    conversationId: 'c1',
    payload: {
      id: 'probe-mcp-tool',
      name: 'mcp__windows-mcp__Click',
      phase: 'start',
      detail: 'x=1024 y=768'
    }
  })
  win.webContents.send('chat:reasoning', {
    conversationId: 'c1',
    payload: '先看看入口文件怎么写的…'
  })
  await new Promise((r) => setTimeout(r, 600))
  // —— 目标面板：输入框上方一条、摆在待办上面（两条都渲染 + 行内动作齐 + 几何位置）——
  const goalPanel = await win.webContents.executeJavaScript(`
    (() => {
      const panel = document.querySelector('.goal-panel');
      if (!panel) return { hasPanel: false };
      const rows = Array.from(document.querySelectorAll('.goal-row'));
      const todo = document.querySelector('.todo-panel') ?? document.querySelector('.console-todos');
      const pr = panel.getBoundingClientRect();
      const tr = todo ? todo.getBoundingClientRect() : null;
      return {
        hasPanel: true,
        rows: rows.length,
        texts: rows.map((r) => r.querySelector('.goal-text')?.textContent?.trim() ?? ''),
        pausedCount: rows.filter((r) => r.classList.contains('paused')).length,
        btnTexts: rows.map((r) => Array.from(r.querySelectorAll('.goal-btn')).map((b) => b.textContent.trim()).join('/')),
        hasAdd: !!document.querySelector('.goal-add'),
        topOfPanel: Math.round(pr.top),
        topOfTodo: tr ? Math.round(tr.top) : null,
        visible: pr.height > 0 && pr.width > 0
      };
    })()
  `)
  console.log('GOAL_PANEL=' + JSON.stringify(goalPanel))

  const processVisible = await win.webContents.executeJavaScript(`
    (() => {
      // plan36 S3 判据重定：旧的「全局过程块 + 直接子元素排序」已随架构退役 ——
      // 现在验的是**最后一条助手消息内**的分段：类名沿用（.reasoning-block/.tool-log/.msg-content），
      // 位置从"消息之前"变成"消息之内"，顺序必须等于事件到达顺序（本桩序列：既有正文 → tool → thinking）
      const assts = Array.from(document.querySelectorAll('.chat-messages .msg-assistant'));
      const last = assts[assts.length - 1];
      if (!last) return { toolName: null, toolDesc: null, mcpBadge: null, hasReasoning: false, reasoningLabel: null, reasoningText: null, reasoningVisible: false, reasoningHeight: 0, segmentOrder: [], segmentsInsideMsg: false };
      const segs = Array.from(last.children)
        .filter((el) => el.matches('.msg-content, .tool-log, .reasoning-block'))
        .map((el) => el.className.split(' ')[0]);
      const tool = last.querySelector('.tool-item');
      const rb = last.querySelector('.reasoning-block');
      const pr = rb ? rb.getBoundingClientRect() : null;
      return {
        toolName: tool ? (tool.querySelector('.tool-name')?.textContent?.trim() ?? null) : null,
        // 关键：显示的是"在干什么"（入参摘要），**不是**干巴巴的「执行中…」
        toolDesc: tool ? (tool.querySelector('.tool-desc')?.textContent?.trim() ?? null) : null,
        // plan44 S2：mcp 工具卡 —— 徽标拆出 server、名字只留本名、坐标明文回显
        mcpBadge: (() => {
          const items = Array.from(last.querySelectorAll('.tool-item'));
          const mcpItem = items.find((it) => !!it.querySelector('.tool-mcp-badge'));
          return mcpItem
            ? {
                badge: mcpItem.querySelector('.tool-mcp-badge')?.textContent?.trim() ?? null,
                name: mcpItem.querySelector('.tool-name')?.textContent?.trim() ?? null,
                desc: mcpItem.querySelector('.tool-desc')?.textContent?.trim() ?? null
              }
            : null;
        })(),
        hasReasoning: !!rb,
        reasoningLabel: rb ? (rb.querySelector('.reasoning-head')?.textContent?.trim() ?? null) : null,
        reasoningText: rb ? (rb.querySelector('.reasoning-body')?.textContent?.trim() ?? null) : null,
        // **高度合理**才算看得见：被 flex 压成一条线（实测只有 4px）等于没显示
        reasoningVisible: pr ? pr.height > 20 && pr.top < window.innerHeight : false,
        reasoningHeight: pr ? Math.round(pr.height) : 0,
        segmentOrder: segs,
        segmentsInsideMsg: segs.includes('tool-log') && segs.includes('reasoning-block')
      };
    })()
  `)
  console.log('PROCESS_VISIBLE=' + JSON.stringify(processVisible))

  // —— 待办清单面板（plan7 批 D：输入框上方的任务栏）——
  const todoInfo = await win.webContents.executeJavaScript(`
    (() => {
      const panel = document.querySelector('.todo-panel');
      const cons = document.querySelector('.console');
      const items = Array.from(document.querySelectorAll('.todo-item'));
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
      };
      return {
        hasPanel: !!panel,
        panel: panel ? rect(panel) : null,
        // 关键：面板必须在输入框**上方**（用户明确要求的形态）
        aboveConsole:
          panel && cons
            ? panel.getBoundingClientRect().bottom <= cons.getBoundingClientRect().top + 1
            : false,
        title: document.querySelector('.todo-title')?.textContent?.trim() ?? null,
        stats: document.querySelector('.todo-stats')?.textContent?.trim() ?? null,
        count: items.length,
        marks: items.map((el) => el.querySelector('.todo-mark')?.textContent?.trim() ?? null),
        classes: items.map((el) => el.className),
        texts: items.map((el) => el.querySelector('.todo-text')?.textContent?.trim() ?? null),
        // 与目标的联动（plan12 ⑥）：挂着进行中的目标时，面板顶部一行"服务于哪条"
        goalLine: (() => {
          const line = panel?.querySelector('.todo-goal');
          return line
            ? {
                tag: line.querySelector('.todo-goal-tag')?.textContent?.trim() ?? null,
                text: line.querySelector('.todo-goal-text')?.textContent?.trim() ?? null,
                more: line.querySelector('.todo-goal-more')?.textContent?.trim() ?? null
              }
            : null;
        })()
      };
    })()
  `)
  console.log('TODO_PANEL=' + JSON.stringify(todoInfo))
  // plan12 ⑥：待办面板顶部「服务于哪条目标」联动行 —— 桩的 FAKE_GOALS 前两条都是 open（active+paused），
  // 主进程 listGoals 已排序（进行中 → 暂停），联动行应取第一条并如实标注总数
  checkTrue(
    '挂着进行中的目标时，待办面板顶部出现「目标」联动行，文本是排序后的第一条',
    todoInfo.goalLine !== null &&
      todoInfo.goalLine.tag === '目标' &&
      todoInfo.goalLine.text === FAKE_GOALS[0].text,
    todoInfo.goalLine
  )
  checkTrue(
    'open 目标不止一条 → 联动行如实标注「等 N 条」（不假装只有一条）',
    todoInfo.goalLine?.more === '等 2 条',
    todoInfo.goalLine?.more
  )
  // 等一帧再拍：面板是“挂载 → 异步拉清单 → 渲染”三步出来的，量完立刻 capturePage 可能是空画面
  await new Promise((r) => setTimeout(r, 500))
  const shotTodo = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-todo.png'), shotTodo.toPNG())

  await win.webContents.executeJavaScript(`
    (() => {
      const head = document.querySelector('.todo-head');
      if (head) head.click();
      return !!head;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const todoCollapsed = await win.webContents.executeJavaScript(`
    (() => ({
      listGone: !document.querySelector('.todo-list'),
      goalGone: !document.querySelector('.todo-goal'),
      expanded: document.querySelector('.todo-head')?.getAttribute('aria-expanded') ?? null,
      panelH: Math.round(document.querySelector('.todo-panel')?.getBoundingClientRect().height ?? 0)
    }))()
  `)
  console.log('TODO_COLLAPSE=' + JSON.stringify(todoCollapsed))
  checkTrue('折叠后目标联动行一并收起（不占地方）', todoCollapsed.goalGone === true, todoCollapsed)

  await win.webContents.executeJavaScript(`
    (() => {
      const head = document.querySelector('.todo-head');
      if (head) head.click();
      return !!head;
    })()
  `)
  await new Promise((r) => setTimeout(r, 300))

  // —— 全部完成 → 自动折叠（2026-09-15 用户需求）：只在「有未完成 → 全完成」的沿上收一次，
  //    统计行保留当证据；用户随后手动展开不得被折回（不然等于抢走界面控制权）。——
  const ALL_DONE = FAKE_TODOS.map((t) => ({ ...t, status: 'completed' }))
  win.webContents.send('todo:changed', { conversationId: 'c1', payload: ALL_DONE })
  await new Promise((r) => setTimeout(r, 400))
  const todoAutoFold = await win.webContents.executeJavaScript(`
    (() => ({
      expanded: document.querySelector('.todo-head')?.getAttribute('aria-expanded') ?? null,
      panelAlive: !!document.querySelector('.todo-panel'),
      statsText: document.querySelector('.todo-stats')?.textContent?.trim() ?? null
    }))()
  `)
  console.log('TODO_AUTO_FOLD=' + JSON.stringify(todoAutoFold))
  checkTrue(
    '清单全部完成 → 面板**自动折叠**（沿触发），统计行保留当证据',
    todoAutoFold.expanded === 'false' && todoAutoFold.panelAlive === true && (todoAutoFold.statsText ?? '').includes('4 已完成'),
    todoAutoFold
  )
  // 手动展开 → 不被折回（600ms 后仍是展开态才算数）
  await win.webContents.executeJavaScript(`
    (() => {
      const head = document.querySelector('.todo-head');
      if (head) head.click();
      return !!head;
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))
  const todoStayOpen = await win.webContents.executeJavaScript(
    `document.querySelector('.todo-head')?.getAttribute('aria-expanded') ?? null`
  )
  checkTrue('用户手动展开已完成的清单 → **不再被自动折回**（沿只触发一次）', todoStayOpen === 'true', {
    expanded: todoStayOpen
  })
  // 恢复现场：把原清单推回去（后续探针的 todos 语义不变）
  win.webContents.send('todo:changed', { conversationId: 'c1', payload: FAKE_TODOS })
  await new Promise((r) => setTimeout(r, 300))

  // 顶栏是否还挂着「新建任务」/ 对话页空状态文案（用户 2026-09-12 两条意见）
  const textCheck = await win.webContents.executeJavaScript(`
    (() => {
      const bar = document.querySelector('.topbar');
      const msgs = document.querySelector('.chat-messages');
      const empty = document.querySelector('.chat-empty');
      return {
        topbarText: bar ? bar.textContent.trim() : null,
        topbarHasSep: !!(bar && bar.querySelector('.topbar-sep')),
        topbarHasTitle: !!(bar && bar.querySelector('.topbar-title')),
        // 空对话必须**一个字都没有**（用户 2026-09-12：进入对话的背景干净最好）
        hasEmptyBlock: !!empty,
        messagesText: msgs ? msgs.textContent.trim() : null,
        msgCount: document.querySelectorAll('.msg').length,
        // plan46：消息操作条 —— 常驻（每条都有）、复制每条都有、编辑**只给用户消息**
        msgActions: (() => {
          const list = Array.from(document.querySelectorAll('.msg'));
          const hasAct = (m, kw) =>
            Array.from(m.querySelectorAll('.msg-act')).some((b) =>
              (b.getAttribute('aria-label') || '').includes(kw)
            );
          return {
            withBar: list.filter((m) => m.querySelector('.msg-actions')).length,
            withCopy: list.filter((m) => hasAct(m, '复制')).length,
            editOnUser: list
              .filter((m) => m.classList.contains('msg-user'))
              .every((m) => hasAct(m, '编辑')),
            editOnAssistant: list
              .filter((m) => m.classList.contains('msg-assistant'))
              .some((m) => hasAct(m, '编辑')),
            userCount: list.filter((m) => m.classList.contains('msg-user')).length,
            assistantCount: list.filter((m) => m.classList.contains('msg-assistant')).length
          };
        })()
      };
    })()
  `)

  const shot1 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-wide.png'), shot1.toPNG())

  win.setSize(760, 700)
  await new Promise((r) => setTimeout(r, 1200))
  const m2 = await measure()
  const shot2 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-narrow.png'), shot2.toPNG())

  win.setSize(1200, 800)
  await new Promise((r) => setTimeout(r, 800))

  /*
   * ── 设置改**独立窗口**（2026-09-13 用户定案）──────────────────────────
   *
   * 以前这里点齿轮 = 主区域切到设置页，此后所有探针都打在 `win` 上。
   * 现在点齿轮 = **弹出第二个 BrowserWindow**，设置内容在**另一个 webContents** 里 ——
   * 故下面一律改用 `swin`（设置窗口）与 `seval`（在设置窗口里求值）。
   *
   * ⚠️ 这一段本身就是"设置真的独立了"的**机械证据**：若齿轮还是切主区域那一套，
   *    `swin` 会一直是 null，下面每一条都会红 —— 而不是悄悄绿着。
   * ⚠️ 用 `getAllWindows()` 找**第二个**窗口（不是 [0]）：这一层是"测试怎么找窗口"，
   *    与产品代码里的窗口登记制是两回事（那是主进程里按用途取，见 window-registry.ts）。
   */
  const openSettingsWin = async () => {
    // 点齿轮 → 主进程建独立窗口
    await win.webContents.executeJavaScript(`
      (() => {
        const gear = document.querySelector('.gear-btn');
        if (gear) gear.click();
        return !!gear;
      })()
    `)
    // 等窗口出现 + 加载完（设置页要拉 settings/models/logs 好几路 IPC）
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      const found = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed())
      if (found) {
        await new Promise((r) => setTimeout(r, 900)) // 再等一拍让 React 挂载完
        return found
      }
    }
    return null
  }

  /** 在**设置窗口**里求值（主窗口一律用 win.webContents） */
  const sevalRaw = async (expr) => {
    const swinNow = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed())
    if (!swinNow) throw new Error('设置窗口不存在 —— 齿轮没能开出独立窗口')
    return swinNow.webContents.executeJavaScript(expr)
  }
  /** 在设置窗口里求值，并顺带返回该窗口对象的方便取法 */
  const getSettingsWin = () => BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed())

  const swin = await openSettingsWin()
  checkTrue('点侧栏齿轮 → **开出独立的设置窗口**（不是切主区域视图）', swin !== null && swin !== undefined, {
    opened: !!swin,
    windowCount: BrowserWindow.getAllWindows().length
  })
  // 主区域**不该**再出现设置内容 —— 齿轮是开窗，不是切页
  const mainHasSettings = await win.webContents.executeJavaScript(
    "(() => !!document.querySelector('.settings-view'))()"
  )
  checkTrue('主窗口里**不再有设置视图**（设置已整体搬进独立窗口）', mainHasSettings === false, {
    mainHasSettings
  })
  // 独立窗口的地址带 `#/settings` —— 渲染入口据此分叉（main.tsx）
  checkTrue(
    '设置窗口的 URL 带 `#/settings`（渲染入口按 hash 分叉）',
    typeof swin.webContents.getURL() === 'string' && swin.webContents.getURL().includes('settings'),
    { url: swin.webContents.getURL().slice(-60) }
  )
  // 外壳：标题行（视觉锚点）—— ⚠️ **没有**自绘关闭按钮（2026-09-14 用户反馈双 ×：
  // 系统标题栏已有 ×，再画一个紧贴其下干同一件事，想关设置时极易误点成关掉整个应用）
  const shellInfo = await sevalRaw(`
    (() => ({
      hasShell: !!document.querySelector('.settings-window'),
      title: document.querySelector('.settings-window-title')?.textContent?.trim() ?? null,
      hasDrawnClose: !!document.querySelector('.settings-window-close'),
      // ⚠️ 旧的「← 返回」必须**不在**：设置是独立窗口，出口是系统标题栏 × 与 Esc
      hasBackBtn: !!document.querySelector('.settings-nav .back-btn')
    }))()
  `)
  console.log('SETTINGS_SHELL=' + JSON.stringify(shellInfo))
  checkTrue(
    '设置窗口有外壳标题「设置」；**自绘 × 已删**（系统标题栏 × 是唯一鼠标出口，双 × 会误关应用）；旧的「← 返回」也不在',
    shellInfo.hasShell === true &&
      shellInfo.title === '设置' &&
      shellInfo.hasDrawnClose === false &&
      shellInfo.hasBackBtn === false,
    shellInfo
  )

  // 设置窗口截一张（这就是用户看到的形态）
  {
    const sshot = await getSettingsWin().capturePage()
    writeFileSync(join(SHOTS, 'verify-settings-window.png'), sshot.toPNG())
  }

  // —— 设置页分区导航（左导航 + 右内容）：量几何 + 逐个点开截图，选中态必须有背景色 ——
  const navInfo = await sevalRaw(`
    (() => {
      const items = Array.from(document.querySelectorAll('.settings-nav-item'));
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
      };
      const nav = document.querySelector('.settings-nav');
      const body = document.querySelector('.settings-body');
      const on = document.querySelector('.settings-nav-item.is-on');
      const idle = items.find((b) => !b.classList.contains('is-on'));
      return {
        count: items.length,
        labels: items.map((b) => b.textContent.trim()),
        nav: nav ? rect(nav) : null,
        body: body ? rect(body) : null,
        active: on ? on.textContent.trim() : null,
        activeBg: on ? getComputedStyle(on).backgroundColor : null,
        idleBg: idle ? getComputedStyle(idle).backgroundColor : null,
        iconCount: document.querySelectorAll('.settings-nav-icon svg').length,
        h2: document.querySelector('.settings-body h2')?.textContent?.trim() ?? null
      };
    })()
  `)
  console.log('SETTINGS_NAV=' + JSON.stringify(navInfo))

  // —— 设置页「语音输入」分区（plan45 决策 1/5）：端点/Key/模型/语言 + 测试连接 + 推荐服务清单 ——
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((x) => x.textContent.trim() === '语音输入');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const voiceSection = await sevalRaw(`
    (() => {
      const body = document.querySelector('.settings-body');
      if (!body) return null;
      const inputs = Array.from(body.querySelectorAll('input'));
      const testBtn = Array.from(body.querySelectorAll('button')).find((x) => x.textContent.trim() === '测试连接');
      return {
        h2: body.querySelector('h2')?.textContent?.trim() ?? null,
        hasEndpoint: inputs.some((i) => (i.placeholder || '').includes('127.0.0.1')),
        endpointFilled: inputs.some((i) => (i.value || '').includes('7101')),
        hasKeyField: inputs.some((i) => i.type === 'password'),
        hasSelect: !!body.querySelector('select'),
        testEnabled: testBtn ? !testBtn.disabled : null,
        guide: !!body.querySelector('details.voice-guide'),
        noPostProcessNote: (body.textContent || '').includes('不做任何后处理')
      };
    })()
  `)
  checkTrue(
    '设置页「语音输入」：端点/Key/语言字段齐、已存端点回显、测试连接可用、推荐清单与零后处理声明在位',
    voiceSection !== null &&
      voiceSection.h2 === '语音输入' &&
      voiceSection.hasEndpoint &&
      voiceSection.endpointFilled &&
      voiceSection.hasKeyField &&
      voiceSection.hasSelect &&
      voiceSection.testEnabled === true &&
      voiceSection.guide &&
      voiceSection.noPostProcessNote,
    voiceSection
  )

  // —— 设置页「开发环境」区（plan43 S2）：只借 Trae 结构；无＋、逐字文案、双行下拉、其他折叠 ——
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((x) => x.textContent.trim() === '开发环境');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const deView = await sevalRaw(`
    (() => {
      const body = document.querySelector('.settings-body');
      if (!body) return null;
      const groups = Array.from(body.querySelectorAll('.de-group'));
      const nodeGroup = groups.find((g) => g.textContent.includes('Node.js'));
      const pyGroup = groups.find((g) => g.textContent.includes('Python'));
      const trigger = pyGroup ? pyGroup.querySelector('.rs-trigger') : null;
      return {
        h2: body.querySelector('h2')?.textContent?.trim() ?? null,
        groupCount: groups.length,
        nodeEmptyText: nodeGroup ? nodeGroup.textContent : null,
        triggerLabel: trigger ? trigger.textContent : null,
        hasRefresh: Array.from(body.querySelectorAll('button')).some((x) => x.textContent.trim() === '刷新'),
        hasPlus: Array.from(body.querySelectorAll('button')).some((x) => x.textContent.trim() === '＋')
      };
    })()
  `)
  checkTrue(
    '开发环境区：只显 Node/Python 两组、空组逐字「未检测到，请刷新」、选中项回显别名、有刷新、**无＋按钮**',
    deView !== null &&
      deView.h2 === '开发环境' &&
      deView.groupCount === 2 &&
      deView.nodeEmptyText.includes('未检测到，请刷新') &&
      deView.triggerLabel.includes("3.12.13 ('ai_env')") &&
      deView.hasRefresh &&
      !deView.hasPlus,
    deView
  )
  // 下拉展开：双行（名称+路径）、当前项打勾、「其他」可展开；选中「其他」项 → 落选择并回显
  const dePop = await sevalRaw(`
    (async () => {
      const pyGroup = Array.from(document.querySelectorAll('.de-group')).find((g) => g.textContent.includes('Python'));
      pyGroup.querySelector('.rs-trigger').click();
      await new Promise((r) => setTimeout(r, 200));
      const pop = document.querySelector('.rs-pop');
      if (!pop) return { fail: 'no-pop' };
      const checked = !!pop.querySelector('.rs-item.is-on .rs-item-check');
      const othersBtn = Array.from(pop.querySelectorAll('button')).find((b) => b.textContent.includes('其他'));
      if (othersBtn) othersBtn.click();
      await new Promise((r) => setTimeout(r, 150));
      const itemPaths = Array.from(pop.querySelectorAll('.rs-item-path')).length;
      const items = Array.from(pop.querySelectorAll('.rs-item'));
      const target = items.find((i) => i.textContent.includes('D:/weird') || i.textContent.includes('D:\\\\weird'));
      if (target) target.click();
      await new Promise((r) => setTimeout(r, 250));
      const trigger = pyGroup.querySelector('.rs-trigger');
      return { itemPaths, checked, hasOthersToggle: !!othersBtn, newLabel: trigger.textContent };
    })()
  `)
  checkTrue(
    '运行时下拉：每项双行含路径、当前项打勾、「其他」展开后可选中，选择即时回显（探测是唯一入口，选择即持久化）',
    dePop.itemPaths >= 5 &&
      dePop.checked === true &&
      dePop.hasOthersToggle === true &&
      dePop.newLabel.includes('3.8.0'),
    dePop
  )
  checkTrue(
    '选择走 IPC 落盘（dev-env:select 被真实调用，语言与路径都对）',
    devEnvSelectCalls.some(([lang, p]) => lang === 'python' && String(p).includes('weird')),
    devEnvSelectCalls
  )

  // —— MCP 区 computer-use 推荐卡片（plan44 S3）：uv 联动 / 风险披露逐字 / 添加只写配置 ——
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((x) => x.textContent.trim() === 'MCP');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))
  const cuCard = await sevalRaw(`
    (() => {
      const card = document.querySelector('.cu-card');
      if (!card) return null;
      const addBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '添加');
      return {
        title: card.textContent.includes('电脑操作（computer-use）'),
        uvLine: (card.querySelector('.cu-meta')?.textContent ?? '').includes('已检测到'),
        mainOnlyNote: card.textContent.includes('仅支持主显示器'),
        addEnabled: addBtn ? !addBtn.disabled : false
      };
    })()
  `)
  checkTrue(
    '推荐卡片：标题在位、uv 联动"已检测到"（复用 plan43 探测）、主屏限定声明、依赖就绪时[添加]可点',
    cuCard !== null && cuCard.title && cuCard.uvLine && cuCard.mainOnlyNote && cuCard.addEnabled,
    cuCard
  )
  const cuRisk = await sevalRaw(`
    (async () => {
      const card = document.querySelector('.cu-card');
      Array.from(card.querySelectorAll('button')).find((b) => b.textContent.includes('查看风险说明')).click();
      await new Promise((r) => setTimeout(r, 250));
      const modal = document.querySelector('.voice-disclosure');
      return modal ? { text: modal.textContent } : null;
    })()
  `)
  checkTrue(
    '风险披露（决策 8 逐字）：三能力 + "请勿在开启状态下离开电脑" + "无法区分你本人与AI" 的天花板诚实行都在',
    cuRisk !== null &&
      cuRisk.text.includes('截取你的整个屏幕') &&
      cuRisk.text.includes('请勿在开启状态下离开电脑') &&
      cuRisk.text.includes('无法区分') &&
      cuRisk.text.includes('屏蔽了文件系统、注册表、PowerShell'),
    cuRisk
  )
  const cuAdd = await sevalRaw(`
    (async () => {
      const modal = document.querySelector('.voice-disclosure');
      const btn = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent.includes('我已了解，添加服务'));
      if (!btn) return { fail: 'no-confirm-btn' };
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const card = document.querySelector('.cu-card');
      return {
        tagAdded: card.textContent.includes('已添加'),
        twoGatesNote: card.textContent.includes('电脑控制')
      };
    })()
  `)
  checkTrue(
    '添加：确认后写入 windows-mcp 配置（uvx windows-mcp serve）并回显"已添加"，提示还需第二道闸',
    cuAdd.tagAdded === true &&
      cuAdd.twoGatesNote === true &&
      mcpSaveCalls.some(
        (c) => c.name === 'windows-mcp' && c.command === 'uvx' && (c.args ?? []).includes('serve')
      ),
    { cuAdd, saved: mcpSaveCalls.map((c) => c.name) }
  )

  // ── 设置页「记忆」分区（plan19 批 1）· 判据 14 的 UI 契约 ──────────────────
  // ⚠️ 判据 14 的**判定逻辑**在真主进程（关→开 且 完全访问档）；门禁不加载它，
  //    故这里钉的是**界面契约**：主进程说 warnFullAccess，界面就必须当场告警、关回去就消失。
  //    （开关桩在 STUBS 表里 —— 那张表启动时一次性注册，后挂的桩不会生效。）
  const clickMemorySection = () =>
    sevalRaw(`
      (() => {
        const b = Array.from(document.querySelectorAll('.settings-nav-item'))
          .find((x) => x.textContent.trim() === '记忆');
        if (b) b.click();
        return !!b;
      })()
    `)
  await clickMemorySection()
  await new Promise((r) => setTimeout(r, 700))
  const memSettings = await sevalRaw(`
    (() => {
      const box = document.querySelector('.settings-section .checkbox input[type="checkbox"]');
      return {
        h2: document.querySelector('.settings-body h2')?.textContent?.trim() ?? null,
        hasCheckbox: !!box,
        checked: box ? box.checked : null,
        disabled: box ? box.disabled : null,
        note: (document.querySelector('.settings-body .field-note')?.textContent ?? '').length
      };
    })()
  `)
  console.log('SETTINGS_MEMORY=' + JSON.stringify(memSettings))
  checkTrue(
    '设置页有「记忆」分区：开关存在、可点、说明走 ⓘ',
    memSettings.h2 === '记忆' && memSettings.hasCheckbox === true && memSettings.disabled === false,
    memSettings
  )

  // 判据 14：完全访问档下开启记忆 → **当场**出现告警（躺一行字等于没写）。
  // ⚠️ 先把"主进程判定为最大风险组合"这个开关打开 —— 上一版忘了置位，桩返回 false，
  //    红的其实是探针而不是产品（证伪纪律的又一次兑现：红的必须先查是谁的错）
  memoryWarnOnNextEnable = true
  await sevalRaw(
    "(() => { document.querySelector('.settings-section .checkbox input[type=checkbox]').click(); return true; })()"
  )
  await new Promise((r) => setTimeout(r, 600))
  const warnShown = await sevalRaw(`(() => !!document.querySelector('.mem-settings-warn'))()`)
  checkTrue(
    '判据 14：完全访问档下开启记忆 → **当场**出现告警（只躺一行字等于没写）',
    warnShown === true && memorySwitchCalls.includes(true),
    { warnShown, calls: memorySwitchCalls }
  )
  await sevalRaw(
    "(() => { document.querySelector('.settings-section .checkbox input[type=checkbox]').click(); return true; })()"
  )
  await new Promise((r) => setTimeout(r, 600))
  const warnGone = await sevalRaw(`(() => !!document.querySelector('.mem-settings-warn'))()`)
  checkTrue('判据 14：关回去告警即消失（风险组合不再成立）', warnGone === false, warnGone)
  memorySwitch = false
  memoryWarnOnNextEnable = false

  for (const [label, slug] of [
    ['通用设置', 'general'],
    ['模型', 'model'],
    ['子 Agent', 'agents'],
    ['记忆', 'memory'],
    ['外观', 'appearance'],
    ['故障排查', 'trouble']
  ]) {
    await sevalRaw(`
      (() => {
        const b = Array.from(document.querySelectorAll('.settings-nav-item'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (b) b.click();
        return !!b;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const secInfo = await sevalRaw(`
      (() => {
        const cards = Array.from(document.querySelectorAll('.choice-item'));
        const rects = cards.map((el) => el.getBoundingClientRect());
        return {
          h2: document.querySelector('.settings-body h2')?.textContent?.trim() ?? null,
          choices: cards.length,
          // 卡片宽度 + 是否同一行（top 相同即一排）——"等宽并排"必须量，不能靠看
          cardW: rects.map((r) => Math.round(r.width)),
          sameRow: new Set(rects.map((r) => Math.round(r.top))).size === 1,
          buttons: Array.from(document.querySelectorAll('.settings-body .actions button'))
            .map((b) => b.textContent.trim())
        };
      })()
    `)
    console.log('SETTINGS_SECTION=' + slug + ' ' + JSON.stringify(secInfo))
    if (slug === 'model') {
      // ── 模型列表：判据盯看得见的东西 —— 条数、当前标记只有 1 个、每行 3 个操作、页面里出现真实路径 ──
      const modelPage = await sevalRaw(`
        (() => {
          const rows = Array.from(document.querySelectorAll('.model-row'));
          const first = rows[0];
          return {
            rows: rows.length,
            names: rows.map((r) => r.querySelector('.model-name')?.textContent?.trim() ?? ''),
            sources: rows.map((r) => r.querySelector('.model-source')?.textContent?.trim() ?? ''),
            currentCount: document.querySelectorAll('.model-current').length,
            currentRow: rows.findIndex((r) => r.querySelector('.model-current')) ,
            actsPerRow: rows.map((r) => r.querySelectorAll('.model-act').length),
            hasAddBtn: !!Array.from(document.querySelectorAll('.model-add')).find(
              (b) => (b.textContent || '').includes('添加模型')
            ),
            filePathShown: document.querySelector('.model-file')?.textContent?.trim() ?? '',
            // 表单**不该**在列表态出现（以前它是常驻的，那才是"表单而不是列表"）
            formVisible: !!document.querySelector('.model-form-title'),
            addVisible: (() => {
              const b = Array.from(document.querySelectorAll('.model-add'))[0];
              if (!b) return false;
              const r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
            })(),
            rowVisibleH: first ? Math.round(first.getBoundingClientRect().height) : 0
          };
        })()
      `)
      console.log('MODELS=' + JSON.stringify(modelPage))

      // ── 模型分组（2026-09-15 用户需求）：端点为组、组名做标题、组下摆全部模型 ──
      const modelGroup = await sevalRaw(`
        (() => {
          const groups = Array.from(document.querySelectorAll('.model-list .model-group'));
          return {
            groups: groups.length,
            entries: document.querySelectorAll('.model-list .model-entry').length,
            curMarks: document.querySelectorAll('.model-list .model-entry-cur').length,
            useBtns: document.querySelectorAll('.model-list .model-entry-use').length,
            headNames: groups.map((g) => g.querySelector('.model-row .model-name')?.textContent?.trim() ?? ''),
            firstEntryName: document.querySelector('.model-list .model-entry-name')?.textContent?.trim() ?? '',
            firstEntryVisible: (() => {
              const el = document.querySelector('.model-list .model-entry');
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })()
          };
        })()
      `)
      console.log('MODELS_GROUP=' + JSON.stringify(modelGroup))
      checkTrue('设置页模型列表**按端点分组**（组数 = 端点数）', modelGroup.groups === modelPage.rows, {
        groups: modelGroup.groups,
        rows: modelPage.rows
      })
      checkTrue(
        '组下列出**全部模型目录条目**且看得见（几何尺寸非零）',
        modelGroup.entries >= modelGroup.groups && modelGroup.firstEntryVisible === true,
        { entries: modelGroup.entries, groups: modelGroup.groups, firstEntryVisible: modelGroup.firstEntryVisible }
      )
      checkTrue('组下「当前模型」标记**全局唯一**', modelGroup.curMarks === 1, { curMarks: modelGroup.curMarks })
      checkTrue('非当前模型都有「用这个」入口（数量互补，一个不缺）', modelGroup.useBtns === modelGroup.entries - modelGroup.curMarks, {
        useBtns: modelGroup.useBtns,
        entries: modelGroup.entries,
        curMarks: modelGroup.curMarks
      })

      // ── 模型目录编辑器（F5.1）：点「编辑」→ 一行一个模型 + 每个模型可展开高级设置 ──
      // ⚠️ 2026-09-13：点「编辑」现在进的是**二级页**（表单取代列表）。故这一段同时验二级页形态。
      await sevalRaw(`
        (() => {
          const btn = Array.from(document.querySelectorAll('.model-row .model-act'))
            .find((b) => (b.getAttribute('title') || '').includes('编辑'));
          if (btn) btn.click();
          return !!btn;
        })()
      `)
      await new Promise((r) => setTimeout(r, 700))
      const catalog = await sevalRaw(`
        (() => {
          const rows = Array.from(document.querySelectorAll('.mc-row'));
          return {
            open: !!document.querySelector('.mc'),
            rows: rows.length,
            ids: Array.from(document.querySelectorAll('.mc-model')).map((i) => i.value),
            hasAdd: !!Array.from(document.querySelectorAll('.mc-foot button')).find((b) => (b.textContent || '').includes('添加模型')),
            hasFetch: !!Array.from(document.querySelectorAll('.mc-link')).find((b) => (b.textContent || '').includes('获取可用模型')),
            hasRestore: !!Array.from(document.querySelectorAll('.mc-link')).find((b) => (b.textContent || '').includes('恢复默认模型')),
            advBefore: !!document.querySelector('.mc-adv'),
            // 二级页形态（2026-09-13）：表单取代列表 + 左上角有「← 返回」
            isSubpage: !!document.querySelector('.settings-subpage'),
            hasBack: !!document.querySelector('.settings-subpage .back-btn'),
            listGone: !document.querySelector('.model-head'),
            titleText: document.querySelector('.model-form-title')?.textContent?.trim() ?? null
          };
        })()
      `)
      await sevalRaw(`
        (() => { const b = document.querySelector('.mc-row .mc-icon'); if (b) b.click(); return !!b })()
      `)
      await new Promise((r) => setTimeout(r, 500))
      const adv = await sevalRaw(`
        (() => ({ panel: !!document.querySelector('.mc-adv'), fields: document.querySelectorAll('.mc-adv input, .mc-adv select').length }))()
      `)
      console.log('MODEL_CATALOG=' + JSON.stringify({ ...catalog, adv }))
      modelCatalog = { ...catalog, adv }

      // ── plan47 S1 免保存拉取：新建端点（未入库、无 id）也应能拉，破「先保存才能拉」死循环 ──
      // 点「添加模型」进空白表单 → 填 baseURL → 点「获取可用模型」→ 断言真的发起了 models:fetch-available
      //   且入参含表单里的 baseURL（不是先弹「请先保存」）。
      await sevalRaw(`
        (() => {
          const back = document.querySelector('.settings-subpage .back-btn');
          if (back) back.click();
          return !!back;
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))
      await sevalRaw(`
        (() => {
          const add = Array.from(document.querySelectorAll('button.model-add')).find((b) => (b.textContent || '').includes('添加模型'));
          if (add) add.click();
          return !!add;
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))
      fetchNewEndpoint = await sevalRaw(`
        (() => {
          const label = Array.from(document.querySelectorAll('.settings-subpage label'))
            .find((l) => (l.textContent || '').includes('接口地址'));
          const urlInput = label ? label.querySelector('input') : null;
          if (!urlInput) return { ok: false, reason: 'no-url-input' };
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(urlInput, 'https://api.new-unsaved.test');
          urlInput.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        })()
      `)
      await new Promise((r) => setTimeout(r, 300))
      const beforeFetchCalls = fetchAvailableCalls.length
      await sevalRaw(`
        (() => {
          const btn = Array.from(document.querySelectorAll('.mc-link')).find((b) => (b.textContent || '').includes('获取可用模型'));
          if (btn) btn.click();
          return !!btn;
        })()
      `)
      await new Promise((r) => setTimeout(r, 600))
      const fetchCall = fetchAvailableCalls[beforeFetchCalls] || null
      fetchNewEndpoint = {
        ...fetchNewEndpoint,
        fired: fetchAvailableCalls.length > beforeFetchCalls,
        baseURL: fetchCall ? fetchCall.baseURL : null,
        hasId: fetchCall ? !!fetchCall.id : null
      }
      console.log('FETCH_NEW_ENDPOINT=' + JSON.stringify(fetchNewEndpoint))
    }
    if (slug === 'agents') {
      // ── 子 Agent 管理（plan17）：列表三节 + 警告区可见；编辑进表单；表单校验拒绝 ──
      const listInfo = await sevalRaw(`
        (() => {
          const sections = Array.from(document.querySelectorAll('.ag-section'));
          const rows = Array.from(document.querySelectorAll('.ag-row'));
          return {
            sections: sections.length,
            titles: sections.map((s) => (s.querySelector('.ag-section-title')?.textContent || '').trim()),
            rows: rows.length,
            names: rows.map((r) => r.querySelector('.ag-name')?.textContent?.trim() ?? ''),
            warnShown: !!document.querySelector('.ag-warn'),
            warnText: document.querySelector('.ag-warn')?.textContent?.trim() ?? '',
            newBtn: !!Array.from(document.querySelectorAll('.ag-btn-go')).find((b) => b.textContent.includes('新建 Agent')),
            overriddenTag: !!document.querySelector('.ag-tag-off'),
            editBtns: rows.filter((r) => r.querySelector('.ag-row-actions')).length
          };
        })()
      `)
      console.log('AGENTS_LIST=' + JSON.stringify(listInfo))

      // 点「新建 Agent」进表单 → 空 name 直接近保存：校验必须拦（表单与 loader 同口径的可视面）
      await sevalRaw(`
        (() => {
          const b = Array.from(document.querySelectorAll('.ag-btn-go')).find((x) => x.textContent.includes('新建 Agent'));
          if (b) b.click();
          return !!b;
        })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      const formEmpty = await sevalRaw(`
        (() => ({
          formOpen: !!document.querySelector('.ag-form-head'),
          saveDisabled: (() => {
            const b = Array.from(document.querySelectorAll('.ag-btn-go')).find((x) => x.textContent.trim() === '保存');
            return b ? b.disabled : null;
          })(),
          errShown: document.querySelector('.ag-err')?.textContent?.trim() ?? null,
          nameEditable: (() => {
            const i = document.querySelector('.ag-input');
            return i ? !i.disabled : null;
          })()
        }))()
      `)
      console.log('AGENTS_FORM_EMPTY=' + JSON.stringify(formEmpty))

      // 填上合法值再保存 → 列表应多出「code-reviewer」（桩有状态：save 后 list 可见）
      // ⚠️ 填值与点击之间**必须等 React 重渲染**：受控组件的禁用态由 render 重算，
      //    立即点击时按钮还停在 disabled（合成 click 打在被禁用的按钮上 = 什么都不会发生）
      await sevalRaw(`
        (() => {
          // .ag-input = name/description/model 三个；systemPrompt 是 .ag-textarea —— 它没填校验就拦（恰好也是一次校验面验证）
          const inputs = Array.from(document.querySelectorAll('.ag-input'));
          const name = inputs[0];
          const desc = inputs[1];
          const body = document.querySelector('.ag-textarea');
          const iSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const tSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          if (name && !name.disabled) { iSet.call(name, 'code-reviewer'); name.dispatchEvent(new Event('input', { bubbles: true })); }
          if (desc) { iSet.call(desc, '代码评审专家'); desc.dispatchEvent(new Event('input', { bubbles: true })); }
          if (body) { tSet.call(body, '只报告可证明的问题，按 P0~P3 分级。'); body.dispatchEvent(new Event('input', { bubbles: true })); }
          return true;
        })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      const beforeSave = await sevalRaw(`
        (() => {
          const inputs = Array.from(document.querySelectorAll('.ag-input'));
          const b = Array.from(document.querySelectorAll('.ag-btn-go')).find((x) => x.textContent.trim() === '保存');
          return {
            nameValue: inputs[0]?.value ?? null,
            descValue: inputs[1]?.value ?? null,
            saveDisabled: b ? b.disabled : null,
            err: document.querySelector('.ag-err')?.textContent?.trim() ?? null
          };
        })()
      `)
      console.log('AGENTS_BEFORE_SAVE=' + JSON.stringify(beforeSave))
      await sevalRaw(`
        (() => {
          const b = Array.from(document.querySelectorAll('.ag-btn-go')).find((x) => x.textContent.trim() === '保存');
          if (b) b.click();
          return !!b;
        })()
      `)
      await new Promise((r) => setTimeout(r, 700))
      const afterSave = await sevalRaw(`
        (() => ({
          names: Array.from(document.querySelectorAll('.ag-row .ag-name')).map((n) => n.textContent.trim()),
          notice: document.querySelector('.ag-ok')?.textContent?.trim() ?? '',
          stillForm: !!document.querySelector('.ag-form-head')
        }))()
      `)
      console.log('AGENTS_AFTER_SAVE=' + JSON.stringify(afterSave))
      agentsMgr = { list: listInfo, formEmpty, afterSave }
    }
    const png = await getSettingsWin().capturePage()
    writeFileSync(join(SHOTS, 'verify-settings-' + slug + '.png'), png.toPNG())
  }

  // —— 注释收 ⓘ（2026-09-14 用户定调「界面极简」）：卡内不再有直接显示的说明，
  //    说明住在组级 ⓘ 气泡里 —— 且气泡必须**真的能展开**（只写 aria-label 不算展示）。
  // ⚠️ 探针跑在分区循环之后，窗口停在「故障排查」——那里本来就没有 choice 卡，
  //    直接量 = descCount 恒 0 的假绿。必须先点回「通用设置」再量。
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.trim() === '通用设置');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  // ⚠️ Chromium 对**失焦窗口**不匹配 :focus（activeElement 有值但伪类不命中）—— 真实用户看 ⓘ 时
  //    窗口必然是前台的，故先把设置窗口调到前台再聚焦 ⓘ，探针环境才对齐真实使用状态
  getSettingsWin().focus()
  await new Promise((r) => setTimeout(r, 300))
  const minimal = await sevalRaw(`
    (async () => {
      const descCount = document.querySelectorAll('.choice-desc').length;
      const fnoteCount = document.querySelectorAll('.fnote-mark').length;
      // 聚焦 Token Saver 的 ⓘ，量气泡几何 —— "DOM 存在 ≠ 看得见"（AGENTS §八同源教训）
      const label = Array.from(document.querySelectorAll('.field-label')).find((l) => l.textContent.trim().startsWith('Token Saver'));
      const mark = label ? label.querySelector('.fnote-mark') : null;
      let bubbleVisible = false;
      let bubbleH = 0;
      let bubbleLines = 0;
      let focusDiag = null;
      if (mark) {
        mark.focus();
        await new Promise((r) => setTimeout(r, 300));
        const bubble = mark.parentElement.querySelector('.fnote-bubble');
        if (bubble) {
          const r = bubble.getBoundingClientRect();
          bubbleVisible = getComputedStyle(bubble).display !== 'none' && r.height > 20;
          bubbleH = Math.round(r.height);
          bubbleLines = bubble.querySelectorAll('.fnote-line').length;
        }
        // 诊断：activeIsMark=true 而 matchesFocus=false 是 Chromium 对脚本聚焦的已知怪癖
        // （executeJavaScript 的 focus() 不触发 :focus 伪类），与真实用户悬停/点击无关。
        focusDiag = {
          activeIsMark: document.activeElement === mark,
          matchesFocus: (() => { try { return mark.matches(':focus') } catch { return null } })(),
          display: bubble ? getComputedStyle(bubble).display : null
        };
        mark.blur();
      }
      // 展开规则必须**真实存在于已加载的样式表**（悬停/聚焦是浏览器原生行为，规则在即生效）；
      // 遍历 styleSheets 而不是赌 :focus 伪类在脚本聚焦下命中 —— 后者已被证伪两次
      let expandRuleFound = false;
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const t = rule.cssText || '';
            if (t.indexOf('fnote-mark') >= 0 && t.indexOf('fnote-bubble') >= 0 && (t.indexOf(':focus') >= 0 || t.indexOf(':hover') >= 0)) {
              expandRuleFound = true;
            }
          }
        } catch {
          // 跨域样式表读不了 cssRules —— 本应用的样式全同源，走不到这里
        }
      }
      // 卡片高度对比：去说明后主题卡应明显变薄（>14px 说明文字占了近一行）
      const themeCard = document.querySelector('[aria-label="主题"] .choice-item');
      return { descCount, fnoteCount, bubbleVisible, bubbleH, bubbleLines, expandRuleFound, focusDiag, themeCardH: themeCard ? Math.round(themeCard.getBoundingClientRect().height) : 0 };
    })()
  `)
  console.log('MINIMAL_NOTE=' + JSON.stringify(minimal))
  checkTrue('界面极简：选项卡内不再有直接显示的说明文字（.choice-desc 清零）',
    minimal?.descCount === 0, minimal)
  checkTrue('组级 ⓘ 就位（本分区：权限/Token Saver/系统/网络/工作区等 ≥ 4 个记号）',
    (minimal?.fnoteCount ?? 0) >= 4, minimal)
  checkTrue('ⓘ 气泡就位：分条内容在（≥5 条）且**展开规则真实存在于已加载样式表**（悬停/聚焦即生效）',
    (minimal?.bubbleLines ?? 0) >= 5 && minimal?.expandRuleFound === true, minimal)

  const m3 = await sevalRaw(`
    (() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        view: pick('.settings-view') ? 'settings' : '?',
        section: pick('.settings-section'),
        logsInfo: pick('.logs-info'),
        logsPath: pick('.logs-path'),
        pathText: document.querySelector('.logs-path')?.textContent?.trim() ?? null,
        countText: document.querySelector('.logs-count')?.textContent?.trim() ?? null,
        btnText: document.querySelector('.settings-section button')?.textContent?.trim() ?? null,
        btnDisabled: document.querySelector('.settings-section button')?.disabled ?? null
      };
    })()
  `)
  // 不额外存 verify-settings.png：它与下面分区循环里的 trouble 那张**逐字节相同**（实测哈希一致）
  void m3

  /** 打开工作台里的某个内置面板：不是“点常驻页签”，而是 ＋ 开窗菜单 —— 没展开先点顶栏开关 →
   *  已有栏就点栏内 ＋ → 点菜单里同名那项；每步之间要等 React 重渲染，故拆成三次 executeJavaScript。 */
  const openBuiltin = async (label) => {
    await win.webContents.executeJavaScript(`
      (() => {
        if (document.querySelector('.dock')) return 'already-open';
        // 必须按 title 定位（顶栏有两个 panel-btn，第一个是侧栏开关）；本行在模板串里，注释不许出现反引号
        const b = document.querySelector('.panel-btn[title*="工作台"]');
        if (b) b.click();
        return b ? 'opened' : 'no-toggle';
      })()
    `)
    await new Promise((r) => setTimeout(r, 450))

    await win.webContents.executeJavaScript(`
      (() => {
        if (document.querySelector('.wb-pick')) return 'chooser-visible';
        const add = document.querySelector('.pane-add');
        if (add) add.click();
        return add ? 'menu-opened' : 'no-add';
      })()
    `)
    await new Promise((r) => setTimeout(r, 400))

    return win.webContents.executeJavaScript(`
      (() => {
        const b = Array.from(document.querySelectorAll('.wb-pick'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (b) b.click();
        return !!b;
      })()
    `)
  }

  // —— 文件变更记录面板（plan8 R4）：真点一遍回滚，验证"改坏能退回" ──
  const openedChanges = await openBuiltin('文件变更')
  checkTrue('工作台能通过 ＋ 菜单打开面板（文件变更）', openedChanges === true, openedChanges)
  await new Promise((r) => setTimeout(r, 1200))

  await win.webContents.executeJavaScript(`
    (() => {
      const t = document.querySelector('.ck-run-toggle');
      if (t) t.click();
      return !!t;
    })()
  `)
  await new Promise((r) => setTimeout(r, 1000))

  const beforeRollback = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.ck-files');
      const r = box ? box.getBoundingClientRect() : null;
      const body = document.querySelector('.dock-body');
      return {
        runs: document.querySelectorAll('.ck-run').length,
        files: document.querySelectorAll('.ck-file').length,
        kinds: Array.from(document.querySelectorAll('.ck-kind')).map((e) => e.textContent.trim()),
        rels: Array.from(document.querySelectorAll('.ck-file-rel')).map((e) => e.textContent.trim()),
        badges: Array.from(document.querySelectorAll('.ck-badge')).map((e) => e.textContent.trim()),
        // 关键：文件列表是否**真的可见**（存在 ≠ 用户看得到）
        filesBox: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) } : null,
        dockBodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
        dockScrollTop: body ? Math.round(body.scrollTop) : null,
        dockScrollH: body ? Math.round(body.scrollHeight) : null
      };
    })()
  `)
  const shot4 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-changes.png'), shot4.toPNG())

  // 点「整轮回滚」→ 应进入二次确认。⚠️ React 状态更新是异步的，点击后必须等一拍再读 DOM，否则假阴性
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.ck-run .ck-btn'))
        .find((b) => b.textContent.trim() === '整轮回滚');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const confirmStep = await win.webContents.executeJavaScript(`
    (() => ({
      hasConfirm: !!document.querySelector('.ck-confirm'),
      confirmText: document.querySelector('.ck-btn-danger')?.textContent?.trim() ?? null,
      // 二次确认弹出时，回滚不应已发生（这正是"危险动作要卡一下"的意义）
      noticeBeforeConfirm:
        document.querySelector('.ck-panel .notice-ok')?.textContent?.trim() ?? null
    }))()
  `)

  const afterRollback = await win.webContents.executeJavaScript(`
    (() => {
      const go = document.querySelector('.ck-btn-danger');
      if (go) go.click();
      return !!go;
    })()
  `)
  await new Promise((r) => setTimeout(r, 1500))
  const rollbackNotice = await win.webContents.executeJavaScript(`
    (() => ({
      notice: document.querySelector('.ck-panel .notice-ok, .ck-panel .notice-err')?.textContent?.trim() ?? null,
      ok: !!document.querySelector('.ck-panel .notice-ok')
    }))()
  `)
  const shot5 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-rollback.png'), shot5.toPNG())

  // —— 文件差异：判据落在内容与行号上（不用“有没有出现某个元素”当判据 —— 那样切错块、算错行号也照样绿）——
  const openDiff = async (rel) => {
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const item = Array.from(document.querySelectorAll('.ck-file-item'))
          .find((el) => el.querySelector('.ck-file-rel')?.textContent?.trim() === ${JSON.stringify(rel)});
        const btn = item
          ? Array.from(item.querySelectorAll('.ck-btn')).find((b) => b.textContent.trim() === '看差异')
          : null;
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 900))
    return clicked
  }
  const readDiff = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const wrap = document.querySelector('.df-wrap');
        if (!wrap) return { shown: false, hunks: 0, rows: [], warns: [], notes: [] };
        const rows = Array.from(wrap.querySelectorAll('.df-line')).map((el) => {
          const nos = Array.from(el.querySelectorAll('.df-no')).map((n) => n.textContent.trim());
          return {
            add: el.className.includes('df-add'),
            del: el.className.includes('df-del'),
            text: el.querySelector('.df-text')?.textContent ?? '',
            oldNo: nos[0] ?? '',
            newNo: nos[1] ?? ''
          };
        });
        return {
          shown: true,
          hunks: wrap.querySelectorAll('.df-hunk').length,
          hunkNos: Array.from(wrap.querySelectorAll('.df-hunk-no')).map((e) => e.textContent.trim()),
          sum: wrap.querySelector('.df-sum')?.textContent?.trim() ?? null,
          warns: Array.from(wrap.querySelectorAll('.df-warn')).map((e) => e.textContent.trim()),
          notes: Array.from(wrap.querySelectorAll('.df-note')).map((e) => e.textContent.trim()),
          identical: !!wrap.querySelector('.df-none'),
          rows
        };
      })()
    `)

  const diffEntry = await win.webContents.executeJavaScript(`
    (() => ({
      files: document.querySelectorAll('.ck-file-item').length,
      withBtn: Array.from(document.querySelectorAll('.ck-file-item')).filter((el) =>
        Array.from(el.querySelectorAll('.ck-btn')).some((b) => b.textContent.trim() === '看差异')
      ).length
    }))()
  `)

  const openedApp = await openDiff('src/app.ts')
  const diffApp = await readDiff()
  const shotDiff = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-diff.png'), shotDiff.toPNG())

  const openedNotes = await openDiff('src/notes.md')
  const diffNotes = await readDiff()
  const openedNew = await openDiff('src/brand-new.md')
  const diffNew = await readDiff()
  const openedHuge = await openDiff('src/huge.log')
  const diffHuge = await readDiff()

  const clickedClose = await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.df-bar .ck-btn'))
        .find((x) => x.textContent.trim() === '收起');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const diffClosed = await win.webContents.executeJavaScript(
    `(() => ({ gone: !document.querySelector('.df-wrap') }))()`
  )

  // —— 文件差异的**断言**（紧跟探针，避免暂时性死区）——
  checkTrue('每个改动文件都给了「看差异」入口',
    diffEntry.files > 0 && diffEntry.withBtn === diffEntry.files, diffEntry)
  checkTrue('点「看差异」→ 差异视图真的出来了', openedApp === true && diffApp.shown === true,
    { openedApp, shown: diffApp.shown })

  // ① 切块：fixture 里 app.ts 是**两处相隔很远**的改动，所以必须切成 2 块
  checkTrue('差异切成 **2 处**（fixture 就是两处远离的改动；切错会立刻暴露）',
    diffApp.hunks === 2, { hunks: diffApp.hunks, hunkNos: diffApp.hunkNos, sum: diffApp.sum })
  check('块号是「第 1 处 / 第 2 处」且连续',
    (diffApp.hunkNos || []).join(','), '第 1 处,第 2 处')

  const delX = (diffApp.rows || []).find((r) => r.del && r.text === 'const x = 1')
  const addX = (diffApp.rows || []).find((r) => r.add && r.text === 'const x = 42')
  checkTrue('删掉的行显示的是**改前那一行**（`const x = 1`）', !!delX, delX ?? diffApp.rows?.slice(0, 8))
  checkTrue('新增的行显示的是**改后那一行**（`const x = 42`）', !!addX, addX ?? null)
  // 行号是这套视图最容易算错的地方 —— 算错就是在骗用户"第几行改了"
  checkTrue('改前那行的**行号是 2**（不是从 0 或 1 重数）', delX?.oldNo === '2', { oldNo: delX?.oldNo })
  checkTrue('新增那行的**改后行号是 2**', addX?.newNo === '2', { newNo: addX?.newNo })
  const addZ = (diffApp.rows || []).find((r) => r.add && r.text === 'const z = y * 2')
  checkTrue('插进去的新行拿到的是**改后行号 18**（前面增过行，行号必须跟着错开）',
    addZ?.newNo === '18', { newNo: addZ?.newNo, text: addZ?.text })
  checkTrue('摘要写着「共 2 处改动」', (diffApp.sum || '').includes('共 2 处改动'), diffApp.sum)

  // ② 阴性对照：内容与快照一致时**不许**显示改动
  checkTrue('**内容与快照一致时显示"完全一致"**（阴性对照：证明它不是恒显示有改动）',
    diffNotes.shown === true && diffNotes.identical === true && diffNotes.hunks === 0,
    { shown: diffNotes.shown, identical: diffNotes.identical, hunks: diffNotes.hunks })

  // ③ created：改前根本不存在
  checkTrue('新建的文件：说清"改前不存在"，且**全是新增行**（一行删除都不该有）',
    openedNew === true && diffNew.notes.some((n) => n.includes('不存在')) &&
      diffNew.rows.length > 0 && diffNew.rows.every((r) => r.add),
    { notes: diffNew.notes, rows: diffNew.rows.length, hasDel: (diffNew.rows || []).some((r) => r.del) })
  checkTrue('新建的文件**明说不给逐处退回**（只能整份退回）',
    (diffNew.notes || []).some((n) => n.includes('没有') && n.includes('只能整份退回')),
    diffNew.notes)

  // ④ truncated：读不全就必须说出来，且不许逐处退回
  checkTrue('内容被截断时**明说只读了 256 KB**（读一半就下结论比不显示更误导）',
    openedHuge === true && (diffHuge.warns || []).some((w) => w.includes('256 KB')),
    { warns: diffHuge.warns })
  // ⚠️ 判据盯语义（“说明为什么退不了” + “只能整份退回”），不背原文 —— 绑死整句的话改文案就会假红
  checkTrue('截断时**说清为什么不能逐处退回、并指向整份退回**（拿半个文件写盘 = 把文件砍坏）',
    (diffHuge.notes || []).some((n) => n.includes('写坏') && n.includes('只能整份退回')),
    diffHuge.notes)

  checkTrue('点「收起」→ 差异视图收回去（不收起来会把面板撑爆）',
    clickedClose === true && diffClosed.gone === true, { clickedClose, ...diffClosed })

  // —— 逐处退回：验“界面说退第几处、内容由主进程算” ——
  // 判据三层：① 点一下不写盘（先弹确认）② 载荷是序号 + mtime 安全阀 ③ 退回后界面必须重新取数。
  const openedAppRevert = await openDiff('src/app.ts')
  const revertUi = await win.webContents.executeJavaScript(`
    (() => {
      const wrap = document.querySelector('.df-wrap');
      if (!wrap) return { shown: false, hunks: 0, perHunk: [] };
      // ⚠️ **逐块**收集按钮，不是只看第一块 —— 只看第一块的话，"只有第 1 处给了退回入口"也能绿（自证式）
      const perHunk = Array.from(wrap.querySelectorAll('.df-hunk')).map((h) =>
        Array.from(h.querySelectorAll('.ck-btn')).map((b) => b.textContent.trim())
      );
      return { shown: true, hunks: perHunk.length, perHunk };
    })()
  `)

  const clickedAsk = await win.webContents.executeJavaScript(`
    (() => {
      const h = document.querySelector('.df-hunk');
      const b = h
        ? Array.from(h.querySelectorAll('.ck-btn')).find((x) => x.textContent.trim() === '退回这一处')
        : null;
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const revertAskState = await win.webContents.executeJavaScript(`
    (() => {
      const h = document.querySelector('.df-hunk');
      return {
        confirmShown: !!document.querySelector('.df-hunk .ck-btn-danger'),
        // 确认那一刻，这一行必须说“点下去会发生什么”，而不是复述“改动是什么”（纯新增/纯删除最易误解）
        rangeText: (h?.querySelector('.df-hunk-range')?.textContent ?? '').trim(),
        btns: h ? Array.from(h.querySelectorAll('.ck-btn')).map((b) => b.textContent.trim()) : []
      };
    })()
  `)
  const callsAfterAsk = revertCalls.length

  const clickedConfirmRevert = await win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.df-hunk .ck-btn-danger');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 1400))
  const diffAfterRevert = await readDiff()
  const shotRevert = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-diff-revert.png'), shotRevert.toPNG())

  // created / 截断 两种情形**不许**出现"退回这一处"
  const openedNewNoRevert = await openDiff('src/brand-new.md')
  const newRevertBtns = await win.webContents.executeJavaScript(`
    (() => ({
      hunks: document.querySelectorAll('.df-wrap .df-hunk').length,
      btns: Array.from(document.querySelectorAll('.df-wrap .ck-btn')).map((b) => b.textContent.trim())
    }))()
  `)
  const openedHugeNoRevert = await openDiff('src/huge.log')
  const hugeRevertBtns = await win.webContents.executeJavaScript(`
    (() => ({
      hunks: document.querySelectorAll('.df-wrap .df-hunk').length,
      btns: Array.from(document.querySelectorAll('.df-wrap .ck-btn')).map((b) => b.textContent.trim())
    }))()
  `)
  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.df-bar .ck-btn'))
        .find((x) => x.textContent.trim() === '收起');
      if (b) b.click();
    })()
  `)

  checkTrue('**每一处**改动都给了「退回这一处」（不是只有第一处有 —— 所以要逐块数）',
    openedAppRevert === true && revertUi.shown === true && revertUi.perHunk.length === 2 &&
      revertUi.perHunk.every((bs) => bs.includes('退回这一处')),
    { openedAppRevert, hunks: revertUi.hunks, perHunk: revertUi.perHunk })

  checkTrue('点「退回这一处」→ **先弹确认，而且没写盘**（危险动作点一下就走的都算 bug）',
    clickedAsk === true && revertAskState.confirmShown === true && callsAfterAsk === 0,
    { clickedAsk, confirmShown: revertAskState.confirmShown, callsAfterAsk })

  checkTrue('确认时**说清点下去会发生什么**（不是复述"改动是什么"）',
    revertAskState.rangeText.includes('退回后'), { rangeText: revertAskState.rangeText })

  checkTrue('确认按钮给的是两个明确选择（确认退回 / 取消）',
    revertAskState.btns.includes('确认退回') && revertAskState.btns.includes('取消'),
    revertAskState.btns)

  checkTrue('点「确认退回」→ 请求真的发出去了（不是只改了个提示）',
    clickedConfirmRevert === true && revertCalls.length === 1, {
      clickedConfirmRevert,
      calls: revertCalls
    })
  checkTrue('载荷说的是**退第几处 + 那条 mtime 安全阀**，而**不是**"退成什么内容"',
    revertCalls[0]?.hunkIndex === 1 &&
      revertCalls[0]?.rel === 'src/app.ts' &&
      revertCalls[0]?.expectedMtimeMs === 111111 &&
      Object.keys(revertCalls[0] ?? {}).sort().join(',') === 'expectedMtimeMs,hunkIndex,rel,runId',
    revertCalls[0])
  checkTrue('**退回之后界面重新取数**：那一处从差异里消失了（原来 2 处 → 现在 1 处）',
    diffAfterRevert.shown === true && diffAfterRevert.hunks === 1, {
      shown: diffAfterRevert.shown,
      hunks: diffAfterRevert.hunks,
      sum: diffAfterRevert.sum
    })

  checkTrue('**新建的文件不给「退回这一处」**（它没有改前内容可还原）',
    openedNewNoRevert === true && newRevertBtns.hunks > 0 && !newRevertBtns.btns.includes('退回这一处'),
    newRevertBtns)
  checkTrue('**截断的大文件不给「退回这一处」**（拿半个文件写盘 = 把文件砍坏）',
    openedHugeNoRevert === true && hugeRevertBtns.hunks > 0 && !hugeRevertBtns.btns.includes('退回这一处'),
    hugeRevertBtns)

  // —— 危险操作确认对话框：真推一次请求、真点一次（webContents.send 就是真实链路）——
  win.webContents.send('confirm:request', {
    id: 'probe-1',
    tool: 'run_command',
    detail: 'rm -rf build && npm run build',
    agent: '内核默认',
    where: 'D:\\jsllworkplace_for_test',
    // plan11：确认请求要能说出**哪条会话在问**（并发时用户才知道自己在批谁）
    conversationId: 'c1'
  })
  await new Promise((r) => setTimeout(r, 900))

  const confirmShown = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.cf-box');
      if (!box) return { shown: false };
      const r = box.getBoundingClientRect();
      return {
        shown: true,
        w: Math.round(r.width),
        h: Math.round(r.height),
        title: document.querySelector('.cf-title')?.textContent?.trim() ?? null,
        tool: document.querySelector('.cf-tool')?.textContent?.trim() ?? null,
        cmd: document.querySelector('.cf-cmd')?.textContent?.trim() ?? null,
        note: document.querySelector('.cf-note')?.textContent?.trim() ?? null,
        buttons: Array.from(document.querySelectorAll('.cf-btn')).map((b) => b.textContent.trim())
      };
    })()
  `)
  const shot6 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-confirm.png'), shot6.toPNG())

  await win.webContents.executeJavaScript(`
    (() => {
      const go = document.querySelector('.cf-btn-go');
      if (go) go.click();
      return !!go;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const confirmClosed = await win.webContents.executeJavaScript(
    `(() => ({ dialogGone: !document.querySelector('.cf-box') }))()`
  )

  // —— 面板宽度可拖拽：用 executeJavaScript 派发真实鼠标事件，按住分隔条往右拖 80px ——
  const geom = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const sp = document.querySelector('.splitter');
        const sb = document.querySelector('.sidebar');
        const main = document.querySelector('.content');
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), left: Math.round(b.left) }; };
        return {
          splitter: r(sp),
          sidebar: r(sb),
          content: r(main),
          count: document.querySelectorAll('.splitter').length,
          bodyResizing: document.body.getAttribute('data-resizing')
        };
      })()
    `)

  const beforeDrag = await geom()

  await win.webContents.executeJavaScript(`
    (() => {
      const sp = document.querySelector('.splitter');
      if (!sp) return false;
      const b = sp.getBoundingClientRect();
      const y = b.top + b.height / 2;
      const opts = (x) => ({ bubbles: true, clientX: x, clientY: y, button: 0 });
      sp.dispatchEvent(new MouseEvent('mousedown', opts(b.left + 2)));
      for (let i = 1; i <= 4; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', opts(b.left + 2 + i * 20)));
      }
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 300))
  const duringDrag = await geom()

  await win.webContents.executeJavaScript(`
    (() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const afterDrag = await geom()
  const shot7 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-splitter.png'), shot7.toPNG())

  // —— 批 A：资源管理器（真点一次展开 + 一次文件预览）——
  const openedExplorer = await openBuiltin('资源管理器')
  checkTrue('工作台能通过 ＋ 菜单打开资源管理器', openedExplorer === true, openedExplorer)
  await new Promise((r) => setTimeout(r, 1200))

  const explorerRoot = await win.webContents.executeJavaScript(`
    (() => ({
      rows: Array.from(document.querySelectorAll('.ex-row .ex-name')).map((e) => e.textContent.trim()),
      dirs: Array.from(document.querySelectorAll('.ex-dir')).map((e) => e.textContent.trim()),
      sizes: Array.from(document.querySelectorAll('.ex-size')).map((e) => e.textContent.trim()),
      path: document.querySelector('.ex-path')?.textContent?.trim() ?? null
    }))()
  `)

  await win.webContents.executeJavaScript(`
    (() => {
      const dir = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.querySelector('.ex-name')?.textContent?.trim() === '归档');
      if (dir) dir.click();
      return !!dir;
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const afterExpand = await win.webContents.executeJavaScript(`
    (() => ({
      rows: Array.from(document.querySelectorAll('.ex-row .ex-name')).map((e) => e.textContent.trim())
    }))()
  `)

  // 点文件 → 应在**右侧独立开一栏**（plan9 W6；改造前是压在文件树底下的 .ex-preview）
  await win.webContents.executeJavaScript(`
    (() => {
      const f = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.querySelector('.ex-name')?.textContent?.trim() === '紫水晶采购清单.txt');
      if (f) f.click();
      return !!f;
    })()
  `)
  // ⚠️ Monaco 靠 rAF 渲染而验证窗口是离屏的（900ms 时 .view-line 是 0 行），给到 2.6s 让 rAF 真跑起来
  await new Promise((r) => setTimeout(r, 2600))
  const previewState = await win.webContents.executeJavaScript(`
    (() => {
      const panes = Array.from(document.querySelectorAll('.pane'));
      const last = panes[panes.length - 1];
      // ⚠️ 非 Markdown 文本改用 Monaco 渲染（虚拟化，全文不在 DOM 里）—— 读“可见行拼起来”更贴近用户看到的
      const editor = last ? last.querySelector('.ce-host') : null;
      const visibleText = editor
        ? Array.from(editor.querySelectorAll('.view-line')).map((el) => el.textContent).join('\\n')
        : '';
      const fp = last ? last.querySelector('.fp') : null;
      const dim = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; };
      return {
        paneCount: panes.length,
        // 关键：预览必须是**自己的一栏**，而不是塞在资源管理器那一栏里面
        isOwnPane: panes.length >= 2 && !!last && !last.querySelector('.ex-panel'),
        hasPreview: !!editor,
        firstLine: visibleText.split('\\n')[0] || null,
        hasFileContent: visibleText.includes('紫水晶'),
        // 关键：**看得见**才算数（DOM 存在但高度塌成 0 等于没显示）
        preBox: dim(editor),
        fpBox: dim(fp)
      };
    })()
  `)
  const shot8 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-explorer.png'), shot8.toPNG())

  // —— 资源管理器右键菜单 + 写操作接线：验的不是“菜单画出来了”，而是动作真的发下去了（stub 记流水）——
  await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.textContent.includes('紫水晶采购清单.txt'));
      if (row) {
        // 用**行自己的坐标**派发 —— 菜单贴边回收逻辑才有意义，截图也更接近真实
        const r = row.getBoundingClientRect();
        row.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: Math.round(r.left + 40),
            clientY: Math.round(r.top + 12)
          })
        );
      }
      return !!row;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const exMenuFile = await win.webContents.executeJavaScript(`
    (() => ({
      hasMenu: !!document.querySelector('.ex-menu'),
      labels: Array.from(document.querySelectorAll('.ex-menu-item')).map((b) => b.textContent.trim()),
      hasDanger: !!document.querySelector('.ex-menu-danger')
    }))()
  `)
  const shotMenu = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-ex-menu.png'), shotMenu.toPNG())

  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.ex-menu-item'))
        // ⚠️ 用 includes 而非 ===：菜单项叫「重命名 / 移动到…」，写死全等会在改文案时静默点不中
        .find((x) => x.textContent.includes('重命名'));
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const exRename = await win.webContents.executeJavaScript(`
    (() => ({
      hasInput: !!document.querySelector('.ex-edit'),
      value: document.querySelector('.ex-edit')?.value ?? null,
      menuGone: !document.querySelector('.ex-menu')
    }))()
  `)

  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.ex-edit');
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return !!input;
    })()
  `)
  await new Promise((r) => setTimeout(r, 350))
  const exEsc = await win.webContents.executeJavaScript(`
    (() => ({ inputGone: !document.querySelector('.ex-edit') }))()
  `)

  await win.webContents.executeJavaScript(`
    (() => {
      const panel = document.querySelector('.ex-panel');
      if (panel) {
        panel.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 520 }));
      }
      return !!panel;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const exMenuRoot = await win.webContents.executeJavaScript(`
    (() => ({
      labels: Array.from(document.querySelectorAll('.ex-menu-item')).map((b) => b.textContent.trim())
    }))()
  `)

  // 新建文件：点菜单 → 输入名字 → Enter → **必须真的调到 fs:write**
  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.ex-menu-item'))
        .find((x) => x.textContent.trim() === '新建文件');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 350))
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.ex-edit');
      if (!input) return false;
      // React 受控输入：必须走原生 value setter + input 事件，直接赋值它收不到
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '新建的笔记.md');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const exCreate = await win.webContents.executeJavaScript(`
    (() => ({
      notice: document.querySelector('.ex-notice')?.textContent?.trim() ?? null,
      inputGone: !document.querySelector('.ex-edit')
    }))()
  `)

  // —— 拖拽上传：验 ① dragover 落点高亮 ② drop 真的接线（合成 File 没有磁盘路径 → 必须如实提示）——
  await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.textContent.includes('归档'));
      if (row) row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      return !!row;
    })()
  `)
  await new Promise((r) => setTimeout(r, 300))
  const exDragOver = await win.webContents.executeJavaScript(`
    (() => ({
      highlighted: !!document.querySelector('.ex-row-drop'),
      cls: document.querySelector('.ex-row-drop')?.className ?? null
    }))()
  `)

  await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.textContent.includes('归档'));
      if (!row) return false;
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], '拖入的测试.txt'));
      row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const exDropState = await win.webContents.executeJavaScript(`
    (() => ({
      notice: document.querySelector('.ex-notice')?.textContent?.trim() ?? null,
      highlightGone: !document.querySelector('.ex-row-drop')
    }))()
  `)

  // —— 文件「移动」（plan16 尾巴）：工作区内部拖拽 = 移动，不再只有"同目录改名"——
  // ⚠️ 合成拖拽必须**自己造 DataTransfer 并塞进 DragEvent**：只 dispatch 'drop' 而不给
  //    dataTransfer，`getData` 恒为空串 → 移动分支永远走不到，而断言会红得像"功能没做"。
  const syntheticDrag = (fromText, toText) =>
    win.webContents.executeJavaScript(`
      (() => {
        const rows = Array.from(document.querySelectorAll('.ex-row'));
        const src = rows.find((b) => b.textContent.includes(${JSON.stringify(fromText)}));
        const dst = rows.find((b) => b.textContent.includes(${JSON.stringify(toText)}));
        if (!src || !dst) return { ok: false, why: !src ? 'no-src' : 'no-dst' };
        const dt = new DataTransfer();
        // 起点必须先跑 dragstart —— 行上的 onDragStart 就是在这儿把路径写进 dataTransfer 的
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const carried = dt.getData('application/x-jiushililu-move'); // 契约副本：DRAG_MOVE_MIME（shared/fs-tree.ts）
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return { ok: true, carried, from: src.getAttribute('title'), to: dst.getAttribute('title') };
      })()
    `)

  const exMoveBefore = fsOpLog.filter((s) => s.startsWith('rename:')).length
  // 把根目录下的 README.md 拖进「归档」目录 —— 服务层 rename 本来就支持跨目录，缺的一直是这条接线
  const exMoveDrag = await syntheticDrag('README.md', '归档')
  await new Promise((r) => setTimeout(r, 700))
  const exMoveState = await win.webContents.executeJavaScript(`
    (() => ({
      notice: document.querySelector('.ex-notice')?.textContent?.trim() ?? null
    }))()
  `)
  console.log('EX_MOVE=' + JSON.stringify({ drag: exMoveDrag, state: exMoveState }))
  const exMoveCalls = fsOpLog.filter((s) => s.startsWith('rename:'))
  checkTrue(
    '拖拽**真的带上了路径**（合成拖拽必须自己造 DataTransfer，否则移动分支根本走不到）',
    exMoveDrag.ok === true && exMoveDrag.carried === 'README.md',
    exMoveDrag
  )
  checkTrue(
    '把文件拖到别的目录 = **移动**（调用 `fs:rename`，目标是「归档/README.md」而不是同名改名）',
    exMoveCalls.length === exMoveBefore + 1 &&
      exMoveCalls[exMoveCalls.length - 1] === 'rename:README.md->归档/README.md',
    exMoveCalls
  )
  checkTrue(
    '移动成功的提示**写清去了哪儿**（`README.md → 归档/README.md`），不是一句笼统的"已重命名"',
    typeof exMoveState.notice === 'string' &&
      exMoveState.notice.includes('README.md') &&
      exMoveState.notice.includes('归档/README.md'),
    exMoveState
  )

  // —— 不能把目录拖进它自己（文件系统会拒，但理由必须是人话，不是 EINVAL）——
  const exSelfBefore = fsOpLog.filter((s) => s.startsWith('rename:')).length
  await syntheticDrag('归档', '归档')
  await new Promise((r) => setTimeout(r, 600))
  const exSelfState = await win.webContents.executeJavaScript(`
    (() => document.querySelector('.ex-notice')?.textContent?.trim() ?? null)()
  `)
  console.log('EX_MOVE_SELF=' + JSON.stringify(exSelfState))
  checkTrue(
    '把目录拖进它自己 → **拦下并说人话**（不许冒出 EINVAL 那种系统话）',
    fsOpLog.filter((s) => s.startsWith('rename:')).length === exSelfBefore &&
      typeof exSelfState === 'string' &&
      exSelfState.includes('不能把') &&
      exSelfState.includes('它自己'),
    { calls: fsOpLog.filter((s) => s.startsWith('rename:')).length, notice: exSelfState }
  )

  // —— 资源管理器：工具栏图标 + 在选中文件夹下新建 + 预览（0.12.0 验收反馈）——
  const exTools = await win.webContents.executeJavaScript(`
    (() => {
      const btns = Array.from(document.querySelectorAll('.ex-icon-btn'));
      return {
        count: btns.length,
        titles: btns.map((b) => b.title),
        allSvg: btns.every((b) => !!b.querySelector('svg'))
      };
    })()
  `)

  // 选中「归档」目录 → 工具栏第一个按钮的 title 应变，新建的东西也真的落在 归档/ 下（fsOpLog 是证据）
  await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.textContent.includes('归档'));
      if (row) row.click();
      return !!row;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const exTargetTitle = await win.webContents.executeJavaScript(`
    (() => document.querySelector('.ex-icon-btn')?.title ?? null)()
  `)
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.ex-icon-btn');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 350))
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.ex-edit');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '归档下新建.txt');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const exNewInDir = await win.webContents.executeJavaScript(`
    (() => document.querySelector('.ex-notice')?.textContent?.trim() ?? null)()
  `)

  // Markdown 预览：点 README.md → 应在**同一预览栏**里开第二个页签，并走富文本渲染
  await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.textContent.includes('README.md'));
      if (row) row.click();
      return !!row;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))
  const exMdPreview = await win.webContents.executeJavaScript(`
    (() => {
      const panes = Array.from(document.querySelectorAll('.pane'));
      const last = panes[panes.length - 1];
      const md = last ? last.querySelector('.fp-md') : null;
      const pre = last ? last.querySelector('.fp-pre') : null;
      const fp = last ? last.querySelector('.fp') : null;
      const tabs = last ? Array.from(last.querySelectorAll('.pane-tab-name')).map((e) => e.textContent.trim()) : [];
      return {
        // 复用同一栏（同一栏里多文件 = 多页签），**不是**每点一个文件就多一栏
        paneCount: panes.length,
        tabs,
        renderedMarkdown: !!md,
        rawPre: !!pre,
        h1: md ? (md.querySelector('h1')?.textContent?.trim() ?? null) : null,
        liCount: md ? md.querySelectorAll('li').length : 0,
        // 旧形态必须**彻底退役**：那个"拖高手柄"不该还在
        hasOldResizeHandle: !!document.querySelector('.ex-preview-resize'),
        oldPreviewGone: !document.querySelector('.ex-preview'),
        visible: fp ? fp.getBoundingClientRect().height > 20 : false
      };
    })()
  `)

  // 先拍预览渲染的样子（拖拽会碰鼠标事件、可能搅乱选中态）；capturePage 拿的是合成后的帧，DOM 更新 ≠ 帧已更新
  await new Promise((r) => setTimeout(r, 800))
  const shotMd = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-ex-preview.png'), shotMd.toPNG())

  // —— 二进制预览（三档各走一遍）—— ⚠️ 探针必须放在这一段：放到脚本末尾会全红（前台已切成「任务管理」→ clickFile 静默失败）——
  // plan40：页签保活后失活页签只是隐藏不卸载 —— 预览类探针一律限定在**激活页签**内
  // （Pane 的 data-active 是稳定契约，见 Pane.tsx 注释；不限定就会命中别页签的同类节点，假绿假红都出过）
  const activeTabRoot = `const root = Array.from(document.querySelectorAll('[data-active="1"]')).find((r) => r.querySelector('.fp'))`
  const clickFile = async (name) => {
    return win.webContents.executeJavaScript(`
      (() => {
        const row = Array.from(document.querySelectorAll('.ex-row'))
          .find((b) => b.querySelector('.ex-name')?.textContent?.trim() === ${JSON.stringify(name)});
        if (row) row.click();
        return !!row;
      })()
    `)
  }

  // ① 正常图片：必须真的解码出来（naturalWidth > 0）—— DOM 里有 <img> 不等于图显示出来了
  const imgClicked = await clickFile('示例截图.png')
  await new Promise((r) => setTimeout(r, 900))
  const imagePreview = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      const img = root ? root.querySelector('.fp-img') : null;
      if (!img) return { hasImg: false };
      const r = img.getBoundingClientRect();
      const pane = img.closest('.pane');
      return {
        hasImg: true,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        complete: img.complete,
        boxW: Math.round(r.width),
        boxH: Math.round(r.height),
        // 安全：必须是 img 上下文（img 不执行脚本），不能是 object / iframe
        tag: img.tagName,
        isDataUrl: (img.getAttribute('src') || '').startsWith('data:image/'),
        paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : 0
      };
    })()
  `)
  console.log('BIN_IMAGE=' + JSON.stringify({ clicked: imgClicked, ...imagePreview }))

  // ② 超大图：**只给元信息、不给数据**（不该把几十 MB 塞进 IPC）
  await clickFile('超大图.png')
  await new Promise((r) => setTimeout(r, 800))
  const tooLarge = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      return {
        hasImg: !!root && !!root.querySelector('.fp-img'),
        notice: root ? (root.querySelector('.fp .ex-msg')?.textContent ?? '').trim() : ''
      }
    })()
  `)
  console.log('BIN_TOO_LARGE=' + JSON.stringify(tooLarge))

  // ③ 未知二进制：**降级而不是放弃** —— 十六进制转储（看文件头就能认格式）
  await clickFile('固件镜像.bin')
  await new Promise((r) => setTimeout(r, 800))
  const hexPreview = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      const pre = root ? root.querySelector('.fp-hex') : null;
      const text = pre ? pre.textContent : '';
      return {
        hasHex: !!pre,
        firstLine: text.split('\\n')[0] ?? '',
        // ELF 魔数的十六进制样子 —— 能认出来才说明转储是有用的
        hasElfMagic: text.includes('7f 45 4c 46')
      };
    })()
  `)
  console.log('BIN_HEX=' + JSON.stringify(hexPreview))

  // —— Office 内嵌预览（2026-09-14）：docx/xlsx 沙箱 iframe + pptx 走系统打开 ——
  // 桩只回沙箱 URL 的形状（解析真链路在 office-preview.test.ts 喂真实字节）；这里验**分发与容器**：
  // ① docx 装进 iframe（沙箱属性必须是空串 —— 与 HTML 预览同一道锁）；
  // ② xlsx 出 sheet 按钮组且点击切换真的换 URL；
  // ③ pptx 内嵌不了 → 十六进制头 + 「用系统程序打开」按钮（出口必须存在，不能是死胡同）。
  const clickDocx = await clickFile('会议纪要.docx')
  await new Promise((r) => setTimeout(r, 800))
  const docxPreview = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      const f = root ? root.querySelector('.fp-office') : null;
      const btns = root ? Array.from(root.querySelectorAll('.fp-head button')).map(b => b.textContent.trim()) : [];
      // 几何判据（2026-09-15 用户报「预览不向下铺满」= 高度链断裂）：iframe 必须吃满
      // 栏（.dock-body）里除「文件名行 + gap + 栏 padding」之外的高度 —— 实测这部分
      // 固定开销约占 22%（门禁小窗），修复前 iframe 只有内容高、比率远低于此。
      // "DOM 存在"防不住这条，只能量 rect。
      const pane = f ? f.closest('.dock-body') : null;
      const fillRatio = f && pane && pane.clientHeight > 0
        ? f.getBoundingClientRect().height / pane.clientHeight
        : 0;
      return {
        clicked: ${clickDocx},
        hasFrame: !!f,
        srcOk: !!f && (f.getAttribute('src') || '').startsWith('jsl-preview://mem/'),
        // sandbox=""（空串 = 全锁）：少了这个属性，沙箱就是摆设
        sandboxEmpty: !!f && f.getAttribute('sandbox') === '',
        hasOpenSys: btns.some(t => t.includes('用系统程序打开')),
        fillsPane: fillRatio >= 0.75,
        fillRatio: Math.round(fillRatio * 100) / 100
      };
    })()
  `)
  console.log('OFFICE_DOCX=' + JSON.stringify(docxPreview))

  const clickXlsx = await clickFile('库存表.xlsx')
  await new Promise((r) => setTimeout(r, 800))
  const sheetPreview = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      const tabs = root ? Array.from(root.querySelectorAll('.fp-sheet-tab')) : [];
      const f = root ? root.querySelector('.fp-office') : null;
      const before = f ? f.getAttribute('src') : '';
      const names = tabs.map(t => t.textContent.trim());
      if (tabs[1]) tabs[1].click();
      return { clicked: ${clickXlsx}, tabCount: tabs.length, names, srcBefore: before };
    })()
  `)
  await new Promise((r) => setTimeout(r, 300))
  const sheetAfter = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      const f = root ? root.querySelector('.fp-office') : null;
      return { srcAfter: f ? f.getAttribute('src') : '' };
    })()
  `)
  console.log('OFFICE_XLSX=' + JSON.stringify({ ...sheetPreview, ...sheetAfter }))

  const clickPptx = await clickFile('产品演示.pptx')
  await new Promise((r) => setTimeout(r, 800))
  const pptxPreview = await win.webContents.executeJavaScript(`
    (() => {
      ${activeTabRoot}
      const pre = root ? root.querySelector('.fp-hex') : null;
      const btns = root ? Array.from(root.querySelectorAll('.fp-head button')).map(b => b.textContent.trim()) : [];
      return {
        clicked: ${clickPptx},
        hasHex: !!pre,
        // PPTX 是 ZIP 容器：文件头 PK 魔数可认出它（hex 展示不是摆设）
        hasPkmagic: !!pre && pre.textContent.includes('50 4b 03 04'),
        hasOpenSys: btns.some(t => t.includes('用系统程序打开')),
        // 内嵌 iframe 不该出现（pptx 不支持内嵌，别给一个白框装样子）
        noOfficeFrame: !!root && !root.querySelector('.fp-office')
      };
    })()
  `)
  console.log('OFFICE_PPTX=' + JSON.stringify(pptxPreview))

  // —— HTML 沙箱预览（渲染 / 源码 开关 + 「不执行工作区代码」红线）——
  // 不验“iframe 在不在 DOM 里”（太容易绿）：① 渲染真的渲染出来了 —— 常见死法是 srcdoc 被页面 CSP
  // 拦成空白框；② 工作区的 HTML 一行脚本都没跑。手段是采像素：桩文件自己会把背景从品红改成纯红。
  const clickHtmlFile = await clickFile('预览桩.html')
  await new Promise((r) => setTimeout(r, 900))

  const readHtmlFrame = () =>
    win.webContents.executeJavaScript(`
      (() => {
        ${activeTabRoot}
        const f = root ? root.querySelector('.fp-html') : null;
        const t = root ? root.querySelector('.fp-html-toggle') : null;
        /* 源码视图现在也是 Monaco（plan13 批 B）—— 同样读"可见行"（它虚拟化，全文不在 DOM 里） */
        const editor = root ? root.querySelector('.ce-host') : null;
        const visibleText = editor
          ? Array.from(editor.querySelectorAll('.view-line')).map((el) => el.textContent).join('\\n')
          : '';
        const r = f ? f.getBoundingClientRect() : null;
        return {
          hasFrame: !!f,
          sandbox: f ? f.getAttribute('sandbox') : null,
          // ⚠️ 必须没有 srcdoc：子文档会继承父页策略，style-src 'self' 把内联样式全砍光（渲染成白骨架）
          srcdoc: f ? f.getAttribute('srcdoc') : 'no-frame',
          srcScheme: f ? String(f.getAttribute('src') || '').split(':')[0] : null,
          frameRect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
          toggleText: t ? t.textContent.trim() : null,
          toggleRect: t ? (() => {
            const b = t.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          })() : null,
          rawPreShown: !!editor,
          preText: visibleText,
          // 可视区：采像素要先把采样区夹进视口，不然 capturePage 会抛
          view: { w: window.innerWidth, h: window.innerHeight },
          hasToggle: !!t
        };
      })()
    `)

  const htmlRender = await readHtmlFrame()

  /** 采样一个矩形里的像素，按**三个分量的大小关系**归类（不假设 BGRA / RGBA 的顺序） */
  const sampleArea = async (area) => {
    const out = { magenta: 0, red: 0, blank: 0, other: 0, total: 0, note: '' }
    try {
      const shot = await win.webContents.capturePage(area)
      const size = shot.getSize()
      const bmp = shot.toBitmap()
      for (let i = 0; i + 3 < bmp.length; i += 4) {
        const px = [bmp[i], bmp[i + 1], bmp[i + 2]].sort((a, b) => a - b)
        const [mn, mid, mx] = px
        out.total++
        if (mn > 200) out.blank++
        else if (mx > 180 && mid < 60 && mn < 60) out.red++
        else if (mx > 180 && mid >= 90 && mid <= 230 && mn < 60) out.magenta++
        else out.other++
      }
      out.note = size.width + 'x' + size.height
    } catch (err) {
      out.note = 'capturePage 失败: ' + (err && err.message ? err.message : String(err))
    }
    return out
  }

  // 采样区取 iframe 的下半部分（上半有标题文字，下半是纯背景）。⚠️ 窗口必须先显示：跨进程沙箱帧在隐藏
  //    窗口里不会被合成，capturePage 拿到一片白 —— 那是“没合成”不是“没渲染”，另有 previewHits 分开二者。
  win.showInactive()
  await new Promise((r) => setTimeout(r, 400))

  let htmlPixels = { magenta: 0, red: 0, blank: 0, other: 0, total: 0, note: 'no-frame' }
  if (htmlRender.frameRect) {
    const r = htmlRender.frameRect
    const vw = htmlRender.view.w
    const vh = htmlRender.view.h
    const x0 = Math.max(0, Math.round(r.x) + 2)
    const y0 = Math.max(0, Math.round(r.y + r.height * 0.45))
    const x1 = Math.min(vw, Math.round(r.x + r.width) - 2)
    const y1 = Math.min(vh, Math.round(r.y + r.height) - 2)
    if (x1 - x0 >= 30 && y1 - y0 >= 30) {
      htmlPixels = await sampleArea({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
    } else {
      htmlPixels.note = '采样区太小（预览栏被挤出可视区？）: ' + [x0, y0, x1, y1].join(',')
    }
  }

  writeFileSync(join(SHOTS, 'verify-html-preview.png'), (await win.webContents.capturePage()).toPNG())

  // ② 开关：点「源码」→ 原始代码；再点「渲染」→ 沙箱预览。⚠️ 必须走真手势（dbg/realClick 在这里还在 TDZ）
  const realClickHere = async (pos) => {
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      button: 'left',
      clickCount: 1
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      button: 'left',
      clickCount: 1
    })
    await new Promise((r) => setTimeout(r, 500))
  }

  let htmlToggle = { clicked: false, before: htmlRender.toggleText }
  if (htmlRender.toggleRect) {
    await realClickHere(htmlRender.toggleRect)
    htmlToggle.clicked = true
    const srcView = await readHtmlFrame()
    htmlToggle.afterSrc = { toggleText: srcView.toggleText, rawPreShown: srcView.rawPreShown }
    // ⚠️ Monaco 虚拟化：只断言可见行里出现标签形态的文本（意图不变：看到的是源码 markup）
    htmlToggle.srcHasMarkup = /<[a-zA-Z!/]/.test(srcView.preText)
    // 再点回来：**开关是双向的**，别做成只能往一个方向切（用户会以为坏了）
    const backPos = srcView.toggleRect
    if (backPos) {
      await realClickHere(backPos)
      const backView = await readHtmlFrame()
      htmlToggle.afterBack = {
        toggleText: backView.toggleText,
        hasFrame: backView.hasFrame,
        rawPreShown: backView.rawPreShown
      }
    }
  }

  console.log(
    'HTML_PREVIEW=' +
      JSON.stringify({
        clicked: clickHtmlFile,
        hasFrame: htmlRender.hasFrame,
        sandbox: htmlRender.sandbox,
        srcScheme: htmlRender.srcScheme,
        srcdoc: htmlRender.srcdoc,
        previewHits,
        toggle: htmlToggle,
        pixels: htmlPixels,
        cspViolations: cspViolations.filter((m) => /frame|srcdoc|inline style/i.test(m)).slice(0, 4)
      })
  )


  // —— 新建任务页：内容完全居中 + 旧文案已移除（用户 2026-09-12 美学偏好）——
  await win.webContents.executeJavaScript(`
    (() => {
      const back = document.querySelector('.back-btn');
      if (back) back.click();
      return !!back;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))

  // —— ③ 文件拖进会话：把文件树里的一行拖到输入框。⚠️ 探针必须在输入框存在时跑（工作台视图无关、文件行
  //    一直在，而输入框只属于对话页/新建页）。⚠️ 合成 DragEvent 绕过浏览器判定能否开始拖的全部逻辑 → 天生
  //    为绿；故用 CDP 真手势（setInterceptDrags → dragIntercepted 拿真实载荷 → dispatchDragEvent）+ 阳性对照。
  const dragPre = await win.webContents.executeJavaScript(`
    (async () => {
      const row = Array.from(document.querySelectorAll('.ex-row'))
        .find((b) => b.querySelector('.ex-name')?.textContent?.trim() === '紫水晶采购清单.txt');
      if (row) {
        row.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 150));
      }
      const probe = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const x = Math.round(Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2)));
        const y = Math.round(Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2)));
        const top = document.elementFromPoint(x, y);
        return {
          x: x, y: y,
          w: Math.round(r.width), h: Math.round(r.height),
          hittable: !!(top && (top === el || el.contains(top)))
        };
      };
      return {
        hasConsole: !!document.querySelector('.console'),
        hasRow: !!row,
        row: probe(row),
        box: probe(document.querySelector('.console')),
        paneHead: probe(document.querySelector('.pane-head'))
      };
    })()
  `)
  const consoleReady = { hasConsole: dragPre.hasConsole, hasRow: dragPre.hasRow }
  console.log('DRAG_PRECONDITION=' + JSON.stringify(dragPre))

  // 真手势通道：挂不上就**明确失败**，绝不悄悄退回合成事件装作验过
  let dragGestureReady = false
  let dragCap = null
  let dbg = null
  try {
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    dbg.on('message', (_ev, method, params) => {
      if (method === 'Input.dragIntercepted') dragCap = params
    })
    await dbg.sendCommand('Input.setInterceptDrags', { enabled: true })
    dragGestureReady = true
  } catch (err) {
    console.log('DRAG_GESTURE_UNAVAILABLE=' + (err && err.message ? err.message : String(err)))
  }

  /** 真鼠标拖一次；返回**浏览器收上来的真实载荷**，可选把它投到某个落点上 */
  const realDrag = async (from, to, between) => {
    dragCap = null
    const move = (type, x, y, buttons) =>
      dbg.sendCommand('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons,
        clickCount: 1
      })
    await move('mousePressed', from.x, from.y, 1)
    // 要走够距离才算拖拽：Chromium 有启动阈值，原地不动只会被当成一次点击
    for (const d of [10, 26, 48]) await move('mouseMoved', from.x + d, from.y + d, 1)
    await new Promise((r) => setTimeout(r, 280))
    const data = dragCap && dragCap.data ? dragCap.data : null
    const items = data && Array.isArray(data.items) ? data.items : null
    let mid = null
    if (items && to) {
      // dragEnter → dragOver → drop 三步都要发；少了 dragOver，页面不认这里是合法落点
      for (const type of ['dragEnter', 'dragOver']) {
        await dbg.sendCommand('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
        await new Promise((r) => setTimeout(r, 130))
      }
      if (between) mid = await between()
      await dbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data })
      await new Promise((r) => setTimeout(r, 130))
    }
    // 收尾必须干净：被拦截的拖拽不主动取消的话，**后面每一次拖拽都会静默失效**
    //（搭探针时真踩到：第 2、3 次全空，看上去就像"button 不能拖"—— 阳性对照就是防这个）
    if (data) {
      await dbg
        .sendCommand('Input.dispatchDragEvent', {
          type: 'dragCancel',
          x: 4,
          y: 4,
          data: { items: [], dragOperationsMask: 0 }
        })
        .catch(() => {})
    }
    await move('mouseReleased', from.x + 48, from.y + 48, 0)
    await new Promise((r) => setTimeout(r, 260))
    return { items, mid }
  }

  // 真拖两次：① 只到 dragEnter/dragOver 就停 —— 量落点高亮；② 走完整 drop —— 量“真的变成附件”。
  // 载荷必须用自定义 MIME：用 text/plain 的话，拖到编辑器/终端会被当成一段文字贴进去。
  let controlDrag = null
  let rowDrag = null
  if (dragGestureReady) {
    // 阳性对照：分栏标题本来就能拖（拖拽换位）。只起拖、不落点，所以不会改变布局
    if (dragPre.paneHead && dragPre.paneHead.hittable) controlDrag = await realDrag(dragPre.paneHead)
    if (dragPre.row && dragPre.row.hittable && dragPre.box) {
      rowDrag = await realDrag(dragPre.row, dragPre.box, () =>
        // 落点高亮要在**真拖拽的过程里**量：dragEnter/dragOver 之后、drop 之前
        win.webContents.executeJavaScript(
          `(() => ({ highlighted: !!document.querySelector('.console-drop') }))()`
        )
      )
    }
  }
  const carriedItem = ((rowDrag && rowDrag.items) || []).find(
    (it) => it.mimeType === 'application/x-jiushililu-path'
  )
  const dragControl = {
    gestureReady: dragGestureReady,
    hasPaneHead: !!dragPre.paneHead,
    started: !!(controlDrag && controlDrag.items && controlDrag.items.length > 0)
  }
  const dragStart = {
    ok: !!(rowDrag && rowDrag.items && rowDrag.items.length > 0),
    carried: carriedItem ? carriedItem.data : '',
    items: rowDrag ? rowDrag.items : null
  }
  const dropHighlight = { highlighted: !!(rowDrag && rowDrag.mid && rowDrag.mid.highlighted) }
  console.log('DRAG_CONTROL=' + JSON.stringify(dragControl))
  console.log('DRAG_ATTACH=' + JSON.stringify(dragStart))
  await new Promise((r) => setTimeout(r, 700))
  const attachState = await win.webContents.executeJavaScript(`
    (() => {
      const chips = Array.from(document.querySelectorAll('.attach-chip'));
      return {
        count: chips.length,
        titles: chips.map((c) => c.title || ''),
        // 高亮要收回去（不然会一直是高亮态）
        stillHighlighted: !!document.querySelector('.console-drop')
      };
    })()
  `)
  console.log('DRAG_ATTACH_DONE=' + JSON.stringify(attachState))

  // —— ③-2 从系统资源管理器拖文件进来（dataTransfer.files 那条分支）——
  // ⚠️ 只有这条分支会传绝对路径（合成事件走的是自定义 MIME 那条），用户报的越界正出在这里。
  // CDP 的 drag 事件可直接带 files（真实路径），渲染端才拿得到真 File、getPathForFile 才有得可查。
  const osDragFile = join(process.env.TEMP || '.', 'jsl-verify-os-drag.txt')
  writeFileSync(osDragFile, '从系统资源管理器拖进来的一个真文件\n', 'utf8')
  const osDragCalls = []
  attachPathCalls.length = 0
  let osDrag = { attempted: false }
  if (dragGestureReady && dragPre.box) {
    const t = dragPre.box
    await dbg.sendCommand('Input.dispatchDragEvent', {
      type: 'dragEnter',
      x: t.x,
      y: t.y,
      data: { items: [], files: [osDragFile], dragOperationsMask: 1 }
    })
    await new Promise((r) => setTimeout(r, 200))
    await dbg.sendCommand('Input.dispatchDragEvent', {
      type: 'drop',
      x: t.x,
      y: t.y,
      data: { items: [], files: [osDragFile], dragOperationsMask: 1 }
    })
    await new Promise((r) => setTimeout(r, 900))
    Object.assign(osDragCalls, attachPathCalls)
    const chips = await win.webContents.executeJavaScript(`
      (() => {
        const all = Array.from(document.querySelectorAll('.attach-chip'));
        const last = all[all.length - 1];
        return {
          titles: all.map((c) => c.title || ''),
          badges: last ? Array.from(last.querySelectorAll('span')).map((s) => s.textContent || '').filter(Boolean) : []
        };
      })()
    `)
    osDrag = {
      attempted: true,
      payloads: osDragCalls.slice(),
      // **拿到的必须是绝对路径** —— 相对路径走不到这条分支，走到了就说明串了
      gotAbsolute: osDragCalls.some((p) => /^[a-zA-Z]:[\\/]/.test(p)),
      titles: chips.titles,
      badges: chips.badges
    }
  }
  console.log('DRAG_OS_FILE=' + JSON.stringify(osDrag))

  // —— ③-3 认出是文件拖拽、却一个可用路径都没拿到 → 必须说话（以前什么都不做 = 静默失败，最糟的失败方式）——
  const silentCase = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.console');
      if (!box) return { ok: false, reason: 'no-console' };
      const dt = new DataTransfer();
      // 类型在（认得出这是"文件拖拽"），数据却是空的 —— 正好是"载荷丢了"的样子
      dt.setData('application/x-jiushililu-path', '');
      box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { ok: true, hadTypes: dt.types.includes('application/x-jiushililu-path') };
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const silentState = await win.webContents.executeJavaScript(`
    (() => ({ text: (document.querySelector('.console-error')?.textContent ?? '').trim() }))()
  `)
  console.log('DRAG_NO_PAYLOAD=' + JSON.stringify({ ...silentCase, ...silentState }))

  // 拖拽通道用完就撤：留着拦截会继续拦住后面所有鼠标手势
  if (dragGestureReady) {
    try {
      await dbg.sendCommand('Input.setInterceptDrags', { enabled: false })
      dbg.detach()
    } catch {
    }
  }
  await new Promise((r) => setTimeout(r, 900))
  // 若没有返回按钮（初始就在新建页），直接切到新建视图
  await win.webContents.executeJavaScript(`
    (() => {
      const nav = Array.from(document.querySelectorAll('.sidebar button, .nav-item'))
        .find((b) => b.textContent.includes('新建任务'));
      if (nav) nav.click();
      return document.querySelector('.new-task') ? 'ok' : 'retry';
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))

  const centerCheck = await win.webContents.executeJavaScript(`
    (() => {
      const page = document.querySelector('.new-task');
      const box = document.querySelector('.new-task-center');
      if (!page || !box) return { ok: false, found: { page: !!page, box: !!box } };
      const p = page.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const pageMid = p.top + p.height / 2;
      const boxMid = b.top + b.height / 2;
      return {
        ok: true,
        pageRect: { top: Math.round(p.top), h: Math.round(p.height) },
        boxRect: { top: Math.round(b.top), h: Math.round(b.height) },
        // 偏移越小越居中：0 = 完美居中
        offsetPx: Math.round(Math.abs(pageMid - boxMid)),
        // 旧文案必须消失，新文案必须就位（2026-09-12 用户指定）
        hasOldTitle: !!Array.from(document.querySelectorAll('h1')).find((h) => h.textContent.trim() === '新建任务'),
        hasOldSlogan: document.body.textContent.includes('说清你想做的事'),
        newTitle: document.querySelector('.new-task-hero h1')?.textContent?.trim() ?? null,
        newSlogan: document.querySelector('.new-task-hero p')?.textContent?.trim() ?? null,
        heroBox: (() => {
          const el = document.querySelector('.new-task-hero');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
        })(),
        hasInput: !!document.querySelector('.console-input'),
        // 顶栏：新建任务页不应再出现标题与分隔符（用户 2026-09-12）
        topbarText: document.querySelector('.topbar')?.textContent?.trim() ?? null,
        topbarHasSep: !!document.querySelector('.topbar-sep'),
        topbarHasTitle: !!document.querySelector('.topbar-title')
      };
    })()
  `)
  const shot9 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-newtask.png'), shot9.toPNG())

  // —— 水墨风配色预览（INK=1）：insertCSS 注入 token + 水印，不动源码（内联 <style> 会被 CSP 的 style-src 'self' 拦）——
  if (process.env.INK === '1') {
    const inkCss = `
      :root {
        --bg: #f6f5f2;
        --panel: #ffffff;
        --border: #ebe9e3;
        --text: #1c1c1a;
        --muted: #8b8a83;
        --accent: #1c1c1a;
        --accent-soft: #efeee9;
        --accent-border: #ddd9d0;
        --danger: #a8342c;
        --danger-soft: #f7ece9;
        --danger-border: #e8cfc8;
        --ok: #1c1c1a;
        --ok-soft: #efeee9;
        --ok-border: #ddd9d0;
      }
      .new-task { position: relative; overflow-x: hidden; }
      .new-task-center { position: relative; z-index: 1; }
      .topbar, .sidebar, .dock { border-color: #efece6; }
    `
    await win.webContents.insertCSS(inkCss)

    // 两个水印变体：A 完整句（适配宽度不裁切）/ B 只取「九十」（超大，符号化）
    const variants = [
      { file: 'verify-ink-A-full.png', text: '行百里者半九十', size: 68, top: '19%', ls: '0.14em' },
      { file: 'verify-ink-B-short.png', text: '九十', size: 190, top: '23%', ls: '0.06em' }
    ]

    for (const v of variants) {
      await win.webContents.executeJavaScript(`
        (() => {
          const page = document.querySelector('.new-task');
          if (!page) return;
          let wm = page.querySelector('.ink-wm');
          if (!wm) {
            wm = document.createElement('div');
            wm.className = 'ink-wm';
            page.appendChild(wm);
          }
          wm.textContent = ${JSON.stringify(v.text)};
          Object.assign(wm.style, {
            position: 'absolute', left: '50%', top: '${v.top}',
            transform: 'translate(-50%, -50%)',
            fontSize: '${v.size}px', fontWeight: '700',
            letterSpacing: '${v.ls}', color: '#eae9e3',
            whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none', zIndex: '0'
          });
        })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      const s = await win.webContents.capturePage()
      writeFileSync(join(SHOTS, v.file), s.toPNG())
    }

    await win.webContents.executeJavaScript(`
      (() => {
        const item = document.querySelector('.conv-item');
        if (item) item.click();
        return !!item;
      })()
    `)
    await new Promise((r) => setTimeout(r, 900))
    const shotInk2 = await win.webContents.capturePage()
    writeFileSync(join(SHOTS, 'verify-ink-chat.png'), shotInk2.toPNG())
    console.log('INK_PREVIEW=done')
  }

  // —— 设置 · 外观：主题切换（plan7）——真点一次，验证 data-theme 生效 ——
  await win.webContents.executeJavaScript(`
    (() => {
      const back = document.querySelector('.back-btn');
      if (back) back.click();
      return !!back;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  await win.webContents.executeJavaScript(`
    (() => {
      const gear = document.querySelector('.gear-btn');
      if (gear) gear.click();
      return !!gear;
    })()
  `)
  // —— 工作台「任务管理」面板：子代理 + 后台任务（plan7 批 D）——
  const openedTasks = await openBuiltin('任务管理')
  checkTrue('工作台能通过 ＋ 菜单打开任务管理', openedTasks === true, openedTasks)
  await new Promise((r) => setTimeout(r, 900))
  const tasksState = await win.webContents.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('.task-item'));
      // 两块共用 .task-item，靠类名区分：后台任务带 task-bg-*
      const bgItems = items.filter((e) => /task-bg-/.test(e.className));
      const jobItems = items.filter((e) => !/task-bg-/.test(e.className));
      return {
        hasPanel: !!document.querySelector('.tasks-panel'),
        heads: Array.from(document.querySelectorAll('.tasks-title')).map((e) => e.textContent.trim()),
        subs: Array.from(document.querySelectorAll('.tasks-sub')).map((e) => e.textContent.trim()),
        jobCount: jobItems.length,
        jobStatuses: jobItems.map((e) => e.querySelector('.task-status')?.textContent?.trim() ?? null),
        jobClasses: jobItems.map((e) => e.className),
        bgCount: bgItems.length,
        bgIds: bgItems.map((e) => e.querySelector('.task-name')?.textContent?.trim() ?? null),
        bgStatuses: bgItems.map((e) => e.querySelector('.task-status')?.textContent?.trim() ?? null),
        bgClasses: bgItems.map((e) => e.className),
        bgHasOutput: bgItems.map((e) => !!e.querySelector('.task-output')),
        // 只有 running 的那条该有终止按钮
        bgHasKill: bgItems.map((e) => !!e.querySelector('.task-actions button'))
      };
    })()
  `)
  const shotTasks = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-tasks.png'), shotTasks.toPNG())

  await new Promise((r) => setTimeout(r, 900))

  // —— 工作台「终端」面板 —— ⚠️ 门禁跑不了真 shell；能验的：xterm 真渲染 / 样式真生效 / 推一帧看得见 / 切走再切回不重不漏 / 只读档明说“不执行”
  const openedTerm = await openBuiltin('终端')
  checkTrue('工作台能通过 ＋ 菜单打开终端', openedTerm === true, openedTerm)
  await new Promise((r) => setTimeout(r, 2500)) // xterm 按需加载 + 建实例

  const termState = await win.webContents.executeJavaScript(`
    (() => {
      const host = document.querySelector('.tm-host');
      const rows = document.querySelector('.tm-host .xterm-rows');
      const span = rows ? rows.querySelector('span') : null;
      // ⚠️ 底色不在 .xterm-rows 上 —— 它在 .xterm-screen（xterm 把主题背景画在这一层）。
      //    早先断言读 rows.backgroundColor，恒得 rgba(0,0,0,0)（透明），于是这条断言**必红且没诊断力**：
      //    它抓的是"取错了节点"，不是"配色对不对"。故这里显式取 screen，并回传二者便于日后排障。
      const screen = document.querySelector('.tm-host .xterm-screen');
      // ⚠️⚠️ 底色真正的落点（2026-09-13 用树遍历查明）：.xterm-scrollable-element。
      //    踩坑记：先取 .xterm-rows（透明）、再改取 .xterm-screen（还是透明），两条都恒红。
      //    教训：xterm 的 DOM 层级是 terminal > xterm-viewport / xterm-scrollable-element > xterm-screen > xterm-rows，
      //    主题底色画在**带滚动的那一层**上；写断言前先把树打出来看，别猜。
      const scroller = document.querySelector('.tm-host .xterm-scrollable-element');
      const cs = (el) => { if (!el) return null; const c = getComputedStyle(el); return { color: c.color, background: c.backgroundColor, whiteSpace: c.whiteSpace, display: c.display, verticalAlign: c.verticalAlign }; };
      return {
        hasPanel: !!document.querySelector('.tm-panel'),
        hasTerm: !!document.querySelector('.tm-host .xterm'),
        hasRows: !!rows,
        hostH: host ? Math.round(host.getBoundingClientRect().height) : 0,
        // 当前主题（值 'ink' 才是墨色，其余一律纸白）—— 下面的样式断言按它选期望色（本行在模板串里，注释不许有反引号）
        dataTheme: document.documentElement.dataset.theme ?? '',
        status: document.querySelector('.tm-status')?.textContent?.trim() ?? null,
        shell: document.querySelector('.tm-shell')?.textContent?.trim() ?? null,
        rowsStyle: cs(rows),
        screenStyle: cs(screen),
        scrollerStyle: cs(scroller),
        spanStyle: cs(span),
        // ⚠️ 锚定直接子节点：面板里有两个 .tm-note，裸 querySelector('.tm-note') 拿的是文档序第一个
        note: document.querySelector('.tm-panel > .tm-note')?.textContent?.trim() ?? null
      };
    })()
  `)
  const shotTerm = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-terminal.png'), shotTerm.toPNG())

  // 从主进程推一帧输出（真链路：主进程 → preload → React → xterm）。⚠️ 同时记进 termChunks，否则切页签
  // 回来时 stub 快照里没这一帧，“重放”就验不出来。这帧故意带 ANSI 红：style-src-attr 被收成 'none' 就会字还在、颜色没了。
  const TERM_MARK = 'JSL_TERM_PROBE_9Z'
  // **16 色 palette** —— 走 xterm 注入样式表里的类名（`xterm-fg-1`），归 `style-src-elem` 档
  const TERM_RED_MARK = 'JSL_TERM_RED_9Z'
  // **真彩** —— 走 `_addStyle()` 的 `setAttribute('style', 'color:#…')`，归 `style-src-attr` 档。
  // 这条是给 attr 那一档补的牙：只验 16 色的话，把它收成 'none' 断言照样绿（16 色走注入样式表）。
  const TERM_TRUE_MARK = 'JSL_TERM_TRUE_9Z'
  const termFrameSeq = termSeq
  const termFrameData =
    TERM_MARK +
    '\r\n\u001b[31m' +
    TERM_RED_MARK +
    '\u001b[0m\r\n\u001b[38;2;255;0;0m' +
    TERM_TRUE_MARK +
    '\u001b[0m\r\n'
  termChunks.push({ seq: termFrameSeq, data: termFrameData })
  termSeq += 1
  win.webContents.send('terminal:data', {
    sessionId: termSessionId(),
    seq: termFrameSeq,
    data: termFrameData
  })
  await new Promise((r) => setTimeout(r, 800))
  const termAfterFrame = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelector('.tm-host .xterm-rows');
      if (!rows) return { text: '', has: false, redColor: null, plainColor: null };
      const text = Array.from(rows.children).map((e) => e.textContent || '').join('');
      const spans = Array.from(rows.querySelectorAll('span'));
      const pick = (mark) => spans.find((s) => (s.textContent || '').includes(mark)) || null;
      const redSpan = pick(${JSON.stringify(TERM_RED_MARK)});
      const trueSpan = pick(${JSON.stringify(TERM_TRUE_MARK)});
      return {
        text: text.slice(0, 200),
        has: text.includes(${JSON.stringify(TERM_MARK)}),
        redColor: redSpan ? getComputedStyle(redSpan).color : null,
        trueColor: trueSpan ? getComputedStyle(trueSpan).color : null,
        // ⚠️ 别去找“普通文字的 span”（默认色文字是 row 的文本节点，只有带色的才有 span）；基准取行元素的默认前景色
        rowsColor: getComputedStyle(rows).color
      };
    })()
  `)

  // 切走再切回（plan40 注释更新）：页签保活后失活不卸载，屏幕原地保留 —— 这条判据的语义从"重放不重复"
  // 变为**保活合同**：内容还在、不重写。真正的"重挂重放"窗口在下面用**关页签→重开**制造。
  await openBuiltin('任务管理')
  await new Promise((r) => setTimeout(r, 600))
  await openBuiltin('终端')

  // ⚠️ **就在这一刻推一帧实时输出**（不再额外等待）：先关掉终端页签再重开，强制真重挂 ——
  //    面板刚挂载、`boot()` 正卡在 stub 的 400ms 快照上（`replaying = true`）—— 这一帧**必然落进"订阅↔重放"那个缝**。
  //    保活让"切页签"不再产生这个缝（plan40 前这里是空转：boot 根本没跑，判据名不副实），必须关而复合。
  await win.webContents.executeJavaScript(`
    (() => {
      const tab = Array.from(document.querySelectorAll('.pane-tab'))
        .find((t) => (t.textContent || '').includes('终端'));
      const x = tab ? tab.querySelector('.pane-tab-x') : null;
      if (x) x.click();
      return !!x;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  await openBuiltin('终端')
  const LIVE_MARK = 'JSL_TERM_LIVE_7Q'
  const liveSeq = termSeq
  const liveData = LIVE_MARK + '\r\n'
  termChunks.push({ seq: liveSeq, data: liveData })
  termSeq += 1
  win.webContents.send('terminal:data', {
    sessionId: termSessionId(),
    seq: liveSeq,
    data: liveData
  })
  await new Promise((r) => setTimeout(r, 2000))
  const termAfterSwitch = await win.webContents.executeJavaScript(`
    (() => {
      const text = Array.from(document.querySelectorAll('.tm-host .xterm-rows > div'))
        .map((e) => e.textContent || '').join('');
      const marks = text.split(${JSON.stringify(TERM_MARK)}).length - 1;
      return { marks, has: text.includes(${JSON.stringify(TERM_MARK)}) };
    })()
  `)
  const termLive = await win.webContents.executeJavaScript(`
    (() => {
      const hosts = Array.from(document.querySelectorAll('.tm-host'));
      const rows = document.querySelector('.tm-host .xterm-rows');
      const text = rows ? Array.from(rows.children).map((e) => e.textContent || '').join('') : '';
      return {
        hostCount: hosts.length,
        termMarks: text.split(${JSON.stringify(TERM_MARK)}).length - 1,
        liveMarks: text.split(${JSON.stringify(LIVE_MARK)}).length - 1,
        liveAt: text.indexOf(${JSON.stringify(LIVE_MARK)}),
        termAt: text.indexOf(${JSON.stringify(TERM_MARK)}),
        text: text.slice(0, 160)
      };
    })()
  `)

  checkTrue('终端面板渲染出来了（xterm 实例在、有可见的行、有高度）',
    termState.hasPanel === true && termState.hasTerm === true && termState.hasRows === true && termState.hostH > 100,
    termState)

  // ⚠️ 这一条最容易静默坏掉：xterm 运行时插 <style>，被生产 CSP 拒掉后字会变成背景色（什么都看不见）、
  //    white-space 从 pre 掉回 normal —— 而页面照样渲染得出来，“元素在不在”抓不到它。判据必须落在计算样式上、
  //    钉住主题常量（期望色与 TerminalPanel.tsx 的 THEME_* 同源、改配色要同步改；只断言“前景 ≠ 背景”近乎恒真）。
  // 2026-09-14 六主题定调：**夜梦 → 黑终端；其余五套 → 纯白终端**（白底深字，用户强调不是旧的黑底白盖）。
  // 期望值与 TerminalPanel.tsx 的 THEME_* 同源、改配色要同步改；只断言"前景 ≠ 背景"近乎恒真。
  const themeFg = termState.dataTheme === 'yemeng' ? 'rgb(232, 230, 227)' : 'rgb(31, 35, 40)'
  checkTrue('**终端样式真的生效**（字色 = 当前主题的前景色、white-space:pre、span 是 inline-block）',
    termState.rowsStyle?.color === themeFg &&
      termState.rowsStyle?.whiteSpace === 'pre' &&
      termState.spanStyle?.display === 'inline-block',
    { theme: termState.dataTheme, expect: themeFg, rows: termState.rowsStyle, span: termState.spanStyle })
  // 底色也要钉 —— 只钉前景色的话，"把两套主题的背景色写反"这类错误照样全绿
  const themeBg = termState.dataTheme === 'yemeng' ? 'rgb(28, 28, 26)' : 'rgb(255, 255, 255)'
  // 从 `.xterm-scrollable-element` 取（xterm 把主题底色画在带滚动的那一层；rows/screen 都是透明的）
  const scrollerBg = termState.scrollerStyle?.background
  checkTrue('终端底色跟着主题走（夜梦=黑 / 其余=纯白 #ffffff），不是两套都一个色',
    scrollerBg === themeBg,
    { theme: termState.dataTheme, expect: themeBg, actual: scrollerBg, rowsBg: termState.rowsStyle?.background })
  checkTrue('**样式类 CSP 违规为 0**（`style-src-elem` 与 `style-src-attr` 两档都放行了）',
    cspViolations.filter((m) => /Refused to apply inline style/i.test(m)).length === 0,
    cspViolations.filter((m) => /Refused to apply inline style/i.test(m)).slice(0, 3))

  checkTrue('主进程推一帧输出 → **屏幕上真的看得见**（主进程 → preload → React → xterm 整条链路）',
    termAfterFrame.has === true, termAfterFrame)

  // ⚠️ 先说清这条判不了什么：把构建产物的 style-src-attr 改回 'none'（CSP 证伪实验）之后它仍然绿 ——
  //    16 色走注入样式表的类名（xterm-fg-N），归 elem 档；它守的是“颜色链路整体没坏”。
  checkTrue('**16 色 ANSI 颜色真的画上去了**（红色那段的计算色 ≠ 行的默认前景色）',
    termAfterFrame.redColor !== null &&
      termAfterFrame.rowsColor !== null &&
      termAfterFrame.redColor !== termAfterFrame.rowsColor,
    termAfterFrame)

  // ⚠️ 这才是咬住 style-src-attr 那一档的断言：真彩走 _addStyle() 的 setAttribute('style', 'color:#…')，
  //    那一档一旦收成 'none'，span 拿不到颜色、计算色掉回行的默认前景色，这条必红。
  checkTrue('**真彩（24 位）颜色真的画上去了**（`38;2;255;0;0` 那段 = rgb(255, 0, 0)，这条咬 style-src-attr）',
    termAfterFrame.trueColor === 'rgb(255, 0, 0)',
    { trueColor: termAfterFrame.trueColor, rowsColor: termAfterFrame.rowsColor })

  checkTrue('**切走页签再切回：历史输出还在、且没有重复**（缓冲重放）',
    termAfterSwitch.has === true && termAfterSwitch.marks === 1, termAfterSwitch)

  checkTrue('**重挂后到达的实时帧：只出现一次、且落在历史之后**（订阅↔重放那段窗口的判据）',
    termLive.liveMarks === 1 && termLive.termMarks === 1 && termLive.liveAt > termLive.termAt,
    termLive)

  // ── 「重启终端」必须是真重启 ── 老实现走幂等的 terminal:start（拿回同一会话、屏幕原样 = 死按钮）；判据：会话号变了 + 旧屏被清掉
  const clickedRestart = await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.tm-bar .ck-btn'))
        .find((b) => (b.textContent || '').trim() === '重启终端');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 1600))
  const termAfterRestart = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelector('.tm-host .xterm-rows');
      const text = rows ? Array.from(rows.children).map((e) => e.textContent || '').join('') : '';
      return {
        text: text.slice(0, 120),
        hasOld: text.includes(${JSON.stringify(TERM_MARK)}),
        hasLive: text.includes(${JSON.stringify(LIVE_MARK)})
      };
    })()
  `)
  checkTrue('点「重启终端」→ **真的换了会话**（走了 restart 通道、旧屏被清掉）',
    clickedRestart === true &&
      termRestartCalls === 1 &&
      termAfterRestart.hasOld === false &&
      termAfterRestart.hasLive === false,
    { clickedRestart, termRestartCalls, termAfterRestart })

  checkTrue('边界如实写在界面上（终端里改/删的文件不进检查点与回收站）',
    (termState.note || '').includes('回收站'), termState.note)

  // ── 只读档：拒绝执行 + 说清原因（判据：界面明说原因、且真的没有起会话）。这一段放在最后做，它会把会话置成”没有”。——
  termPermission = 'read-only'
  // plan40 S3 同口径：真实主进程改权限档后会广播 settings:changed，面板据此重 boot；
  // 隔离验证进程里这一步由桩补发（不广播的话保活面板永远不会重取权限 = 测的是旧前提）
  win.webContents.send('settings:changed', 'permission')
  termHasSession = false
  const termStartCallsBefore = termStartCalls
  await openBuiltin('任务管理')
  await new Promise((r) => setTimeout(r, 500))
  await openBuiltin('终端')
  await new Promise((r) => setTimeout(r, 1600))
  const termReadOnly = await win.webContents.executeJavaScript(`
    (() => ({
      refuse: document.querySelector('.tm-panel .tm-refuse')?.textContent?.trim() ?? null,
      warnAll: document.querySelector('.tm-panel .df-warn')?.textContent?.trim() ?? null,
      status: document.querySelector('.tm-status')?.textContent?.trim() ?? null
    }))()
  `)
  // ⚠️ 判据读独立节点 .tm-refuse 且要求出现 stub 的哨兵串 —— 证明那句话来自 IPC 返回值，不是模板写死的
  checkTrue('只读档下终端**拒绝执行**，且界面把 IPC 返回的原因**原样说出来**（哨兵串在）',
    (termReadOnly.refuse || '').includes('JSL_RO_9Z') && termReadOnly.status === '还没有会话',
    { termReadOnly, termStartCalls })
  // ⚠️ 光断言 termHasSession === false 是恒真的（门禁自己刚设成 false）；加上“界面试过启动”的计数差才算验过
  checkTrue('只读档下**界面试过启动、却一条会话都没留下**（计数差 + 会话状态双判）',
    termStartCalls > termStartCallsBefore && termHasSession === false,
    { termStartCalls, termStartCallsBefore, termHasSession })
  termPermission = 'write' // 收尾：把门禁的存根状态还原，免得影响后面段落
  win.webContents.send('settings:changed', 'permission') // 与 plan40 S3 同口径：还原也要广播，保活面板才会恢复会话

  // ⚠️ 必须先切回「通用设置」：上面分区循环最后一站停在「故障排查」，不切回来
  //    下面找 `.settings-body label.checkbox` 必然全 null（会红成"开关不存在"，其实只是没翻到那一页）
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.trim() === '通用设置');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))

  // ── Token Saver 档位：档位卡片与权限档同屏 —— 一律用 [aria-label="Token Saver 档位"] 限定范围查（.choice-item 会把权限档也捞进来）──
  const tierBefore = await sevalRaw(`
    (() => {
      const group = document.querySelector('[aria-label="Token Saver 档位"]');
      if (!group) return { found: false };
      return {
        found: true,
        items: Array.from(group.querySelectorAll('.choice-name')).map((e) => e.textContent.trim()),
        checked: group.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null
      };
    })()
  `)
  checkTrue('设置页有「Token Saver」一栏，四档都在（0.13.42 定序：轻量/平衡/极致/土豪，平衡居中）',
    tierBefore.found && tierBefore.items.join('/') === '轻量/平衡/极致/土豪', tierBefore)
  checkTrue('默认落在**平衡**档（用户定调的默认，不是界面随手编的）',
    tierBefore.checked === '平衡', tierBefore)

  await sevalRaw(`
    (() => {
      const group = document.querySelector('[aria-label="Token Saver 档位"]');
      const btn = group && Array.from(group.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '轻量');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const tierAfter = await sevalRaw(`
    (() => {
      const group = document.querySelector('[aria-label="Token Saver 档位"]');
      if (!group) return null;
      return group.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null;
    })()
  `)
  checkTrue('点一下就切到「轻量」—— 档位真值在主进程，界面只是它的视图',
    tierAfter === '轻量', tierAfter)

  // ── 系统集成（plan7 批 F1）：锁屏/熄屏后继续运行 + 开机自启 ──
  // ⚠️ 门禁里主进程是存根，故这一段能验的只有"界面结构与载荷对不对"；"真生效"由实机验收
  //    （`scripts/probe-main-system.cjs` 跑真组合根 + `powercfg /requests` 人工看，见 PLAN/plan15 §六），
  //    **不许在这里冒充**。
  const systemRead = () => sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=checkbox]'));
      const pick = (t) => rows.find((r) => r.textContent.trim().startsWith(t)) ?? null;
      const size = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      const shape = (el) => {
        if (!el) return null;
        const input = el.querySelector('input');
        return { checked: input.checked, disabled: input.disabled, box: size(input) };
      };
      const hints = Array.from(document.querySelectorAll('.settings-body p.hint'));
      return {
        labels: rows.map((r) => r.textContent.trim()),
        // 电脑控制开关（2026-09-15 新增）混在同一个 .settings-body 里，一并采下默认态
        cc: shape(pick('启用电脑控制')),
        keep: shape(pick('锁屏与熄屏后继续运行')),
        auto: shape(pick('开机自启')),
        hints: hints.map((p) => p.textContent.trim()),
        // 注释收 ⓘ 后，承重文案住在 aria-label 里（气泡展开与否它都在，屏幕阅读器读的也是它）
        fnoteLabels: Array.from(document.querySelectorAll('.fnote-mark')).map((n) => n.getAttribute('aria-label') ?? ''),
        // 几何也要量：DOM 里在 ≠ 用户看得见（AGENTS §八同源教训）
        hintBoxes: hints.map((p) => size(p))
      };
    })()
  `)
  const systemBefore = await systemRead()
  const visible = (box) => box !== null && box.w >= 12 && box.h >= 12
  checkTrue('设置页「系统」区三项：启用电脑控制 / 锁屏与熄屏后继续运行 / 开机自启 —— 默认都关着、都可点',
    systemBefore.labels.length === 3 &&
      systemBefore.cc !== null && systemBefore.cc.checked === false && systemBefore.cc.disabled === false &&
      systemBefore.keep !== null && systemBefore.keep.checked === false && systemBefore.keep.disabled === false &&
      systemBefore.auto !== null && systemBefore.auto.checked === false && systemBefore.auto.disabled === false,
    systemBefore)
  checkTrue('电脑控制初值来自主进程（`computer-control:get` 桩真被调过，勾选框不进禁用死角）',
    ccEnabled === false && systemBefore.cc !== null && systemBefore.cc.disabled === false,
    { ccEnabled, cc: systemBefore.cc })
  // 开关往返：点击 → 桩收到载荷 → **跟随返回值回显**（同档位选择/系统开关的口径：不做乐观更新）→ 开着时提示行必须出现
  await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=checkbox]'));
      const c = rows.find((r) => r.textContent.trim().startsWith('启用电脑控制'));
      if (c) c.querySelector('input').click();
      return !!c;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const ccAfter = await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=checkbox]'));
      const c = rows.find((r) => r.textContent.trim().startsWith('启用电脑控制'));
      const hints = Array.from(document.querySelectorAll('.settings-body p.hint')).map((p) => p.textContent.trim());
      return { checked: c ? c.querySelector('input').checked : null, hints };
    })()
  `)
  checkTrue('电脑控制点一下 → 桩收到 true、界面跟随返回值勾选，且开着时**当场说明**"还要先添加 windows-mcp"的现状',
    ccCalls.length === 1 && ccCalls[0] === true &&
      ccAfter.checked === true &&
      ccAfter.hints.some((h) => h.indexOf('windows-mcp') >= 0 && h.indexOf('下发') >= 0),
    { ccCalls, ccAfter })
  // 恢复：关回去，别让后续探针活在"被开着"的世界里
  await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=checkbox]'));
      const c = rows.find((r) => r.textContent.trim().startsWith('启用电脑控制'));
      if (c) c.querySelector('input').click();
      return !!c;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  checkTrue('电脑控制再点一下 → 关回原状（载荷 false、勾选框回未勾）',
    ccCalls.length === 2 && ccCalls[1] === false && ccEnabled === false,
    { ccCalls, ccEnabled })
  // 初值必须是**从主进程取到的**：取数失败会回落到"未勾选+禁用"，那与"存根返回 false"在断言层分不开 → 查调用次数
  checkTrue('初值来自主进程（`system:get` 真的被调过，不是界面默认值）',
    systemGetCalls >= 1 && systemBefore.keep !== null && systemBefore.keep.disabled === false,
    { systemGetCalls })
  checkTrue('两个勾选框**量出来是看得见的**（宽高 > 0，不是零尺寸的隐形控件）',
    visible(systemBefore.keep.box) && visible(systemBefore.auto.box),
    { keep: systemBefore.keep.box, auto: systemBefore.auto.box })
  // 承重文案：这两项都是**系统级副作用**，代价与边界必须可达（注释收 ⓘ 后住在 aria-label 里）
  // （"空闲"两个字是承诺范围的边界：合盖/手动睡眠仍会中断，写成"系统绝不睡眠"是兑现不了的）
  const sysNotes = systemBefore.fnoteLabels.join('|')
  checkTrue('两项都写明了代价/边界（只阻止空闲睡眠 · 功耗代价 · 无托盘且关窗即退出）',
    sysNotes.indexOf('空闲') >= 0 &&
      sysNotes.indexOf('功耗') >= 0 &&
      sysNotes.indexOf('托盘') >= 0 &&
      sysNotes.indexOf('关闭主窗口即退出应用') >= 0,
    systemBefore.fnoteLabels)

  await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=checkbox]'));
      const pick = (t) => rows.find((r) => r.textContent.trim().startsWith(t));
      const k = pick('锁屏与熄屏后继续运行');
      const a = pick('开机自启');
      if (k) k.querySelector('input').click();
      if (a) a.querySelector('input').click();
      return !!k && !!a;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const systemAfter = await systemRead()
  checkTrue('勾选后载荷正确：两个开关各发自己那一个键（互不污染）',
    systemSetCalls.length === 2 &&
      systemSetCalls[0].keepRunning === true && systemSetCalls[0].openAtLogin === undefined &&
      systemSetCalls[1].openAtLogin === true && systemSetCalls[1].keepRunning === undefined,
    systemSetCalls)
  checkTrue('勾选后两个开关都变成已勾选（载荷已发出）',
    systemAfter.keep !== null && systemAfter.keep.checked === true &&
      systemAfter.auto !== null && systemAfter.auto.checked === true,
    systemAfter)

  // ⚠️ 上面那条在"纯回显"的存根下**乐观更新也能绿**。真正能分辨的是这一条：让存根回一个**载荷没要的值**
  //    （点击发 `openAtLogin:false`，存根回 `true`）—— 界面若跟着返回值走，就该保持勾选。
  systemForceNextSet = { openAtLogin: true }
  await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=checkbox]'));
      const a = rows.find((r) => r.textContent.trim().startsWith('开机自启'));
      if (a) a.querySelector('input').click();
      return !!a;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const systemEcho = await systemRead()
  checkTrue('界面跟随**主进程返回值**而不是乐观更新（存根故意回了与载荷相反的值，勾选态跟着返回值）',
    systemSetCalls.length === 3 && systemSetCalls[2].openAtLogin === false &&
      systemEcho.auto !== null && systemEcho.auto.checked === true,
    { calls: systemSetCalls, echo: systemEcho.auto })

  // 翻存根 → 验两条"设了却不生效"的真实分支：blocker 起不来（显示原因）· 开发态不给写启动项（禁用 + 原因）
  // ⚠️ 原因用**哨兵串**（同 JSL_RO_9Z 的手法）：用真文案的话，界面里硬编码同一句也能绿
  systemStub = {
    ...systemStub,
    keepRunningActive: false,
    keepRunningError: '系统拒绝了执行状态请求 JSL_SYS_K7',
    openAtLogin: false,
    openAtLoginActive: false,
    openAtLoginSupported: false,
    openAtLoginReason: '开发态写入的启动项指向 Electron 而非本应用，仅安装版可用。JSL_SYS_A9'
  }
  // ⚠️ 必须"切走、**等一帧**、再切回"：两次点击在同一批次里会被 React 合并成"没离开过"，依赖 section 的
  //    取数就不会重跑 —— 那会把"重取真值"验成假绿（探针只验到内存里的旧值）
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.trim() === '模型');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item')).find((x) => x.textContent.trim() === '通用设置');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const systemTrouble = await systemRead()
  checkTrue('blocker 设了却没生效时：复选框仍反映用户的选择，但**当场显示原因**（不许静默显示"已开"）',
    systemTrouble.keep !== null && systemTrouble.keep.checked === true &&
      systemTrouble.hints.some((t) => t.indexOf('JSL_SYS_K7') >= 0),
    systemTrouble)
  checkTrue('开机自启不可用时：复选框**禁用**且给出原因（不会写出指向 electron.exe 的启动项）',
    systemTrouble.auto !== null && systemTrouble.auto.disabled === true &&
      systemTrouble.auto.checked === false &&
      systemTrouble.hints.some((t) => t.indexOf('JSL_SYS_A9') >= 0),
    systemTrouble)
  checkTrue('「没生效」的提示行**量出来是看得见的**（那句防线不许是零尺寸的隐形文字）',
    systemTrouble.hintBoxes.some((b) => visible(b)) &&
      systemTrouble.hints.some((t) => t.indexOf('JSL_SYS_K7') >= 0 && t.length > 10),
    systemTrouble.hintBoxes)

  // 还原存根状态（验证脚本要能重复运行：留着"不支持"会让后面再进通用设置的段落看到禁用态）
  systemStub = {
    ...systemStub,
    keepRunning: false,
    keepRunningActive: false,
    keepRunningError: null,
    openAtLoginSupported: true,
    openAtLoginReason: null
  }

  // ── 网络代理（plan7 批 F2）──
  // 验收的**核心**是「当前生效」那一行：代理配错的表现是超时，而"没生效"与"生效了但连不上"
  // 对用户是同一个现象 —— 只有这一行能把两者分开，所以每一档都要验它真的变了。
  const netRead = () => sevalRaw(`
    (() => {
      // ⚠️ size 是**每个 eval 脚本内部的局部函数**（别的段落里那份到不了这里），必须自带一份；
      //    漏了它的表现是整段 eval 抛异常，报错只说"脚本执行失败"，很难定位到这一行。
      //    （本段注释里不许出现反引号 —— 它会截断外层模板字符串，上次 2319 行就是这么炸的）
      const size = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=radio]'));
      const shape = (el) => {
        if (!el) return null;
        const input = el.querySelector('input');
        return { checked: input.checked, disabled: input.disabled, box: size(input) };
      };
      const pick = (t) => rows.find((r) => r.textContent.trim().startsWith(t));
      const hints = Array.from(document.querySelectorAll('.settings-body p.hint'));
      const addrLabel = Array.from(document.querySelectorAll('.settings-body label'))
        .find((l) => l.textContent.trim().startsWith('代理地址'));
      const addrInput = addrLabel ? addrLabel.querySelector('input') : null;
      const eff = hints.find((p) => p.textContent.indexOf('当前生效') >= 0);
      const clearBtn = Array.from(document.querySelectorAll('.settings-body button'))
        .find((b) => b.textContent.trim().indexOf('清除已保存') >= 0);
      return {
        modes: rows.map((r) => r.textContent.trim()),
        system: shape(pick('跟随系统')),
        direct: shape(pick('直连')),
        custom: shape(pick('手动配置')),
        hasAddrInput: !!addrInput,
        addrValue: addrInput ? addrInput.value : null,
        effectiveText: eff ? eff.textContent.trim() : '',
        // 注释收 ⓘ 后，承重文案住在 aria-label 里（气泡展开与否它都在）
        fnoteLabels: Array.from(document.querySelectorAll('.fnote-mark')).map((n) => n.getAttribute('aria-label') ?? ''),
        hasClearBtn: !!clearBtn,
        hints: hints.map((p) => p.textContent.trim())
      };
    })()
  `)

  const netInitial = await netRead()
  checkTrue('设置页「网络」有三档：跟随系统 / 直连 / 手动配置 —— 默认跟随系统（与 Electron 自身默认一致）',
    netInitial.modes.length === 3 &&
      netInitial.system !== null && netInitial.system.checked === true &&
      netInitial.direct !== null && netInitial.direct.checked === false &&
      netInitial.custom !== null && netInitial.custom.checked === false,
    netInitial)
  checkTrue('初值来自主进程（net-proxy:get 真被调过，不是界面默认值）', netGetCalls >= 1, { netGetCalls })
  checkTrue('「当前生效」显示的是**探测到的代理**（跟随系统档：能读出系统里那个代理与兜底直连）',
    netInitial.effectiveText.indexOf('当前生效') >= 0 &&
      netInitial.effectiveText.indexOf('127.0.0.1:7897') >= 0 &&
      netInitial.effectiveText.indexOf('直连') >= 0,
    netInitial.effectiveText)
  checkTrue('三档单选框**量出来是看得见的**（宽高 > 0，不是零尺寸隐形控件）',
    visible(netInitial.system.box) && visible(netInitial.direct.box) && visible(netInitial.custom.box),
    { s: netInitial.system.box, d: netInitial.direct.box, c: netInitial.custom.box })
  // 承重文案：代理是**只对新请求生效**的，不说清楚会被理解成"改完立刻全局生效"（收 ⓘ 后住 aria-label）
  checkTrue('写明「只影响之后发起的请求」（已建立的连接不受影响）',
    netInitial.fnoteLabels.join('|').indexOf('之后发起的') >= 0, netInitial.fnoteLabels)

  await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=radio]'));
      const d = rows.find((r) => r.textContent.trim().startsWith('直连'));
      if (d) d.querySelector('input').click();
      return !!d;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const netDirect = await netRead()
  checkTrue('选「直连」：载荷只带 proxyMode=direct，且**当前生效变成直连**',
    netSetCalls.length >= 1 && netSetCalls[netSetCalls.length - 1].proxyMode === 'direct' &&
      netDirect.direct.checked === true && netDirect.effectiveText.indexOf('当前生效：直连') >= 0,
    { calls: netSetCalls, text: netDirect.effectiveText })

  await sevalRaw(`
    (() => {
      const rows = Array.from(document.querySelectorAll('.settings-body label.checkbox'))
        .filter((r) => r.querySelector('input[type=radio]'));
      const c = rows.find((r) => r.textContent.trim().startsWith('手动配置'));
      if (c) c.querySelector('input').click();
      return !!c;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const netCustom = await netRead()
  checkTrue('选「手动配置」才出现地址输入框（另外两档不该有，那会诱导乱填）',
    netCustom.custom.checked === true && netCustom.hasAddrInput === true, netCustom)

  // 空地址直接点「应用」：体检不通过 → 界面**当场说出原因**，且不假装已生效
  await sevalRaw(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.settings-body button'))
        .find((b) => b.textContent.trim() === '应用');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const netEmpty = await netRead()
  checkTrue('手动档不填地址就应用：**当场报原因**（"改了没反应"是最难排查的一类故障）',
    netEmpty.hints.some((t) => t.indexOf('手动配置需要填写代理地址') >= 0), netEmpty.hints)

  // 填一个**带凭据**的地址：界面传原文、主进程剥走、只回显剥过的地址（凭据不回显）
  await sevalRaw(`
    (() => {
      const label = Array.from(document.querySelectorAll('.settings-body label'))
        .find((l) => l.textContent.trim().startsWith('代理地址'));
      const input = label ? label.querySelector('input') : null;
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'http://u:p@1.2.3.4:8080');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  await sevalRaw(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.settings-body button'))
        .find((b) => b.textContent.trim() === '应用');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const netApplied = await netRead()
  checkTrue('填地址后应用：载荷把**用户填的原文**发出去（剥凭据是主进程的活，不是界面的）',
    netSetCalls.length >= 1 &&
      netSetCalls[netSetCalls.length - 1].proxyRules === 'http://u:p@1.2.3.4:8080',
    netSetCalls)
  checkTrue('⚠️ 凭据**不回显**：地址框里只剩 http://1.2.3.4:8080，明文不回到界面',
    netApplied.addrValue === 'http://1.2.3.4:8080', { addrValue: netApplied.addrValue })
  checkTrue('「当前生效」跟着变成刚配的那个代理（这是"配了到底生效没有"唯一的硬证据）',
    netApplied.effectiveText.indexOf('1.2.3.4:8080') >= 0, netApplied.effectiveText)
  checkTrue('存过凭据后出现「清除已保存的账号密码」（凭据只进不出，但必须给得出清退的路）',
    netApplied.hasClearBtn === true, { hasClearBtn: netApplied.hasClearBtn })

  // 还原：别把"手动配置"留给后面的段落
  netStub = { ...netStub, proxyMode: 'system', proxyRules: '', hasCredentials: false, effective: 'PROXY 127.0.0.1:7897; DIRECT', applied: true, error: null }

  // ── 区块读取辅助：从某个 .field-label 切到下一个 .field-label 之间（⚠️ 它们的父元素是整个
  // settings-section，不切片的话 querySelector 会读到别的区块的路径/徽标 —— plan10 C 批实测踩中） ──
  const readSection = (label, buttonNames) => `
    (() => {
      const body = document.querySelector('.settings-body');
      const labels = Array.from(body.querySelectorAll('.field-label'));
      const label = labels.find((l) => l.textContent.trim() === ${JSON.stringify(label)});
      if (!label) return { found: false };
      const section = label.parentElement;
      const all = Array.from(section.children);
      const start = all.indexOf(label);
      let end = all.length;
      for (let i = start + 1; i < all.length; i++) {
        if (all[i].classList && all[i].classList.contains('field-label')) { end = i; break; }
      }
      const scope = all.slice(start, end);
      // ⚠️ querySelectorAll 只查后代不查自身 —— hint 是 <p class="hint"> 本身就是切片成员，必须连自身一起查
      const q = (sel) =>
        scope.map((el) => {
          const self = el.matches && el.matches(sel) ? [el] : [];
          return [...self, ...Array.from(el.querySelectorAll(sel))];
        }).flat();
      const btn = (name) => q('button').find((b) => b.textContent.trim() === name) ?? null;
      const shape = (b) => (b ? { disabled: b.disabled } : null);
      const buttons = {};
      for (const name of ${JSON.stringify(buttonNames)}) buttons[name] = shape(btn(name));
      const paths = q('.logs-path').map((e) => e.textContent.trim());
      return {
        found: true,
        path: paths[0] ?? null,
        paths,
        badge: q('.logs-count')[0]?.textContent?.trim() ?? null,
        pendingText: paths.find((t) => t.indexOf('下次启动') >= 0) ?? null,
        buttons,
        hints: q('.hint').map((p) => p.textContent.trim())
      };
    })()
  `

  // ── 工作区默认落点（plan7 批 F4）：三键齐 + 恢复内置默认有真退路 + 文案说清"只影响新任务" ──
  // 这条设置的全部语义就两句话：新任务默认在这个目录进行；老会话各自绑定当时的工作区，改这里不影响它们
  {
    const wsRead = async () =>
      await sevalRaw(readSection('工作区', ['选择目录…', '恢复内置默认', '打开目录']))
    const wsInit = await wsRead()
    checkTrue('工作区行有三键：选择目录… / 恢复内置默认 / 打开目录；内置默认档下「恢复内置默认」禁用（空操作按钮不装可用）',
      // ⚠️ checkTrue 对 cond 做 === true 严判：末位不能落在对象上（truthy 对象不等于 true），包一层 Boolean
      Boolean(
        wsInit.found && wsInit.buttons['选择目录…'] && wsInit.buttons['选择目录…'].disabled === false &&
          wsInit.buttons['恢复内置默认'] && wsInit.buttons['恢复内置默认'].disabled === true &&
          wsInit.buttons['打开目录']
      ),
      wsInit)
    checkTrue('文案写明「新任务默认在这个目录进行」与「不影响」已有会话（这项设置的全部语义）',
      wsInit.hints.some((t) => t.indexOf('新任务默认在这个目录') >= 0) &&
        wsInit.hints.some((t) => t.indexOf('不影响') >= 0),
      wsInit.hints)

    // 让桩"选"一个自定义目录（真实对话框自动化不了；桩默认返回取消，行为与真取消一致）
    wsPickNext = { path: 'D:\\ws_f4_custom', custom: true }
    await sevalRaw(`
      (() => {
        const btn = Array.from(document.querySelectorAll('.settings-body button'))
          .find((b) => b.textContent.trim() === '选择目录…');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const wsCustom = await wsRead()
    checkTrue('选目录后：路径与徽标变成自定义档、「恢复内置默认」解锁（默认落点改了要看得见）',
      wsCustom.path === 'D:\\ws_f4_custom' && wsCustom.badge === null &&
        wsCustom.buttons['恢复内置默认'] && wsCustom.buttons['恢复内置默认'].disabled === false,
      wsCustom)

    await sevalRaw(`
      (() => {
        const btn = Array.from(document.querySelectorAll('.settings-body button'))
          .find((b) => b.textContent.trim() === '恢复内置默认');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const wsBack = await wsRead()
    checkTrue('恢复内置默认后：徽标与路径回到内置档、按钮再禁用（选错目录必须有单程退路才算完整）',
      wsBack.path === 'D:\\jsllworkplace_for_test' && wsBack.badge === '内置默认' &&
        wsBack.buttons['恢复内置默认'] && wsBack.buttons['恢复内置默认'].disabled === true,
      wsBack)
    checkTrue('workspace:reset 真被调过且只调一次（状态变化只能来自主进程桩，不是界面乐观更新）',
      wsResetCalls.length === 1, { calls: wsResetCalls.length })
  }

  // ── 存储位置（plan10 C 批）：三键齐 + pending 待生效提示可撤销 + 回退语义 + lastEvent 提示条 ──
  // ⚠️ 桩变量是门禁侧的，React 不知道它变了 —— 状态变化必须**通过一次 IPC 调用**（点按钮 → 桩返回新值 → setState）驱动
  {
    const stRead = async () =>
      await sevalRaw(readSection('存储位置', ['更改…', '恢复默认位置', '打开目录', '撤销']))
    const stInit = await stRead()
    checkTrue('存储位置行有三键：更改… / 恢复默认位置 / 打开目录；默认位置档下「恢复默认位置」禁用',
      Boolean(
        stInit.found && stInit.buttons['更改…'] && stInit.buttons['更改…'].disabled === false &&
          stInit.buttons['恢复默认位置'] && stInit.buttons['恢复默认位置'].disabled === true &&
          stInit.buttons['打开目录']
      ),
      stInit)
    checkTrue('文案写明「下次启动时迁移生效」与「原目录保留」（迁移只在启动时做 + 有回退点，两项语义缺一不可）',
      stInit.hints.some((t) => t.indexOf('下次启动时迁移生效') >= 0) &&
        stInit.hints.some((t) => t.indexOf('原目录保留') >= 0),
      stInit.hints)

    // 第一段 pick：桩返回"已自定义档 + 最近迁移成功"（模拟已在新目录跑了一段时间）
    storagePickNext = {
      ok: true,
      info: {
        current: 'D:\\jsl-data-new',
        custom: true,
        pendingDir: null,
        pendingKind: null,
        lastEvent: { kind: 'ok', text: '数据已迁移到 D:\\jsl-data-new（6 个文件；原目录原样保留）', at: '2026-09-14T00:00:00Z' }
      }
    }
    await sevalRaw(`
      (() => {
        const btn = Array.from(document.querySelectorAll('.settings-body button'))
          .find((b) => b.textContent.trim() === '更改…');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const stCustom = await stRead()
    checkTrue('自定义档：路径与徽标切换、「恢复默认位置」解锁（数据搬没搬家要看得见）',
      stCustom.path === 'D:\\jsl-data-new' && stCustom.badge === '自定义' &&
        stCustom.buttons['恢复默认位置'] && stCustom.buttons['恢复默认位置'].disabled === false,
      stCustom)
    checkTrue('最近一次迁移结果以提示条展示（启动时发生的事，回到设置页必须看得见）',
      stCustom.hints.some((t) => t.indexOf('数据已迁移到') >= 0),
      stCustom.hints)

    // 第二段 pick：桩返回"pending 换新目录"—— 驱动 React 渲染待生效提示条
    storagePickNext = {
      ok: true,
      info: {
        current: 'D:\\jsl-data-new',
        custom: true,
        pendingDir: 'E:\\jsl-data-newer',
        pendingKind: 'migrate',
        lastEvent: null
      }
    }
    await sevalRaw(`
      (() => {
        const btn = Array.from(document.querySelectorAll('.settings-body button'))
          .find((b) => b.textContent.trim() === '更改…');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const stPending = await stRead()
    checkTrue('选目录后：出现「下次启动将迁移到」待生效提示 + 「撤销」按钮（点了没反应是这种设置的大忌）',
      // ⚠️ checkTrue 对 cond 做 === true 严判：末位落在对象上（truthy 但不 === true）必挂，包一层 Boolean
      Boolean(
        stPending.pendingText !== null && stPending.pendingText.indexOf('下次启动将迁移到') >= 0 &&
          stPending.pendingText.indexOf('E:\\jsl-data-newer') >= 0 && stPending.buttons['撤销']
      ),
      stPending)

    // 撤销 pending
    await sevalRaw(`
      (() => {
        const section = Array.from(document.querySelectorAll('.settings-body .field-label'))
          .find((l) => l.textContent.trim() === '存储位置')?.parentElement;
        const btn = section ? Array.from(section.querySelectorAll('button')).find((b) => b.textContent.trim() === '撤销') : null;
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const stUndone = await stRead()
    checkTrue('撤销后 pending 提示条消失（改主意必须是一条完整的路）',
      stUndone.pendingText === null && !stUndone.buttons['撤销'],
      stUndone)

    // 回退默认（自定义档 → storage:reset → pendingKind = restore）
    await sevalRaw(`
      (() => {
        const btn = Array.from(document.querySelectorAll('.settings-body button'))
          .find((b) => b.textContent.trim() === '恢复默认位置');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const stRestore = await stRead()
    checkTrue('自定义档点「恢复默认位置」后：出现「下次启动将迁回默认目录」提示（回退=反向迁移，同一台机器两个方向）',
      stRestore.pendingText !== null && stRestore.pendingText.indexOf('下次启动将迁回默认目录') >= 0,
      stRestore)
    checkTrue('storage:pick / storage:undo-pending / storage:reset 真被调过（状态变化只能来自主进程桩）',
      storagePickCalls === 2 && storageUndoCalls.length === 1 && storageResetCalls.length === 1,
      { picks: storagePickCalls, undos: storageUndoCalls.length, resets: storageResetCalls.length })
  }

  // R7 分区导航：主题项在「外观」分区里，不切过去就点不到（改版前是单页平铺）
  await sevalRaw(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((x) => x.textContent.trim() === '外观');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))

  const themeBefore = await sevalRaw(`
    (() => ({
      items: Array.from(document.querySelectorAll('.choice-item .choice-name')).map((e) => e.textContent.trim()),
      checked: document.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null,
      dataTheme: document.documentElement.dataset.theme ?? '(none)'
    }))()
  `)
  // 2026-09-14 六主题：此前的探针"只 log 不断言"—— TodoPanel 消失案同款盲区，这次补上断言
  // ⚠️ items 是整个外观分区的 choice-name（主题六项在前 + 字号四项在后），主题断言取前六
  checkTrue(
    '「外观」六主题齐（晴空/信纸/桃花/夜梦/春和/极光），默认晴空',
    themeBefore.items.length === 10 &&
      themeBefore.items.slice(0, 6).join(',') === '晴空,信纸,桃花,夜梦,春和,极光' &&
      themeBefore.checked === '晴空' &&
      themeBefore.dataTheme === 'qingkong',
    themeBefore
  )

  await sevalRaw(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '信纸');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const themeAfter = await sevalRaw(`
    (() => ({
      checked: document.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null,
      dataTheme: document.documentElement.dataset.theme ?? '(none)',
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    }))()
  `)
  const shotTheme = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-theme-ink.png'), shotTheme.toPNG())
  checkTrue(
    '切「信纸」：data-theme=xinzh、主色变墨（#1c1c1a）—— 旧名 ink 经迁移仍可读，但界面上是新 slug',
    themeAfter.checked === '信纸' && themeAfter.dataTheme === 'xinzh' && themeAfter.accent === '#1c1c1a',
    themeAfter
  )

  // 再切「桃花」：验一套新增主题的变量真的接上（不只选得中，还要换得了色）
  await sevalRaw(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '桃花');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const themePeach = await sevalRaw(`
    (() => ({
      dataTheme: document.documentElement.dataset.theme ?? '(none)',
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    }))()
  `)
  checkTrue(
    '切「桃花」：data-theme=taohua、主色桃粉（#c9556e）、底色粉白 —— 新主题变量真的生效',
    themePeach.dataTheme === 'taohua' && themePeach.accent === '#c9556e' && themePeach.bg === '#fdf5f6',
    themePeach
  )

  // 恢复晴空（别把状态留在别的主题 —— 验证脚本应可重复运行）
  await sevalRaw(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '晴空');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))

  // ── 界面字号（plan7 批 F3）：四档选择 → 根元素 font-size 变化 + 落盘载荷带档位 ──
  // 实现口径：--fs-* 已是 rem 基，根字号一改全站跟着动；标准档 100% 必须与旧的绝对像素逐像素一致
  {
    const fontRead = await sevalRaw(`
      (() => {
        const group = document.querySelector('[role="radiogroup"][aria-label="界面字号"]');
        const items = group ? Array.from(group.querySelectorAll('.choice-item')) : [];
        return {
          count: items.length,
          names: items.map((b) => b.querySelector('.choice-name')?.textContent?.trim() ?? ''),
          checked: group?.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null,
          rootFontSize: document.documentElement.style.fontSize || '(inline 未设置)'
        };
      })()
    `)
    checkTrue('「外观」有字号四档（小/标准/大/特大），默认选中标准档',
      fontRead.count === 4 && fontRead.names.join(',') === '小,标准,大,特大' && fontRead.checked === '标准',
      fontRead)
    checkTrue('标准档根元素 font-size 为 100%（rem 换算逐像素复刻旧版的前提）',
      fontRead.rootFontSize === '100%', fontRead.rootFontSize)

    await sevalRaw(`
      (() => {
        const group = document.querySelector('[role="radiogroup"][aria-label="界面字号"]');
        const btn = group && Array.from(group.querySelectorAll('.choice-item'))
          .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '特大');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const fontXl = await sevalRaw(`
      (() => ({
        rootFontSize: document.documentElement.style.fontSize || '(inline 未设置)',
        checked: document.querySelector('[role="radiogroup"][aria-label="界面字号"] .choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null,
        bodyPx: getComputedStyle(document.body).fontSize
      }))()
    `)
    checkTrue('点「特大」：根元素变 125%，正文字号从 14px 跟到 17.5px（rem token 全站联动）',
      fontXl.rootFontSize === '125%' && fontXl.checked === '特大' && fontXl.bodyPx === '17.5px',
      fontXl)
    checkTrue('字号档落盘：ui-prefs:set 载荷带 fontScale=xl（不是只改界面）',
      uiPrefsSetCalls.length >= 1 && uiPrefsSetCalls[uiPrefsSetCalls.length - 1].fontScale === 'xl',
      uiPrefsSetCalls[uiPrefsSetCalls.length - 1])

    // 还原标准档（可重复运行）
    await sevalRaw(`
      (() => {
        const group = document.querySelector('[role="radiogroup"][aria-label="界面字号"]');
        const btn = group && Array.from(group.querySelectorAll('.choice-item'))
          .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '标准');
        if (btn) btn.click();
        return !!btn;
      })()
    `)
    await new Promise((r) => setTimeout(r, 500))
  }

  // ── 界面字体（plan7 批 F3）：fonts:list 出下拉框，选中写 --font-ui 且落盘；空串 = 恢复默认栈 ──
  {
    const fontSel = await sevalRaw(`
      (() => {
        const label = Array.from(document.querySelectorAll('.settings-body label'))
          .find((l) => l.textContent.trim().startsWith('字体'));
        const sel = label ? label.querySelector('select') : null;
        return {
          hasSelect: !!sel,
          optionCount: sel ? sel.options.length : 0,
          firstOption: sel && sel.options[0] ? sel.options[0].textContent.trim() : null
        };
      })()
    `)
    checkTrue('字体枚举来自主进程：下拉框存在，含默认项 + 桩里 4 个系统字体',
      fontSel.hasSelect && fontSel.optionCount === 5 && (fontSel.firstOption ?? '').indexOf('默认') === 0,
      fontSel)

    await sevalRaw(`
      (() => {
        const label = Array.from(document.querySelectorAll('.settings-body label'))
          .find((l) => l.textContent.trim().startsWith('字体'));
        const sel = label ? label.querySelector('select') : null;
        if (!sel) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'Microsoft YaHei');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const fontApplied = await sevalRaw(`
      (() => ({
        fontUi: document.documentElement.style.getPropertyValue('--font-ui').trim(),
        value: document.querySelector('.settings-body select')
          ? document.querySelector('.settings-body select').value
          : null
      }))()
    `)
    checkTrue('选字体后 --font-ui 写上（选中字体打头 + 回退栈跟随），ui-prefs:set 载荷带 uiFont',
      fontApplied.fontUi.indexOf("'Microsoft YaHei'") === 0 &&
        fontApplied.fontUi.indexOf('Segoe UI') > 0 &&
        uiPrefsSetCalls[uiPrefsSetCalls.length - 1].uiFont === 'Microsoft YaHei',
      fontApplied)

    await sevalRaw(`
      (() => {
        const sel = document.querySelector('.settings-body select');
        if (!sel) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, '');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const fontReset = await sevalRaw(`
      document.documentElement.style.getPropertyValue('--font-ui').trim()
    `)
    checkTrue('选回「默认」：--font-ui 被移除（空串是恢复默认栈，不是往 style 里写空值）',
      fontReset === '', fontReset)
  }

  // CSS 是否真的生效（CSP 若拦掉样式表，界面会退化成裸 HTML —— 用计算样式判定）
  const cssCheck = await sevalRaw(`
    (() => {
      const sheets = document.styleSheets.length;
      const view = document.querySelector('.settings-view');
      const nav = document.querySelector('.settings-nav');
      const body = document.querySelector('.settings-body');
      const cs = view ? getComputedStyle(view) : null;
      const ns = nav ? getComputedStyle(nav) : null;
      const bs = body ? getComputedStyle(body) : null;
      return {
        sheets,
        // 设置页改两栏后，用这几个值判定样式表真生效（裸 HTML 下会退回默认值）
        display: cs ? cs.display : null, // 期望 flex
        navWidth: ns ? ns.width : null, // 期望 196px
        bodyPadding: bs ? bs.paddingTop : null, // 期望 24px
        scrollable: cs ? cs.overflowY : null // 期望 hidden（滚动交给右栏）
      };
    })()
  `)

  // CSP 是否真的在拦：主动注入内联脚本探针（“零违规”只说明没打坏东西；script-src 'self' 下注入的赋值不应执行）
  const cspProbe = await sevalRaw(`
    new Promise((resolve) => {
      window.__cspProbe = false;
      const s = document.createElement('script');
      s.textContent = 'window.__cspProbe = true';
      document.head.appendChild(s);
      setTimeout(() => resolve({ inlineScriptExecuted: window.__cspProbe }), 80);
    })
  `)

  // ── 设置窗口的生命周期：Esc 真能关掉 / 齿轮能再开出来 / 连点两次不叠窗（幂等）──
  // 这三条是独立窗口形态的核心交互，缺一条用户就会遇到"关不掉""开出两个一模一样的设置窗口"。
  // （自绘 × 删除后，渲染端的关窗出口是 Esc —— 就测它，别的都是主进程/OS 层的事）
  {
    const beforeClose = BrowserWindow.getAllWindows().length
    await sevalRaw(
      `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`
    )
    // 等窗口真的销毁（close 是异步的，立刻查会假绿）
    let gone = false
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 150))
      if (!getSettingsWin()) {
        gone = true
        break
      }
    }
    checkTrue(
      '设置窗口 **Esc 真能关掉**（关完窗口数回落，不是只隐藏）',
      gone === true && BrowserWindow.getAllWindows().length < beforeClose,
      { before: beforeClose, after: BrowserWindow.getAllWindows().length, gone }
    )

    // 再开一次：证明关掉之后齿轮还能重新开出来（不是一次性）
    const reopened = await openSettingsWin()
    checkTrue('关掉后点齿轮**还能再开出来**（不是一次性窗口）', reopened !== null, {
      opened: !!reopened
    })

    // 幂等：再点一次齿轮，不该叠出第二个设置窗口
    await win.webContents.executeJavaScript(`
      (() => { document.querySelector('.gear-btn')?.click(); return true; })()
    `)
    await new Promise((r) => setTimeout(r, 900))
    const otherWins = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed())
    checkTrue('连点两次齿轮**不叠窗**（幂等：已开则聚焦，只保留一个设置窗口）', otherWins.length === 1, {
      settingsWindowCount: otherWins.length
    })
  }

  console.log('TEXT_CHECK=' + JSON.stringify(textCheck))
  console.log('WIDE=' + JSON.stringify(m1))
  console.log('NARROW=' + JSON.stringify(m2))
  console.log('SETTINGS=' + JSON.stringify(m3))
  console.log('CHANGES_BEFORE=' + JSON.stringify(beforeRollback))
  console.log('CONFIRM_STEP=' + JSON.stringify(confirmStep))
  console.log('ROLLBACK_NOTICE=' + JSON.stringify(rollbackNotice))
  console.log('DIFF_APP=' + JSON.stringify(diffApp))
  console.log('DIFF_NOTES=' + JSON.stringify(diffNotes))
  console.log('DIFF_NEW=' + JSON.stringify(diffNew))
  console.log('DIFF_HUGE=' + JSON.stringify(diffHuge))
  console.log('REVERT_UI=' + JSON.stringify(revertUi))
  console.log('REVERT_CALLS=' + JSON.stringify(revertCalls))
  console.log('DIFF_AFTER_REVERT=' + JSON.stringify(diffAfterRevert))
  console.log('CONFIRM_DIALOG=' + JSON.stringify(confirmShown))
  console.log('CONFIRM_RESPONSES=' + JSON.stringify({ sent: confirmResponses, ...confirmClosed }))
  console.log('SPLITTER_BEFORE=' + JSON.stringify(beforeDrag))
  console.log('SPLITTER_DURING=' + JSON.stringify(duringDrag))
  console.log('SPLITTER_AFTER=' + JSON.stringify(afterDrag))
  console.log('EXPLORER_ROOT=' + JSON.stringify(explorerRoot))
  console.log('EXPLORER_EXPANDED=' + JSON.stringify(afterExpand))
  console.log('EXPLORER_PREVIEW=' + JSON.stringify(previewState))
  console.log('EX_MENU_FILE=' + JSON.stringify(exMenuFile))
  console.log('EX_RENAME=' + JSON.stringify(exRename))
  console.log('EX_ESC=' + JSON.stringify(exEsc))
  console.log('EX_MENU_ROOT=' + JSON.stringify(exMenuRoot))
  console.log('EX_CREATE=' + JSON.stringify(exCreate))
  console.log('EX_DRAGOVER=' + JSON.stringify(exDragOver))
  console.log('EX_DROP=' + JSON.stringify(exDropState))
  console.log('EX_TOOLS=' + JSON.stringify(exTools))
  console.log('EX_NEW_TARGET=' + JSON.stringify({ title: exTargetTitle, notice: exNewInDir }))
  console.log('EX_MD_PREVIEW=' + JSON.stringify(exMdPreview))
  console.log('EX_OP_LOG=' + JSON.stringify(fsOpLog))
  console.log('TASKS_PANEL=' + JSON.stringify(tasksState))
  console.log('NEWTASK_CENTER=' + JSON.stringify(centerCheck))
  console.log('CSS=' + JSON.stringify(cssCheck))
  console.log('CSP_VIOLATIONS=' + JSON.stringify(cspViolations))
  console.log('CSP_PROBE=' + JSON.stringify(cspProbe))

  // ── 工作台多栏几何（plan9 W3）─────────────────────────────────────────
  const wbGeom = await win.webContents.executeJavaScript(`
    (() => {
      const dock = document.querySelector('.dock');
      if (!dock) return { open: false };
      const row = document.querySelector('.wb-row');
      const panes = Array.from(document.querySelectorAll('.pane'));
      // 注意类名是 .wb-divider（W5 把 .wb-gap 换成可拖拽分隔条）—— 查不存在的类名不报错，只会静默算出间隙(0) 而假失败
      const gaps = Array.from(document.querySelectorAll('.wb-divider'));
      const widths = panes.map((p) => Math.round(p.getBoundingClientRect().width));
      const gapW = gaps.reduce((a, g) => a + Math.round(g.getBoundingClientRect().width), 0);
      const sprawl = widths.reduce((a, b) => a + b, 0) + gapW;
      const rowW = row ? Math.round(row.getBoundingClientRect().width) : -1;
      return {
        open: true,
        paneCount: panes.length,
        widths,
        tabs: Array.from(document.querySelectorAll('.pane-tab-name')).map((e) => e.textContent.trim()),
        activeTab: document.querySelector('.pane-tab.on .pane-tab-name')?.textContent.trim() ?? null,
        rowW,
        sprawl,
        // 关键：栏宽之和 + 间隙必须正好等于行可用宽（PANE_GAP 没算漏、也没被 overflow 悄悄裁掉）
        exact: sprawl === rowW,
        // 工作台标题栏已按验收反馈去掉：开面板的 ＋ 在**页签条**上，收起交给顶栏开关
        hasAdd: !!document.querySelector('.pane-add'),
        headerGone:
          !document.querySelector('.dock-head') &&
          !document.querySelector('.wb-add') &&
          !document.querySelector('.dock-close')
      };
    })()
  `)
  console.log('WB_GEOM=' + JSON.stringify(wbGeom))

  // 折叠 / 展开走一遍：验证「折叠 = 藏标题与页签条、内容占满、**宽度不变**」
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.pane-btn[title*="折叠"]');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 450))
  const wbFolded = await win.webContents.executeJavaScript(`
    (() => {
      const pane = document.querySelector('.pane');
      const body = pane ? pane.querySelector('.dock-body') : null;
      return {
        // ⚠️ 必须限定在第一栏内查：全局 querySelector('.pane-head') 会查到第二栏的头，“折叠了没”永远显示没折叠
        hasHead: !!(pane && pane.querySelector('.pane-head')),
        hasTabs: !!(pane && pane.querySelector('.pane-tabs')),
        hasBody: !!body,
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0,
        width: pane ? Math.round(pane.getBoundingClientRect().width) : 0,
        hasUnfold: !!(pane && pane.querySelector('.pane-unfold'))
      };
    })()
  `)
  console.log('WB_FOLDED=' + JSON.stringify(wbFolded))

  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.pane-unfold');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 450))
  const wbUnfolded = await win.webContents.executeJavaScript(`
    (() => {
      const pane = document.querySelector('.pane');
      return {
        hasHead: !!(pane && pane.querySelector('.pane-head')),
        hasTabs: !!(pane && pane.querySelector('.pane-tabs'))
      };
    })()
  `)
  console.log('WB_UNFOLDED=' + JSON.stringify(wbUnfolded))

  // —— 分栏：右键页签（常驻的「＋ 新建一栏」已随工作台标题栏一起去掉）——
  const beforeSplit = await win.webContents.executeJavaScript(`
    (() => ({
      panes: document.querySelectorAll('.pane').length,
      tabs: document.querySelectorAll('.pane-tab').length
    }))()
  `)
  const splitOpened = await win.webContents.executeJavaScript(`
    (() => {
      const tab = document.querySelector('.pane-tab');
      if (!tab) return false;
      const r = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5)
      }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 450))
  const openedSecond = await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.wb-pick'))
        .find((x) => x.textContent.trim() === '在右侧分栏');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 1100))
  const wbTwo = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('.wb-row');
      const panes = Array.from(document.querySelectorAll('.pane'));
      const gaps = Array.from(document.querySelectorAll('.wb-divider'));
      const widths = panes.map((p) => Math.round(p.getBoundingClientRect().width));
      const gapW = gaps.reduce((a, g) => a + Math.round(g.getBoundingClientRect().width), 0);
      const sprawl = widths.reduce((a, b) => a + b, 0) + gapW;
      const rowW = row ? Math.round(row.getBoundingClientRect().width) : -1;
      return {
        paneCount: panes.length,
        widths,
        rowW,
        sprawl,
        exact: sprawl === rowW,
        // 栏数多到放不下时进入溢出模式（横向滚动）—— 此时 sprawl 大于 rowW 是设计好的降级，不是被裁掉
        overflow: !!row && row.classList.contains('wb-overflow'),
        // 新栏里装的是什么（证明各栏互相独立，不是同一份内容渲染两遍）；用“第一栏/最后一栏”而不是硬编码 pane0/pane1
        firstHasExplorer: !!panes[0] && !!panes[0].querySelector('.ex-panel'),
        lastHasExplorer: !!panes[panes.length - 1] && !!panes[panes.length - 1].querySelector('.ex-panel'),
        firstTabs: panes[0] ? panes[0].querySelectorAll('.pane-tab').length : 0,
        lastTabs: panes[panes.length - 1] ? panes[panes.length - 1].querySelectorAll('.pane-tab').length : 0,
        // 全工作台页签总数 —— 用来验「分栏是**挪**不是复制」
        allTabs: document.querySelectorAll('.pane-tab').length,
        // 窄栏时 ＋ 会不会被页签条滚走 —— 数字全绿也看不出来，必须量它是否落在栏的边界内
        addInsidePane: panes.map((p) => {
          const add = p.querySelector('.pane-add');
          if (!add) return false;
          const pr = p.getBoundingClientRect();
          const ar = add.getBoundingClientRect();
          return ar.width > 0 && ar.right <= pr.right + 0.5 && ar.left >= pr.left - 0.5;
        })
      };
    })()
  `)
  console.log('WB_TWO_PANE=' + JSON.stringify(wbTwo))

  const shotWb = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-workbench.png'), shotWb.toPNG())

  // —— 三栏塞进 359px 是设计好的降级（每栏退到下限 120 → 横向滚动）：必须被断言，否则分不清“溢出”与“被裁掉” ——
  const wbOverflow = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('.wb-row');
      const panes = Array.from(document.querySelectorAll('.pane'));
      const widths = panes.map((p) => Math.round(p.getBoundingClientRect().width));
      return {
        paneCount: panes.length,
        widths,
        allAtAbsMin: widths.length > 0 && widths.every((w) => w === 120),
        scrollable: row ? getComputedStyle(row).overflowX : null
      };
    })()
  `)
  console.log('WB_OVERFLOW=' + JSON.stringify(wbOverflow))

  // —— 页签栏滚轮横滚（plan42）：三栏最小宽下页签条必然溢出，正好做真渲染验证 ——
  // 三条件（plan42 §3.2 风险 6）：① 滑条不可见 ② 滚轮有效（scrollLeft 真的变）③ 触控板横划路径未被夺走。
  // ② 是本条的主角：只改 scrollLeft、零 React 渲染 —— 加监听却绑不上时（如 effect 空依赖踩条件渲染）
  //    滑条又已隐藏，就会出现"双重失效"，比不改还糟；故必须有断言看着。
  const wbWheel = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('.pane-tabs-scroll');
      if (!el) return { found: false };
      if (el.scrollWidth <= el.clientWidth) return { found: true, overflowed: false };
      const fire = (dx, dy) => {
        el.scrollLeft = 0;
        const ev = new WheelEvent('wheel', {
          deltaX: dx, deltaY: dy, bubbles: true, cancelable: true
        });
        el.dispatchEvent(ev);
        return { left: Math.round(el.scrollLeft), prevented: ev.defaultPrevented };
      };
      const vertical = fire(0, 120);
      const horizontal = fire(120, 0);
      const zeroDelta = fire(0, 0);
      // 横向滑条若占位，offsetHeight 会比 clientHeight 大（本元素无 border，故差值即滑条高度）
      const scrollbarH = el.offsetHeight - el.clientHeight;
      el.scrollLeft = 0;
      return { found: true, overflowed: true, vertical, horizontal, zeroDelta, scrollbarH };
    })()
  `)
  console.log('WB_WHEEL=' + JSON.stringify(wbWheel))

  // 关掉最后一栏回到 2 栏（顺便真走一遍关栏）—— 之后才做拖拽：2 栏在 359px 下拖得动，3 栏本来就拖不动
  await win.webContents.executeJavaScript(`
    (() => {
      const panes = Array.from(document.querySelectorAll('.pane'));
      const last = panes[panes.length - 1];
      const btn = last ? last.querySelector('.pane-btn[title*="关闭本栏"]') : null;
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))
  const afterClosePane = await win.webContents.executeJavaScript(`
    (() => ({
      paneCount: document.querySelectorAll('.pane').length,
      exact: (() => {
        const row = document.querySelector('.wb-row');
        const panes = Array.from(document.querySelectorAll('.pane'));
        const gaps = Array.from(document.querySelectorAll('.wb-divider'));
        const sprawl = panes.reduce((a, p) => a + Math.round(p.getBoundingClientRect().width), 0)
          + gaps.reduce((a, g) => a + Math.round(g.getBoundingClientRect().width), 0);
        return sprawl === (row ? Math.round(row.getBoundingClientRect().width) : -1);
      })()
    }))()
  `)
  console.log('WB_AFTER_CLOSE=' + JSON.stringify(afterClosePane))

  // —— 拖拽（调宽 + 换位）：结构先验 —— 分隔条数量必须 = 栏数 − 1（宽度数组也只存 n−1 个）——
  const dividerInfo = await win.webContents.executeJavaScript(`
    (() => {
      const ds = Array.from(document.querySelectorAll('.wb-divider'));
      return {
        count: ds.length,
        panes: document.querySelectorAll('.pane').length,
        cursor: ds[0] ? getComputedStyle(ds[0]).cursor : null,
        title: ds[0] ? ds[0].title : null
      };
    })()
  `)
  console.log('WB_DIVIDER=' + JSON.stringify(dividerInfo))

  // 调宽：合成 PointerEvent 真拖一次（监听挂手柄自身，故合成事件可靠；老坑是 mousemove 会被真实鼠标位置覆盖）。先清空写盘计数。
  wbSetCalls.length = 0
  const dragResult = await win.webContents.executeJavaScript(`
    (() => {
      const d = document.querySelector('.wb-divider');
      const panes = Array.from(document.querySelectorAll('.pane'));
      if (!d || panes.length < 2) return { ok: false, reason: 'no-divider-or-single-pane' };
      const before = panes.map((p) => Math.round(p.getBoundingClientRect().width));
      const r = d.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const mk = (type, x) =>
        new PointerEvent(type, {
          pointerId: 1, isPrimary: true, pointerType: 'mouse',
          bubbles: true, cancelable: true, clientX: x, clientY: cy
        });
      d.dispatchEvent(mk('pointerdown', cx));
      // **连拖三次** —— 只为把"拖拽中不写盘"验出来：若实现每帧落盘，这里会写 3 次以上
      d.dispatchEvent(mk('pointermove', cx + 8));
      d.dispatchEvent(mk('pointermove', cx + 16));
      d.dispatchEvent(mk('pointermove', cx + 25));
      d.dispatchEvent(mk('pointerup', cx + 25));
      return { ok: true, before };
    })()
  `)
  // 等 debounce（300ms）后数写盘次数：⚠️ 轮询等它发生而不是睡定值（机器一忙定时器会推迟 → 假红），本意是“3 次拖动合并成 1 次写”
  const persistDeadline = Date.now() + 2000
  while (wbSetCalls.length === 0 && Date.now() < persistDeadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const persistCalls = wbSetCalls.length
  const wbAfterDrag = await win.webContents.executeJavaScript(`
    (() => {
      const panes = Array.from(document.querySelectorAll('.pane'));
      const gaps = Array.from(document.querySelectorAll('.wb-divider'));
      const row = document.querySelector('.wb-row');
      const widths = panes.map((p) => Math.round(p.getBoundingClientRect().width));
      const gapW = gaps.reduce((a, g) => a + Math.round(g.getBoundingClientRect().width), 0);
      const sprawl = widths.reduce((a, b) => a + b, 0) + gapW;
      const rowW = row ? Math.round(row.getBoundingClientRect().width) : -1;
      return { widths, sprawl, rowW, exact: sprawl === rowW };
    })()
  `)
  console.log('WB_DRAG=' + JSON.stringify({ before: dragResult.before, after: wbAfterDrag, persistCalls }))

  // 换位：合成 HTML5 DnD（dragstart/dragover/drop）；拖拽下标走 dataTransfer，同步派发也拿得到
  const orderOf = `
    (() => Array.from(document.querySelectorAll('.pane'))
      .map((p) => p.querySelector('.pane-tab-name')?.textContent?.trim() ?? ''))()
  `
  const beforeOrder = await win.webContents.executeJavaScript(orderOf)
  const reorder = await win.webContents.executeJavaScript(`
    (() => {
      const heads = Array.from(document.querySelectorAll('.pane-head'));
      if (heads.length < 2) return { ok: false, reason: 'less-than-2-panes' };
      const dt = new DataTransfer();
      const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      heads[0].dispatchEvent(mk('dragstart'));
      heads[1].dispatchEvent(mk('dragover'));
      heads[1].dispatchEvent(mk('drop'));
      heads[0].dispatchEvent(mk('dragend'));
      return { ok: true };
    })()
  `)
  await new Promise((r) => setTimeout(r, 550))
  const afterOrder = await win.webContents.executeJavaScript(orderOf)
  console.log('WB_REORDER=' + JSON.stringify({ before: beforeOrder, after: afterOrder }))

  checkTrue('思考块高度可见（此前被 flex 压成 4px 的回归）', processVisible.reasoningHeight > 20, processVisible.reasoningHeight)
  checkTrue(
    'plan36：过程块长在助手消息内（全局过程块已退役）',
    processVisible.segmentsInsideMsg === true,
    processVisible.segmentOrder
  )
  checkTrue(
    'plan36：消息内分段顺序 = 到达顺序（正文 → tool → thinking）',
    JSON.stringify(processVisible.segmentOrder) ===
      JSON.stringify(['msg-content', 'tool-log', 'tool-log', 'reasoning-block']),
    processVisible.segmentOrder
  )
  checkTrue(
    'plan44 S2：mcp 工具卡带来源徽标（MCP·windows-mcp），名字只留本名，坐标明文回显',
    processVisible.mcpBadge !== null &&
      processVisible.mcpBadge.badge === 'MCP·windows-mcp' &&
      processVisible.mcpBadge.name === 'Click' &&
      processVisible.mcpBadge.desc === 'x=1024 y=768',
    processVisible.mcpBadge
  )
  checkTrue(
    '思考块有实际内容（不是空壳）',
    typeof processVisible.reasoningText === 'string' && processVisible.reasoningText.length > 0
  )
  checkTrue(
    '工具卡片带上了入参摘要（不是干巴巴的"执行中…"）',
    typeof processVisible.toolDesc === 'string' && processVisible.toolDesc.length > 0,
    processVisible.toolDesc
  )
  check('设置页两栏布局生效', cssCheck.display, 'flex')
  check('设置页左导航宽度', cssCheck.navWidth, '196px')
  check('设置页右栏不滚动（滚动交给内容区）', cssCheck.scrollable, 'hidden')
  check('CSP 仍拦住内联脚本（安全策略没被新代码打穿）', cspProbe.inlineScriptExecuted, false)

  // —— plan9 W3：多栏工作台 ——
  checkTrue('工作台处于展开态（.dock 在）', wbGeom.open === true)
  checkTrue('栏宽之和 + 间隙**正好等于**可用宽（PANE_GAP 没算漏、没被裁）', wbGeom.exact === true, {
    widths: wbGeom.widths,
    sprawl: wbGeom.sprawl,
    rowW: wbGeom.rowW
  })
  checkTrue(
    '至少一栏、且栏内挂着页签',
    wbGeom.paneCount >= 1 && wbGeom.tabs.length >= 1,
    { paneCount: wbGeom.paneCount, tabs: wbGeom.tabs }
  )
  checkTrue('开面板的 ＋ 在**栏内页签条**上', wbGeom.hasAdd === true)
  checkTrue(
    '工作台标题栏已去掉（用户验收：「那一栏也是多余的」）',
    wbGeom.headerGone === true,
    { dockHead: !!wbGeom.dockHead }
  )
  checkTrue(
    '折叠后标题栏与页签条隐藏、内容区还在',
    wbFolded.hasHead === false && wbFolded.hasTabs === false && wbFolded.hasBody === true,
    wbFolded
  )
  checkTrue('折叠后内容区仍有高度（不是被压没）', wbFolded.bodyH > 100, wbFolded.bodyH)
  checkTrue('折叠后留了展开按钮（否则用户没法还原）', wbFolded.hasUnfold === true)
  check('折叠**不改变栏宽**', wbFolded.width, wbGeom.widths ? wbGeom.widths[0] : -1)
  checkTrue('展开回来标题栏与页签条都回来了', wbUnfolded.hasHead && wbUnfolded.hasTabs, wbUnfolded)

  // —— plan9 W6：文件预览独立成栏 ——
  check('点文件后工作台是**两栏**（资源管理器 + 预览栏）', previewState.paneCount, 2)
  checkTrue('预览开在**自己的一栏**里（不是塞在资源管理器那一栏）', previewState.isOwnPane === true, previewState)
  checkTrue(
    '预览内容**看得见**（高度 > 20，不是塌成 0）',
    !!previewState.preBox && previewState.preBox.h > 20,
    previewState.preBox
  )
  checkTrue('预览读到的确实是那个文件', previewState.hasFileContent === true, previewState.firstLine)
  checkTrue(
    'Markdown 走富文本渲染（有 .fp-md、没有 .fp-pre）',
    exMdPreview.renderedMarkdown === true && exMdPreview.rawPre === false,
    exMdPreview
  )
  checkTrue(
    '点第二个文件**复用同一栏**（同一栏多页签，不是每点一个就多一栏）',
    exMdPreview.paneCount === previewState.paneCount && exMdPreview.tabs.length === 2,
    exMdPreview
  )
  checkTrue(
    '旧的"压在文件树底下"的预览已**彻底退役**（无 .ex-preview、无拖高手柄）',
    exMdPreview.oldPreviewGone === true && exMdPreview.hasOldResizeHandle === false,
    exMdPreview
  )

  // —— plan9 形态修订：分栏改由**右键页签**触发 ——
  checkTrue(
    '**右键页签**能分栏（多栏的唯一入口，不再是默认形态）',
    splitOpened !== false && openedSecond === true,
    { openedSecond }
  )
  check('右键分栏后栏数 **+1**', wbTwo.paneCount, beforeSplit.panes + 1)
  checkTrue(
    '分栏是**挪**不是复制（全工作台页签总数不变）',
    wbTwo.allTabs === beforeSplit.tabs,
    { before: beforeSplit.tabs, after: wbTwo.allTabs }
  )
  checkTrue(
    '各栏宽度 + 间隙满足「**放得下就正好、放不下就溢出**」这条不变量',
    wbTwo.overflow === true ? wbTwo.sprawl >= wbTwo.rowW : wbTwo.sprawl === wbTwo.rowW,
    { widths: wbTwo.widths, sprawl: wbTwo.sprawl, rowW: wbTwo.rowW, overflow: wbTwo.overflow }
  )
  checkTrue('原栏仍在（分栏不把源栏清空）', wbTwo.firstTabs >= 1, wbTwo.firstTabs)
  checkTrue(
    '窄栏里 ＋ 仍在栏内可见（没被页签条横向滚动带走）',
    Array.isArray(wbTwo.addInsidePane) && wbTwo.addInsidePane.every((v) => v === true),
    wbTwo.addInsidePane
  )

  // —— plan9 W5：拖拽 ——
  checkTrue(
    '三栏塞不进窄工作台时**退到绝对下限并允许横向滚动**（设计好的降级，不是被裁）',
    wbOverflow.allAtAbsMin === true && wbOverflow.scrollable === 'auto',
    wbOverflow
  )

  // —— plan42：页签栏滚轮横滚（三条件，见 §3.2 风险 6）——
  checkTrue(
    '页签栏滚轮 · 前置：页签条确实溢出（否则本组测不出东西）',
    wbWheel.found === true && wbWheel.overflowed === true,
    wbWheel
  )
  checkTrue(
    '页签栏滚轮 · **纵向滚轮转为横滚**（deltaY → scrollLeft 真的变）',
    wbWheel.vertical.left > 0,
    wbWheel.vertical
  )
  checkTrue(
    '页签栏滚轮 · 事件被 preventDefault（不冒泡给父容器造成双重滚动）',
    wbWheel.vertical.prevented === true,
    wbWheel.vertical
  )
  checkTrue(
    '页签栏滚轮 · **触控板横划路径生效**（deltaX 生效，未被夺走）',
    wbWheel.horizontal.left > 0,
    wbWheel.horizontal
  )
  checkTrue(
    '页签栏滚轮 · 零 delta 不动（未溢出/空手势不误吞）',
    wbWheel.zeroDelta.left === 0,
    wbWheel.zeroDelta
  )
  checkTrue(
    '页签栏滚轮 · **原生滑条已隐藏**（不占高度，否则 0 会露馅）',
    wbWheel.scrollbarH === 0,
    wbWheel.scrollbarH
  )
  check('关掉一栏后回到 2 栏', afterClosePane.paneCount, 2)
  checkTrue('2 栏重新放得下 → 几何恢复精确', afterClosePane.exact === true)
  check('分隔条数量 = 栏数 − 1（与宽度数组一一对应）', dividerInfo.count, dividerInfo.panes - 1)
  check('分隔条光标是 col-resize', dividerInfo.cursor, 'col-resize')
  checkTrue('**拖分隔条真的改变了栏宽**（往右拖 → 第 0 栏变宽）',
    dragResult.ok === true && wbAfterDrag.widths[0] > dragResult.before[0],
    { before: dragResult.before, after: wbAfterDrag.widths })
  checkTrue('拖完之后几何仍**精确**（没有溢出、没有被裁）', wbAfterDrag.exact === true, wbAfterDrag)
  check('拖了 3 次只落盘 **1** 次（拖拽中不写盘、松手才合并写）—— 提交点表', persistCalls, 1)
  checkTrue('**整栏换位真的生效**（两栏内容对调）',
    reorder.ok === true && afterOrder[0] === beforeOrder[1] && afterOrder[1] === beforeOrder[0],
    { before: beforeOrder, after: afterOrder })

  checkTrue('图片预览：<img> 在', imagePreview.hasImg === true)
  checkTrue(
    '图片**真的解码出来了**（`naturalWidth > 0` —— DOM 里有 <img> 不等于图显示出来了）',
    imagePreview.naturalWidth > 0 && imagePreview.naturalHeight > 0,
    { w: imagePreview.naturalWidth, h: imagePreview.naturalHeight }
  )
  check('图片走 img 标签渲染（**安全红线**：不能用 object / iframe）', imagePreview.tag, 'IMG')
  checkTrue('图片来源是 data:image/（走的是我们自己的读取通道）', imagePreview.isDataUrl === true)
  checkTrue(
    '图在画面上真占了地方（不是 0 尺寸）',
    imagePreview.boxW > 0 && imagePreview.boxH > 0,
    { w: imagePreview.boxW, h: imagePreview.boxH }
  )
  checkTrue('**超大图不给数据**（不渲染 img，避免把几十 MB 塞进 IPC）', tooLarge.hasImg === false)
  checkTrue('超大图有明确提示（不是一片空白）', tooLarge.notice.length > 0, tooLarge.notice)
  checkTrue(
    '未知二进制**降级为十六进制转储**（不再是「暂不支持预览」）',
    hexPreview.hasHex === true,
    hexPreview.firstLine
  )
  checkTrue('转储内容能认出文件头（ELF 魔数）', hexPreview.hasElfMagic === true)

  // —— Office 内嵌预览（2026-09-14）：docx/xlsx 沙箱 iframe、pptx 系统打开 ——
  checkTrue(
    'docx：点开是**沙箱 iframe**（不是十六进制，也不是把文档 HTML 灌进主文档）',
    docxPreview.clicked === true && docxPreview.hasFrame === true && docxPreview.srcOk === true,
    docxPreview
  )
  checkTrue(
    'docx：iframe 的 sandbox 是**空值**（与 HTML 预览同一道锁；内容来自用户文件）',
    docxPreview.sandboxEmpty === true
  )
  checkTrue(
    'docx：给「用系统程序打开」出口（内嵌是便利，不是唯一出路）',
    docxPreview.hasOpenSys === true
  )
  checkTrue(
    'docx：iframe 铺满栏高 ≥75%（2026-09-15 高度链断裂修复的几何判据）',
    docxPreview.fillsPane === true,
    { fillRatio: docxPreview.fillRatio }
  )
  checkTrue(
    'xlsx：sheet 按钮组在（多 sheet 可切，不是只看第一个）',
    sheetPreview.clicked === true && sheetPreview.tabCount === 2 &&
      sheetPreview.names.join(',') === '一月,二月',
    { names: sheetPreview.names, tabCount: sheetPreview.tabCount }
  )
  checkTrue(
    'xlsx：点「二月」后 iframe 真的换了 URL（不是按钮摆设）',
    sheetPreview.srcBefore !== sheetAfter.srcAfter &&
      sheetAfter.srcAfter === `jsl-preview://mem/${'c'.repeat(32)}`,
    { before: sheetPreview.srcBefore, after: sheetAfter.srcAfter }
  )
  checkTrue(
    'pptx：不支持内嵌 → 十六进制头（PK 魔数认得出它是 OOXML 容器）',
    pptxPreview.clicked === true && pptxPreview.hasHex === true && pptxPreview.hasPkmagic === true,
    pptxPreview
  )
  checkTrue(
    'pptx：**没有**装样子的内嵌 iframe + 「用系统程序打开」出口在',
    pptxPreview.noOfficeFrame === true && pptxPreview.hasOpenSys === true
  )

  checkTrue('前置状态：点开了桩 HTML，且沙箱 iframe 在',
    htmlRender.hasFrame === true && clickHtmlFile === true, {
      clicked: clickHtmlFile,
      hasFrame: htmlRender.hasFrame
    })
  check('iframe 的 sandbox 是**空值**（不执行脚本 / 不透明源）', htmlRender.sandbox, '')
  check('预览走的是**自定义协议**（真实 scheme 才拿得到全新策略容器）', htmlRender.srcScheme, 'jsl-preview')
  checkTrue(
    '**没有**走 srcdoc（本地 scheme 会继承父页策略 → 内联样式被砍光；这是回归守卫）',
    htmlRender.srcdoc === null,
    htmlRender.srcdoc
  )
  checkTrue('桩文件**确实带了脚本**（否则"脚本没跑"这条断言是自我安慰，等于没验）',
    HTML_STUB.includes('<script>'))
  checkTrue(
    '主进程**真的收到了预览请求**（协议这条线是通的，不是把帧晾在那儿没加载）',
    previewHits.length > 0,
    previewHits
  )
  checkTrue(
    '**HTML 真的渲染出来了，且内联样式没被父页 CSP 砍掉**（桩页整片品红；一片白 = 走错机制了）',
    htmlPixels.total > 0 && htmlPixels.magenta / Math.max(1, htmlPixels.total) > 0.5,
    { total: htmlPixels.total, magenta: htmlPixels.magenta, note: htmlPixels.note }
  )
  checkTrue(
    '**工作区的脚本一行都没跑**（红线）—— 脚本若执行会把背景改成纯红',
    htmlPixels.total > 0 && htmlPixels.red / Math.max(1, htmlPixels.total) < 0.02,
    { red: htmlPixels.red, total: htmlPixels.total }
  )
  check('「渲染 / 源码」开关默认渲染（按钮显示的是"源码"）', htmlRender.toggleText, '源码')
  checkTrue('开关**双向可用**：切到源码看到原始 markup，切回来又是沙箱预览',
    htmlToggle.clicked === true &&
      htmlToggle.afterSrc?.rawPreShown === true &&
      htmlToggle.afterSrc?.toggleText === '渲染' &&
      htmlToggle.srcHasMarkup === true &&
      htmlToggle.afterBack?.hasFrame === true &&
      htmlToggle.afterBack?.toggleText === '源码',
    htmlToggle)

  // —— ③ 文件拖进会话（**真手势**，不是合成事件）——
  checkTrue('前置状态：输入框与文件行**都在**（否则下面几条失败说明不了任何事）',
    consoleReady.hasConsole === true && consoleReady.hasRow === true, consoleReady)
  checkTrue('前置状态：文件行与输入框**看得见、点得到**（几何 + 命中测试，不是"DOM 里在"）',
    !!(dragPre.row && dragPre.row.hittable && dragPre.box && dragPre.box.hittable), dragPre)
  checkTrue('真手势通道可用（CDP 拖拽拦截）—— 不可用就必须红，不许退回合成事件装作验过',
    dragControl.gestureReady === true, dragControl)
  checkTrue('阳性对照：分栏标题**真拖得起来**（对照不绿，"行拖不动"就说明不了任何事）',
    dragControl.hasPaneHead === true && dragControl.started === true, dragControl)
  checkTrue('文件行**真拖得起来**（真手势下浏览器确实开始了拖拽）', dragStart.ok === true, dragStart)
  check('载荷用的是**自定义 MIME**（不是 text/plain），且是工作区相对路径',
    dragStart.carried, '紫水晶采购清单.txt')
  checkTrue('拖到输入框上方会有**落点高亮**', dropHighlight.highlighted === true)
  check('丢下去后输入框里出现 **1 个附件 chip**', attachState.count, 1)
  checkTrue(
    '附件就是被拖的那一个文件',
    (attachState.titles[0] ?? '').includes('紫水晶采购清单.txt'),
    attachState.titles
  )
  checkTrue('放下之后高亮收回去（不是一直亮着）', attachState.stillHighlighted === false)

  checkTrue('系统拖拽：真 File 经 `getPathForFile` 解析后确实送到了 `attach:path`',
    osDrag.attempted === true && (osDrag.payloads ?? []).length > 0, osDrag)
  checkTrue('系统拖拽送的是**绝对路径**（相对路径走不到这条分支）',
    osDrag.gotAbsolute === true, osDrag.payloads)
  checkTrue('工作区外的附件会在 chip 上**标出来**（主人有权知道上下文里混进了外面的文件）',
    (osDrag.badges ?? []).includes('工作区外'), osDrag.badges)
  checkTrue('载荷丢了会**说话**（以前是什么都不做 = 静默失败）',
    silentState.text.includes('没收到文件路径'), { ...silentCase, ...silentState })

  // ⚠️ ④ 会话回滚的断言不放在这里 —— 探针声明是 const，放前面会踩暂时性死区；断言紧跟探针之后。

  // —— ④ 会话回滚：右键一条消息 → 回到这条之前 → 可撤销 ——
  // ⚠️⚠️ 必须用真鼠标（CDP），不能用 el.click()：菜单容器挂着 document 的 mousedown 关闭监听，mousedown 早于 click
  //    → 按钮在 mousedown 那一刻就被卸载，而 el.click() 只派发 click、正好绕过这条竞态 → 断言全绿（天生为绿）。
  let rbInputReady = false
  try {
    dbg.attach('1.3')
    rbInputReady = true
  } catch (err) {
    console.log('RB_INPUT_UNAVAILABLE=' + (err && err.message ? err.message : String(err)))
  }

  const centerOf = (sel) =>
    win.webContents.executeJavaScript(
      "(() => { const el = document.querySelector('" +
        sel +
        "'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()"
    )

  const realClick = async (x, y, button) => {
    const buttons = button === 'right' ? 2 : 1
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons,
      clickCount: 1
    })
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1
    })
  }

  await win.webContents.executeJavaScript(`
    (() => {
      const item = Array.from(document.querySelectorAll('.conv-item'))
        .find((b) => (b.textContent || '').includes('打个招呼'));
      if (item) item.click();
      return !!item;
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))

  const rbPre = await win.webContents.executeJavaScript(`
    (() => ({
      msgs: document.querySelectorAll('.msg').length,
      hasChat: !!document.querySelector('.chat-view')
    }))()
  `)
  console.log('RB_PRECONDITION=' + JSON.stringify(rbPre))

  // 右键前先把消息区滚回顶部：自动滚底后第一条消息上半截会钻到 chat-head 底下，
  // centerOf 的「几何中心」命中的就是 chat-head 而不是消息 —— CDP 右键落在 head 上，
  // 菜单永远开不出来（2026-09-15 诊断实锤：hitTag=DIV.chat-head，合成派发却能开出 → 探针选点 bug）
  await win.webContents.executeJavaScript(`document.querySelector('.chat-messages')?.scrollTo(0, 0)`)
  await new Promise((r) => setTimeout(r, 250))
  const msgPos = await centerOf('.msg')
  let rbMenu = { ok: false, reason: 'no-msg-or-no-input' }
  if (rbInputReady && msgPos) {
    await realClick(msgPos.x, msgPos.y, 'right')
    // ⚠️ 不能死等固定 ms：机器高负载（连跑 build/门禁、CI）时 React 渲染菜单会超过
    //    400ms，判据齐红全是"传导伤"（回滚/撤销/大纲连带空转）。改成轮询等浮层出现，
    //    上限 2s —— 语义不变（菜单真没开照样红），只是不再把"渲染慢"误判成"功能坏"。
    let menuShown = false
    for (let i = 0; i < 20; i++) {
      menuShown = await win.webContents.executeJavaScript(`!!document.querySelector('.wb-menu')`)
      if (menuShown) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // 轮询超时 → 带一组对照证据再走：命中测试（那个坐标上最顶层元素是谁）+
    // 合成 contextmenu 派发（能开 = CDP 路由/坐标问题；不能开 = React 层问题）
    if (!menuShown) {
      rbMenu.diag = await win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('.chat-messages .msg')
          if (!el) return { noMsg: true }
          const r = el.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2)
          const cy = Math.round(r.top + r.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
          return new Promise((res) =>
            setTimeout(() => res({
              rect: { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) },
              hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 40) : null,
              syntheticOpens: !!document.querySelector('.wb-menu')
            }), 300)
          )
        })()
      `)
    }
    rbMenu = { ok: true, via: 'real-right-click', menuShown, ...(rbMenu.diag ? { diag: rbMenu.diag } : {}) }
  }
  const rbMenuState = await win.webContents.executeJavaScript(`
    (() => {
      const item = Array.from(document.querySelectorAll('.wb-menu button'))
        .find((b) => (b.textContent || '').includes('回到这条之前'));
      return { hasItem: !!item };
    })()
  `)
  console.log('RB_MENU=' + JSON.stringify({ ...rbMenu, ...rbMenuState }))

  // **真左键**点菜单项 → 回滚（这一下如果退化成 el.click() 就再也测不出那个 bug 了）
  const itemPos = await centerOf('.wb-menu button')
  let rbClicked = { ok: false, reason: 'no-menu-item-or-no-input' }
  if (rbInputReady && itemPos) {
    await realClick(itemPos.x, itemPos.y, 'left')
    rbClicked = { ok: true }
  }
  await new Promise((r) => setTimeout(r, 900))
  const rbAfter = await win.webContents.executeJavaScript(`
    (() => ({
      msgs: document.querySelectorAll('.msg').length,
      // 提示条必须**再声明一次作用域**（用户会担心"文件是不是也退了"）
      notice: (document.querySelector('.rb-bar .rb-text')?.textContent ?? '').trim(),
      hasUndo: !!Array.from(document.querySelectorAll('.rb-btn')).find((b) => (b.textContent || '').includes('撤销')),
      menuClosed: !document.querySelector('.wb-menu')
    }))()
  `)
  console.log('RB_AFTER=' + JSON.stringify({ calls: convRollbackCalls, clicked: rbClicked, ...rbAfter }))

  // 撤销 → 条数换回来（这一下用合成 click 就够了：撤销按钮没有"mousedown 把自己卸载"的问题）
  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.rb-btn')).find((x) => (x.textContent || '').includes('撤销'));
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const rbUndone = await win.webContents.executeJavaScript(`
    (() => ({
      msgs: document.querySelectorAll('.msg').length,
      noticeGone: !document.querySelector('.rb-bar')
    }))()
  `)
  console.log('RB_UNDONE=' + JSON.stringify({ calls: convUndoCalls.length, ...rbUndone }))

  // —— 会话刻度条（plan41 S1，改版自 plan7 批 D 大纲）：右缘**常驻**竖条 → 点击刻度定位 ——
  // 此刻 msgs=4（两轮问答），正是"两轮起才出条"的验证时机。判据：
  // ① 刻度条常驻可见；② 刻度数 = 用户消息数（2）；③ 点击第 1 根刻度真的往回滚（scrollTop 变小）+
  // 高亮 class 在（"跳到了哪"要看得见）。
  const railInfo = await win.webContents.executeJavaScript(`
    (() => {
      const rail = document.querySelector('.chat-outline-rail');
      if (!rail) return null;
      const r = rail.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, ticks: rail.querySelectorAll('.chat-outline-tick').length };
    })()
  `)
  // 案三（09-18 三现）：断言此前吃"撤销后是否恰好滚到底"的环境抖动——加硬前置：
  // 点击前先**主动滚到底**并回报可滚动余量；短会话（内容不满一屏）改走"跳转高亮"判据（见下）
  const outlineBefore = await win.webContents.executeJavaScript(`
    (async () => {
      const box = document.querySelector('.chat-messages');
      if (box) { box.scrollTop = box.scrollHeight; await new Promise((r) => setTimeout(r, 350)); }
      // msgs 一起输出：刻度条不在时先看这里 —— 上游（回滚/撤销链）断了会传导成刻度判据齐挂
      return {
        msgs: document.querySelectorAll('.chat-messages .msg').length,
        scrollTop: box ? Math.round(box.scrollTop) : -1,
        scrollable: box ? Math.round(box.scrollHeight - box.clientHeight) : -1
      };
    })()
  `)
  await win.webContents.executeJavaScript(`document.querySelector('.chat-outline-tick')?.click()`)
  await new Promise((r) => setTimeout(r, 900))
  const outlineAfter = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.chat-messages');
      const firstUser = document.querySelector('.chat-messages .msg-user');
      return {
        scrollTop: box ? Math.round(box.scrollTop) : -1,
        firstUserTop: firstUser ? Math.round(firstUser.getBoundingClientRect().top) : null,
        highlighted: !!document.querySelector('.msg-jump-hl')
      };
    })()
  `)
  console.log(
    'OUTLINE=' +
      JSON.stringify({ rail: railInfo, before: outlineBefore, after: outlineAfter })
  )

  // 确认框文案：会话回滚 vs 文件回滚**必须分得清**（plan10 §六 第 6 条）
  win.webContents.send('confirm:request', {
    id: 'cf-rb-1',
    kind: 'rollback-messages',
    tool: '会话回滚',
    detail: '回到第 2 条消息之前 —— 之后 2 条将从对话里隐去（可撤销）',
    agent: '打个招呼',
    where: '仅回滚对话消息',
    conversationId: 'c1'
  })
  await new Promise((r) => setTimeout(r, 500))
  const cfText = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.cf-box');
      return { shown: !!box, text: (box ? box.textContent : '') };
    })()
  `)
  console.log('CONFIRM_RB=' + JSON.stringify({ shown: cfText.shown, len: cfText.text.length }))
  // 收拾：按「拒绝」把它关掉，免得挡住后面
  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.cf-btn')).find((x) => (x.textContent || '').includes('拒绝'));
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 300))

  // ── Agent 提问卡片（带选项）─────────────────────────────────────────────
  //
  // 判据刻意**咬 IPC 载荷与几何尺寸**，不咬界面文案：
  // ① "DOM 里在" ≠ "用户看得见" → 量 getBoundingClientRect；② "卡片上写了选什么" ≠ "发下去的是选项的值 / 自填的字"
  //   （label 与 value 是两回事，界面只是视图）；③ "点一下没报错" ≠ "只发了一条回执"（重复回执会改掉已定下的结论）；
  // ④ "跳过"与"自由输入"必须**原样**到达主进程 —— 被当成脏值吞掉的话，模型那边只能干等到超时。
  const ASK1 = {
    id: 'ask-probe-1',
    question: '奶茶怎么调？',
    options: [
      { value: 'opt-1', label: '加糖' },
      { value: 'opt-2', label: '少冰', description: '冰块减半' },
      { value: 'opt-3', label: '都不要' }
    ],
    tool: 'ask_user',
    conversationId: 'c1'
  }
  const ASK2 = {
    id: 'ask-probe-2',
    question: '先做哪几件？',
    options: [
      { value: 'opt-1', label: '改文档' },
      { value: 'opt-2', label: '补测试' },
      { value: 'opt-3', label: '清理日志' }
    ],
    multiSelect: true,
    tool: 'ask_user',
    conversationId: 'c1'
  }
  const ASK3 = {
    id: 'ask-probe-3',
    question: '用哪套配色？',
    options: [
      { value: 'opt-1', label: '水墨' },
      { value: 'opt-2', label: 'classic' }
    ],
    tool: 'ask_user',
    conversationId: 'c1'
  }
  const ASK4 = {
    id: 'ask-probe-4',
    question: '这条要保留吗？',
    options: [
      { value: 'opt-1', label: '保留' },
      { value: 'opt-2', label: '删掉' }
    ],
    tool: 'ask_user',
    conversationId: 'c1'
  }

  const centerOfNth = (sel, n) =>
    win.webContents.executeJavaScript(
      "(() => { const el = document.querySelectorAll('" +
        sel +
        "')[" +
        n +
        "]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()"
    )

  /** 展开某张已答卡的折叠头（**必须独立成一次 executeJavaScript**）
   *  ⚠️ 血泪（2026-09-13）：早先把 `foldHead.click()` 和"读 DOM"写在同一个 executeJavaScript 里，
   *     点完立刻同步读 —— React 还没重渲染，`aria-expanded` 恒为 false、`.ask-done-body` 恒不存在。
   *     症状是三条"展开后…"的断言全红，**但功能本身是好的**（假红，方向反了：它冤枉了产品代码）。
   *     故这里拆成两步：本函数只负责点 + 等重渲染；读取交给下面的 readAskCardById。
   *  另：返回 `folded` 供断言核对"点之前确实是折叠的"，否则卡本来就是展开态，这一步等于没点、断言恒绿。 */
  const expandAskCard = async (id) => {
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const card = document.querySelector('.ask-card[data-ask-id="${id}"]');
        if (!card) return { clicked: false, reason: 'no-card' };
        const head = card.querySelector('.ask-fold-head');
        if (!head) return { clicked: false, reason: 'no-fold-head' };
        const before = head.getAttribute('aria-expanded') === 'true';
        if (!before) head.click();
        return { clicked: !before, reason: before ? 'already-open' : 'clicked' };
      })()
    `)
    // 等 React 提交 + 浏览器把新节点插进版面（一帧不够稳，给足 250ms）
    if (clicked.clicked) await new Promise((r) => setTimeout(r, 250))
    return clicked
  }

  /** 按 **id** 读某一张提问卡（待答 / 只读同一把尺子：只读态靠 done 字段与"按钮归零"判定）
   *  ⚠️ 已答卡**默认折叠**（2026-09-13 起）：详情（选项行 / 自填文字 / 说明）只在展开态渲染。
   *     故读展开态要先 await expandAskCard(id)**（独立一步，不能塞进这里）**，再调 readAskCardById。
   *     **不这么做而直接放宽断言（比如删掉 answerText 那几条）就等于把留痕的哨兵撤了**：
   *     将来谁把展开态弄坏，界面上"我写了什么"消失，而门禁全绿。 */
  const readAskCardById = async (id, expand = false) =>
    win.webContents.executeJavaScript(`
      (() => {
        const card = document.querySelector('.ask-card[data-ask-id="${id}"]');
        if (!card) return { shown: false };
        const foldHead = card.querySelector('.ask-fold-head');
        const wasFoldable = !!foldHead;
        // ⚠️ expand=true 时这里**只**用来兜底（正常情况下调用方已 await expandAskCard）。
        //    塞进同一次读取里是不行的：React 未提交，读到的还是折叠态。故这里显式不点，只观察。
        const rows = Array.from(card.querySelectorAll('.ask-row'));
        const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
        const composer = document.querySelector('.console-input');
        const cr = card.getBoundingClientRect();
        const skip = card.querySelector('.ask-skip');
        const submit = card.querySelector('.ask-submit');
        const free = card.querySelector('.ask-free-input');
        const picked = card.querySelectorAll('.ask-row-on');
        return {
          shown: true,
          // ⚠️ 必须回传 id：断言要验"显示的是**先来的那条**"（排队不覆盖）。
          //    探针少这个字段 → 断言去比 undefined，恒红（本批就吃了这一次假红）。
          id: card.dataset.askId ?? null,
          done: card.classList.contains('ask-done'),
          title: (card.querySelector('.ask-title') || { textContent: '' }).textContent.trim(),
          tool: (card.querySelector('.ask-tool') || { textContent: '' }).textContent.trim(),
          question: (card.querySelector('.ask-q') || { textContent: '' }).textContent.trim(),
          rowCount: rows.length,
          rowTexts: rows.map((r) => (r.textContent || '').trim()),
          rowBoxes: rows.map(box),
          rowW: rows.length > 0 ? Math.round(rows[0].getBoundingClientRect().width) : 0,
          cardW: Math.round(cr.width),
          buttonCount: card.querySelectorAll('button.ask-row').length,
          descCount: card.querySelectorAll('.ask-opt-desc').length,
          leaked: /opt-[0-9]/.test(card.textContent || ''),
          freePlaceholder: free ? free.getAttribute('placeholder') : null,
          freeW: free ? Math.round(free.getBoundingClientRect().width) : 0,
          hasSkip: !!skip,
          countText: (card.querySelector('.ask-count') || { textContent: '' }).textContent.trim(),
          submitDisabled: submit ? submit.disabled === true : null,
          submitIsRight: submit && skip ? Math.round(submit.getBoundingClientRect().left) > Math.round(skip.getBoundingClientRect().left) : null,
          roundMarks: card.querySelectorAll('.ask-mark-round').length,
          squareMarks: card.querySelectorAll('.ask-mark-square').length,
          aboveComposer: composer ? Math.round(cr.bottom) <= Math.round(composer.getBoundingClientRect().top) + 2 : null,
          queueNote: (card.textContent || '').includes('还有 1 条提问在排队'),
          picked: picked.length,
          pickedText: picked.length > 0 ? (picked[0].textContent || '').trim() : '',
          answerText: (card.querySelector('.ask-answer-text') || { textContent: '' }).textContent.trim(),
          note: ((card.querySelector('.ask-note') || { textContent: '' }).textContent || '').trim(),
          // —— 折叠态三个字段（2026-09-13 新增）——
          hasFoldHead: wasFoldable,
          foldOpen: wasFoldable ? foldHead.getAttribute('aria-expanded') === 'true' : null,
          summary: (card.querySelector('.ask-summary') || { textContent: '' }).textContent.trim(),
          // 折叠态的高度 —— 用来验"收起确实把卡片压矮了"（不是只改了个属性）
          cardH: Math.round(cr.height)
        };
      })()
    `)

  // 连推两条：顺带验"排队不覆盖"（后到的顶掉先到的，用户就会读着 A 的问题、答成 B 的选项）
  win.webContents.send('ask:request', ASK1)
  win.webContents.send('ask:request', ASK2)
  await new Promise((r) => setTimeout(r, 500))

  const askShown = await readAskCardById('ask-probe-1')
  console.log('ASK_SHOWN=' + JSON.stringify(askShown))
  checkTrue(
    '前置：真鼠标通道可用（否则下面几条只是合成事件，测不出"点下去没反应"）',
    rbInputReady === true,
    rbInputReady
  )
  checkTrue(
    '卡片出现在**输入框上方**（非模态、同级摆放）',
    askShown.shown === true && askShown.aboveComposer === true,
    { shown: askShown.shown, aboveComposer: askShown.aboveComposer }
  )
  checkTrue(
    '小标题 + 右上角发起方都在（一眼看出这是什么、谁在问）',
    askShown.title === '需要你决定' && askShown.tool === 'ask_user',
    { title: askShown.title, tool: askShown.tool }
  )
  checkTrue(
    '问题与**全部 3 个选项行**都真看得见（宽高 > 0，不是"DOM 在"）',
    askShown.rowCount === 3 && askShown.rowBoxes.every((b) => b.w > 0 && b.h > 0),
    askShown.rowBoxes
  )
  checkTrue(
    '选项是**整行可点**（行宽 ≈ 卡片宽，不是一排小按钮）',
    askShown.rowW > askShown.cardW * 0.8,
    { rowW: askShown.rowW, cardW: askShown.cardW }
  )
  checkTrue(
    '行内主文案是 **label**（内部值 opt-N 不露），说明行按 description 渲染成灰字小字号',
    askShown.leaked === false && askShown.rowTexts[1].includes('少冰') && askShown.descCount === 1,
    { rowTexts: askShown.rowTexts, descCount: askShown.descCount }
  )
  checkTrue(
    '单选行用**圆框**记号（多选才用方框）',
    askShown.roundMarks === 3 && askShown.squareMarks === 0,
    { round: askShown.roundMarks, square: askShown.squareMarks }
  )
  checkTrue(
    '自由输入框与选项**同宽**、占位文字是「输入你的答案」',
    askShown.freePlaceholder === '输入你的答案' && Math.abs(askShown.freeW - askShown.rowW) <= 2,
    { placeholder: askShown.freePlaceholder, freeW: askShown.freeW, rowW: askShown.rowW }
  )
  checkTrue(
    '底部操作栏：左「跳过本题」· 计数 1/1 · 右「提交」，且**没选也没输入时提交禁用**',
    askShown.hasSkip === true &&
      askShown.countText === '1/1' &&
      askShown.submitIsRight === true &&
      askShown.submitDisabled === true,
    {
      hasSkip: askShown.hasSkip,
      countText: askShown.countText,
      submitIsRight: askShown.submitIsRight,
      submitDisabled: askShown.submitDisabled
    }
  )
  checkTrue(
    '排队不覆盖：两条同时在等时显示**先来的那条**，并写明还有几条排队',
    askShown.id === 'ask-probe-1' && askShown.queueNote === true,
    { id: askShown.id, queueNote: askShown.queueNote }
  )

  // —— 自由输入：写进去的**就是答案本身**（不必是上面某个选项），点「提交」原样送主进程 ——
  const FREE_TEXT = '改成浅色，别用默认的'
  const freePos = await centerOf('.ask-free-input')
  let freeTyped = { ok: false }
  if (rbInputReady && freePos) {
    await realClick(freePos.x, freePos.y, 'left')
    for (const ch of FREE_TEXT) {
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp' })
    }
    freeTyped = { ok: true }
  }
  await new Promise((r) => setTimeout(r, 300))
  const submitPos = await centerOf('.ask-submit')
  let freeSubmit = { ok: false, enabled: null }
  if (rbInputReady && submitPos) {
    // 框里有字 → 提交键必须从"禁用"翻成可用（否则用户写完发现点不动）
    const enabled = await win.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('.ask-submit'); return !!b && b.disabled === false })()"
    )
    await realClick(submitPos.x, submitPos.y, 'left')
    freeSubmit = { ok: true, enabled }
  }
  await new Promise((r) => setTimeout(r, 400))
  // 自填作答后：**默认折叠** → 展开后能看到"我写了什么"
  // ⚠️ 2026-09-13 起已答卡默认折叠，故这里分两段验：折叠态（摘要对、详情不渲染）+ 展开态（留痕还在）
  const askedFreeFolded = await readAskCardById('ask-probe-1')
  // ⚠️ 先独立点开 + 等重渲染，再读（同一同步块里点完就读 = 读到折叠态，三条断言会假红）
  const freeExpandAct = await expandAskCard('ask-probe-1')
  const askedFree = await readAskCardById('ask-probe-1')
  console.log('ASK_FREE=' + JSON.stringify({ ...freeTyped, ...freeSubmit, sent: askResponses, folded: askedFreeFolded, card: askedFree }))
  checkTrue(
    '框里有字 → 「提交」不再是禁用态（不是写完点不动）',
    freeSubmit.ok === true && freeSubmit.enabled === true,
    freeSubmit
  )
  checkTrue(
    '自由输入点「提交」→ stub 收到 `text` **原样**（不带选项、也不被当无效值吞掉）',
    askResponses.length === 1 &&
      askResponses[0].id === 'ask-probe-1' &&
      askResponses[0].text === FREE_TEXT &&
      Array.isArray(askResponses[0].values) &&
      askResponses[0].values.length === 0,
    askResponses[0]
  )
  checkTrue(
    '自填作答后卡片**默认折叠**：只剩一行摘要（自填原文），详情不渲染（选项行 = 0）',
    askedFreeFolded.done === true &&
      askedFreeFolded.hasFoldHead === true &&
      askedFreeFolded.foldOpen === false &&
      askedFreeFolded.rowCount === 0 &&
      askedFreeFolded.summary.includes(FREE_TEXT),
    askedFreeFolded
  )
  checkTrue(
    '展开折叠头 → **留住"我写了什么"**（那段字原样显示在卡上）+ 四个选项行回来了',
    freeExpandAct.clicked === true &&
      askedFree.hasFoldHead === true &&
      askedFree.foldOpen === true &&
      askedFree.answerText.includes(FREE_TEXT) &&
      askedFree.rowCount === 3 &&
      askedFree.buttonCount === 0,
    { act: freeExpandAct, card: askedFree }
  )

  // —— 多选：勾选**先不作答**，点「提交」才发（此时当前问题是排队的那条 ASK2）——
  await new Promise((r) => setTimeout(r, 300))
  const multiCard = await readAskCardById('ask-probe-2')
  checkTrue(
    '排队的那条接管为当前问题，且它用**方框**记号（多选）',
    multiCard.shown === true && multiCard.done === false && multiCard.squareMarks === 3,
    { shown: multiCard.shown, done: multiCard.done, square: multiCard.squareMarks }
  )

  const multiOpt = await centerOfNth('button.ask-row', 1)
  if (rbInputReady && multiOpt) await realClick(multiOpt.x, multiOpt.y, 'left')
  await new Promise((r) => setTimeout(r, 300))
  const afterPick = await win.webContents.executeJavaScript(
    "(() => ({ marked: document.querySelectorAll('button.ask-row-on').length }))()"
  )
  checkTrue(
    '多选：勾一下**先不作答**（要等「提交」）—— 顺手证明它不是单选那条路',
    afterPick.marked === 1 && askResponses.length === 1,
    { marked: afterPick.marked, sent: askResponses.length }
  )

  const submitPos2 = await centerOf('.ask-submit')
  if (rbInputReady && submitPos2) await realClick(submitPos2.x, submitPos2.y, 'left')
  await new Promise((r) => setTimeout(r, 400))
  // 多选卡：先验折叠态，再展开验"选中的那一行被标出来了"
  const askedMultiFolded = await readAskCardById('ask-probe-2')
  // ⚠️ 同上：展开必须独立成一步并等待重渲染，否则读到的还是折叠态
  const multiExpandAct = await expandAskCard('ask-probe-2')
  const askedMulti = await readAskCardById('ask-probe-2')
  console.log('ASK_MULTI=' + JSON.stringify({ sent: askResponses, folded: askedMultiFolded, card: askedMulti }))
  check(
    '点「提交」→ stub 收到第二条回执，且 values **就是那个选项的值**（不是 label、不是第一个）',
    [askResponses.length, askResponses[1] && askResponses[1].id, askResponses[1] && askResponses[1].values],
    [2, 'ask-probe-2', ['opt-2']]
  )
  checkTrue(
    '载荷里**不含 label 文本**，也没冒出个空 `text`（没写字就不该带这个字段）',
    JSON.stringify(askResponses[1] || {}).includes('补测试') === false &&
      askResponses[1].text === undefined,
    askResponses[1]
  )
  checkTrue(
    '多选作答后折叠：摘要**就是选中的那个选项文案**（不是"已答复"这种空话）',
    askedMultiFolded.done === true &&
      askedMultiFolded.foldOpen === false &&
      askedMultiFolded.rowCount === 0 &&
      askedMultiFolded.summary.includes('补测试'),
    askedMultiFolded
  )
  checkTrue(
    '展开后：**按钮一个不剩**（转只读），且把选中的那一行标了出来',
    multiExpandAct.clicked === true &&
      askedMulti.buttonCount === 0 &&
      askedMulti.rowCount === 3 &&
      askedMulti.picked === 1 &&
      askedMulti.pickedText.includes('补测试'),
    { act: multiExpandAct, card: askedMulti }
  )

  // 只读之后再点同一处：不该产生新回执（重复回执会让"已经定下的结论"被改写）
  // ⚠️ 必须先**展开**再点：折叠态那个坐标上根本没有选项行，点它是"点空气"——
  //    回执数当然不变，于是这条会**假绿**（本仓已吃过一次"探针点空气"的亏）。
  const multiOptAgain = await (async () => {
    await expandAskCard('ask-probe-2') // 展开（同样的两步走：点 → 等重渲染）
    return centerOfNth('button.ask-row', 1)
  })()
  if (rbInputReady && multiOptAgain) await realClick(multiOptAgain.x, multiOptAgain.y, 'left')
  await new Promise((r) => setTimeout(r, 300))
  check('只读卡片（已展开）再点同一处 → 回执数**没有变化**', askResponses.length, 2)

  // —— 单选：点整行**直接作答**（不需要再点「提交」）——
  win.webContents.send('ask:request', ASK3)
  await new Promise((r) => setTimeout(r, 500))
  const singleOpt = await centerOfNth('button.ask-row', 0)
  if (rbInputReady && singleOpt) await realClick(singleOpt.x, singleOpt.y, 'left')
  await new Promise((r) => setTimeout(r, 400))
  const askedSingleFolded = await readAskCardById('ask-probe-3')
  const singleExpandAct = await expandAskCard('ask-probe-3')
  const askedSingle = await readAskCardById('ask-probe-3')
  console.log('ASK_SINGLE=' + JSON.stringify({ sent: askResponses, folded: askedSingleFolded, card: askedSingle }))
  check(
    '单选：点一下整行 → **立即作答**（values = 那一行的值）',
    [askResponses.length, askResponses[2] && askResponses[2].id, askResponses[2] && askResponses[2].values],
    [3, 'ask-probe-3', ['opt-1']]
  )
  checkTrue(
    '单选作答后折叠：摘要 = 选中项文案（「水墨」那条）',
    askedSingleFolded.done === true &&
      askedSingleFolded.foldOpen === false &&
      askedSingleFolded.summary.includes('水墨'),
    askedSingleFolded
  )
  checkTrue(
    '展开后把**这一行**标了出来（留住"我选了什么"）',
    singleExpandAct.clicked === true &&
      askedSingle.done === true &&
      askedSingle.picked === 1 &&
      askedSingle.pickedText.includes('水墨'),
    { act: singleExpandAct, card: askedSingle }
  )

  // —— 跳过本题：明确不答 ≠ 超时（回执走 `skip`，不是把空数组当脏值丢掉继续等）——
  win.webContents.send('ask:request', ASK4)
  await new Promise((r) => setTimeout(r, 500))
  const skipPos = await centerOf('.ask-skip')
  if (rbInputReady && skipPos) await realClick(skipPos.x, skipPos.y, 'left')
  await new Promise((r) => setTimeout(r, 400))
  const askedSkip = await readAskCardById('ask-probe-4')
  console.log('ASK_SKIP=' + JSON.stringify({ sent: askResponses, card: askedSkip }))
  check(
    '点「跳过本题」→ stub 收到 `{ values: [], skip: true }`（明确不答，不是超时、也没被当脏值吞掉）',
    [
      askResponses.length,
      askResponses[3] && askResponses[3].skip,
      askResponses[3] && askResponses[3].values
    ],
    [4, true, []]
  )
  checkTrue(
    '跳过后卡片转只读，且标题明说"已跳过本题"（不是"已回答"）',
    askedSkip.done === true && askedSkip.title === '已跳过本题' && askedSkip.picked === 0,
    askedSkip
  )
  // 折叠态：跳过没有"我选了什么"可摘要，故摘要位写「未作答」——**不能空着**（空着像加载失败）
  checkTrue(
    '跳过的卡折叠后：摘要写「未作答」（跳过没有选项可摘要，但位置不能空着）',
    askedSkip.hasFoldHead === true &&
      askedSkip.foldOpen === false &&
      askedSkip.summary === '未作答' &&
      askedSkip.rowCount === 0,
    askedSkip
  )
  // 「全部清除」出口：用户反馈的原话是「无法关闭或收起」——这条验它真能收掉
  const clearPos = await centerOf('.ask-clear')
  if (rbInputReady && clearPos) await realClick(clearPos.x, clearPos.y, 'left')
  await new Promise((r) => setTimeout(r, 300))
  const afterClear = await win.webContents.executeJavaScript(
    "(() => ({ cards: document.querySelectorAll('.ask-card').length, bar: !!document.querySelector('.ask-done-bar'), shown: !!document.querySelector('.ask-card[data-ask-id=\"ask-probe-4\"]') }))()"
  )
  console.log('ASK_CLEAR=' + JSON.stringify(afterClear))
  checkTrue(
    '点「全部清除」→ 已处理的卡片**真的消失**（不是只隐藏了清除条）',
    afterClear.cards === 0 && afterClear.bar === false && afterClear.shown === false,
    afterClear
  )

  // —— Markdown 轻编辑：三条边界各验一条 —— 用真鼠标（el.click() 只发 click、不发 mousedown，会绕过真故障）。
  // ⚠️ 这一段跑在很后面，前面几段探针动过工作台布局 —— 先自愈地把「资源管理器」栏找回来，
  //    否则 clickFile 点不到东西，失败理由会伪装成“编辑功能坏了”。
  const ensureExplorerRow = async (name) => {
    for (let i = 0; i < 8; i += 1) {
      const has = await win.webContents.executeJavaScript(
        "(() => !!Array.from(document.querySelectorAll('.ex-row')).find((b) => (b.textContent || '').includes('" +
          name +
          "')))()"
      )
      if (has) return true
      // ① 有 ＋ 就点 ＋；没有（连栏都没了）就点顶栏的工作台开关
      await win.webContents.executeJavaScript(`
        (() => {
          const add = document.querySelector('.pane-add');
          if (add) { add.click(); return true; }
          const toggle = Array.from(document.querySelectorAll('button')).find((b) => (b.title || '').includes('工作台'));
          if (toggle) { toggle.click(); return true; }
          return false;
        })()
      `)
      await new Promise((r) => setTimeout(r, 450))
      await win.webContents.executeJavaScript(`
        (() => {
          const pick = Array.from(document.querySelectorAll('.wb-pick'))
            .find((b) => (b.textContent || '').includes('资源管理器'));
          if (pick) pick.click();
          return !!pick;
        })()
      `)
      await new Promise((r) => setTimeout(r, 450))
    }
    return false
  }
  const explorerReady = await ensureExplorerRow('README.md')
  await clickFile('README.md')
  await new Promise((r) => setTimeout(r, 800))

  const editPre = await win.webContents.executeJavaScript(`
    (() => ({
      explorerReady: ${JSON.stringify(explorerReady)},
      hasPane: !!document.querySelector('.fp'),
      hasModeBtn: !!Array.from(document.querySelectorAll('.fp-mode')).find((b) => (b.textContent || '').includes('编辑')),
      // ⚠️ 判「在不在编辑态」不能用 .fp-textarea：Monaco 的 DOM 在预览态里也存在，用 .fp-edit-bar
      hasEditBar: !!document.querySelector('.fp-edit-bar')
    }))()
  `)
  console.log('EDIT_PRE=' + JSON.stringify(editPre))

  // 点「编辑」→ 出现编辑栏 + Monaco 编辑器。⚠️ 必须先把窗口显示出来（同下面 iframe 采样）：窗口 show: false，
  //    而 monaco 的渲染走 rAF + 合成，隐藏窗口里的帧不会被合成 —— insertText 无处可去 → 文件不脏 → Ctrl+S
  //    没反应（9 条连锁红）。showInactive() 只显示、不抢焦点。
  win.showInactive()
  await new Promise((r) => setTimeout(r, 400))
  const modePos = await centerOf('.fp-mode')
  if (rbInputReady && modePos) await realClick(modePos.x, modePos.y, 'left')
  await new Promise((r) => setTimeout(r, 2600))
  // ⚠️ 等 2.6s 而不是 0.5s：monaco 按需加载（首次要拉 7.6MB chunk），且离屏窗口里 rAF 会被节流
  const editOn = await win.webContents.executeJavaScript(`
    (() => ({
      hasEditBar: !!document.querySelector('.fp-edit-bar'),
      hasEditor: !!document.querySelector('.ce-host'),
      // 阳性对照：先认清“输入面”是谁（monaco 默认走 EditContext）—— 认不出来就分不清功能坏了还是探针找错
      inputSurface: document.querySelector('.ce-host .native-edit-context')
        ? 'native-edit-context'
        : document.querySelector('.ce-host textarea.inputarea')
          ? 'textarea.inputarea'
          : null
    }))()
  `)
  console.log('EDIT_ON=' + JSON.stringify(editOn))

  // —— 编辑区必须真的能写东西（用户报「切回编辑窗口缩得很小，而且无法扩大」）—— 根因是高度链断在中间：
  // .fp 是“高度=内容”的盒子 → flex: 1 的 textarea 塌成最小行数，resize: none 又堵死手动。故量高度 + 能否放大。
  const editBox = await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('.ce-wrap');
      if (!ta) return { hasEditor: false };
      const body = document.querySelector('.dock-body');
      const r = ta.getBoundingClientRect();
      const br = body ? body.getBoundingClientRect() : null;
      const cs = getComputedStyle(ta);
      return {
        hasEditor: true,
        h: Math.round(r.height),
        w: Math.round(r.width),
        bodyH: br ? Math.round(br.height) : 0,
        ratio: br && br.height > 0 ? +(r.height / br.height).toFixed(2) : 0,
        resize: cs.resize,
        overflowY: cs.overflowY,
        visible: r.height > 0 && r.width > 0 && r.top < window.innerHeight
      };
    })()
  `)
  console.log('EDIT_BOX=' + JSON.stringify(editBox))

  // 打字（真键盘 / 真输入管线：合成 input 事件测不出“受控组件会不会把字吞掉”）。换 Monaco 后：① 命中的是
  // .ce-host .view-line（虚拟化，没有整块 textarea）② 必须先确认真焦点落进去 ③ 输入走 Input.insertText。
  let editFocus = null
  /** 等“可见行真的渲染出来”再取坐标；点完确认焦点真的落进去了，没落进去就再点一次。
   *  ⚠️ 离屏窗口里 monaco 分批渲染（.view-line 高在 0 和 16 之间跳），在高度还是 0 的中间态上点一下会打空 → insertText 无处可去 → 文件不脏 → Ctrl+S 没反应（9 条连锁红）。 */
  let taPos = null
  /** 找“可见行”的坐标。必须挑“可见的那个”编辑器：DOM 里可能同时存在多个 .ce-host，非活动页签里
   *  的那个高度是 0。（本段在模板字符串里，注释不许写反引号 —— 见文件顶部自检。） */
  const findEditorPoint = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const host = Array.from(document.querySelectorAll('.ce-host')).find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 4 && r.height > 4;
        });
        if (!host) return null;
        const line = host.querySelector('.view-line');
        if (!line) return null;
        const r = line.getBoundingClientRect();
        if (r.height < 4 || r.width < 4) return null; // 还在中间态，不算数
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `)
  for (let i = 0; i < 10 && !taPos; i++) {
    taPos = await findEditorPoint()
    if (!taPos) {
      // ⚠️ 主动逼一帧：隐藏窗口里 Chromium 可能不做合成（monaco 的 DOM 都在但布局没 flush → 每行高恒 0）；capturePage() 会强制产出一帧
      try {
        await win.webContents.capturePage()
      } catch {
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  // —— 还找不到就把 monaco 叫醒 ——
  // 失败时 .view-line 是 h:0（而 host 442 高、28 行都在），成功时 h:16 —— 那是 monaco 的字体测量还没完成；
  // 它的 automaticLayout 会在窗口尺寸变化时重算度量，故把窗口推 1px 再还原等于戳它一下。⚠️ 环境兜底，不是产品补丁。
  if (!taPos) {
    const [w0, h0] = win.getSize()
    win.setSize(w0 + 1, h0)
    await new Promise((r) => setTimeout(r, 250))
    win.setSize(w0, h0)
    await new Promise((r) => setTimeout(r, 600))
    for (let i = 0; i < 10 && !taPos; i++) {
      taPos = await findEditorPoint()
      if (!taPos) await new Promise((r) => setTimeout(r, 400))
    }
  }
  // 找不到就**把现场打出来**：不然只有一句 EDIT_FOCUS=null，下一个人只看到"9 条连锁红"、不知该往哪儿看。
  if (!taPos) {
    const miss = await win.webContents.executeJavaScript(`
      (() => {
        const rr = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
        const hosts = Array.from(document.querySelectorAll('.ce-host'));
        const h0 = hosts[0] ?? null;
        const l0 = h0 ? h0.querySelector('.view-line') : null;
        const cs = (el) => {
          if (!el) return null;
          const c = getComputedStyle(el);
          return { h: c.height, lh: c.lineHeight, disp: c.display, vis: c.visibility, pos: c.position, top: c.top, ov: c.overflow };
        };
        return {
          hostCount: hosts.length,
          hosts: hosts.map(rr),
          lineCounts: hosts.map((h) => h.querySelectorAll('.view-line').length),
          firstLineRects: hosts.map((h) => rr(h.querySelector('.view-line'))),
          editBar: !!document.querySelector('.fp-edit-bar'),
          wrap: rr(document.querySelector('.ce-wrap')),
          loadingMsg: !!document.querySelector('.ce-loading'),
          errMsg: document.querySelector('.ex-err')?.textContent ?? null,
          monacoRoots: document.querySelectorAll('.monaco-editor').length,
          activePanes: Array.from(document.querySelectorAll('.pane')).map((p) => rr(p)),
          visibility: document.visibilityState,
          lineStyle: cs(l0),
          lineInline: l0 ? (l0.getAttribute('style') || '').slice(0, 120) : null,
          linesStyle: cs(l0?.parentElement ?? null),
          monacoStyle: cs(document.querySelector('.monaco-editor')),
          paneActive: (() => {
            const pane = h0?.closest('.pane');
            if (!pane) return null;
            return { cls: String(pane.className), rect: rr(pane), display: getComputedStyle(pane).display };
          })()
        };
      })()
    `)
    console.log('EDIT_TA_MISSING=' + JSON.stringify(miss))
  }
  if (rbInputReady && taPos) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await realClick(taPos.x, taPos.y, 'left')
      await new Promise((r) => setTimeout(r, 350))
      editFocus = await win.webContents.executeJavaScript(`
        (() => {
          const host = document.querySelector('.ce-host');
          const ae = document.activeElement;
          const ec = document.querySelector('.ce-host .native-edit-context');
          const line = document.querySelector('.ce-host .view-line');
          const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
          return {
            inHost: !!host?.contains(ae),
            activeTag: ae ? ae.tagName : null,
            activeCls: ae ? String(ae.className).slice(0, 40) : null,
            hasHost: !!host,
            hostCount: document.querySelectorAll('.ce-host').length,
            visibleHostCount: Array.from(document.querySelectorAll('.ce-host')).filter((el) => {
              const b = el.getBoundingClientRect();
              return b.width > 4 && b.height > 4;
            }).length,
            taPosFound: true,
            hostRect: r(host),
            lineCount: document.querySelectorAll('.ce-host .view-line').length,
            lineRect: r(line),
            hasEditContext: !!ec,
            hasLoading: !!document.querySelector('.ce-loading'),
            clicked: ${JSON.stringify({ x: Math.round(taPos.x), y: Math.round(taPos.y) })},
            attempt: ${attempt + 1}
          };
        })()
      `)
      if (editFocus?.inHost) break
    }
    console.log('EDIT_FOCUS=' + JSON.stringify(editFocus))

    // ⚠️ **点击路径跑完了但没拿到焦点** → 也走 DOM 聚焦兜底（2026-09-13 实测根因）。
    //    根因：用户开着打包版应用时，门禁窗口**抢不到系统焦点**，点击只会落到 BODY 上 ——
    //    于是"焦点/打字/脏标记/Ctrl+S/未保存守卫"整串 8 条连锁红，而**产品本身没坏**。
    //    这里补一次 DOM 聚焦，并把"点击路径本次未验到"如实标出来（不假装验过、也不把断言改松：
    //    `inHost` 仍是真量出来的，兜底也拿不到焦点照样判红）。
    if (editFocus?.inHost !== true) {
      const viaDomRetry = await win.webContents.executeJavaScript(`
        (() => {
          const ec = document.querySelector('.ce-host .native-edit-context')
            || document.querySelector('.ce-host textarea.inputarea');
          if (!ec) return { ok: false };
          ec.focus();
          return { ok: true, inHost: !!document.querySelector('.ce-host')?.contains(document.activeElement) };
        })()
      `)
      editFocus = {
        ...editFocus,
        inHost: viaDomRetry.inHost === true,
        envFallback: true,
        viaDomFocus: viaDomRetry.ok === true
      }
      console.log(
        'EDIT_FOCUS_ENV_FALLBACK=' +
          JSON.stringify(editFocus) +
          ' ← 点击路径本次没拿到焦点（多半是门禁窗口被别的应用占着系统焦点），改用 DOM 聚焦兜底；' +
          '「点一下能不能进编辑器」这条本次未验到'
      )
    }
  } else if (rbInputReady) {
    /** 环境兜底：拿不到“可见行”的坐标（隐藏窗口里 Chromium 可能不做合成 → 每行高度恒为 0）时，直接聚焦输入面，
     *  让“打字 → 变脏 → Ctrl+S → 守卫”主线照样测得到。⚠️ 不是把断言改松：inHost 仍是真量出来的，失败照样判红。 */
    const viaDom = await win.webContents.executeJavaScript(`
      (() => {
        const ec = document.querySelector('.ce-host .native-edit-context')
          || document.querySelector('.ce-host textarea.inputarea');
        if (!ec) return { ok: false };
        ec.focus();
        return { ok: true, inHost: !!document.querySelector('.ce-host')?.contains(document.activeElement) };
      })()
    `)
    editFocus = { inHost: viaDom.inHost === true, envFallback: true, viaDomFocus: viaDom.ok === true, taPosFound: false }
    console.log(
      'EDIT_FOCUS_ENV_FALLBACK=' + JSON.stringify(editFocus) +
        ' ← 点击路径本次不可用（编辑器没渲染出可见行），改用 DOM 聚焦兜底；' +
        '「点一下能不能进编辑器」这条本次未验到'
    )
  }
  if (rbInputReady) {
    await dbg.sendCommand('Input.insertText', { text: '改了' })
  }
  await new Promise((r) => setTimeout(r, 600))
  const dirtyState = await win.webContents.executeJavaScript(`
    (() => ({
      hasDirtyBadge: !!document.querySelector('.fp-dirty'),
      hasTabDot: !!document.querySelector('.pane-tab-dirty'),
      // ⚠️ monaco 虚拟化：DOM 里只有可见行，读它更贴近用户实际看到的；权威全文在 fsWritePayloads 里验
      text: Array.from(document.querySelectorAll('.ce-host .view-line'))
        .map((e) => e.textContent || '')
        .join('')
    }))()
  `)
  console.log('EDIT_DIRTY=' + JSON.stringify(dirtyState))

  // 保存①：真按 Ctrl+S。⚠️ 必须真按键：monaco 的 KeybindingService 会先吃掉这个组合键，外面挂 onKeyDown 收不到
  fsWritePayloads.length = 0
  if (rbInputReady) {
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: 2, // Ctrl
      windowsVirtualKeyCode: 83,
      code: 'KeyS',
      key: 's'
    })
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 2,
      windowsVirtualKeyCode: 83,
      code: 'KeyS',
      key: 's'
    })
  }
  await new Promise((r) => setTimeout(r, 900))
  const savedState = await win.webContents.executeJavaScript(`
    (() => ({
      hasDirtyBadge: !!document.querySelector('.fp-dirty'),
      hasTabDot: !!document.querySelector('.pane-tab-dirty'),
      msg: (document.querySelector('.fp-msg')?.textContent ?? '').trim()
    }))()
  `)
  const savedByKeyCount = fsWritePayloads.length
  console.log('EDIT_SAVED=' + JSON.stringify({ writes: fsWritePayloads, ...savedState }))

  // 保存②：再脏一次，这回**真点保存按钮**（两条入口都得在，不能只留键盘一条）
  if (rbInputReady && taPos) {
    await realClick(taPos.x, taPos.y, 'left')
    await dbg.sendCommand('Input.insertText', { text: '再' })
  }
  await new Promise((r) => setTimeout(r, 500))
  const savePos = await centerOf('.fp-edit-bar .fp-btn')
  if (rbInputReady && savePos) await realClick(savePos.x, savePos.y, 'left')
  await new Promise((r) => setTimeout(r, 900))
  const savedByButtonCount = fsWritePayloads.length
  console.log('EDIT_SAVED_BUTTON=' + JSON.stringify({ count: savedByButtonCount }))

  // 边界①：改了没存 → 点页签 ✕ **不许直接关掉**
  if (rbInputReady && taPos) {
    await realClick(taPos.x, taPos.y, 'left')
    // ⚠️ 与上面同因、同修法：窗口没有系统焦点时，这次点击也**进不了编辑器** ——
    //    不兜底的话 `insertText` 打空，"守卫没出现"就会被误读成守卫坏了（2026-09-13 实测踩到：
    //    用户开着打包版应用时，这里整串 3 条连锁红，而产品本身没问题）。
    const inHostAgain = await win.webContents.executeJavaScript(
      "!!document.querySelector('.ce-host') && !!document.querySelector('.ce-host').contains(document.activeElement)"
    )
    if (inHostAgain !== true) {
      await win.webContents.executeJavaScript(`
        (() => {
          const ec = document.querySelector('.ce-host .native-edit-context')
            || document.querySelector('.ce-host textarea.inputarea');
          ec?.focus();
          return !!ec;
        })()
      `)
    }
    await dbg.sendCommand('Input.insertText', { text: '未存' })
  }
  await new Promise((r) => setTimeout(r, 500))
  // 打字之后**先确认真的脏了** —— 否则下面"守卫没出现"就分不清是守卫坏了还是根本没脏
  const dirtyAgain = await win.webContents.executeJavaScript(`
    (() => ({ hasDirtyBadge: !!document.querySelector('.fp-dirty') }))()
  `)
  // ⚠️ 必须点这个文件那个页签的 ✕：centerOf('.pane-tab-x') 拿的是 DOM 里第一个，点错会关掉别的栏
  const xPos = await win.webContents.executeJavaScript(
    "(() => { const tab = Array.from(document.querySelectorAll('.pane-tab')).find((t) => (t.textContent || '').includes('README.md')); if (!tab) return null; const el = tab.querySelector('.pane-tab-x'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()"
  )
  if (rbInputReady && xPos) await realClick(xPos.x, xPos.y, 'left')
  await new Promise((r) => setTimeout(r, 500))
  const guardState = await win.webContents.executeJavaScript(`
    (() => ({
      guard: (document.querySelector('.pane-guard .pg-text')?.textContent ?? '').trim(),
      stillOpen: !!document.querySelector('.fp-edit-bar'),
      buttons: Array.from(document.querySelectorAll('.pane-guard .pg-btn')).map((b) => (b.textContent || '').trim())
    }))()
  `)
  console.log('EDIT_GUARD=' + JSON.stringify({ dirtyAgain: dirtyAgain.hasDirtyBadge, clickedX: !!xPos, ...guardState }))

  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.pane-guard .pg-btn')).find((x) => (x.textContent || '').includes('放弃'));
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const closed = await win.webContents.executeJavaScript(`
    (() => ({
      hasEditBar: !!document.querySelector('.fp-edit-bar'),
      // ⚠️ 判“页签关没关”要看页签条里还有没有这个文件：monaco 异步创建，用它的消失当判据会假绿
      tabGone: !Array.from(document.querySelectorAll('.pane-tab')).some(
        (t) => (t.textContent || '').includes('README.md')
      )
    }))()
  `)
  console.log('EDIT_CLOSED=' + JSON.stringify(closed))

  // —— 流式订阅不该跟着视图卸载（会卡死人的 bug）——
  // 现象：流式期间去「设置」页 → 中途吐出来的字全丢；流恰在那一刻跑完时 chat:done 收不到 → streaming 永远停在
  // true。根因：订阅挂在 ChatView 的 effect 上，而主区域是条件渲染（切页就卸载）；修法是订阅搬到 App。
  await win.webContents.executeJavaScript(`
    (() => {
      const item = Array.from(document.querySelectorAll('.conv-item'))
        .find((b) => (b.textContent || '').includes('打个招呼'));
      if (item) item.click();
      return !!item;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))

  win.webContents.send('chat:chunk', { conversationId: 'c1', payload: '切换之前的字' })
  await new Promise((r) => setTimeout(r, 500))
  const subBefore = await win.webContents.executeJavaScript(`
    (() => ({ got: (document.querySelector('.chat-messages')?.textContent ?? '').includes('切换之前的字') }))()
  `)

  // 点齿轮开独立设置窗口 —— ⚠️ 语义已随架构切换更新：以前"点齿轮"是主窗口**切视图**（ChatView 卸载）；
  //    现在是**开新窗口**，主窗口的 ChatView 根本不卸载。要验的东西没变：**对话流式订阅不因开设置窗口而断**
  //    （旧代码就是因为视图卸载时订阅被清掉才丢字）。
  const gearPos = await centerOf('.gear-btn')
  if (rbInputReady && gearPos) await realClick(gearPos.x, gearPos.y, 'left')
  await new Promise((r) => setTimeout(r, 900))
  const onSettings = await win.webContents.executeJavaScript(`
    (() => ({
      chatStillMounted: !!document.querySelector('.chat-view'),
      mainHasNoSettings: !document.querySelector('.settings, .settings-view, .settings-page')
    }))()
  `)
  checkTrue(
    '点齿轮开设置窗口时，**主窗口的对话视图仍在**（开窗不是切页，对话不该被卸载）',
    onSettings.chatStillMounted === true && onSettings.mainHasNoSettings === true,
    onSettings
  )

  // 设置窗口开着期间继续推：一段正文 + 结束（旧代码里视图卸载后 chat:done 收不到 → 那段字永远不会被存盘）
  convSaveCalls.length = 0
  win.webContents.send('chat:chunk', { conversationId: 'c1', payload: '开窗期间的字' })
  await new Promise((r) => setTimeout(r, 300))
  win.webContents.send('chat:done', { conversationId: 'c1', payload: null })
  await new Promise((r) => setTimeout(r, 700))
  const savedWhileAway = convSaveCalls.some((c) =>
    (c.messages ?? []).some((m) => String(m.content ?? '').includes('开窗期间的字'))
  )

  await win.webContents.executeJavaScript(`
    (() => {
      const item = Array.from(document.querySelectorAll('.conv-item'))
        .find((b) => (b.textContent || '').includes('打个招呼'));
      if (item) item.click();
      return !!item;
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const subAfter = await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.send-btn');
      const all = document.querySelector('.chat-messages')?.textContent ?? '';
      return {
        text: all.slice(-40),
        hasChunkWhileSettingsOpen: all.includes('开窗期间的字'),
        stopping: !!btn && btn.classList.contains('stopping'),
        sendTitle: btn ? (btn.getAttribute('title') || '') : ''
      };
    })()
  `)
  console.log(
    'SUB_LIFECYCLE=' + JSON.stringify({ before: subBefore.got, onSettings, savedWhileAway, ...subAfter })
  )

  // —— 两条会话同时跑（并发能力的最后一道验收）—— 要求验四件事：① 两条都在跑 ② 切到 A 时 A 的流在长、
  // B 的字不串进来 ③ A 结束后 B 仍在跑 ④ 两条各自落盘。判据盯界面上的字落在哪条会话 + conv:save 的载荷。
  const convItems = async () =>
    win.webContents.executeJavaScript(`
      (() => Array.from(document.querySelectorAll('.conv-item')).map((b) => ({
        text: (b.textContent || '').trim(),
        running: !!b.querySelector('.conv-running'),
        active: b.classList.contains('active')
      })))()
    `)

  const clickConv = async (title) => {
    const ok = await win.webContents.executeJavaScript(`
      (() => {
        const it = Array.from(document.querySelectorAll('.conv-item'))
          .find((b) => (b.textContent || '').includes(${JSON.stringify('__T__')}));
        if (it) it.click();
        return !!it;
      })()
    `.replace('__T__', title))
    await new Promise((r) => setTimeout(r, 800))
    return ok
  }

  const typeAndSend = async (text) => {
    const pos = await centerOf('.console-input')
    if (!pos) return false
    await realClick(pos.x, pos.y, 'left')
    for (const ch of text) {
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp' })
    }
    const enter = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    }
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter })
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
    await new Promise((r) => setTimeout(r, 500))
    return true
  }

  const chatText = async () =>
    win.webContents.executeJavaScript(`(() => (document.querySelector('.chat-messages')?.textContent ?? ''))()`)

  await clickConv('打个招呼')
  const sentA = await typeAndSend('A 的活开工')
  await new Promise((r) => setTimeout(r, 300))
  const runningAfterA = await convItems()

  await clickConv('查点资料')
  const sentB = await typeAndSend('B 的活开工')
  await new Promise((r) => setTimeout(r, 300))
  const runningAfterB = await convItems()

  // ② 此时界面显示的是 B：推一段**属于 A** 的字 —— 它**不许**出现在 B 的对话里
  win.webContents.send('chat:chunk', { conversationId: 'c1', payload: '【这是 A 的字】' })
  await new Promise((r) => setTimeout(r, 500))
  const bText = await chatText()

  // ③ A 结束 → A 的标记消失、B 仍在跑；④ 落盘的是 **A**
  convSaveCalls.length = 0
  win.webContents.send('chat:done', { conversationId: 'c1', payload: null })
  await new Promise((r) => setTimeout(r, 800))
  const runningAfterADone = await convItems()
  const savedAOnly = convSaveCalls.map((c) => c.id)

  // 切回 A：它的字**在它自己那条里**（存档 / 恢复）
  await clickConv('打个招呼')
  const aText = await chatText()
  const concurrencyResult = {
    sentA,
    sentB,
    runningAfterA: runningAfterA.filter((c) => c.running).map((c) => c.text),
    runningAfterB: runningAfterB.filter((c) => c.running).map((c) => c.text),
    leakedIntoB: bText.includes('【这是 A 的字】'),
    runningAfterADone: runningAfterADone.filter((c) => c.running).map((c) => c.text),
    savedAOnly,
    aHasOwnText: aText.includes('【这是 A 的字】')
  }
  console.log('CONCURRENCY=' + JSON.stringify(concurrencyResult))
  const shotConc = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-concurrency.png'), shotConc.toPNG())

  if (rbInputReady) {
    try {
      dbg.detach()
    } catch {
    }
  }

  checkTrue('前置状态：会话页开着、里面有消息（否则下面几条失败说明不了任何事）',
    rbPre.hasChat === true && rbPre.msgs >= 2, rbPre)
  checkTrue('**右键消息**能开出菜单，且里面有「回到这条之前」',
    rbMenu.ok === true && rbMenuState.hasItem === true, { ...rbMenu, ...rbMenuState })
  checkTrue('真鼠标通道可用（否则上面那条只是合成事件，测不出"点下去没反应"）',
    rbInputReady === true, { rbInputReady })
  checkTrue('**真鼠标点**菜单项 → 回滚请求真的发出去了（这一下就是 0.13.6 漏掉的那个 bug）',
    rbClicked.ok === true && convRollbackCalls.length === 1, { clicked: rbClicked, calls: convRollbackCalls })
  check('回滚载荷带的是**被右键那条的下标**（右键第一条 → 0）',
    convRollbackCalls[0]?.toIndex, 0)
  checkTrue('回滚后**消息变少了** —— 界面换成了主进程给的权威正文',
    rbAfter.msgs === 1 && rbAfter.msgs < rbPre.msgs, { before: rbPre.msgs, after: rbAfter.msgs })
  checkTrue('回滚后菜单自己收回去（不是一直挂在那儿）', rbAfter.menuClosed === true)
  // 下面两条对应 plan10 §六 第 6 条那三条可判定断言里的 ① 与 ③
  // plan46 改重：措辞由「仅回滚对话消息，工作区文件未改动」改为**两段式**（什么退了 / 什么没退）——
  // 原句容易被读成"什么都没发生过"，与实际会打架（实机截图为证：提示条说"文件未改动"，右侧工作台却躺着一批产物）
  checkTrue('提示条**再声明一次作用域**（说清「对话退了、文件与提交没退」）',
    (rbAfter.notice || '').includes('对话历史已退') &&
      (rbAfter.notice || '').includes('工作区文件与 git 提交未回退'),
    rbAfter.notice)
  checkTrue('提示条**不许**用"文件已还原"这类措辞（那是文件回滚的说法）',
    !/文件已还原|已还原文件|回滚了文件/.test(rbAfter.notice || ''), rbAfter.notice)

  // plan46：消息操作条（操作条常驻 / 复制每条都有 / 编辑只给用户消息）
  checkTrue('消息操作条**每条消息都有**（常驻显示，不是 hover 才出）',
    textCheck.msgActions.withBar === textCheck.msgCount && textCheck.msgCount > 0,
    textCheck.msgActions)
  checkTrue('复制按钮**每条消息都有**',
    textCheck.msgActions.withCopy === textCheck.msgCount, textCheck.msgActions)
  checkTrue('编辑按钮**只在用户消息**上（改 AI 的回答等于伪造历史）',
    textCheck.msgActions.userCount > 0 &&
      textCheck.msgActions.editOnUser === true &&
      textCheck.msgActions.editOnAssistant === false,
    textCheck.msgActions)
  checkTrue('提示条上有个**撤销**入口', rbAfter.hasUndo === true)
  checkTrue('点撤销 → 调了撤销通道，且条数**换回 4 条**（权威正文说了算）',
    convUndoCalls.length === 1 && rbUndone.msgs === 4, { calls: convUndoCalls.length, ...rbUndone })
  checkTrue('撤销之后提示条消失（没东西可撤了）', rbUndone.noticeGone === true)
  // 第 6 条的第 ② 条：确认框文案 —— 两个回滚入口不许长得一样
  checkTrue('**确认框**弹出来了（会话回滚也有二次确认，不是一点就走）', cfText.shown === true)
  checkTrue('确认框说的是「会话回滚」这一档（含「仅回滚对话消息」）',
    cfText.text.includes('仅回滚对话消息'), cfText.text.slice(0, 120))
  checkTrue('确认框**不含**文件回滚的措辞（分得清）',
    !/文件已还原|已还原文件|回滚文件/.test(cfText.text), cfText.text.slice(0, 160))

  // —— 会话刻度条判据（plan41 S1，改版自 plan7 批 D 大纲）——
  checkTrue('多轮会话（2 轮起）右缘常驻刻度条（单轮不摆条）',
    railInfo !== null && railInfo.visible === true, railInfo)
  checkTrue('刻度数 = 用户消息数（2）—— 一根刻度就是一轮提问',
    railInfo !== null && railInfo.ticks === 2, railInfo)
  checkTrue(
    '点第 1 根刻度 → 真的往回滚（可滚时 scrollTop 变小；不满一屏时改验跳转高亮 —— 案三硬前置）',
    outlineAfter.scrollTop >= 0 &&
      (outlineBefore.scrollable > 4
        ? outlineAfter.scrollTop < outlineBefore.scrollTop
        : outlineAfter.highlighted === true),
    { before: outlineBefore.scrollTop, scrollable: outlineBefore.scrollable, after: outlineAfter.scrollTop, highlighted: outlineAfter.highlighted }
  )
  checkTrue('跳转落点带高亮（「跳到了哪」看得见）', outlineAfter.highlighted === true, outlineAfter)

  checkTrue('前置：文件开在预览栏里，且有「编辑」入口', editPre.hasPane === true && editPre.hasModeBtn === true, editPre)
  checkTrue('前置：**还没进编辑态**（不然下面"点了才出现"什么也说明不了）', editPre.hasEditBar === false, editPre)
  checkTrue('点「编辑」→ 编辑栏与编辑器都出来了', editOn.hasEditBar === true && editOn.hasEditor === true, editOn)
  // **阳性对照**：先认清输入面是谁 —— 认不出来的话，"打字没生效"就分不清是功能坏了还是探针找错了地方。
  checkTrue('认得清 Monaco 的输入面（EditContext 或 textarea.inputarea，二者必居其一）',
    editOn.inputSurface !== null, editOn)
  // 用户 2026-09-12 报的那个"缩得很小、还放不大"—— 判据盯着**实际占多大**与**能不能放大**
  checkTrue(
    '编辑区**真占得下地方**（相对它所在的栏 ≥ 45%，不是塌成两行的小盒子）',
    editBox.hasEditor === true && editBox.visible === true && editBox.ratio >= 0.45,
    editBox
  )
  checkTrue(
    '编辑区**可以手动放大**（`resize: none` 就是把主人堵死的那一行）',
    editBox.resize === 'vertical' || editBox.resize === 'both',
    { resize: editBox.resize }
  )
  checkTrue('打字后**页面上看得见"未保存"**（头部标记 + 页签脏点，两处都要有）',
    dirtyState.hasDirtyBadge === true && dirtyState.hasTabDot === true && dirtyState.text.length > 0, dirtyState)
  checkTrue('**真敲进去的字出现在编辑器里**（不是只改了 state）',
    (dirtyState.text || '').includes('改'), { text: (dirtyState.text || '').slice(0, 60) })
  checkTrue('**焦点真的落进了编辑器**（不确认这一条，"打字没生效"就分不清该怪谁）',
    editFocus?.inHost === true, editFocus)
  checkTrue('**Ctrl+S 真的能存**（monaco 会先吃掉这个组合键，绑在外面是收不到的）',
    savedByKeyCount === 1, { savedByKeyCount, writes: fsWritePayloads.length })
  checkTrue('**存进盘里的是敲进去的那几个字**（读的是写盘载荷，不是界面）',
    (fsWritePayloads[0]?.content || '').includes('改了'), {
      tail: (fsWritePayloads[0]?.content || '').slice(-20)
    })
  check('保存时**带上了冲突基线**（mtime；不带就等于"盲写"）',
    fsWritePayloads[0]?.expectedMtimeMs, 111111)
  checkTrue('**保存按钮也照样能用**（键盘与按钮两条入口都在）',
    savedByButtonCount === 2, { savedByButtonCount })
  checkTrue('保存后**脏标记收回去**（两处都收）',
    savedState.hasDirtyBadge === false && savedState.hasTabDot === false, savedState)
  // 边界①：脏标记守卫 —— 这条是 plan7 验收里写死的那句"改了没存就关页签 → 有提示"
  checkTrue('**改了没存就关页签 → 被拦下来问一句**（不静默丢）',
    guardState.guard.includes('未保存'), guardState)
  checkTrue('拦下来时**页签还在**（只是问了句，没有关掉）', guardState.stillOpen === true, guardState)
  checkTrue('守卫条给的是两个明确选择（取消 / 放弃修改并关闭）',
    guardState.buttons.length === 2 && guardState.buttons.some((b) => b.includes('取消')), guardState.buttons)
  checkTrue('选「放弃修改并关闭」→ 页签真的关掉了',
    closed.tabGone === true && closed.hasEditBar === false, closed)

  checkTrue('前置：订阅在（推一段流界面能收到）', subBefore.got === true, subBefore)
  // ⚠️ 判据随架构更新：以前"切设置页"= 主窗口切视图（ChatView 卸载）；现在 = **开独立窗口**。
  //    强度不变：必须确认**设置窗口真的开了**，否则"开窗期间的字仍存盘"这条证明不了任何事。
  checkTrue('前置：设置窗口确实开出来了（主窗口对话仍在，设置已搬去独立窗口）',
    onSettings.chatStillMounted === true &&
      onSettings.mainHasNoSettings === true &&
      getSettingsWin() !== null &&
      getSettingsWin() !== undefined,
    onSettings)
  checkTrue('**设置窗口开着期间流出来的内容，仍然被存盘**（订阅不因开窗而断 —— 旧代码这里必红）',
    savedWhileAway === true, { savedWhileAway, saves: convSaveCalls.length })
  checkTrue('**收到 `chat:done` 之后不卡在"生成中"**（发送键回到「发送」）',
    subAfter.stopping === false && subAfter.sendTitle.includes('发送'), subAfter)

  checkTrue('前置：**两条会话都发出去了**（真键盘打字 + 回车；没发出去的话下面全说明不了任何事）',
    concurrencyResult.sentA === true && concurrencyResult.sentB === true, concurrencyResult)
  checkTrue('① **两条都在跑** —— 侧边栏两个「正在生成」标记（并发没生效时只会有 1 个）',
    concurrencyResult.runningAfterB.length === 2, concurrencyResult.runningAfterB)
  checkTrue('② **切到 B 时，属于 A 的字不会串进来**（这就是"切会话串台"的回归门）',
    concurrencyResult.leakedIntoB === false, { leakedIntoB: concurrencyResult.leakedIntoB })
  checkTrue('③ **A 结束后 B 仍在跑**（一条跑完不该把另一条也标记成结束）',
    concurrencyResult.runningAfterADone.length === 1 &&
      concurrencyResult.runningAfterADone.some((t) => t.includes('查点资料')),
    concurrencyResult.runningAfterADone)
  checkTrue('④ **后台那条（A）跑完真的落了盘，且落的是它自己**（P0-1：以前只存"当前显示的那条"）',
    concurrencyResult.savedAOnly.includes('c1'), concurrencyResult.savedAOnly)
  // —— plan12：目标面板（跨轮次的长期意图）——
  checkTrue('目标面板在输入框上方，且**两条目标都渲染出来**（一进行中、一暂停）',
    goalPanel?.hasPanel === true && goalPanel?.rows === 2 && goalPanel?.pausedCount === 1 && goalPanel?.visible === true,
    goalPanel)
  checkTrue('行内动作齐（进行中：暂停/编辑/完成/删除；暂停：继续/编辑/完成/删除）+ 有「加目标」',
    goalPanel?.hasAdd === true &&
      (goalPanel?.btnTexts ?? []).some((s) => s.includes('暂停') && s.includes('完成') && s.includes('删除')) &&
      (goalPanel?.btnTexts ?? []).some((s) => s.includes('继续') && s.includes('完成')),
    goalPanel?.btnTexts)
  // ⚠️ “目标摆在待办上面”这条没写成断言：待办面板“没有待办”时自己不占位，探针跑到那一刻它根本不在
  //    DOM 里 → 几何对比无从判；写成“todo 为 null 就放行”只会得到一条永远绿的假断言。顺序目前由 JSX
  //    结构保证（GoalPanel 在 TodoPanel 之前）。TODO：等有稳定的“待办非空”场景时补上真判据。

  // —— plan7 F5.1：模型目录（一把 Key 能调多个模型 + 每个模型的高级设置）——
  checkTrue('点「编辑」→ 出现**模型目录编辑器**（这是 F5.1 的核心形态）',
    modelCatalog?.open === true, modelCatalog)
  checkTrue('目录里**一行一个模型**（≥3 条，且模型 ID 都读出来了）',
    (modelCatalog?.rows ?? 0) >= 3 && (modelCatalog?.ids ?? []).every((s) => typeof s === 'string' && s.length > 0),
    modelCatalog)
  checkTrue('三个动作都在：添加模型 / 获取可用模型 / 恢复默认模型',
    modelCatalog?.hasAdd === true && modelCatalog?.hasFetch === true && modelCatalog?.hasRestore === true,
    modelCatalog)
  checkTrue('**每个模型能展开自己的高级设置**（展开前没有面板 → 展开后有，且字段不止一个）',
    modelCatalog?.advBefore === false && modelCatalog?.adv?.panel === true && (modelCatalog?.adv?.fields ?? 0) >= 5,
    modelCatalog?.adv)

  // —— plan47 S1：免保存拉取（破「先保存才能拉、先有模型才能保存」死循环）——
  checkTrue('新端点（未保存、无 id）点「获取可用模型」→ **真的发起 models:fetch-available**，入参是表单草稿',
    fetchNewEndpoint?.ok === true && fetchNewEndpoint?.fired === true &&
      fetchNewEndpoint?.baseURL === 'https://api.new-unsaved.test' && fetchNewEndpoint?.hasId === false,
    fetchNewEndpoint)

  // —— plan17 F8：子 Agent 管理（**两节列表**（D-103：项目级已取消）+ 警告区 + 表单校验 + 有状态桩的保存链）——
  checkTrue('设置页「子 Agent」分区：两节列表（自定义/内置，D-103 项目级已取消）+ 警告区可见（坏文件不静默）+ 新建入口',
    (agentsMgr?.list?.sections ?? 0) === 2 &&
      agentsMgr?.list?.warnShown === true &&
      agentsMgr?.list?.warnText.includes('broken.md') === true &&
      agentsMgr?.list?.newBtn === true,
    agentsMgr?.list)
  checkTrue('列表条数与编辑入口：内置 + 自定义都有行，自定义行带编辑/删除（内置行不带）',
    (agentsMgr?.list?.names ?? []).includes('planner') &&
      (agentsMgr?.list?.names ?? []).includes('word-smith') &&
      agentsMgr?.list?.editBtns === 1,
    agentsMgr?.list)
  checkTrue('新建表单：空表单直接保存被**实时校验拦下**（按钮禁用 + 显示人话错误），name 可编辑',
    agentsMgr?.formEmpty?.formOpen === true &&
      agentsMgr?.formEmpty?.saveDisabled === true &&
      (agentsMgr?.formEmpty?.errShown ?? '').length > 0 &&
      agentsMgr?.formEmpty?.nameEditable === true,
    agentsMgr?.formEmpty)
  checkTrue('保存链真的走通：合法值保存后列表出现新定义（桩有状态，固定值桩验不出这条）',
    (agentsMgr?.afterSave?.names ?? []).includes('code-reviewer') &&
      (agentsMgr?.afterSave?.notice ?? '').includes('已保存'),
    agentsMgr?.afterSave)
  checkTrue('对话页「主 Agent」单选：菜单有「主 Agent」一节，列出内核默认 + 各定义，默认勾选在内核默认上',
    agentMenu?.menuOpen === true &&
      (agentMenu?.titles ?? []).includes('主 Agent') &&
      (agentMenu?.names ?? []).includes('内核默认') &&
      (agentMenu?.names ?? []).includes('word-smith') &&
      agentMenu?.checkedNow === '内核默认',
    agentMenu)
  checkTrue('选中 word-smith：会话头出现 Agent 徽标（切会话/重启后从 meta 恢复的就是它）',
    agentPicked?.badge === 'Agent word-smith' && agentPicked?.menuClosed === true,
    agentPicked)
  checkTrue('切换动作写进了 conv:save 载荷（⚠️ 只护渲染侧这一段 —— handler 转发与主循环真生效由 runner 单测与冒烟钉）',
    agentSaveCall?.agentName === 'word-smith',
    agentSaveCall ? { agentName: agentSaveCall.agentName } : null)
  checkTrue('切回 A → **A 的字在它自己那条里**（存档/恢复生效，不是靠重新拉盘掩盖）',
    concurrencyResult.aHasOwnText === true, { aHasOwnText: concurrencyResult.aHasOwnText })

  // —— 模型分组下拉（2026-09-15 用户需求，参考图二）：端点为组、组下逐条模型、当前那条打勾 ——
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.tb-model');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const modelMenuGrouped = await win.webContents.executeJavaScript(`
    (() => {
      const menu = document.querySelector('.model-menu');
      if (!menu) return { open: false };
      return {
        open: true,
        groups: menu.querySelectorAll('.model-group-head').length,
        items: menu.querySelectorAll('.model-item').length,
        checked: menu.querySelectorAll('.model-item-cur').length,
        firstHead: menu.querySelector('.model-group-name')?.textContent?.trim() ?? '',
        checkedItem: menu.querySelector('.model-item.active')?.textContent?.trim() ?? ''
      };
    })()
  `)
  checkTrue('输入框模型下拉**按端点分组**：组头 = 端点名、组下 = 模型目录、当前那条打勾',
    modelMenuGrouped.open === true &&
      modelMenuGrouped.groups === 3 &&
      modelMenuGrouped.items === 9 &&
      modelMenuGrouped.checked === 1,
    modelMenuGrouped)
  await win.webContents.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('.model-menu .model-item'));
      const target = items.find((b) => !b.querySelector('.model-item-cur'));
      if (target) target.click();
      return !!target;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  checkTrue('点组下一条**非当前**模型 → 真的发起了 models:set-entry 切换（不是摆设）',
    modelEntryCalls.length === 1 &&
      typeof modelEntryCalls[0]?.profileId === 'string' &&
      typeof modelEntryCalls[0]?.entryId === 'string' &&
      modelEntryCalls[0].entryId.endsWith('-e2'),
    modelEntryCalls)

  // —— 真实用量（只计量、不记钱）—— 为什么真推 IPC 事件而不直接看 store：用量从厂商上报 → Provider 解析
  // → runner 累加 → chat:done 带货 → preload 桥 → store 记账 → 界面渲染，推事件能覆盖桥之后的整条链。
  // 上面两处 chat:done 带的是 payload: null —— 那正是“厂商没报用量”那一档：先确认它不冒出一个 0（假 0 更坏）。
  const readUsageChip = async () =>
    win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('.usage-chip')
        if (!el) return { total: null, last: null, saved: null, rates: [], tier: null, title: '' }
        return {
          total: el.querySelector('.usage-total')?.textContent ?? null,
          last: el.querySelector('.usage-last')?.textContent ?? null,
          saved: el.querySelector('.usage-saved')?.textContent ?? null,
          // 注入税（plan19 §5.2）：第三笔账，同样要"有就显示、没有就不显示"
          memoryTax: el.querySelector('.usage-memory')?.textContent ?? null,
          // 命中率 / 思考占比：两块可能都在、只在一块、或一块都没有（"都没有"正是**厂商没报**那档，不许冒 0%）
          rates: Array.from(el.querySelectorAll('.usage-rate')).map((n) => n.textContent),
          tier: el.querySelector('.usage-tier')?.textContent ?? null,
          title: el.getAttribute('title') ?? ''
        }
      })()
    `)

  const chipNull = await readUsageChip()
  checkTrue('厂商没报用量时，工具栏**不冒出用量牌**（宁可没有，也不写一笔假账）',
    chipNull.total === null, chipNull)

  // 真报一轮：1200 + 340 = 1540 → 显示 1.5k。缓存/推理都明确报 0（厂商说了没命中也没思考）→ 该显示 0%，不许当“没报”藏起来
  win.webContents.send('chat:done', {
    conversationId: 'c1',
    payload: {
      usage: { promptTokens: 1200, completionTokens: 340, cachedPromptTokens: 0, reasoningTokens: 0 },
      avoided: 4800,
      // 注入税（plan19 §5.2）：本轮记忆段占掉的估算 token —— 有就显示，且必须标"估"
      memoryTokens: 340,
      tier: 'light'
    }
  })
  await new Promise((r) => setTimeout(r, 500))
  const chip1 = await readUsageChip()
  checkTrue('判据 13b：注入税出现在用量牌上，且标明是**估算**',
    typeof chip1.memoryTax === 'string' && chip1.memoryTax.includes('340') && chip1.memoryTax.includes('估'),
    chip1.memoryTax)

  // 再来一轮：+1000 → 累计 2540 → 2.5k（这条才是“累计”的判据）；命中 800/2000 = 40%，推理 200/540 = 37%
  win.webContents.send('chat:done', {
    conversationId: 'c1',
    payload: {
      usage: { promptTokens: 800, completionTokens: 200, cachedPromptTokens: 800, reasoningTokens: 200 },
      avoided: 400,
      tier: 'balanced'
    }
  })
  await new Promise((r) => setTimeout(r, 500))
  const chip2 = await readUsageChip()

  checkTrue('厂商真报了 → 用量牌出现，且填的是**真实值**（1540 → 1.5k）',
    chip1.total === '1.5k' && chip1.last === '+1.5k', chip1)
  checkTrue('第二轮**累计**上去（2540 → 2.5k，不是把上一轮覆盖掉）',
    chip2.total === '2.5k' && chip2.last === '+1.0k', chip2)
  checkTrue('悬停说明里**输入/输出分开列**（否则用户没法判断钱花在哪一头上）',
    chip1.title.includes('输入') && chip1.title.includes('输出') && chip1.title.includes('最近一轮'),
    chip1.title)
  // plan8 R9.1：窗口化省下的量要看得见，**且不许混进厂商真值**
  checkTrue('省下的量单独显示（5.2k = 4800+400），**没有混进 2.5k 那个真值里**',
    chip2.saved === '省 5.2k' && chip2.total === '2.5k', chip2)
  checkTrue('悬停说明把"省下的量"标成**本地估算**（它和厂商账不是一个来源）',
    chip2.title.includes('本地估算'), chip2.title)
  // plan8 R9.1 §七①：命中率 / 思考占比 —— 厂商**报了**才有资格出现
  checkTrue('厂商报了 0 → 显示 `命中 0%` / `思考 0%`（"真 0"是事实，不许当成"没报"藏掉）',
    chip1.rates.length === 2 && chip1.rates[0] === '命中 0%' && chip1.rates[1] === '思考 0%', chip1.rates)
  checkTrue('第二轮按**累计**算命中率（800/2000 = 40%；推理 200/540 = 37%）',
    chip2.rates.length === 2 && chip2.rates[0] === '命中 40%' && chip2.rates[1] === '思考 37%', chip2.rates)
  // 档位：计量必须记下“这轮用的哪一档”，否则事后按档位比数字说不清来源；这里顺带验它跟着轮次更新
  checkTrue('用量牌显示这轮用的档位（第一轮 light → 第二轮 balanced，跟着更新）',
    chip1.tier === '轻量' && chip2.tier === '平衡', { c1: chip1.tier, c2: chip2.tier })

  // 落盘那一环：界面记账只是“看得见”，写进会话索引才是“记得住”；这条盯渲染端→主进程的载荷
  const savedUsage = [...convSaveCalls].reverse().find((c) => c.id === 'c1')?.usage
  checkTrue('`conv:save` 的载荷**带上了账本**（否则一重启"本会话累计"就归零 —— 那数字会骗人）',
    savedUsage?.promptTokens === 2000 && savedUsage?.completionTokens === 540,
    savedUsage)

  // 混进一轮没报缓存字段的 → 累计命中率变成“不知道”、整块消失，而不是写一个 0%（那等于替厂商宣布“一点没命中”）。
  // ⚠️ payload 里必须是显式 null（省略键表示“这份账不含这条信息”，累加时会跳过，老数据靠它保持兼容）。
  win.webContents.send('chat:done', {
    conversationId: 'c1',
    payload: {
      usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: null, reasoningTokens: null }
    }
  })
  await new Promise((r) => setTimeout(r, 500))
  const chip3 = await readUsageChip()
  checkTrue('有一轮没报缓存 → 命中率整块消失（不写 0%），但主计数照常累计（2100+560 = 2.7k）',
    chip3.rates.length === 0 && chip3.total === '2.7k' && chip3.last === '+120', chip3)

  // ── 源代码管理（plan16）：看得见改动 → 勾选暂存 → 写消息 → 提交 → 清空 ──────────
  // ⚠️ 这一段跑在最后：前面几段探针动过工作台布局（分栏 / 折叠 / 关设置窗），
  //    所以开头先**自愈**地把一栏找回来，否则失败理由会伪装成"面板坏了"。
  const openScmPanel = async () => {
    for (let i = 0; i < 8; i += 1) {
      const has = await win.webContents.executeJavaScript("(() => !!document.querySelector('.scm-panel'))()")
      if (has) return true
      await win.webContents.executeJavaScript(`
        (() => {
          const add = document.querySelector('.pane-add');
          if (add) { add.click(); return true; }
          const toggle = Array.from(document.querySelectorAll('button')).find((b) => (b.title || '').includes('工作台'));
          if (toggle) { toggle.click(); return true; }
          return false;
        })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      await win.webContents.executeJavaScript(`
        (() => {
          const pick = Array.from(document.querySelectorAll('.wb-pick'))
            .find((b) => (b.textContent || '').includes('源代码管理'));
          if (pick) pick.click();
          return !!pick;
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  /** 整份重读面板现状（不做增量推断 —— 面板自己就是这么设计的） */
  const readScm = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const p = document.querySelector('.scm-panel');
        if (!p) return { hasPanel: false };
        const btn = p.querySelector('.scm-btn-primary');
        return {
          hasPanel: true,
          branch: p.querySelector('.scm-title')?.textContent.trim() ?? null,
          count: p.querySelector('.scm-count')?.textContent.trim() ?? null,
          empty: p.querySelector('.scm-empty')?.textContent.trim() ?? null,
          groups: Array.from(p.querySelectorAll('.scm-group')).map((g) => ({
            head: g.querySelector('.scm-group-head')?.textContent.trim() ?? '',
            items: Array.from(g.querySelectorAll('.scm-line')).map((l) => ({
              rel: l.querySelector('.scm-rel')?.textContent.trim() ?? '',
              kind: l.querySelector('.scm-kind')?.textContent.trim() ?? '',
              kindLabel: l.querySelector('.scm-kind')?.getAttribute('title') ?? '',
              checked: l.querySelector('.scm-check')?.checked ?? null
            }))
          })),
          hasInput: !!p.querySelector('.scm-input'),
          commitDisabled: btn ? btn.disabled : null,
          commitTitle: btn ? (btn.getAttribute('title') ?? '') : '',
          why: p.querySelector('.scm-why')?.textContent.trim() ?? null,
          hasDiff: !!p.querySelector('.scm-diff')
        };
      })()
    `)

  const tickFirstCheck = async () => {
    await win.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('.scm-check');
        if (box) box.click();
        return !!box;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
  }

  // ① 先切到「不是 Git 仓库」那一档：空面板会被读成"没有改动"，必须明说原因
  gitMode = 'not-repo'
  gitBroadcast()
  const scmReady = await openScmPanel()
  await new Promise((r) => setTimeout(r, 700))
  const scmNoRepo = await readScm()
  console.log('SCM_NO_REPO=' + JSON.stringify(scmNoRepo))
  checkTrue(
    '非 Git 工作区：面板**明说原因**（空面板会被读成"没有改动"，那是假账）',
    scmReady === true &&
      scmNoRepo.hasPanel === true &&
      typeof scmNoRepo.empty === 'string' &&
      scmNoRepo.empty.includes('不是 Git 仓库') &&
      // 摆着一个点不动的提交框比没有更糟 —— 非仓库时整个表单都不该出现
      scmNoRepo.hasInput === false,
    scmNoRepo
  )

  // ② 切回真仓库：三条改动（两条已改 + 一条未跟踪）
  gitMode = 'repo'
  gitBroadcast()
  await new Promise((r) => setTimeout(r, 800))
  const scmList = await readScm()
  console.log('SCM_LIST=' + JSON.stringify(scmList))
  checkTrue(
    '有改动时**一条不漏**列出来（2 条已改 + 1 条未跟踪）',
    scmList.hasPanel === true &&
      scmList.groups.length === 1 &&
      scmList.groups[0].items.length === 3,
    scmList.groups
  )
  checkTrue(
    '状态字母带**中文说明**（不假设用户懂 `??` 是什么意思）',
    (scmList.groups[0]?.items ?? []).every((i) => i.rel.length > 0 && i.kindLabel.length > 0),
    (scmList.groups[0]?.items ?? []).map((i) => `${i.kind}=${i.kindLabel}`)
  )
  checkTrue(
    '顶部一行显示**分支 + 改动计数**',
    scmList.branch === 'master' && scmList.count === '● 3 项改动',
    { branch: scmList.branch, count: scmList.count }
  )
  checkTrue(
    '没勾文件时**提交禁用且明说为什么**（禁用不给理由 = 用户只会以为按钮坏了）',
    scmList.commitDisabled === true &&
      scmList.why === '先勾选要提交的文件' &&
      scmList.commitTitle.includes('先勾选'),
    { disabled: scmList.commitDisabled, why: scmList.why, title: scmList.commitTitle }
  )

  // ③ 点文件看差异：增删行必须被着色（"-"红、"+"绿）
  await win.webContents.executeJavaScript(`
    (() => {
      const rel = document.querySelector('.scm-rel');
      if (rel) rel.click();
      return !!rel;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))
  const scmDiffView = await win.webContents.executeJavaScript(`
    (() => {
      const d = document.querySelector('.scm-diff');
      if (!d) return { hasDiff: false };
      const lines = Array.from(d.querySelectorAll('.scm-d-line'));
      return {
        hasDiff: true,
        rel: d.querySelector('.scm-diff-rel')?.textContent.trim() ?? '',
        add: lines.filter((l) => l.classList.contains('scm-d-add')).length,
        del: lines.filter((l) => l.classList.contains('scm-d-del')).length,
        meta: lines.filter((l) => l.classList.contains('scm-d-meta')).length
      };
    })()
  `)
  console.log('SCM_DIFF=' + JSON.stringify(scmDiffView))
  checkTrue(
    '点文件 → 展开差异，且**增删行分别着色**（新增 2 行 / 删除 1 行 / 位置头 1 行）',
    scmDiffView.hasDiff === true &&
      scmDiffView.add === 2 &&
      scmDiffView.del === 1 &&
      scmDiffView.meta === 1,
    scmDiffView
  )
  // 收起，别让它一直占着面板高度
  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.scm-diff-head .scm-btn')).find((x) => x.textContent.includes('收起'));
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))

  // ④ 勾选 = 暂存：这一条要**真的挪进「已暂存的更改」组**
  await tickFirstCheck()
  const scmStaged = await readScm()
  console.log('SCM_STAGED=' + JSON.stringify(scmStaged))
  checkTrue(
    '勾选 → 这条**真的进了「已暂存的更改」组**（不是本地把勾打上就完事）',
    gitStageCalls.length === 1 &&
      scmStaged.groups.length === 2 &&
      scmStaged.groups[0].head.includes('已暂存的更改 (1)') &&
      scmStaged.groups[1].head.includes('更改 (2)'),
    { calls: gitStageCalls, heads: scmStaged.groups.map((g) => g.head) }
  )
  checkTrue(
    '勾选项的**勾选态以 git 回话为准**（暂存成功后重载出来的确实是勾上的）',
    scmStaged.groups[0]?.items?.[0]?.checked === true,
    scmStaged.groups[0]?.items
  )

  // ⑤ 再点一次 = 取消暂存（只动暂存区，**工作区的改动还在** —— 所以回到「更改」组而不是消失）
  await tickFirstCheck()
  const scmUnstaged = await readScm()
  console.log('SCM_UNSTAGED=' + JSON.stringify(scmUnstaged))
  checkTrue(
    '取消勾选 → 退回「更改」组且**条数不变**（取消暂存不丢改动）',
    gitUnstageCalls.length === 1 &&
      scmUnstaged.groups.length === 1 &&
      scmUnstaged.groups[0].items.length === 3,
    { calls: gitUnstageCalls, groups: scmUnstaged.groups }
  )

  // ⑥ 重新勾上，然后写提交消息
  await tickFirstCheck()
  const scmNoMsg = await readScm()
  checkTrue(
    '勾了文件但**没写消息** → 仍然禁用，且说的是"还没写提交消息"（理由跟着状态变）',
    scmNoMsg.commitDisabled === true && scmNoMsg.why === '还没写提交消息',
    { disabled: scmNoMsg.commitDisabled, why: scmNoMsg.why }
  )
  // ⚠️ React 受控 textarea：直接改 `.value` 不会触发 onChange —— 必须走原型上的原生 setter + input 事件
  await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('.scm-input');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'feat: 补上源代码管理面板');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))
  const scmCanCommit = await readScm()
  checkTrue(
    '写了消息 → 提交按钮**可用**了',
    scmCanCommit.commitDisabled === false,
    scmCanCommit
  )

  // ⑦ 提交：暂存的那条被提交掉，列表清空，顶部切成「↑ N 个提交待推送」
  await win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.scm-btn-primary');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const scmAfterCommit = await readScm()
  console.log('SCM_AFTER_COMMIT=' + JSON.stringify(scmAfterCommit))
  checkTrue(
    '提交后**列表清空**（只提交勾上的那一条，其余两条还在）',
    gitCommitCalls.length === 1 &&
      gitCommitCalls[0] === 'feat: 补上源代码管理面板' &&
      scmAfterCommit.groups.length === 1 &&
      scmAfterCommit.groups[0].items.length === 2,
    { calls: gitCommitCalls, groups: scmAfterCommit.groups }
  )
  checkTrue(
    '提交后顶部显示「↑ 1 个提交待推送」（本批不做远程，但"堆积了"是真实信息）',
    scmAfterCommit.count === '↑ 1 个提交待推送',
    scmAfterCommit.count
  )
  const scmInputLen = await win.webContents.executeJavaScript(
    "(() => (document.querySelector('.scm-input')?.value ?? '').length)()"
  )
  checkTrue('提交完清空输入框（否则下一条会沿用旧说明）', scmInputLen === 0, scmInputLen)

  // ⑧ 外面改了文件（Agent 改 / 终端跑命令）→ **主进程广播** → 面板自动重拉（不靠定时器轮询）
  gitChanges = gitChanges.concat([
    { path: 'src/main/ipc.ts', kind: 'modified', staged: ' ', unstaged: 'M' }
  ])
  gitBroadcast()
  await new Promise((r) => setTimeout(r, 800))
  const scmExternal = await readScm()
  console.log('SCM_EXTERNAL=' + JSON.stringify(scmExternal))
  checkTrue(
    '外面的改动（Agent / 终端）经**广播**自动出现（不用手点刷新）',
    (scmExternal.groups[0]?.items ?? []).some((i) => i.rel === 'src/main/ipc.ts'),
    (scmExternal.groups[0]?.items ?? []).map((i) => i.rel)
  )

  // ── 记忆（plan19 批 1）：看得见 → 广播自动重拉 → 删除后消失 ──────────────────
  // 判据 5a（列表 / 删除）· 判据 15（面板形态 + 消息主干**零非消息行**）· 判据 16（走 store、不一次性 pull）
  // ⚠️ 这三条**不能被"页面没崩"糊过去**：空态与坏掉长得一模一样，故每条都断言"该出现的东西出现了"。
  const openMemoryPanel = async () => {
    for (let i = 0; i < 8; i += 1) {
      const has = await win.webContents.executeJavaScript("(() => !!document.querySelector('.mem-panel'))()")
      if (has) return true
      await win.webContents.executeJavaScript(`
        (() => {
          const add = document.querySelector('.pane-add');
          if (add) { add.click(); return true; }
          const toggle = Array.from(document.querySelectorAll('button')).find((b) => (b.title || '').includes('工作台'));
          if (toggle) { toggle.click(); return true; }
          return false;
        })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      await win.webContents.executeJavaScript(`
        (() => {
          const pick = Array.from(document.querySelectorAll('.wb-pick'))
            .find((b) => (b.textContent || '').includes('记忆'));
          if (pick) pick.click();
          return !!pick;
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  /** 整份重读面板现状（不做增量推断 —— 面板自己就是这么设计的） */
  const readMemoryPanel = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const p = document.querySelector('.mem-panel');
        if (!p) return { hasPanel: false };
        return {
          hasPanel: true,
          title: p.querySelector('.mem-title')?.textContent.trim() ?? null,
          stat: p.querySelector('.mem-stat')?.textContent.trim() ?? null,
          inspectTitle: p.querySelector('.mem-inspect-title')?.textContent.trim() ?? null,
          inspectRows: Array.from(p.querySelectorAll('.mem-inspect-row .mem-name')).map((n) => n.textContent.trim()),
          names: Array.from(p.querySelectorAll('.mem-row .mem-name')).map((n) => n.textContent.trim()),
          badges: Array.from(p.querySelectorAll('.mem-row .mem-badge')).map((n) => n.textContent.trim()),
          warnRows: p.querySelectorAll('.mem-warn-row').length,
          actions: Array.from(p.querySelectorAll('.mem-row-actions button')).map((b) => b.textContent.trim()),
          // 消息主干只许承载 user / assistant —— 这条**不许**被"面板自己好看"掩盖
          msgClasses: Array.from(document.querySelectorAll('.msg')).map((m) => m.className),
          noticeShown: !!document.querySelector('.mem-notice')
        };
      })()
    `)

  const memReady = await openMemoryPanel()
  await new Promise((r) => setTimeout(r, 700))
  const memList = await readMemoryPanel()
  console.log('MEMORY_LIST=' + JSON.stringify(memList))
  checkTrue(
    '记忆页签：列出条目并给出分类徽标（空态不算通过）',
    memReady === true &&
      memList.hasPanel === true &&
      memList.names.includes('prefers-tables') &&
      memList.names.includes('uses-pnpm') &&
      memList.badges.includes('风格'),
    memList
  )
  checkTrue(
    '巡检区只收 `origin: model` 的条目（用户手写的不进巡检），且标出条数',
    memList.inspectRows.length === 1 &&
      memList.inspectRows[0] === 'uses-pnpm' &&
      (memList.inspectTitle || '').includes('1'),
    memList.inspectRows
  )
  // 判据 15 的后半：护栏 2 走面板，**不许**在消息主干里插非消息行
  checkTrue(
    '判据 15：消息主干零「非消息行」（`.msg` 只承载 user / assistant）',
    memList.msgClasses.length > 0 &&
      memList.msgClasses.every((c) => /^msg msg-(user|assistant)$/.test(c)),
    { count: memList.msgClasses.length, classes: [...new Set(memList.msgClasses)] }
  )

  // ── 批 4：重复纠正率 / 误伤率**真的显示在界面上**（不是只算了没地方看）──
  checkTrue(
    '批 4：统计行显示重复纠正率与误伤率（两个指标有可观测读数）',
    (memList.stat || '').includes('重复纠正') && (memList.stat || '').includes('误伤'),
    memList.stat
  )

  // ── 批 4：标记「这条不对」真的走 IPC（`memory:flag`）──
  const flagClicked = await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.mem-row'))
        .find((r) => (r.querySelector('.mem-name')?.textContent || '').includes('prefers-tables'));
      if (!row) return false;
      const btn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '标记不对');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))
  checkTrue(
    '批 4：「标记不对」走 `memory:flag`（误伤率的数据入口真的通了）',
    flagClicked === true && memoryFlagCalls.length >= 1 && memoryFlagCalls[0] === 'prefers-tables',
    { flagClicked, calls: memoryFlagCalls }
  )

  // ── 批 3：Playbook 面板在右抽屉可见（不是"代码在、用户碰不到"）──
  const pbOpened = await win.webContents.executeJavaScript(`
    (() => {
      const pick = Array.from(document.querySelectorAll('.wb-pick'))
        .find((b) => (b.textContent || '').includes('Playbook'));
      if (pick) pick.click();
      return !!pick;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  // ⚠️ 记忆与 Playbook 两块面板共用 `.mem-panel` 类，且可能**同时挂在抽屉里** ——
  // 故按**标题**定位，而不是 `querySelector` 拿第一个（那会读到记忆面板，红得莫名其妙）
  const pbPanel = await win.webContents.executeJavaScript(`
    (() => {
      const p = Array.from(document.querySelectorAll('.mem-panel'))
        .find((n) => (n.querySelector('.mem-title')?.textContent || '').trim() === 'Playbook');
      if (!p) return { hasPanel: false };
      return {
        hasPanel: true,
        title: p.querySelector('.mem-title')?.textContent.trim() ?? null,
        names: Array.from(p.querySelectorAll('.mem-row .mem-name')).map((n) => n.textContent.trim()),
        badges: Array.from(p.querySelectorAll('.mem-row .mem-badge')).map((n) => n.textContent.trim())
      };
    })()
  `)
  console.log('PLAYBOOK_PANEL=' + JSON.stringify(pbPanel))
  checkTrue(
    '批 3：Playbook 面板可从右抽屉打开，且列出条目与标签（模型存的东西用户看得见）',
    pbOpened === true &&
      pbPanel.hasPanel === true &&
      pbPanel.names.includes('edit-react-component') &&
      pbPanel.badges.includes('file-edit'),
    pbPanel
  )

  // 判据 16：外面改了（模型写入 / 另一窗口）→ **广播** → 面板自动重拉。
  // 这一条同时证明"数据走 store 订阅"，因为面板没有重新挂载、也没人点刷新。
  memoryEntries = memoryEntries.concat([
    {
      name: 'from-broadcast',
      description: '广播来的',
      class: 'default',
      origin: 'model',
      evidence: null,
      createdAt: '2026-09-15T02:00:00.000Z',
      updatedAt: '2026-09-15T02:00:00.000Z',
      body: '正文。',
      file: '/mem/notes/from-broadcast.md'
    }
  ])
  memoryBroadcast()
  await new Promise((r) => setTimeout(r, 800))
  const memAfterBroadcast = await readMemoryPanel()
  console.log('MEMORY_BROADCAST=' + JSON.stringify(memAfterBroadcast))
  checkTrue(
    '判据 16：外部写入经**广播**自动出现（证明面板数据走 store 订阅，不是一次性 pull）',
    memAfterBroadcast.names.includes('from-broadcast'),
    memAfterBroadcast.names
  )

  // 判据 5a：删除 → 走 IPC（`memory:delete`）→ 列表不再显示
  // ⚠️ 删的是**预先存在**的那条，不是上面广播加进来的 —— 否则广播一坏、这条跟着红，
  //    失败理由就变成"删不掉 vs 那条根本没出现"两种，信号是歧义的（证伪实验抓到的）
  const memDeleteClicked = await win.webContents.executeJavaScript(`
    (() => {
      window.confirm = () => true;
      const row = Array.from(document.querySelectorAll('.mem-row'))
        .find((r) => (r.querySelector('.mem-name')?.textContent || '').includes('uses-pnpm'));
      if (!row) return false;
      const btn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === '删除');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))
  const memAfterDelete = await readMemoryPanel()
  console.log('MEMORY_DELETE=' + JSON.stringify(memAfterDelete))
  checkTrue(
    '判据 5a：删除走 `memory:delete`，且列表不再显示那一条（删了还留着 = 假成功）',
    memDeleteClicked === true &&
      memoryDeleteCalls.includes('/mem/notes/uses-pnpm.md') &&
      !memAfterDelete.names.includes('uses-pnpm'),
    { clicked: memDeleteClicked, calls: memoryDeleteCalls, names: memAfterDelete.names }
  )

  // 护栏 2（D-043）：本轮写入痕迹的面板。面板只显示**当前会话**的痕迹 ——
  // 故正反两向都要断言：匹配的会话要出现，不匹配的**必须不出现**（否则"只显示当前会话"就是句空话）
  memoryNoticeBroadcast({ conversationId: 'not-this-conversation', written: ['x'], rejected: [] })
  await new Promise((r) => setTimeout(r, 500))
  const noticeForOther = await win.webContents.executeJavaScript(
    "(() => !!document.querySelector('.mem-notice'))()"
  )
  memoryNoticeBroadcast({ conversationId: 'c1', written: ['prefers-tables'], rejected: [] })
  await new Promise((r) => setTimeout(r, 600))
  const memNotice = await win.webContents.executeJavaScript(`
    (() => {
      const n = document.querySelector('.mem-notice');
      return n ? { shown: true, text: n.querySelector('.mem-notice-text')?.textContent.trim() ?? '' } : { shown: false };
    })()
  `)
  console.log('MEMORY_NOTICE=' + JSON.stringify({ noticeForOther, memNotice }))
  checkTrue(
    '护栏 2（D-043）：本轮写入痕迹推给对话流里的面板（当场可见，零摩擦）',
    memNotice.shown === true && memNotice.text.includes('prefers-tables'),
    memNotice
  )
  checkTrue(
    '护栏 2：别的会话的痕迹**不显示**（"只显示当前会话"必须是条真规矩，不是句空话）',
    noticeForOther === false,
    noticeForOther
  )

  // ── 通路 B「选中即记」（plan19 §九 批 1 · 判据 3）─────────────────────────
  // 它是**唯一不经过模型**的写入通路：结构上安全、证据是原话、`origin: user` 的落点。
  // 断言分三下：没选中时**不给**入口 → 选中后出现 → 保存落盘的 input 里 origin=user 且证据指针精确。
  const openCtxMenuOnMessage = (withSelection) =>
    win.webContents.executeJavaScript(`
      (() => {
        const content = document.querySelector('.msg-assistant .msg-content') || document.querySelector('.msg .msg-content');
        if (!content) return false;
        const sel = window.getSelection();
        sel.removeAllRanges();
        if (${withSelection}) {
          const range = document.createRange();
          range.selectNodeContents(content);
          sel.addRange(range);
        }
        const box = content.closest('.msg');
        box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
        return true;
      })()
    `)

  const menuHasCapture = () =>
    win.webContents.executeJavaScript(`
      (() => Array.from(document.querySelectorAll('.wb-menu .wb-pick'))
        .some((b) => (b.textContent || '').includes('记住这句')))()
    `)

  await openCtxMenuOnMessage(false)
  await new Promise((r) => setTimeout(r, 400))
  const captureWithoutSelection = await menuHasCapture()
  // 关掉菜单（点空白）
  await win.webContents.executeJavaScript(
    "(() => { document.body.click(); return true; })()"
  )
  await new Promise((r) => setTimeout(r, 300))

  await openCtxMenuOnMessage(true)
  await new Promise((r) => setTimeout(r, 400))
  const captureWithSelection = await menuHasCapture()
  const captureOpened = await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.wb-menu .wb-pick'))
        .find((b) => (b.textContent || '').includes('记住这句'));
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const captureCard = await win.webContents.executeJavaScript(`
    (() => {
      const c = document.querySelector('.mem-capture');
      return c ? { shown: true, body: c.querySelector('.mem-capture-body')?.textContent ?? '' } : { shown: false };
    })()
  `)
  console.log('MEMORY_CAPTURE=' + JSON.stringify({ captureWithoutSelection, captureWithSelection, captureCard }))
  checkTrue(
    '通路 B：**没选中就没有入口**（点进来是空的入口比没有更糟）',
    captureWithoutSelection === false,
    captureWithoutSelection
  )
  checkTrue(
    '通路 B：选中后菜单出现「记住这句」，且卡片正文 = 选中的原话',
    captureWithSelection === true && captureCard.shown === true && captureCard.body.trim().length > 0,
    { captureWithSelection, captureCard }
  )

  // 保存 → 断言落到主进程的 input 形状（origin / 证据指针）
  const saveBefore = memorySaveCalls.length
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.mem-capture-actions button'))
        .find((b) => b.textContent.trim() === '保存');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const capturedInput = memorySaveCalls[saveBefore]
  console.log('MEMORY_CAPTURE_SAVE=' + JSON.stringify(capturedInput ?? null))
  checkTrue(
    '判据 3：通路 B 落盘时 `origin: user` 且证据指针精确（会话 id + 消息序号）',
    !!capturedInput &&
      capturedInput.origin === 'user' &&
      capturedInput.evidence &&
      typeof capturedInput.evidence.conversationId === 'string' &&
      capturedInput.evidence.conversationId.length > 0 &&
      Number.isInteger(capturedInput.evidence.turnIndex),
    capturedInput
  )

  // ── 时间线（plan26 S2 · D-078）：执行事件流回放 —— 页签可达 + 六 kind 渲染 + scope 切换真的走 IPC ──
  // 判据 4（真渲染门禁）：验的是**布局与渲染**；数据链路（IPC 往返）由本段断言入参+列表变化，
  // 但桩全部 IPC 的老局限仍在 —— 真数据链路由单测与真机冒烟兜底。
  const openTimelinePanel = async () => {
    for (let i = 0; i < 8; i += 1) {
      const has = await win.webContents.executeJavaScript("(() => !!document.querySelector('.tl-root'))()")
      if (has) return true
      await win.webContents.executeJavaScript(`
        (() => {
          const add = document.querySelector('.pane-add');
          if (add) { add.click(); return true; }
          const toggle = Array.from(document.querySelectorAll('button')).find((b) => (b.title || '').includes('工作台'));
          if (toggle) { toggle.click(); return true; }
          return false;
        })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      await win.webContents.executeJavaScript(`
        (() => {
          const pick = Array.from(document.querySelectorAll('.wb-pick'))
            .find((b) => (b.textContent || '').includes('时间线'));
          if (pick) pick.click();
          return !!pick;
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }
  const readTimelinePanel = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const p = document.querySelector('.tl-root');
        if (!p) return { hasPanel: false };
        return {
          hasPanel: true,
          count: p.querySelectorAll('.tl-item').length,
          kinds: Array.from(p.querySelectorAll('.tl-item .tl-kind')).map((n) => n.textContent.trim()),
          subBadges: p.querySelectorAll('.tl-item .tl-sub').length,
          texts: Array.from(p.querySelectorAll('.tl-item .tl-text')).map((n) => n.textContent.trim()),
          countLabel: p.querySelector('.tl-count')?.textContent.trim() ?? null
        };
      })()
    `)

  const tlOpened = await openTimelinePanel()
  await new Promise((r) => setTimeout(r, 700))
  const tlFirst = await readTimelinePanel()
  console.log('TIMELINE=' + JSON.stringify(tlFirst))
  checkTrue(
    '时间线页签：从右抽屉打开，且六种事件 kind 全部渲染（空态不算通过）',
    tlOpened === true &&
      tlFirst.hasPanel === true &&
      ['开始', '工具调用', '工具结果', '审批', '裁剪', '结束'].every((k) => tlFirst.kinds.includes(k)),
    tlFirst
  )
  checkTrue(
    '时间线：子代理事件带「子」徽标（agentScope=sub 在界面上可区分，盲审 A P0-2 的可见性）',
    tlFirst.hasPanel === true && tlFirst.subBadges >= 2,
    tlFirst.subBadges
  )
  checkTrue(
    '时间线：摘要行渲染 耗时/大小/审批结论（元数据可读，不渲染正文）',
    tlFirst.texts.some((t) => t.includes('ms')) &&
      tlFirst.texts.some((t) => t.includes('KB')) &&
      tlFirst.texts.some((t) => t.includes('拒绝')),
    tlFirst.texts
  )
  // scope 切换：点「全部」→ 查询不带会话过滤（桩按 query 过滤，列表条数会变）→ 点回「本会话」
  const tlSwitchToAll = await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.tl-root .tl-scope')).find((x) => x.textContent.trim() === '全部');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const tlAll = await readTimelinePanel()
  checkTrue(
    '时间线：「全部」切档真的走 IPC（查询不带会话过滤 → 列表多出别的会话的事件）',
    tlSwitchToAll === true &&
      lastExecEventsQuery !== null &&
      !lastExecEventsQuery.conversationId &&
      tlAll.count === tlFirst.count + 1,
    { query: lastExecEventsQuery, before: tlFirst.count, after: tlAll.count }
  )
  const tlSwitchBack = await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.tl-root .tl-scope')).find((x) => x.textContent.trim() === '本会话');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const tlBack = await readTimelinePanel()
  checkTrue(
    '时间线：「本会话」切回（查询带 conversationId=c1 → 列表回到本会话集合）',
    tlSwitchBack === true &&
      lastExecEventsQuery !== null &&
      lastExecEventsQuery.conversationId === 'c1' &&
      tlBack.count === tlFirst.count,
    { query: lastExecEventsQuery, count: tlBack.count }
  )
  const shotTimeline = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-timeline.png'), shotTimeline.toPNG())

  // —— 滚动联动（plan41 S2）：scroll spy 高亮当前轮 + 激活刻度浮出预览卡 ——
  // ⚠️ 位置必须在「新会话首条」探针之前：那一步会切到 0 消息的新会话，
  // 刻度条按设计 <2 条不渲染，放后面必然读到 0 根。
  // peek 判据取 **.on 刻度内**的卡（每根 tick 各有一张常驻 peek，查第一根会假红）；
  // 且必须对 computed display 判定（常驻 DOM 只靠 CSS 控显隐，只判元素存在是假绿）。
  const scrollSpy = await win.webContents.executeJavaScript(`
    (async () => {
      const box = document.querySelector('.chat-messages');
      if (!box) return null;
      box.scrollTop = box.scrollHeight;
      await new Promise((r) => setTimeout(r, 400));
      const ticks = [...document.querySelectorAll('.chat-outline-tick')];
      const onIdx = ticks.findIndex((t) => t.classList.contains('on'));
      const peek = document.querySelector('.chat-outline-tick.on .chat-outline-peek');
      const out = { onIdx, total: ticks.length, peekShown: !!peek && getComputedStyle(peek).display !== 'none' };
      box.scrollTop = 0;
      return out;
    })()
  `)
  checkTrue(
    '滚到最底 → 最后一根刻度激活（scroll spy 联动）',
    scrollSpy !== null && scrollSpy.total >= 2 && scrollSpy.onIdx === scrollSpy.total - 1,
    scrollSpy
  )
  checkTrue('激活刻度浮出预览卡（向左）', scrollSpy !== null && scrollSpy.peekShown === true, scrollSpy)

  // —— 语音输入（plan45）：按钮 → 一次性披露 → 录音（假音频设备）→ 停止 → 转写插光标处 ——
  const voiceFlow = await win.webContents.executeJavaScript(`
    (async () => {
      const ta = document.querySelector('.console-input');
      if (!ta) return { fail: 'no-textarea' };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '前置文字');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(4, 4);
      const btn = document.querySelector('.voice-btn');
      if (!btn) return { fail: 'no-voice-btn' };
      const r = btn.getBoundingClientRect();
      btn.click();
      await new Promise((x) => setTimeout(x, 400));
      const modal = document.querySelector('.voice-disclosure');
      const modalText = modal ? modal.textContent : '';
      const confirmBtn = modal
        ? Array.from(modal.querySelectorAll('button')).find((b) => b.textContent.includes('开始录音'))
        : null;
      if (confirmBtn) confirmBtn.click();
      await new Promise((x) => setTimeout(x, 1400));
      const recOn = !!document.querySelector('.voice-btn.recording');
      document.querySelector('.voice-btn')?.click();
      await new Promise((x) => setTimeout(x, 1200));
      return {
        btnVisible: r.width > 0 && r.height > 0,
        modalShown: !!modal,
        modalHasEndpoint: modalText.includes('127.0.0.1:7101'),
        recOn,
        value: document.querySelector('.console-input').value
      };
    })()
  `)
  checkTrue(
    '语音：麦克风按钮可见，首次点击弹一次性披露（含端点地址）',
    voiceFlow.btnVisible === true && voiceFlow.modalShown === true && voiceFlow.modalHasEndpoint === true,
    voiceFlow
  )
  checkTrue(
    '语音：确认后进入录音态；停止后转写文本插入光标处（前置文字之后）',
    voiceFlow.recOn === true && voiceFlow.value === '前置文字 语音转写测试文本',
    voiceFlow
  )
  // 披露已记住：第二次点不再弹，直接录音（决策 4 的"一次性"语义）
  const voiceFlow2 = await win.webContents.executeJavaScript(`
    (async () => {
      const btn = document.querySelector('.voice-btn');
      btn.click();
      await new Promise((x) => setTimeout(x, 500));
      const modal2 = !!document.querySelector('.voice-disclosure');
      const recOn2 = !!document.querySelector('.voice-btn.recording');
      if (recOn2) btn.click();
      await new Promise((x) => setTimeout(x, 1200));
      return { modal2, recOn2 }
    })()
  `)
  checkTrue('语音：披露已确认后不再弹（一次性），可直接复录', voiceFlow2.modal2 === false && voiceFlow2.recOn2 === true, voiceFlow2)

  // —— 新会话首条不重复（0.13.42 反馈）────────────────────────────────
  // conv:create 桩已按真实主进程行为把 firstMessage 播种成第一条用户消息；
  // 若 sendMessage 再追加一次：界面显示两条用户消息、chat:send 载荷里 user 角色两条
  // （模型收到 [user, user]，部分兼容后端会因此卡住/返回空流）
  // ⚠️ 探针带**黑匣子步进 + 15s 自超时 + 事后回读**：上一版在渲染端卡过一次却查不出卡在哪步。
  //    步骤实时写 `window.__fsSteps`，超时后回读它 + 测渲染端是否还响应
  const fsBlackBox = await win.webContents.executeJavaScript(`
    (() => {
      window.__fsSteps = ['probe-start'];
      return 'armed';
    })()
  `)
  const firstSendProbe = await Promise.race([
    win.webContents.executeJavaScript(`
      (async () => {
        const S = (window.__fsSteps = window.__fsSteps || []);
        try {
          const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
            (b.textContent || '').includes('新建任务'));
          S.push('buttons:' + buttons.length);
          const nav = buttons[0];
          if (!nav) return { ok: false, why: '找不到「新建任务」按钮' };
          nav.click();
          S.push('nav-clicked');
          await new Promise((r) => setTimeout(r, 600));
          const ta = document.querySelector('.console-input');
          if (!ta) return { ok: false, why: '新任务页没有输入框' };
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '我喜欢你做汇报时用表格出数据');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          S.push('typed');
          await new Promise((r) => setTimeout(r, 250));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          S.push('enter-dispatched');
          for (let i = 0; i < 12; i += 1) {
            await new Promise((r) => setTimeout(r, 250));
            if (document.querySelector('.chat-view')) break
          }
          S.push('waited');
          return {
            ok: true,
            view: document.querySelector('.chat-view')
              ? 'chat'
              : (document.querySelector('.new-task') ? 'new-task' : '?'),
            userMsgs: Array.from(document.querySelectorAll('.msg-user')).map((m) => m.textContent.trim())
          };
        } catch (err) {
          return { ok: false, why: String(err && err.message ? err.message : err) };
        }
      })()
    `),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, why: '探针 15s 未返回' }), 15000)
    )
  ])
  // 事后回读黑匣子 + 测渲染端是否还活着（区分"渲染端卡死"与"只是这条脚本没跑完"）
  const fsAftermath = await Promise.race([
    win.webContents.executeJavaScript(
      "(() => ({ steps: window.__fsSteps ?? null, view: document.querySelector('.chat-view') ? 'chat' : (document.querySelector('.new-task') ? 'new-task' : '?'), userMsgs: document.querySelectorAll('.msg-user').length }))()"
    ),
    new Promise((resolve) => setTimeout(() => resolve({ steps: null, alive: false }), 5000))
  ])
  console.log('FIRST_SEND=' + JSON.stringify({ fsBlackBox, firstSendProbe, fsAftermath }))
  console.log('FIRST_SEND=' + JSON.stringify(firstSendProbe))
  const lastSend = chatSendCalls[chatSendCalls.length - 1]
  checkTrue(
    '新会话首条只出现一次：界面一条、发给模型的载荷里 user 也只有一条',
    firstSendProbe.ok === true &&
      firstSendProbe.userMsgs.filter((t) => t.includes('我喜欢你做汇报时用表格出数据')).length === 1 &&
      !!lastSend &&
      (lastSend.messages ?? []).filter((m) => m.role === 'user').length === 1,
    { probe: firstSendProbe, sent: lastSend ?? null }
  )

  reportAndExit()
})
