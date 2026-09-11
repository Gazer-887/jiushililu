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

const STUBS = {
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
    messageCount: 2,
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！很高兴见到你。' }
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
}

app.whenReady().then(async () => {
  for (const [channel, fn] of Object.entries(STUBS)) {
    ipcMain.handle(channel, () => fn())
  }

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

  // CSS 是否真的生效（CSP 若拦掉样式表，界面会退化成裸 HTML —— 用计算样式判定）
  const cssCheck = await win.webContents.executeJavaScript(`
    (() => {
      const sheets = document.styleSheets.length;
      const view = document.querySelector('.settings-view');
      const cs = view ? getComputedStyle(view) : null;
      return {
        sheets,
        padding: cs ? cs.paddingTop : null,
        maxWidth: cs ? cs.maxWidth : null,
        scrollable: cs ? cs.overflowY : null
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

  console.log('WIDE=' + JSON.stringify(m1))
  console.log('NARROW=' + JSON.stringify(m2))
  console.log('SETTINGS=' + JSON.stringify(m3))
  console.log('CHANGES_BEFORE=' + JSON.stringify(beforeRollback))
  console.log('CONFIRM_STEP=' + JSON.stringify(confirmStep))
  console.log('ROLLBACK_NOTICE=' + JSON.stringify(rollbackNotice))
  console.log('CSS=' + JSON.stringify(cssCheck))
  console.log('CSP_VIOLATIONS=' + JSON.stringify(cspViolations))
  console.log('CSP_PROBE=' + JSON.stringify(cspProbe))
  app.exit(0)
})
