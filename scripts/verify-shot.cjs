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
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = process.cwd()
const OUT = join(ROOT, 'verify-shot.png')

// 让 userData 独立，避免与已安装版本抢目录
app.setPath('userData', join(ROOT, '.verify-userdata'))

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

const STUBS = {
  // 待办清单（plan7 批 D）：界面挂载时会拉一次，故这里给一份样例 ——
  // 验证的是**面板渲染与位置**，不是 Agent 会不会调 update_todos（那要真机跑）
  'todo:get': () => FAKE_TODOS,
  // 子代理运行记录（plan7 批 D）：同上，覆盖 start / end / error 三种渲染分支
  'subagent:get': () => FAKE_SUBAGENTS,
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
    messages: []
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
  // plan7 批 A0：界面布局偏好
  'ui-prefs:get': () => ({ sidebarWidth: 248, dockWidth: 360 }),
  'ui-prefs:set': (patch) => ({
    sidebarWidth: patch?.sidebarWidth ?? 248,
    dockWidth: patch?.dockWidth ?? 360,
    theme: patch?.theme ?? 'classic'
  }),
  'ui-prefs:reset': () => ({ sidebarWidth: 248, dockWidth: 360 }),
  // plan7 批 A：工作区文件树（stub 数据；真实文件系统由 tests/unit/fs-tree.test.ts 覆盖）
  'fs:list': (arg) => {
    const rel = typeof arg === 'string' ? arg : ''
    if (rel === '') {
      return {
        ok: true,
        entries: [
          { name: '归档', rel: '归档', kind: 'dir' },
          { name: '2026年度预算草案.md', rel: '2026年度预算草案.md', kind: 'file', size: 365 },
          { name: '紫水晶采购清单.txt', rel: '紫水晶采购清单.txt', kind: 'file', size: 341 }
        ]
      }
    }
    if (rel === '归档') {
      return { ok: true, entries: [{ name: '旧版说明.txt', rel: '归档/旧版说明.txt', kind: 'file', size: 264 }] }
    }
    return { ok: true, entries: [] }
  },
  'fs:read': () => ({
    ok: true,
    rel: '紫水晶采购清单.txt',
    content:
      '紫水晶采购清单（2026-09-12 起草）\n\n1. 乌拉尔产紫水晶原石 —— 12 公斤\n2. 巴西产紫水晶碎石 —— 40 公斤\n3. 抛光用氧化铈粉 —— 3 罐\n4. 恒温展示柜（带锁）—— 2 台\n',
    size: 341
  }),
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
      sandbox: false
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
  writeFileSync(join(ROOT, 'verify-todo.png'), shotTodo.toPNG())

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
  writeFileSync(join(ROOT, 'verify-wide.png'), shot1.toPNG())

  // 缩窄窗口，验证自适应（这是本次修复的核心诉求）
  win.setSize(760, 700)
  await new Promise((r) => setTimeout(r, 1200))
  const m2 = await measure()
  const shot2 = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'verify-narrow.png'), shot2.toPNG())

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
    writeFileSync(join(ROOT, 'verify-settings-' + slug + '.png'), png.toPNG())
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
  writeFileSync(join(ROOT, 'verify-settings.png'), shot3.toPNG())

  // —— 文件变更记录面板（plan8 R4）：真点一遍回滚，验证"改坏能退回" ──
  await win.webContents.executeJavaScript(`
    (() => {
      const tab = Array.from(document.querySelectorAll('.dock-tab'))
        .find((b) => b.textContent.trim() === '变更');
      if (tab) tab.click();
      return !!tab;
    })()
  `)
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
  writeFileSync(join(ROOT, 'verify-changes.png'), shot4.toPNG())

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
  writeFileSync(join(ROOT, 'verify-rollback.png'), shot5.toPNG())

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
  writeFileSync(join(ROOT, 'verify-confirm.png'), shot6.toPNG())

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
  writeFileSync(join(ROOT, 'verify-splitter.png'), shot7.toPNG())

  // —— 批 A：资源管理器（真点一次展开 + 一次文件预览）——
  await win.webContents.executeJavaScript(`
    (() => {
      const tab = Array.from(document.querySelectorAll('.dock-tab'))
        .find((b) => b.textContent.trim() === '文件');
      if (tab) tab.click();
      return !!tab;
    })()
  `)
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

  // 点文件 → 应出现预览
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
      const pre = document.querySelector('.ex-pre');
      const box = document.querySelector('.ex-preview');
      const tree = document.querySelector('.ex-tree');
      const panel = document.querySelector('.ex-panel');
      const body = document.querySelector('.dock-body');
      const dim = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; };
      return {
        hasPreview: !!pre,
        firstLine: pre ? pre.textContent.split('\\n')[0] : null,
        hasOxide: pre ? pre.textContent.includes('氧化铈粉') : false,
        // 关键：**看得见**才算数（DOM 存在但高度塌成 0 等于没显示）
        preBox: dim(pre),
        previewBox: dim(box),
        treeBox: dim(tree),
        panelBox: dim(panel),
        bodyBox: dim(body)
      };
    })()
  `)
  const shot8 = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'verify-explorer.png'), shot8.toPNG())

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
  writeFileSync(join(ROOT, 'verify-ex-menu.png'), shotMenu.toPNG())

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

  // —— 新建任务页：内容完全居中 + 旧文案已移除（用户 2026-09-12 美学偏好）——
  await win.webContents.executeJavaScript(`
    (() => {
      const back = document.querySelector('.back-btn');
      if (back) back.click();
      return !!back;
    })()
  `)
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
  writeFileSync(join(ROOT, 'verify-newtask.png'), shot9.toPNG())

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
      writeFileSync(join(ROOT, v.file), s.toPNG())
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
    writeFileSync(join(ROOT, 'verify-ink-chat.png'), shotInk2.toPNG())
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
  // —— 右栏「任务」页签：子代理运行记录（plan7 批 D）——
  await win.webContents.executeJavaScript(`
    (() => {
      const tab = Array.from(document.querySelectorAll('.dock-tab'))
        .find((b) => b.textContent.trim() === '任务');
      if (tab) tab.click();
      return !!tab;
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const tasksState = await win.webContents.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('.task-item'));
      return {
        hasPanel: !!document.querySelector('.tasks-panel'),
        head: document.querySelector('.tasks-title')?.textContent?.trim() ?? null,
        sub: document.querySelector('.tasks-sub')?.textContent?.trim() ?? null,
        count: items.length,
        names: items.map((e) => e.querySelector('.task-name')?.textContent?.trim() ?? null),
        statuses: items.map((e) => e.querySelector('.task-status')?.textContent?.trim() ?? null),
        classes: items.map((e) => e.className),
        hasResult: items.map((e) => !!e.querySelector('.task-result'))
      };
    })()
  `)
  const shotTasks = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'verify-tasks.png'), shotTasks.toPNG())

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
  writeFileSync(join(ROOT, 'verify-theme-ink.png'), shotTheme.toPNG())

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
  console.log('EX_OP_LOG=' + JSON.stringify(fsOpLog))
  console.log('TASKS_PANEL=' + JSON.stringify(tasksState))
  console.log('THEME_BEFORE=' + JSON.stringify(themeBefore))
  console.log('THEME_AFTER=' + JSON.stringify(themeAfter))
  console.log('NEWTASK_CENTER=' + JSON.stringify(centerCheck))
  console.log('CSS=' + JSON.stringify(cssCheck))
  console.log('CSP_VIOLATIONS=' + JSON.stringify(cspViolations))
  console.log('CSP_PROBE=' + JSON.stringify(cspProbe))
  app.exit(0)
})
