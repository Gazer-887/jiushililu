/**
 * 视觉验证脚本（可复用）：启动构建产物 → 量取尺寸 → 截图 → 退出。
 * 目的：**真实渲染验证**（不靠猜），用于布局类改动回归。
 *
 * 用法：先 `npm run build`，再 `node scripts/verify-shot.cjs`
 * 产出：verify-wide.png / verify-narrow.png / verify-settings.png
 *
 * 覆盖：
 *   ① 对话页输入控制台的宽度自适应（宽窗 / 窄窗）
 *   ② 设置页「故障排查」区（plan8 R2）
 *
 * 说明：本脚本独立于应用主进程，故需自行 stub 全部 IPC handler——
 * 数据返回空值即可，本脚本验证的是**布局几何**，不是数据流。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = process.cwd()
/**
 * 截图统一落这里 —— 用户要求「项目下的图片建档（Photo 目录）收录」：
 * 验证产出不该散在项目根（此前根目录堆过 17 张）。
 */
const SHOTS = join(ROOT, 'Photo')
mkdirSync(SHOTS, { recursive: true })
const OUT = join(SHOTS, 'verify-shot.png')

// 让 userData 独立，避免与已安装版本抢目录
app.setPath('userData', join(ROOT, '.verify-userdata'))

// ── 断言器（plan9 W2 新增）──────────────────────────────────────────────
//
// 为什么必须加（两份独立审查都点到的**实锤**）：
// 在此之前本脚本只 `console.log` 一堆汇总 + `app.exit(0)` ——
// **没有期望值比对、没有失败退出码**。于是"验证通过"全靠人眼看输出，
// 等于**拿一把没有刻度的尺子当验收标准**。
//
// 用法：`check(名字, 实际, 期望)` 或 `checkTrue(名字, 条件[, 实际值])`；
// 结尾一律调 `reportAndExit()`：有 FAIL → exit(1)，全过 → exit(0)。
//
// 原则：**只断言"确定的"**。每批新功能由那一批自己补断言（plan9 §二），
// 不再把验证的活堆到最后一批。
const checks = []

/**
 * 记录"带 workbench 的 ui-prefs:set"调用 —— 用来断言**提交点**（plan9 §W5）：
 * 拖拽过程中一帧都不该写盘，松手后才合并写一次。
 * 参照实现是每帧同步写盘（它自己标注的卡顿源），我们不学它，但**不学这件事必须被验到**。
 */
const wbSetCalls = []

// ── 造一张**真实可解码**的 PNG（plan7 批 A3 图片预览要验）────────────────
//
// 为什么不直接写个假 base64：图片预览的断言要量 `naturalWidth` ——
// 假串会被浏览器解码失败，naturalWidth 恒为 0，那条断言就永远是红的（测不出东西）。
// 所以这里手搓一个最小的 PNG：IHDR + IDAT(zlib) + IEND，带正确的 CRC32。
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

/** 一张 w×h 的棋盘格 PNG（32×24 → 1024 字节左右，够看清也够小） */
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

// 兜底：脚本内部一旦抛异常（例如断言里访问了不存在的字段），
// Electron 会**挂着不退出** —— 表现为"卡到超时"，完全看不出真实原因。
// 所以这里显式接住，转成一次带堆栈的失败退出。
process.on('unhandledRejection', (err) => {
  console.log('FAIL: 脚本内部异常 → ' + (err && err.stack ? err.stack : String(err)))
  console.log('CHECKS=' + JSON.stringify({ total: checks.length, failed: checks.length + 1 }))
  console.log('==== verify-shot 失败：脚本自身异常 ====')
  app.exit(1)
})

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

/**
 * `attach:path` 收到的载荷流水。
 * 存在的理由：这条通道**两个来源共用**（工作区文件树给相对路径、系统资源管理器给绝对路径），
 * 而"到底哪条路进来的"只有看载荷形式才知道 —— 0.13.2 用户报的越界就卡在这个区分上。
 */
