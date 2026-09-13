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
  'settings:save': () => settingsView,
  'settings:test': () => ({ ok: true, message: 'ok' }),
  'settings:set-model': () => settingsView,
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
  'models:available': () => ({
    ok: true,
    message: '拉到 4 个模型',
    models: ['agnes-image-2.5-flash', 'agnes-video-2.5-flash', 'agnes-3.0-flash', 'agnes-3.0-pro']
  }),
  'models:set-entry': () => ({
    profiles: [fakeEndpoint('m1', 'DeepSeek-V4 Flash', 'deepseek-v4-flash', 'deepseek', true)],
    activeId: 'm1',
    filePath: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu\\models.json'
  }),
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
  'chat:send': () => undefined,
  'chat:abort': () => undefined,
  'agent:run': () => ({ ok: true, output: '', rounds: 0, stopReason: 'completed', agent: 'x' }),
  'workspace:get': () => ({ path: 'D:\\jsllworkplace_for_test', custom: false }),
  'workspace:pick': () => null,
  'workspace:set-known': () => null,
  'workspace:reveal': () => undefined,
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
  'conv:create': () => ({ id: 'x' }),
  // 记流水：要验「在别的页面期间流出来的内容有没有被存下来」+ 用量账本有没有跟着走
  'conv:save': ({ id, messages, usage }) => {
    convSaveCalls.push({ id, messages, usage })
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
  'permission:get': () => 'write',
  'permission:set': () => 'write',
  // 省 token 档位：set 回显传入值（与真主进程一致，界面拿返回值更新显示，故 mock 不存状态）
  'token-tier:get': () => 'balanced',
  'token-tier:set': (tier) => tier,
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
  'ui-prefs:get': () => ({
    sidebarWidth: 248,
    dockWidth: 360,
    theme: 'classic',
    workbench: { schemaVersion: 1, panes: [] },
    workbenchSizes: { paneWidths: [] }
  }),
  'ui-prefs:set': (patch) => {
    if (patch && patch.workbench) wbSetCalls.push(Date.now())
    return {
      sidebarWidth: patch?.sidebarWidth ?? 248,
      dockWidth: patch?.dockWidth ?? 360,
      theme: patch?.theme ?? 'classic',
      workbench: patch?.workbench ?? { schemaVersion: 1, panes: [] },
      workbenchSizes: patch?.workbenchSizes ?? { paneWidths: [] }
    }
  },
  'ui-prefs:reset': () => ({
    sidebarWidth: 248,
    dockWidth: 360,
    theme: 'classic',
    workbench: { schemaVersion: 1, panes: [] },
    workbenchSizes: { paneWidths: [] }
  }),
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
    return { ok: false, rel, size: 0, error: '不支持的预览类型' }
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
          { name: '固件镜像.bin', rel: '固件镜像.bin', kind: 'file', size: 4096 }
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
    // 透传参数：像 fs:list 这种需要知道"列哪个目录"的通道必须拿得到实参
    ipcMain.handle(channel, (_e, ...args) => fn(...args))
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
      const tool = document.querySelector('.tool-item');
      const rb = document.querySelector('.reasoning-block');
      const pr = rb ? rb.getBoundingClientRect() : null;
      const host = document.querySelector('.chat-messages');
      const order = host ? Array.from(host.children).map((el) => el.className.split(' ')[0]) : [];
      const lastMsgIdx = order.lastIndexOf('msg');
      const procIdx = Math.max(order.lastIndexOf('tool-log'), order.lastIndexOf('reasoning-block'));
      return {
        toolName: tool ? (tool.querySelector('.tool-name')?.textContent?.trim() ?? null) : null,
        // 关键：显示的是"在干什么"（入参摘要），**不是**干巴巴的「执行中…」
        toolDesc: tool ? (tool.querySelector('.tool-desc')?.textContent?.trim() ?? null) : null,
        hasReasoning: !!rb,
        reasoningLabel: rb ? (rb.querySelector('.reasoning-head')?.textContent?.trim() ?? null) : null,
        reasoningText: rb ? (rb.querySelector('.reasoning-body')?.textContent?.trim() ?? null) : null,
        // **高度合理**才算看得见：被 flex 压成一条线（实测只有 4px）等于没显示
        reasoningVisible: pr ? pr.height > 20 && pr.top < window.innerHeight : false,
        reasoningHeight: pr ? Math.round(pr.height) : 0,
        // 位置：过程块必须在最后一条消息之前 —— 堆到末尾会把报告挤出视野
        domOrder: order,
        processBeforeLastMsg: lastMsgIdx >= 0 && procIdx >= 0 ? procIdx < lastMsgIdx : null
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
        texts: items.map((el) => el.querySelector('.todo-text')?.textContent?.trim() ?? null)
      };
    })()
  `)
  console.log('TODO_PANEL=' + JSON.stringify(todoInfo))
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
      expanded: document.querySelector('.todo-head')?.getAttribute('aria-expanded') ?? null,
      panelH: Math.round(document.querySelector('.todo-panel')?.getBoundingClientRect().height ?? 0)
    }))()
  `)
  console.log('TODO_COLLAPSE=' + JSON.stringify(todoCollapsed))

  await win.webContents.executeJavaScript(`
    (() => {
      const head = document.querySelector('.todo-head');
      if (head) head.click();
      return !!head;
    })()
  `)
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
        msgCount: document.querySelectorAll('.msg').length
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
  await win.webContents.executeJavaScript(`
    (() => {
      const gear = document.querySelector('.gear-btn');
      if (gear) gear.click();
      return !!gear;
    })()
  `)
  await new Promise((r) => setTimeout(r, 1200))

  // —— 设置页分区导航（左导航 + 右内容）：量几何 + 逐个点开截图，选中态必须有背景色 ——
  const navInfo = await win.webContents.executeJavaScript(`
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

  for (const [label, slug] of [
    ['通用设置', 'general'],
    ['模型', 'model'],
    ['外观', 'appearance'],
    ['故障排查', 'trouble']
  ]) {
    await win.webContents.executeJavaScript(`
      (() => {
        const b = Array.from(document.querySelectorAll('.settings-nav-item'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (b) b.click();
        return !!b;
      })()
    `)
    await new Promise((r) => setTimeout(r, 700))
    const secInfo = await win.webContents.executeJavaScript(`
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
      const modelPage = await win.webContents.executeJavaScript(`
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

      // ── 模型目录编辑器（F5.1）：点「编辑」→ 一行一个模型 + 每个模型可展开高级设置 ──
      await win.webContents.executeJavaScript(`
        (() => {
          const btn = Array.from(document.querySelectorAll('.model-row .model-act'))
            .find((b) => (b.getAttribute('title') || '').includes('编辑'));
          if (btn) btn.click();
          return !!btn;
        })()
      `)
      await new Promise((r) => setTimeout(r, 700))
      const catalog = await win.webContents.executeJavaScript(`
        (() => {
          const rows = Array.from(document.querySelectorAll('.mc-row'));
          return {
            open: !!document.querySelector('.mc'),
            rows: rows.length,
            ids: Array.from(document.querySelectorAll('.mc-model')).map((i) => i.value),
            hasAdd: !!Array.from(document.querySelectorAll('.mc-foot button')).find((b) => (b.textContent || '').includes('添加模型')),
            hasFetch: !!Array.from(document.querySelectorAll('.mc-link')).find((b) => (b.textContent || '').includes('获取可用模型')),
            hasRestore: !!Array.from(document.querySelectorAll('.mc-link')).find((b) => (b.textContent || '').includes('恢复默认模型')),
            advBefore: !!document.querySelector('.mc-adv')
          };
        })()
      `)
      await win.webContents.executeJavaScript(`
        (() => { const b = document.querySelector('.mc-row .mc-icon'); if (b) b.click(); return !!b })()
      `)
      await new Promise((r) => setTimeout(r, 500))
      const adv = await win.webContents.executeJavaScript(`
        (() => ({ panel: !!document.querySelector('.mc-adv'), fields: document.querySelectorAll('.mc-adv input, .mc-adv select').length }))()
      `)
      console.log('MODEL_CATALOG=' + JSON.stringify({ ...catalog, adv }))
      modelCatalog = { ...catalog, adv }
    }
    const png = await win.webContents.capturePage()
    writeFileSync(join(SHOTS, 'verify-settings-' + slug + '.png'), png.toPNG())
  }

  const m3 = await win.webContents.executeJavaScript(`
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
  const shot3 = await win.webContents.capturePage()
  // 不额外存 verify-settings.png：它与下面分区循环里的 trouble 那张**逐字节相同**（实测哈希一致）
  void shot3

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
        .find((x) => x.textContent.trim() === '重命名');
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
      const img = document.querySelector('.fp-img');
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
    (() => ({
      hasImg: !!document.querySelector('.fp-img'),
      notice: (document.querySelector('.fp .ex-msg')?.textContent ?? '').trim()
    }))()
  `)
  console.log('BIN_TOO_LARGE=' + JSON.stringify(tooLarge))

  // ③ 未知二进制：**降级而不是放弃** —— 十六进制转储（看文件头就能认格式）
  await clickFile('固件镜像.bin')
  await new Promise((r) => setTimeout(r, 800))
  const hexPreview = await win.webContents.executeJavaScript(`
    (() => {
      const pre = document.querySelector('.fp-hex');
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

  // —— HTML 沙箱预览（渲染 / 源码 开关 + 「不执行工作区代码」红线）——
  // 不验“iframe 在不在 DOM 里”（太容易绿）：① 渲染真的渲染出来了 —— 常见死法是 srcdoc 被页面 CSP
  // 拦成空白框；② 工作区的 HTML 一行脚本都没跑。手段是采像素：桩文件自己会把背景从品红改成纯红。
  const clickHtmlFile = await clickFile('预览桩.html')
  await new Promise((r) => setTimeout(r, 900))

  const readHtmlFrame = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const f = document.querySelector('.fp-html');
        const t = document.querySelector('.fp-html-toggle');
        /* 源码视图现在也是 Monaco（plan13 批 B）—— 同样读"可见行"（它虚拟化，全文不在 DOM 里） */
        const editor = document.querySelector('.ce-host');
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

  // 切走再切回：会话与输出都该还在（本项目「切页签 = 卸载」，靠主进程缓冲 + 序号重放）
  await openBuiltin('任务管理')
  await new Promise((r) => setTimeout(r, 600))
  await openBuiltin('终端')

  // ⚠️ **就在这一刻推一帧实时输出**（不再额外等待）：面板刚挂载、`boot()` 正卡在 stub 的 400ms
  //    快照上（`replaying = true`）—— 这一帧**必然落进"订阅↔重放"那个缝**。不制造这个缝，
  //    这条断言在老实现（先订阅落屏 → 再重放全量，会写两遍且排在历史**前面**）下也会绿 = 名不副实。
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
  const themeFg = termState.dataTheme === 'ink' ? 'rgb(232, 230, 227)' : 'rgb(43, 43, 40)'
  checkTrue('**终端样式真的生效**（字色 = 当前主题的前景色、white-space:pre、span 是 inline-block）',
    termState.rowsStyle?.color === themeFg &&
      termState.rowsStyle?.whiteSpace === 'pre' &&
      termState.spanStyle?.display === 'inline-block',
    { theme: termState.dataTheme, expect: themeFg, rows: termState.rowsStyle, span: termState.spanStyle })

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

  // ── 只读档：拒绝执行 + 说清原因（判据：界面明说原因、且真的没有起会话）。这一段放在最后做，它会把会话置成“没有”。——
  termPermission = 'read-only'
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

  // ── 省 token 档位：档位卡片与权限档同屏 —— 一律用 [aria-label="省 token 档位"] 限定范围查（.choice-item 会把权限档也捞进来）──
  const tierBefore = await win.webContents.executeJavaScript(`
    (() => {
      const group = document.querySelector('[aria-label="省 token 档位"]');
      if (!group) return { found: false };
      return {
        found: true,
        items: Array.from(group.querySelectorAll('.choice-name')).map((e) => e.textContent.trim()),
        checked: group.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null
      };
    })()
  `)
  checkTrue('设置页有「省 token 档位」一栏，四档都在（土豪/极致/平衡/轻量）',
    tierBefore.found && tierBefore.items.join('/') === '土豪/极致/平衡/轻量', tierBefore)
  checkTrue('默认落在**平衡**档（用户定调的默认，不是界面随手编的）',
    tierBefore.checked === '平衡', tierBefore)

  await win.webContents.executeJavaScript(`
    (() => {
      const group = document.querySelector('[aria-label="省 token 档位"]');
      const btn = group && Array.from(group.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '轻量');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))
  const tierAfter = await win.webContents.executeJavaScript(`
    (() => {
      const group = document.querySelector('[aria-label="省 token 档位"]');
      if (!group) return null;
      return group.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null;
    })()
  `)
  checkTrue('点一下就切到「轻量」—— 档位真值在主进程，界面只是它的视图',
    tierAfter === '轻量', tierAfter)

  // R7 分区导航：主题项在「外观」分区里，不切过去就点不到（改版前是单页平铺）
  await win.webContents.executeJavaScript(`
    (() => {
      const b = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((x) => x.textContent.trim() === '外观');
      if (b) b.click();
      return !!b;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))

  const themeBefore = await win.webContents.executeJavaScript(`
    (() => ({
      items: Array.from(document.querySelectorAll('.choice-item .choice-name')).map((e) => e.textContent.trim()),
      checked: document.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null,
      dataTheme: document.documentElement.dataset.theme ?? '(none)'
    }))()
  `)

  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '水墨');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 700))
  const themeAfter = await win.webContents.executeJavaScript(`
    (() => ({
      checked: document.querySelector('.choice-item[aria-checked="true"] .choice-name')?.textContent?.trim() ?? null,
      dataTheme: document.documentElement.dataset.theme ?? '(none)',
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    }))()
  `)
  const shotTheme = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-theme-ink.png'), shotTheme.toPNG())

  // 恢复经典（别把状态留在水墨 —— 验证脚本应可重复运行）
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('.choice-item'))
        .find((b) => b.querySelector('.choice-name')?.textContent?.trim() === '经典');
      if (btn) btn.click();
      return !!btn;
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))

  // CSS 是否真的生效（CSP 若拦掉样式表，界面会退化成裸 HTML —— 用计算样式判定）
  const cssCheck = await win.webContents.executeJavaScript(`
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
  const cspProbe = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      window.__cspProbe = false;
      const s = document.createElement('script');
      s.textContent = 'window.__cspProbe = true';
      document.head.appendChild(s);
      setTimeout(() => resolve({ inlineScriptExecuted: window.__cspProbe }), 80);
    })
  `)

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
  console.log('THEME_BEFORE=' + JSON.stringify(themeBefore))
  console.log('THEME_AFTER=' + JSON.stringify(themeAfter))
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

  checkTrue(
    '思考块可见（此前被 flex 压成 4px 的回归）',
    processVisible.reasoningHeight > 20,
    processVisible.reasoningHeight
  )
  checkTrue('思考块排在报告之前（阅读顺序 = 过程 → 结论）', processVisible.processBeforeLastMsg === true)
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

  const msgPos = await centerOf('.msg')
  let rbMenu = { ok: false, reason: 'no-msg-or-no-input' }
  if (rbInputReady && msgPos) {
    await realClick(msgPos.x, msgPos.y, 'right')
    await new Promise((r) => setTimeout(r, 400))
    rbMenu = { ok: true, via: 'real-right-click' }
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

  /** 按 **id** 读某一张提问卡（待答 / 只读同一把尺子：只读态靠 done 字段与"按钮归零"判定） */
  const readAskCardById = async (id) =>
    win.webContents.executeJavaScript(`
      (() => {
        const card = document.querySelector('.ask-card[data-ask-id="${id}"]');
        if (!card) return { shown: false };
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
          note: ((card.querySelector('.ask-note') || { textContent: '' }).textContent || '').trim()
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
  const askedFree = await readAskCardById('ask-probe-1')
  console.log('ASK_FREE=' + JSON.stringify({ ...freeTyped, ...freeSubmit, sent: askResponses, card: askedFree }))
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
    '自填作答后卡片转只读，并**留住"我写了什么"**（那段字原样显示在卡上）',
    askedFree.done === true &&
      askedFree.buttonCount === 0 &&
      askedFree.title === '已回答' &&
      askedFree.answerText.includes(FREE_TEXT),
    askedFree
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
  const askedMulti = await readAskCardById('ask-probe-2')
  console.log('ASK_MULTI=' + JSON.stringify({ sent: askResponses, card: askedMulti }))
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
    '答完卡片**转只读**：按钮一个不剩，且把选中的那一行标了出来',
    askedMulti.done === true &&
      askedMulti.buttonCount === 0 &&
      askedMulti.rowCount === 3 &&
      askedMulti.picked === 1 &&
      askedMulti.pickedText.includes('补测试'),
    askedMulti
  )

  // 只读之后再点同一处：不该产生新回执（重复回执会让"已经定下的结论"被改写）
  if (rbInputReady && multiOpt) await realClick(multiOpt.x, multiOpt.y, 'left')
  await new Promise((r) => setTimeout(r, 300))
  check('只读卡片再点同一处 → 回执数**没有变化**', askResponses.length, 2)

  // —— 单选：点整行**直接作答**（不需要再点「提交」）——
  win.webContents.send('ask:request', ASK3)
  await new Promise((r) => setTimeout(r, 500))
  const singleOpt = await centerOfNth('button.ask-row', 0)
  if (rbInputReady && singleOpt) await realClick(singleOpt.x, singleOpt.y, 'left')
  await new Promise((r) => setTimeout(r, 400))
  const askedSingle = await readAskCardById('ask-probe-3')
  console.log('ASK_SINGLE=' + JSON.stringify({ sent: askResponses, card: askedSingle }))
  check(
    '单选：点一下整行 → **立即作答**（values = 那一行的值）',
    [askResponses.length, askResponses[2] && askResponses[2].id, askResponses[2] && askResponses[2].values],
    [3, 'ask-probe-3', ['opt-1']]
  )
  checkTrue(
    '只读卡片把**这一行**标了出来（留住"我选了什么"）',
    askedSingle.done === true && askedSingle.picked === 1 && askedSingle.pickedText.includes('水墨'),
    askedSingle
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

  // 切到设置页（**真鼠标**点齿轮）—— 这一步会让 ChatView 卸载
  const gearPos = await centerOf('.gear-btn')
  if (rbInputReady && gearPos) await realClick(gearPos.x, gearPos.y, 'left')
  await new Promise((r) => setTimeout(r, 800))
  const onSettings = await win.webContents.executeJavaScript(`
    (() => ({ settings: !!document.querySelector('.settings, .settings-view, .settings-page'), chat: !!document.querySelector('.chat-view') }))()
  `)

  // 在设置页期间继续推：一段正文 + 结束（旧代码里 chat:done 收不到 → 那段字永远不会被存盘，故断言的是 conv:save 载荷）
  convSaveCalls.length = 0
  win.webContents.send('chat:chunk', { conversationId: 'c1', payload: '切页期间的字' })
  await new Promise((r) => setTimeout(r, 300))
  win.webContents.send('chat:done', { conversationId: 'c1', payload: null })
  await new Promise((r) => setTimeout(r, 700))
  const savedWhileAway = convSaveCalls.some((c) =>
    (c.messages ?? []).some((m) => String(m.content ?? '').includes('切页期间的字'))
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
        hasChunkAfterUnmount: all.includes('切页期间的字'),
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
  checkTrue('提示条**再声明一次作用域**（含「仅回滚对话消息」）',
    (rbAfter.notice || '').includes('仅回滚对话消息'), rbAfter.notice)
  checkTrue('提示条**不许**用"文件已还原"这类措辞（那是文件回滚的说法）',
    !/文件已还原|已还原文件|回滚了文件/.test(rbAfter.notice || ''), rbAfter.notice)
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
  checkTrue('前置：确实切到了设置页（ChatView 已被卸载 —— 否则下面一条说明不了任何事）',
    onSettings.settings === true && onSettings.chat === false, onSettings)
  checkTrue('**在设置页期间流出来的内容，仍然被存盘**（订阅没跟着视图卸载 —— 旧代码这里必红）',
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
  checkTrue('切回 A → **A 的字在它自己那条里**（存档/恢复生效，不是靠重新拉盘掩盖）',
    concurrencyResult.aHasOwnText === true, { aHasOwnText: concurrencyResult.aHasOwnText })

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
      tier: 'light'
    }
  })
  await new Promise((r) => setTimeout(r, 500))
  const chip1 = await readUsageChip()

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

  reportAndExit()
})