const attachPathCalls = []

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
  // 待办清单（plan7 批 D）：界面挂载时会拉一次，故这里给一份样例 ——
  // 验证的是**面板渲染与位置**，不是 Agent 会不会调 update_todos（那要真机跑）
  'todo:get': () => FAKE_TODOS,
  // 子代理运行记录（plan7 批 D）：同上，覆盖 start / end / error 三种渲染分支
  'subagent:get': () => FAKE_SUBAGENTS,
  // 后台任务（plan7 批 D）：覆盖 running（带终止）与 done（带退出码）
  'bg:list': () => FAKE_BG_TASKS,
  'bg:kill': () => true,
  'settings:get': () => settingsView,
  'settings:save': () => settingsView,
  'settings:test': () => ({ ok: true, message: 'ok' }),
  'settings:set-model': () => settingsView,
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
    }
  ],
  'conv:get': () => ({
    id: 'c1',
    title: '打个招呼',
    workspace: 'D:\\jsllworkplace_for_test',
    model: 'deepseek-flash',
    skills: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    // 空消息 → 对话页显示空状态（验证 0.9.9 的空状态文案）
    // 给一条真实的消息流：这样"过程块在最后一条助手消息之前"这个位置断言才有得验
    messages: [
      { role: 'user', content: '把工作区里的三个文件汇总成一份报告' },
      {
        role: 'assistant',
        content: '# 汇总报告\n\n- 紫水晶采购清单已归档\n- 预算草案待复核\n'
      }
    ]
  }),
  'conv:create': () => ({ id: 'x' }),
  'conv:save': () => null,
  'conv:rename': () => null,
  'conv:delete': () => undefined,
  'skills:list': () => [
    { name: 'planner', description: '规划员：把目标拆成有序步骤', source: 'builtin' },
    { name: 'reviewer', description: '审查员：只读审查', source: 'builtin' }
  ],
  'permission:get': () => 'write',
  'permission:set': () => 'write',
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
  // plan8 R2：设置页「故障排查」
  'logs:info': () => ({
    dir: 'C:\\Users\\Gazer\\AppData\\Roaming\\jiushililu\\logs',
    files: ['app.log', 'app.1.log']
  }),
  'logs:open': () => true,
  // plan7 批 A0 + plan9 W2：界面布局偏好（含工作台分栏布局）
  // ⚠️ 这里是**契约的复制品** —— UIPrefs 加字段必须同步加，
  //    否则渲染端拿到 undefined，而本脚本又是唯一做真渲染验证的地方（会静默漏掉）。
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
  // ③ 文件拖进会话：按路径取附件（拖拽入口；文件选择框那条走 attach:file）
  //
  // ⚠️ 这里的路径处理**是主进程 `readAttachment` 那套两层边界规则的复制品**
  //    （绝对路径原样；相对路径拼工作区根；不在工作区内则带 `outside` 标记）。
  //    主进程那边改了规则，这里必须跟着改 —— stub 是**契约的复制品**，
  //    不同步的话渲染端就会拿到与真机不一样的形状，而这种差异**不会报错、只会静默漏掉**。
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
  // plan7 批 A3：二进制预览
  // 三种情况都要有各自的路径 —— 只验"正常图片"那一档，就是上次假绿灯的老路
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
          // 用来验证 Markdown 预览走富文本渲染（用户反馈「没有渲染」）
          { name: 'README.md', rel: 'README.md', kind: 'file', size: 128 },
          // plan7 批 A3：二进制预览的三档（正常图片 / 超大图 / 未知二进制）
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
    if (String(rel).endsWith('.md')) {
      return {
        ok: true,
        rel,
        content: '# 九十里路\n\n- 第一点\n- 第二点\n\n**加粗** 与 `行内代码`\n',
        size: 60
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
  // plan7 批 A2：写操作。stub 只回人话、不真写 ——
  // 真实落盘与边界由 tests/unit/workspace-write.test.ts 覆盖，这里验的是界面接线。
  'fs:write': (payload) => {
    fsOpLog.push(`write:${payload.rel}`)
    return { ok: true, message: `已写入 ${payload.rel}（0 字节）` }
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
  // plan8 R4：检查点与回滚
  'checkpoint:list': () => [
    {
      runId: 'run-1',
      at: Date.now() - 120000,
      workspace: 'D:\\jsllworkplace_for_test',
      agent: '内核默认',
      status: 'done',
      fileCount: 3,
      createdCount: 1,
      modifiedCount: 2
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
      { rel: 'src/brand-new.md', kind: 'created', beforeBytes: 0, backup: null }
    ]
  }),
  'checkpoint:rollback': () => ({
    runId: 'run-1',
    restored: ['src/notes.md', 'src/app.ts'],
    deleted: ['src/brand-new.md'],
    failed: [],
    rejected: []
  })
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

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(ROOT, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // ⚠️ 必须与**真机一致**（`src/main/index.ts` 的 createWindow 用的是 sandbox: true）。
      //    这里长期写的是 false —— 等于一直在**另一个环境**里验真机，
      //    而"验证环境与生产不一致"正是最容易被放过的一类假绿灯。
      sandbox: true
    }
  })

  // CSP 违规捕获（plan8 R3）：必须在 loadFile **之前**挂监听，否则漏掉加载期错误
  const cspViolations = []
  win.webContents.on('console-message', (...a) => {
    // 兼容新旧签名：Electron 33 是 (event, level, message, ...)，35+ 是 (event, details)
    const msg = typeof a[2] === 'string' ? a[2] : (a[0] && a[0].message) || ''
    if (/Content Security Policy|Refused to/i.test(msg)) cspViolations.push(msg)
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

  // 进入对话页：点心侧栏里那条会话（触发 openConversation）
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

  // —— 过程可见：工具调用详情 + 思考流（用户反馈「看不到执行和思考痕迹」）——
  // 推送通道与真实运行时是同一条（webContents.send → preload → store → 组件），
  // 只是数据由这里伪造：stub 环境跑不了真模型，但"推送→渲染→显示"这段是真跑的。
  win.webContents.send('chat:tool', {
    id: 'probe-tool',
    name: 'read_file',
    phase: 'start',
    detail: 'src/main/index.ts'
  })
  win.webContents.send('chat:reasoning', '先看看入口文件怎么写的…')
  await new Promise((r) => setTimeout(r, 600))
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
        // 位置：过程块必须在最后一条消息**之前** ——
        // 堆到末尾会把报告挤出视野（用户实测反馈的真问题）
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
  // 等一帧再拍：面板是"挂载 → 异步拉清单 → 渲染"三步出来的，
  // 量完立刻 capturePage 可能拿到合成之前的那一帧（实测踩到：拍出来是空画面）
  await new Promise((r) => setTimeout(r, 500))
  const shotTodo = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-todo.png'), shotTodo.toPNG())

  // 折叠：点标题 → 列表消失、面板变矮（DSH 的那个 chevron 行为）
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

  // 展开回来（后续截图别停在折叠态）
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

  // 缩窄窗口，验证自适应（这是本次修复的核心诉求）
  win.setSize(760, 700)
  await new Promise((r) => setTimeout(r, 1200))
  const m2 = await measure()
  const shot2 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-narrow.png'), shot2.toPNG())

  // —— 设置页「故障排查」区（plan8 R2）——
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

  // —— R7 形态改造：设置页分区导航（左导航 + 右内容）——
  // 量导航几何 + 逐个点开分区截图。选中态必须**有背景色**，不能只靠字重区分。
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
  // 不额外存 verify-settings.png：它与下面分区循环里的 trouble 那张**逐字节相同**
  // （实测哈希一致），纯冗余。要设置页截图，看 verify-settings-*.png 即可。
  void shot3

  /**
   * 打开工作台里的某个内置面板（plan9 W3）。
   *
   * 改造前是"点常驻页签"（`.dock-tab`）；现在是**＋ 开窗菜单**：
   *   ① 工作台没展开就先点顶栏开关（展开且为空时直接出现开窗选择器）
   *   ② 已经有栏了 → 点该栏的 ＋ 展开菜单
   *   ③ 点菜单里同名的那一项
   * 每步之间都要等 React 重渲染，所以拆成三次 executeJavaScript。
   */
  const openBuiltin = async (label) => {
    await win.webContents.executeJavaScript(`
      (() => {
        if (document.querySelector('.dock')) return 'already-open';
        // 必须按 title 定位：顶栏有**两个** panel-btn（第一个是侧栏开关），
        // 裸 querySelector(".panel-btn") 会点到侧栏上去 —— 踩过一次，别再踩。
        // （注意：下面是模板字符串，注释里**不能出现反引号**，否则会把字符串提前闭合）
        const b = document.querySelector('.panel-btn[title*="工作台"]');
        if (b) b.click();
        return b ? 'opened' : 'no-toggle';
      })()
    `)
    await new Promise((r) => setTimeout(r, 450))

    await win.webContents.executeJavaScript(`
      (() => {
        // 空工作台直接就是选择器；有栏了就点栏内 ＋
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

  // 展开第一轮
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

  // 点「整轮回滚」→ 应进入二次确认（不会立刻执行）
  // 注意：React 状态更新是异步的，点击后必须等一拍再读 DOM，
  // 否则读到的是旧树 → 假阴性（曾在同 tick 读到 hasConfirm:false 而实际已弹出）。
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

  // 真的点确认 → 走完整回滚链路，看结果提示
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

  // —— 危险操作确认对话框（plan8 R5）：真推一次请求，真点一次 ──
  // 用 webContents.send 模拟主进程推送（这就是真实链路：主进程 → preload → React）
  win.webContents.send('confirm:request', {
    id: 'probe-1',
    tool: 'run_command',
    detail: 'rm -rf build && npm run build',
    agent: '内核默认',
    where: 'D:\\jsllworkplace_for_test'
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

  // 点「允许这一次」→ 应把 {id:'probe-1', allowed:true} 回传主进程，并关闭对话框
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

  // —— 批 A0：面板宽度可拖拽（真拖一次，不是看代码觉得行）——
  // 用 executeJavaScript 派发真实鼠标事件，模拟按住左侧分隔条往右拖 80px
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
      // 往右拖 80px（分几步，模拟真实移动而非瞬移）
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

  // 点「归档」目录 → 应懒加载出子项
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
  await new Promise((r) => setTimeout(r, 900))
  const previewState = await win.webContents.executeJavaScript(`
    (() => {
      const panes = Array.from(document.querySelectorAll('.pane'));
      const last = panes[panes.length - 1];
      const pre = last ? last.querySelector('.fp-pre') : null;
      const fp = last ? last.querySelector('.fp') : null;
      const dim = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; };
      return {
        paneCount: panes.length,
        // 关键：预览必须是**自己的一栏**，而不是塞在资源管理器那一栏里面
        isOwnPane: panes.length >= 2 && !!last && !last.querySelector('.ex-panel'),
        hasPreview: !!pre,
        firstLine: pre ? pre.textContent.split('\\n')[0] : null,
        hasOxide: pre ? pre.textContent.includes('氧化铈粉') : false,
        // 关键：**看得见**才算数（DOM 存在但高度塌成 0 等于没显示）
        preBox: dim(pre),
        fpBox: dim(fp)
      };
    })()
  `)
  const shot8 = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-explorer.png'), shot8.toPNG())

  // —— 资源管理器右键菜单 + 写操作接线（plan7 批 A2）——
  // 验的不是"菜单画出来了"，而是菜单项齐全**且动作真的发下去了**（stub 记流水）
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

  // 点「重命名」→ 内联输入框出现，且初值就是原名
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

  // Esc 取消内联编辑
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

  // 空白处右键 → 根菜单（新建 / 刷新）
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

  // —— 拖拽上传（plan7 批 A2 第 3 步）——
  // 验两件事：① dragover 时落点高亮 ② drop 真的接线（合成 File 没有磁盘路径，
  // 正确行为是**如实提示**而不是静默什么都不做）
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

  // 选中「归档」目录 → 工具栏第一个按钮的 title 应变成"在「归档」下新建文件"，
  // 新建出来的东西也真的落在 归档/ 下（fsOpLog 是证据）
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

  // 先拍预览渲染的样子 —— 拖拽验证会碰鼠标事件、可能把选中状态搅乱，证据别丢。
  // **等一拍再拍**：capturePage 拿的是合成后的帧，DOM 更新不代表帧已更新
  // （这个坑踩过两次：待办面板一次、这次预览一次 —— 都是"查询说在、截图里没有"）
  await new Promise((r) => setTimeout(r, 800))
  const shotMd = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-ex-preview.png'), shotMd.toPNG())

  // —— plan7 批 A3：二进制预览（三档各走一遍）——
  // ⚠️ 探针**必须放在这一段**：此时前台面板还是「资源管理器」（文件行在 DOM 里）、
  //    工作台只有两栏（预览栏放得下）。放到脚本末尾会全红：
  //    那时前台已切成「任务管理」→ clickFile 静默失败；而且多开一栏会溢出、预览栏被挤出可视区。
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

  // ① 正常图片：**必须真的解码出来**（naturalWidth > 0）——
  //    DOM 里有 <img> 不等于图显示出来了，这是本项目"存在 ≠ 看得见"的老教训
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
        // 关键：**解码成功**才有 naturalWidth
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        complete: img.complete,
        boxW: Math.round(r.width),
        boxH: Math.round(r.height),
        // 安全：必须是 img 上下文（img 不执行脚本），不能是 object / iframe
        tag: img.tagName,
        isDataUrl: (img.getAttribute('src') || '').startsWith('data:image/'),
        // 看得见才算数：它所在的那一栏真的有宽度
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

  // 原先这里还有一个「拖高手柄」探针（.ex-preview-resize）。plan9 W6 把预览改成
  // 右侧独立成栏之后，那个手柄**整个退役**了（连带 splitter.ts 的 resizePreview 与它的单测），
  // 所以这里不再探它 —— 改为断言"它确实不在了"（见下方 exMdPreview.hasOldResizeHandle）。

  // —— 新建任务页：内容完全居中 + 旧文案已移除（用户 2026-09-12 美学偏好）——
  await win.webContents.executeJavaScript(`
    (() => {
      const back = document.querySelector('.back-btn');
      if (back) back.click();
      return !!back;
    })()
  `)
  await new Promise((r) => setTimeout(r, 800))

  // —— ③ 文件拖进会话：把文件树里的一行拖到输入框 ——
  //
  // ⚠️ 探针**必须在输入框存在的时候跑**：此前插在设置页那一段，结果 5 条全红、
  //    理由只是 `no-row-or-no-console` —— 因为工作台是**视图无关**的（文件行一直在），
  //    而输入框只属于对话页 / 新建页。**"前置状态不对"和"功能坏了"长得一模一样**，
  //    所以先单独断言"输入框在不在"，把这两件事分开。
  //
  // ⚠️⚠️ 第二层（0.13.2 用户报「文件树里的文件拖不动」之后补上的一课）：
  //    **合成事件永远测不出「真手势能不能拖」**。`new DragEvent('dragstart')` 是
  //    **我们自己把事件塞进 DOM**，绕过了浏览器判定"这个元素能不能开始拖拽"的全部逻辑
  //    （`draggable` 属性、是不是可激活控件、有没有被祖先拦住……）——
  //    也就是说合成事件**天生就是绿的**，而真机上可能一拖什么都不发生。
  //    所以改用 **CDP 真手势**：`Input.setInterceptDrags` + 真鼠标按下/移动 → 浏览器回一个
  //    `Input.dragIntercepted`，里面装的是**浏览器自己从 dragstart 收上来的真实拖拽载荷**；
  //    再用 `Input.dispatchDragEvent` 把这一份真实载荷投到输入框上。
  //    真手势还差两样才算数：① 元素**真的可见可命中**（几何 + 命中测试，"DOM 里在"远远不够）
  //    ② 一个**阳性对照** —— 拖一根分栏标题（它本来就该能拖）。只有对照也绿了，
  //    "行拖不起来"才能算在行头上，而不是算在探针自己头上。
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
    // 收尾必须干净：被拦截的拖拽不主动取消的话，**后面每一次拖拽都会静默失效**。
    //（搭探针时真踩到了：第 2、3 次全空，看上去就像"button 不能拖"——
    //  差点照着这个假根因去改代码。阳性对照就是为了防这种事。）
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

  // 真拖两次：
  //   ① 只到 dragEnter/dragOver 就停 —— 量"落点高亮"（高亮本来就是拖拽过程中的状态）
  //   ② 走完整 drop —— 量"真的变成附件"
  // 载荷必须用**自定义 MIME**（两边同一个常量）：用 text/plain 的话，
  // 拖到编辑器/终端会被当成"一段文字"贴进去，而这里携带的其实是一条工作区相对路径
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

  // —— ③-2 从**系统资源管理器**拖文件进来（`dataTransfer.files` 那条分支）——
  //
  // 这条分支此前**从来没有被验证过**：合成事件走的是自定义 MIME 那条，
  // 而 0.13.2 用户贴回来的报错是 `attach:path: 只能引用当前工作区内的文件` ——
  // **只有这条分支会传绝对路径**，所以那句报错只可能从这儿来。也就是说：
  // 用户踩的分支，恰好是验证唯一没盖到的那条。（"碰巧没验到"和"碰巧对了"一样危险。）
  //
  // CDP 的 drag 事件可以直接带 `files`（真实存在的路径），渲染端才拿得到真 File，
  // `webUtils.getPathForFile` 才有得可查 —— 页面里 `new File()` 造出来的假 File 是查不到的。
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
        // 最后一枚 = 刚拖进来的那个；顺带把它身上的标记也读出来
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

  // —— ③-3 认出是文件拖拽、却**一个可用路径都没拿到** → 必须说话 ——
  // 改之前这里是什么都不做：界面毫无反应、日志也没痕迹，用户只能报"拖不进去"，
  // 而排查的人手上一条线索都没有。**最糟的失败方式就是静默失败。**
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
      // 已经断开就算了
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

  // —— 水墨风配色预览（INK=1 时启用）——
  // 用 insertCSS 注入 token 覆盖 + 水印样式，**不改动正式源码** ——
  // 审美决策先看效果，定了才落进 styles.css。
  // 注：不用内联 <style> 是因为 CSP 的 style-src 'self' 会拦；
  // insertCSS 是 Electron API，属 devtools 特权，不受页面 CSP 限制。
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
      /* 水墨下边框更淡，靠留白分隔 */
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

    // 再切到对话页截一张（看墨色按钮/选中态/朱砂红在实际界面里的效果）
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

  // 点「水墨」
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

  // CSP 是否**真的在拦**：主动注入内联脚本探针。
  // 「零违规」只能说明没打坏东西，不能证明策略生效 —— 必须主动触发一次被拦的行为。
  // 策略为 script-src 'self' 时应拦截内联脚本，故注入的赋值不应执行。
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
      // 注意：类名是 .wb-divider（W5 把 .wb-gap 换成了可拖拽的分隔条）。
      // 这里曾经漏改过一次 —— 查一个不存在的类名不会报错，只会**静默算出错误的间隙(0)**，
      // 于是"栏宽之和 = 可用宽"这条断言就假失败了。**改名就要改验证脚本。**
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
        // 关键：栏宽之和 + 间隙 必须**正好等于**行可用宽
        // —— 这是"PANE_GAP 没算漏、也没被 overflow:hidden 悄悄裁掉"的证据
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
        // ⚠️ 必须**限定在第一栏内**查。全局 querySelector('.pane-head') 会查到第二栏的头，
        //    于是"折叠了没"永远显示成"没折叠"（这个探针栽过一次）
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

  // 展开回来（别让后面的截图停在折叠态）
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

  // —— 分栏：**右键页签**（plan9 形态修订后，多栏不再是默认形态，而是这里长出来的扩展功能；
  //     原来那条常驻的「＋ 新建一栏」已随工作台标题栏一起去掉）——
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
      // 注意：类名是 .wb-divider（W5 把 .wb-gap 换成了可拖拽的分隔条）。
      // 这里曾经漏改过一次 —— 查一个不存在的类名不会报错，只会**静默算出错误的间隙(0)**，
      // 于是"栏宽之和 = 可用宽"这条断言就假失败了。**改名就要改验证脚本。**
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
        // 栏数多到放不下时进入"溢出"模式（横向滚动）—— 此时 sprawl 会**大于** rowW，
        // 那是设计好的降级，不是被裁掉
        overflow: !!row && row.classList.contains('wb-overflow'),
        // 新栏里装的是什么（证明各栏**互相独立**，不是同一份内容渲染两遍）。
        // 用"第一栏 / 最后一栏"而不是硬编码下标 —— 前面点文件已经开过一栏了，
        // 写死 pane0/pane1 会让断言随上游改动而失真
        firstHasExplorer: !!panes[0] && !!panes[0].querySelector('.ex-panel'),
        lastHasExplorer: !!panes[panes.length - 1] && !!panes[panes.length - 1].querySelector('.ex-panel'),
        firstTabs: panes[0] ? panes[0].querySelectorAll('.pane-tab').length : 0,
        lastTabs: panes[panes.length - 1] ? panes[panes.length - 1].querySelectorAll('.pane-tab').length : 0,
        // 全工作台页签总数 —— 用来验「分栏是**挪**不是复制」
        allTabs: document.querySelectorAll('.pane-tab').length,
        // 窄栏时 ＋ 会不会被页签条"滚走" —— 真渲染截图抓出来的问题，
        // 数字全绿也看不出来：必须量它**是否落在栏的边界内**
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

  // 存档：多栏工作台的真渲染截图（给人看的证据，不只是数字）
  const shotWb = await win.webContents.capturePage()
  writeFileSync(join(SHOTS, 'verify-workbench.png'), shotWb.toPNG())

  // —— 三栏塞进 359px：**这是设计好的降级，不是 bug**（三级收缩的尽头）——
  // 每栏退到绝对下限 120，总宽超出容器 → 工作台区改为横向滚动。
  // 这条必须被**断言**：否则"溢出（设计）"与"被裁掉（真 bug）"就分不清了。
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

  // 关掉最后一栏，回到 2 栏（顺便把"关栏"这个动作也真走一遍）——
  // 之后才做拖拽：2 栏在 359px 下拖得动，3 栏塞不下时本来就该拖不动
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

  // —— plan9 W5：拖拽（调宽 + 换位）——
  // 结构先验：分隔条数量必须 = 栏数 − 1（宽度数组也只存 n−1 个，一一对应）
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

  // 调宽：**合成 PointerEvent 真拖一次**。
  // 老坑是 mousemove 会被真实鼠标位置覆盖；这里监听挂在手柄自身、且用 PointerEvent，
  // 所以合成事件是可靠的（纯换算逻辑另有单测兜底）。
  // 先清空写盘计数：前面开栏/开页签也写过盘，不清就数不准
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
  // 等过 debounce 窗口（300ms）再数写盘次数
  await new Promise((r) => setTimeout(r, 750))
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

  // 换位：合成 HTML5 DnD（dragstart/dragover/drop）。
  // 拖拽下标走 dataTransfer 而不是模块级变量，所以**同一轮同步派发**也拿得到。
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

  // ── 断言（plan9 W2 起，本脚本终于有刻度了）────────────────────────────
  // 只挑"确定的"来断言；每一批新功能由那一批自己补断言，不再堆到最后一批。
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
  checkTrue('预览读到的确实是那个文件', previewState.hasOxide === true, previewState.firstLine)
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

  // —— plan7 批 A3：二进制预览（三档各一条，别只验顺的那种）——
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

  // —— ③-2 系统资源管理器拖进来的那条分支（此前零覆盖，而用户报的错正出在这里）——
  checkTrue('系统拖拽：真 File 经 `getPathForFile` 解析后确实送到了 `attach:path`',
    osDrag.attempted === true && (osDrag.payloads ?? []).length > 0, osDrag)
  checkTrue('系统拖拽送的是**绝对路径**（相对路径走不到这条分支）',
    osDrag.gotAbsolute === true, osDrag.payloads)
  checkTrue('工作区外的附件会在 chip 上**标出来**（主人有权知道上下文里混进了外面的文件）',
    (osDrag.badges ?? []).includes('工作区外'), osDrag.badges)
  // —— ③-3 认得出是文件拖拽、却拿不到可用路径 ——
  checkTrue('载荷丢了会**说话**（以前是什么都不做 = 静默失败）',
    silentState.text.includes('没收到文件路径'), { ...silentCase, ...silentState })

  reportAndExit()
})
