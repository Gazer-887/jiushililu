// ⚠️ 数据目录引导必须是**第一个** import（plan10 §2.4 P0-6）：五个 electron-store 在各自模块顶层
// 构造时就锁死 userData 路径 —— setPath 与迁移必须发生在它们之前。见 bootstrap-data-dir.ts 头注。
import { getBootstrapOutcome, releaseBootstrapLock } from './bootstrap-data-dir'
import { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker, session, shell } from 'electron'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { registerIpcHandlers, getActiveConversationId } from './ipc'
import { createAgentContext } from './agent/runner'
import { resolveWorkspaceRoot } from './store/workspace'
import { initLogger, createLogger } from './log'
import { startWatchdog, breadcrumb } from './watchdog'
import { installFsSyncTrace } from './sync-trace'
import { installCrashGuards } from './crash-guard'
import { createConfirmBridge } from './confirm'
import { createPlanApprovalBridge } from './agent/plan-approval'
import { createExecEventRecorder, createFsExecEventSink } from './agent/exec-events'
import { createAskBridge } from './ask'
import { IPC } from '@shared/ipc'
import {
  browserClick,
  browserCurrentUrl,
  browserNavigate,
  browserReadPage,
  browserType,
  initBrowser,
  setBrowserStateListener
} from './browser'
import { setBrowserAdapter } from './agent/browser-bridge'
import { createBackgroundTaskStore } from './agent/background-tasks'
import { createMemoryStore } from './store/memory-store'
import { createPlaybookStore } from './store/playbook-store'
import { createSkillsStore } from './skills/skills-store'
import { createMcpManager } from './mcp/mcp-manager'
import { nodeFsAdapter } from './store/conversations-fs'
import { createTerminalSessionStore, type PtyModuleLike } from './terminal-session'
import type { RuntimeEnv } from './agent/tools/shell-session'
// 常驻 shell 会话（run_command 的复用层）：退出时必须显式收，否则留下没人管的子进程。
// 它是**值** import，与上面那行纯类型 import 分开 —— 合成一行会让 `verbatimModuleSyntax` 把值也当类型擦掉。
import { disposeAllShellSessions } from './agent/tools/shell-session'
import { currentFingerprint, syncRuntimeBin } from './dev-env/runtime-bin'
import { injectRuntimePath } from '@shared/runtime-path'
import { createSystemIntegration } from './system-integration'
import { createNetworkProxy } from './network-proxy'
import { installElectronFetch } from './net/electron-fetch'
import { httpFetchKind } from './providers/http-client'
import {
  getPermissionPreset,
  getSystemSettings,
  setSystemSettings,
  getNetworkSettings,
  setNetworkSettings,
  getNetworkCredentials,
  setNetworkCredentials,
  getMemoryEnabled,
  getMemoryApprovalGate,
  getAutoMemoryEnabled,
  getTerminalLoadProfileEnabled,
  getReflectionDailyLimit,
  getReflectionModel,
  getDevEnvSelected,
  getSkillsDisabled
} from './store/settings'
import { installPreviewProtocol, registerPreviewScheme } from './preview-protocol'
import { createChatEmitter } from './chat-emitter'
import { isExternallyOpenable, isInternalUrl } from './url-guard'
// 窗口登记制（2026-09-13）：取代散落各处的 `getAllWindows()[0]` —— 多窗口后那个前提不再成立
import { getMainWindow, getWindow, isWindowOpen, registerWindow, sendToAll } from './window-registry'
// 批 2：反思执行器接线 —— 模型调用走 provider 抽象（与对话同一出口），会话读取走 conversations 单例
import { getSettingsView, getDecryptedApiKey, hasApiKey } from './store/models'
import { createProvider } from './providers'
import { addReflectionUsage, getConversation } from './store/conversations'
import type { ChatMessage } from '@shared/ipc'
import type { ReflectChat } from './memory/reflection'
import { resolveReflectModel } from './memory/reflection'
import { mergeUsageHalves, type TokenUsage } from '@shared/usage'
import { REFLECTION_SYSTEM_PROMPT } from './memory/reflection-prompt'

// 主进程入口：窗口生命周期 + IPC 注册（Agent 内核跑在 worker_threads，不在这里）。

/**
 * **单实例锁**（plan8 R13，2026-09-12 用户定案）。
 *
 * 两个实例共享同一数据目录，"读旧快照 → 整文件覆盖写"会让**后写的把先写的整个抹掉**（静默丢会话）；
 * 位置迁移时还会两个进程**同时判"新目录是空的" → 同时复制**，造出半迁移状态。
 *
 * ① 锁按数据目录区分 —— `--user-data-dir` 不同的实例**互不影响**：冒烟测试与验证脚本都跑在
 *    `%TEMP%` 隔离目录里，加了锁照样能跑（否则每次都得先关掉主人的窗口）；② 拿不到锁的第二个
 *    实例**直接退出**（不是"再开一个窗口"）；③ 第二个实例启动时把**已有窗口叫到前面**（用户意图是"我要用它"）。
 */
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 已有实例在跑：本进程什么也不做，安静退出（不是崩溃，所以不打 ERROR）
  app.quit()
} else {
  // 数据目录锁（plan10 C 批，与上面这把是**两把不同的锁**）：拿不到说明有另一个实例
  // 正用着这个数据目录（不同 userData 却指向同一自定义目录的场景，R13 那把锁挡不住）——
  // 这不是"让位给已有窗口"，是**拒绝启动并说明原因**（plan8 R13 补记的判据区分）。
  const lockFailed = getBootstrapOutcome().lockFailed
  if (lockFailed) {
    console.error(`[data-dir] 无法锁定数据目录，应用退出：${lockFailed}`)
    app.exit(1)
  } else {
    app.on('second-instance', () => {
      // ⚠️ 必须取**主窗口**，不能取任意窗口（2026-09-13）：用户双击图标时意图是"回到我的工作台"，
      //    若把浮在上面的**设置窗口**叫到前面，看起来就像主窗口丢了。
      const win = getMainWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      // plan37 S2 连带：关窗 flush 期间主窗口被 hide()，双击图标必须 show() 回来
      // （只 focus 对隐藏窗口无效 → 用户看着像"应用没了"）
      if (!win.isVisible()) win.show()
      win.focus()
    })
  }
}

// HTML 预览协议：**必须赶在 ready 之前**注册（迟了就只是个普通死链）
registerPreviewScheme()

/** 提问归属哨兵：`AskRequest.conversationId` 是可选字段（桥是通用的），但**绝不留空** ——
 *  空值查不出"这条问题是谁问的"（同 `ipc.ts` 的 `UI_RUN_OWNER` 口径）。 */
const ASK_OWNER_UNKNOWN = 'unknown'

/**
 * 安全基线（plan8 R3）：主窗口「只能停在自家页面」—— 两条 Electron 安全检查清单必做项，此前都缺失。
 * ① `setWindowOpenHandler`：markdown 里 `<a target="_blank">` 会弹出**无地址栏的新 Electron 窗口**（钓鱼风险）；
 * ② `will-navigate`：主窗口可被导航到任意网站，**整个应用被替换成外部网页**。
 * 外部 http(s) 一律交给**系统浏览器**，其余协议（file: / javascript: 等）直接拒绝 —— 交给 openExternal 是危险的。
 * ⚠️ **内置浏览器面板是独立 WebContents，导航自由，不受本函数约束**。
 */
function applyNavigationGuards(win: BrowserWindow): void {
  const log = createLogger('security')
  const devURL = process.env['ELECTRON_RENDERER_URL']

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url)
    } else {
      log.warn('拒绝打开非 http(s) 外部链接', { url })
    }
    return { action: 'deny' } // 绝不新建 Electron 窗口
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url, devURL)) return
    event.preventDefault()
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url)
    } else {
      log.warn('拦截非法导航', { url })
    }
  })
}

/**
 * 关窗口前先让渲染端把会话落盘（plan11 P0-2）。
 *
 * 内容在**渲染端**（主进程只有流式增量），而 `conv:save` 是异步 IPC —— 窗口一关，渲染进程连同
 * 未落盘的内容一起没了；并发之后**后台会话根本没人存**（整轮白跑、用户完全不知道）。
 * 做法：拦下第一次 `close` → 请渲染端 flush 全部 → 回执 → 才真关。
 * ⚠️ **必须带超时兜底**：渲染端卡死时窗口不能关不掉（"点叉没反应"比丢一次内容更糟，用户会开始强杀进程）。
 */
const FLUSH_TIMEOUT_MS = 2000

/** 当前窗口的"落盘完成 → 真关"回调；由 createWindow 装上，IPC 层回调它 */
let finishClose: (() => void) | null = null

/**
 * 关窗时把当前会话入反思队列（批 2 plan19）。
 * 与 `finishClose` 同口径：模块级单槽，由 app init 装上，`installFlushBeforeClose` 调。
 * ⚠️ 队列已落盘（meta.json）—— 即使反思没跑完，下次启动补跑队列会接着跑。
 */
let enqueueActiveForReflection: (() => void) | null = null

function installFlushBeforeClose(win: BrowserWindow): void {
  const log = createLogger('main')
  let flushed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const closeNow = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    flushed = true
    finishClose = null
    if (!win.isDestroyed()) win.close()
  }

  finishClose = closeNow

  win.on('close', (event) => {
    if (flushed || win.webContents.isDestroyed()) return
    // 批 2：关窗前把当前会话入反思队列（队列落盘在 meta.json，下次启动补跑）
    enqueueActiveForReflection?.()
    event.preventDefault()
    // plan37 S2：点 X 立即有反应 —— 先隐藏窗口，flush 在后台走完（最多 FLUSH_TIMEOUT_MS）。
    // 此前死区里窗口原地不动，用户把"已受理"读成"没点上"，转而强杀进程 —— 比丢内容更糟的体验。
    win.hide()
    try {
      win.webContents.send(IPC.flushRequest)
    } catch {
      // 发不出去（窗口正在销毁）→ 直接放行，别把关闭卡死
      flushed = true
      return
    }
    timer = setTimeout(() => {
      log.warn('落盘回执超时，照关窗口（渲染端可能已卡死）', { timeoutMs: FLUSH_TIMEOUT_MS })
      closeNow()
    }, FLUSH_TIMEOUT_MS)
  })

  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    finishClose = null
  })
}

// ── 反思执行器接线（批 2 plan19）─────────────────────────────────────────
//
// 装配层职责：① 组装 system prompt ② 把会话正文 + system prompt 发给模型 ③ 收回文本。
// 反思执行器（reflection.ts）只管"调 chat → 解析 JSON → 找冲突"，不碰 system prompt 与模型出口。
// ⚠️ 不传 conversationId 给模型 —— ReflectChat 接口只有 messages，id 留在 runner 里用于事件落痕。

// 反思 system prompt 住 `./memory/reflection-prompt.ts`（plan25 判据 7：拆出来让单测能断言内容）。

/**
 * 建反思用的 chat 接口。用**当前激活模型**调一次非流式对话（流式收集 chunks 即可）。
 * ⚠️ 不带工具、不带记忆注入 —— 反思是**旁观**，不参与对话。
 * 模型不可用（没配 Key / 没配端点）→ 返回空内容，反思执行器收到空串后返回空候选。
 */
function createReflectChat(): ReflectChat {
  return async (messages: ChatMessage[]): Promise<{ content: string; usage?: TokenUsage | null }> => {
    const base = getSettingsView()
    if (!base.baseURL || !base.model || !hasApiKey()) {
      return { content: '' }
    }
    // K14：以前这个函数只读 base.model，设置页那格「反思模型」读了都不读 —— 用户挑了便宜模型，
    // 反思仍按对话模型计费。覆盖的是**模型名**（那格是自由文本），端点与 Key 保持当前档案。
    const settings = { ...base, model: resolveReflectModel(base.model, getReflectionModel()) }
    const apiKey = getDecryptedApiKey()
    const provider = createProvider(settings.providerType)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
    const assembled: ChatMessage[] = [
      { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
      ...messages
    ]
    let content = ''
    let usage: TokenUsage | null = null
    try {
      await provider.streamChat(
        { settings, apiKey, messages: assembled, signal: controller.signal },
        {
          onChunk: (text) => {
            content += text
          },
          // K15：反思这笔账以前根本没有来源，现在随候选一起交回装配层
          onUsage: (u) => {
            usage = usage ? mergeUsageHalves(usage, u) : u
          }
        }
      )
    } finally {
      clearTimeout(timer)
    }
    return { content, usage }
  }
}

/**
 * 建智能标题用的轻调用（plan26 D-080）。与 ReflectChat 同款：**当前激活模型**、非流式、不带工具。
 * prompt 由 ipc 层组装（messages 原样转发）；模型不可用 → 返回空串（调用方 fail-soft 退机械标题）。
 */
function createTitleChat(): (messages: ChatMessage[]) => Promise<string> {
  return async (messages: ChatMessage[]): Promise<string> => {
    const settings = getSettingsView()
    if (!settings.baseURL || !settings.model || !hasApiKey()) return ''
    const apiKey = getDecryptedApiKey()
    const provider = createProvider(settings.providerType)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(settings.timeoutMs, 30_000))
    let content = ''
    try {
      await provider.streamChat(
        { settings, apiKey, messages, signal: controller.signal },
        { onChunk: (text) => { content += text } }
      )
    } finally {
      clearTimeout(timer)
    }
    return content
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '九十里路',
    show: false,
    // dev 态取项目内 resources/；打包态图标经 extraResources 落在 resources/ 根（asar 外）
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(app.getAppPath(), 'resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  applyNavigationGuards(win)
  installFlushBeforeClose(win)
  // ⚠️ 登记**用途**（2026-09-13）：之后取窗口一律按用途取，不再靠"数组第 0 个"
  registerWindow('main', win)

  win.on('ready-to-show', () => win.show())

  // electron-vite 约定：开发态注入 ELECTRON_RENDERER_URL，生产态加载构建产物
  const devURL = process.env['ELECTRON_RENDERER_URL']
  if (devURL) {
    void win.loadURL(devURL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 设置独立窗口（2026-09-13 用户定案）。
 *
 * **形态**：浮在主窗口之上的独立窗口，自带标题栏与关闭按钮（对齐用户给的 WorkBuddy 参考图）。
 *
 * **为什么用 `loadURL/loadFile` 带 hash 而不是另做一个 HTML 入口**：
 * electron-vite 的渲染产物入口是单一的 `index.html`。另建入口要动构建配置、多出一份 bundle，
 * 而这里两个窗口**共用同一份代码**（同一套组件与 store 初始化），差异只是"挂哪个根组件"——
 * hash 是这件事最轻的表达方式。`src/renderer/src/main.tsx` 按 hash 分叉。
 *
 * ⚠️ **幂等**：已开则聚焦，绝不叠第二个设置窗口（用户在侧栏连点两下不该出来两个）。
 * ⚠️ **不做 `installFlushBeforeClose`**：那个 flush 是**会话落盘**用的，设置窗口没有会话 ——
 *    给它装上只会白等 2 秒超时，且 `finishClose` 是**单槽全局变量**，会被设置窗口覆盖掉
 *    （那正是"主窗口关不掉 / 落错盘"的成因之一）。
 */
function openSettingsWindow(): void {
  if (isWindowOpen('settings')) {
    const win = getWindow('settings')
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    return
  }

  const win = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 720,
    minHeight: 520,
    title: '设置',
    show: false,
    parent: getMainWindow() ?? undefined,
    /**
     * 09-19 用户裁决：设置窗**不许最小化、不许最大化**，右上角只留系统 ×。
     * 起因是真实观感问题：点「-」之后任务栏那个缩略页签会挡在屏幕左下角。
     * 不能最小化 = 那个状态根本不会产生，比"藏掉按钮"更彻底。
     * ⚠️ 仍**不画自绘关闭钮**（2026-09-14 的决定）：系统 × 就在标题栏上，
     *    再画一个紧贴其下干同一件事，想关设置时极易误点成关掉整个应用。
     */
    minimizable: false,
    maximizable: false,
    // 反过来**保留**任务栏存在感（原注释写"不占任务栏"与这行相反，已按实际行为改正）：
    // 用户可能只想在设置里翻，一翻找不到窗口会比多一个任务栏按钮更困惑。
    skipTaskbar: false,
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(app.getAppPath(), 'resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  applyNavigationGuards(win)
  registerWindow('settings', win)

  /**
   * 锁住窗口标题：渲染入口是**单一 index.html**，其 `<title>九十里路</title>` 会在加载时
   * 覆盖掉上面 `title: '设置'` 的声明（e2e 实测 `getTitle()` 返回「九十里路」）。
   * 后果不只是标题栏不对 —— 设置窗与主窗在任务栏**同名**，正是"找不到窗口"的病根之一。
   * 主窗口不设这条：那里「九十里路」本来就是对的。
   */
  win.on('page-title-updated', (e) => e.preventDefault())

  win.on('ready-to-show', () => win.show())

  const devURL = process.env['ELECTRON_RENDERER_URL']
  const hash = '#/settings'
  if (devURL) {
    void win.loadURL(`${devURL}${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/settings' })
  }
}

app.whenReady().then(async () => {
  // 没拿到锁的第二个实例**到这里就停**：`app.quit()` 是异步的、ready 回调仍会跑到，否则它在退出的
  // 路上还会初始化一遍日志与异常兜底 —— 日志里多出一条「应用启动」，看着像"开了两次却只跑了一次"。
  if (!gotTheLock) return

  const userDataDir = app.getPath('userData')

  // 麦克风权限（plan45 R1）：Electron 默认**拒绝**一切权限请求 —— 不放行则 getUserMedia 静默失败。
  // 只放行"纯音频"的 media 请求（摄像头与其他权限一律维持默认拒绝）。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const types = 'mediaTypes' in (details ?? {}) ? (details as { mediaTypes?: string[] }).mediaTypes : undefined
    const audioOnly =
      permission === 'media' && Array.isArray(types) && types.includes('audio') && !types.includes('video')
    callback(audioOnly)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const media = permission === 'media' && !String(details?.mediaType ?? 'audio').includes('video')
    return media
  })

  // ① 日志系统（plan8 R2）：先于一切初始化，让后续所有环节都能留痕
  initLogger(join(userDataDir, 'logs'), app.isPackaged ? 'info' : 'debug')
  // ② 异常兜底（plan8 R1）：依赖日志，故紧随其后
  installCrashGuards()
  // ③ 事件循环看门狗（plan37 S0）：冻结只有带探针才留痕——5s 一次 tick、
  //    停滞 >1s 才写一条 WARN，常开成本可忽略。归因靠各长任务入口的阶段标记。
  startWatchdog()
  // ③′ 同步 FS 插桩（plan49 A 档）：面包屑原先只覆盖 IPC 通道，主进程内部的同步 fs 调用
  //     占死循环时零记录 —— 那正是真凶看不见的原因。一处包 node:fs，罩住全部调用点。
  installFsSyncTrace()
  const log = createLogger('main')
  log.info('应用启动', { version: app.getVersion(), packaged: app.isPackaged })

  // 去掉默认的 File/Edit/View 菜单栏（P0 用不到，界面更干净）
  Menu.setApplicationMenu(null)

  // 危险操作确认桥（plan8 R5）：推到当前窗口问用户。
  // 注意用**惰性取窗口**（调用时才查），因为桥是在 createWindow 之前建的。
  // 执行事件流 sink（plan26 D-077）：**组合根建一次**，ipc 层（对话轮次）与 confirm 桥（审批）共用
  const execEventSink = createFsExecEventSink(userDataDir, nodeFsAdapter, {
    onWarn: (message, extra) => log.warn(message, extra)
  })

  const confirm = createConfirmBridge({
    send: (req) => {
      // ⚠️ 必须取**主窗口**（2026-09-13）：确认框问的是"要不要执行这条命令"，那是**主窗口那条会话**的事。
      //    取任意窗口的话，用户正在设置里改东西时会被一个"是否允许 rm -rf"的框糊脸 —— 上下文全错。
      const win = getMainWindow()
      if (!win) return false
      // 走同一发送口（plan11 §2.5）：确认请求也带会话身份 —— 否则并发时用户会批了另一条会话的命令
      createChatEmitter(win.webContents, req.conversationId).confirm(req)
      return true
    },
    log: (message, extra) => log.info(message, extra),
    // plan26 D-077：审批结论进执行事件流（user/timeout/undeliverable/aborted 各留其痕）
    onDecide: (info) => {
      createExecEventRecorder({
        sink: execEventSink,
        conversationId: info.conversationId,
        agentScope: 'main'
      }).record('approve', { tool: info.tool, allowed: info.allowed, reason: info.reason })
    }
  })

  // 计划批准桥（plan27）：planner agent 出完方案后**阻塞等用户点头**，点头才由 executor 接续执行。
  // 手法与确认桥完全一致（惰性取主窗口 / 走同一发送口 / 结论进执行事件流），但**另开一条通道** ——
  // 它摆的是一整篇方案（长文本），塞进「即将执行一条命令」那个框会撑爆那条安全关键路径。
  const planApproval = createPlanApprovalBridge({
    send: (req) => {
      // 同确认桥：必须取**主窗口** —— 批准卡问的是「要不要执行这份方案」，那是主窗口那条会话的事
      const win = getMainWindow()
      if (!win) return false
      createChatEmitter(win.webContents, req.conversationId).planApproval(req)
      return true
    },
    log: (message, extra) => log.info(message, extra),
    onDecide: (info) => {
      // 复用 `approve` kind：语义同为「一次审批的结论」，payload 三字段完全吻合。
      // **不新开第 7 种 kind** —— 那要同时动 @shared/exec-events 的联合类型、EXEC_PAYLOAD_WHITELIST、
      // 时间线渲染与它的测试四处，而这里没有新语义需要它承载（用 `tool` 名区分足矣）。
      createExecEventRecorder({
        sink: execEventSink,
        conversationId: info.conversationId,
        agentScope: 'main'
      }).record('approve', { tool: 'plan_approval', allowed: info.allowed, reason: info.reason })
    }
  })

  // 后台任务注册表（plan7 批 D）：**进程级单例** —— 窗口关闭时统一终止，留一堆没人管的进程是隐患
  const background = createBackgroundTaskStore()

  // ── 系统集成（plan7 批 F1）：锁屏/熄屏后继续运行 + 开机自启 ──────
  //
  // 依赖全部注入（连 store 也是）：`system-integration.ts` **不 import electron** ——
  // 架构守卫禁止单测 import 图里出现 electron / electron-store，注入才让它进得了单测链路。
  //
  // ⚠️ 启动项要写的是**用户手里那个可执行文件**：portable 版每次运行解压到不同的临时目录，
  //    写 `process.execPath` 会得到一个下次开机根本不存在的路径（electron-builder 为 portable 注入了
  //    `PORTABLE_EXECUTABLE_FILE`，指向用户解压/存放的那个 .exe）。
  const systemExecPath = process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.execPath
  const system = createSystemIntegration({
    packaged: app.isPackaged,
    platform: process.platform,
    execPath: systemExecPath,
    powerSaveBlocker,
    loginItem: {
      set: (input) => app.setLoginItemSettings(input),
      // ⚠️ 读也要传同一个 path：Electron 只在 set/get 参数一致时才认得出那条启动项
      get: (input) => app.getLoginItemSettings(input)
    },
    store: { read: getSystemSettings, write: setSystemSettings },
    log: (message, extra) => log.info(message, extra)
  })
  // 重启后仍生效靠这一步：blocker 是**进程级**的，进程没了就没了，每次启动都要按落盘意图重新起
  const systemAtStart = system.applyStored()
  // 记录 execPath：portable 版自启项指向哪儿，只有日志能事后查（也是安装版验收的一条证据）
  log.info('系统集成已就绪', {
    packaged: app.isPackaged,
    execPath: systemExecPath,
    keepRunning: systemAtStart.keepRunning,
    keepRunningActive: systemAtStart.keepRunningActive,
    openAtLogin: systemAtStart.openAtLogin,
    openAtLoginSupported: systemAtStart.openAtLoginSupported
  })

  // Agent 提问桥（带选项）：与确认桥同样是"惰性取窗口"。
  // ⚠️ 推送走**所有窗口**（同后台任务 / 终端的广播写法），不是 `getAllWindows()[0]`：只推第一个窗口的话，
  //    用户关窗重开（macOS activate）那条问题就没人看得见 —— 而桥还在等答复，白等到超时。
  const ask = createAskBridge({
    send: (req) => {
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      if (wins.length === 0) return false
      for (const w of wins) {
        createChatEmitter(w.webContents, req.conversationId ?? ASK_OWNER_UNKNOWN).ask(req)
      }
      return true
    },
    log: (message, extra) => log.info(message, extra)
  })

  // 记忆库（plan19 批 1 + 批 2）：组合根建**一次**，同时给 agent 上下文（工具 + 注入）与 IPC（管理界面）。
  // ⚠️ 数据根由这里注入 —— 记忆层因此不碰 electron；"记忆改不了权限"那条不变量靠守卫乙守着。
  // 批 2：反思执行器也在这里接线 —— 装配层负责取数据 + 组装 system prompt + 注入 chat 接口。
  const memory = createMemoryStore(userDataDir, nodeFsAdapter, {
    onWarn: (message, extra) => log.warn(message, extra),
    onReflectionLog: (message, extra) => log.info(message, extra),
    dailyLimit: getReflectionDailyLimit(),
    // plan55 片①-b（D-139 R6）：守卫要能判「运行环境为 X」是否与本机矛盾，而真源只有这里知道。
    // ⚠️ 不写进 `shared/memory.ts` 也不写进 `memory-store.ts` —— 那两层是纯函数，硬编码平台名会让
    // 换一台机器就跑出错误判定（09-25 那条真实候选正是这么来的）。
    hostPlatform: process.platform,
    // plan53 片 2（D-131）：审批门**每次写现读**。设置页那个开关是逃生口，
    // 建库时读一次会把它变成"重启才生效"——用户当场关掉、下一轮照样被拦，那是骗人。
    modelWritesNeedApproval: () => getMemoryApprovalGate(),
    // 校验会话存在（审查 C P1：不重试坏 id，不卡住队列）
    conversationsExists: (id) => getConversation(id) !== null,
    // 取会话正文（含 bodyBytes）—— 反思前置门靠 bodyBytes 判断是否值得跑
    getConversationForReflect: (id) => {
      const conv = getConversation(id)
      if (!conv) return null
      return { messages: conv.messages, bodyBytes: conv.bodyBytes ?? 0 }
    },
    // 反思 chat 接口：把会话正文 + 反思 system prompt 发给模型，收回 JSON 候选
    reflectChat: createReflectChat(),
    // K15：落到会话元数据（逐次累加），用量牌那格「反思 N tokens」才有数
    // 写完必须喊一声：反思跑在一轮结束之后，而列表重读是这格唯一的刷新时机 —— 不广播就要等下次开会话
    onReflectionUsage: (conversationId, usage) => {
      if (addReflectionUsage(conversationId, usage)) sendToAll(IPC.convChanged)
    }
  })

  // Playbook 库（plan19 批 3）：与记忆库同式 —— 组合根建**一次**，同时给 agent 上下文（工具 + 注入）
  // 与 IPC（管理界面）。⚠️ 数据根同样由这里注入，Playbook 层因此不碰 electron。
  // ⚠️ 落 `userData/evolution/`（与 `memory/` **物理隔离**：预算语义不同）。
  const playbook = createPlaybookStore(userDataDir, nodeFsAdapter, {
    onWarn: (message) => log.warn(message, {}),
    conversationId: () => getActiveConversationId()
  })

  // 技能库（plan22）：内置随包分发（resources/skills，extraResources），用户层在 userData/skills。
  // **只读资产** —— 本期无写路径（导入功能后续版本），reload 接口已预留。
  const skillsStore = createSkillsStore({
    builtinDir: app.isPackaged
      ? join(process.resourcesPath, 'skills')
      : join(app.getAppPath(), 'resources/skills'),
    userDir: join(userDataDir, 'skills'),
    onWarn: (message) => log.warn(message, {}),
    // 禁用名单走**注入**而不是让 skills 层去读 settings（那条不变量由 architecture.test.ts 守卫）。
    // 口径只写在 store 一处：注入清单与 `use_skill` 注册都从 `activeEntries()` 出。
    isDisabled: (name) => getSkillsDisabled().includes(name)
  })

  // MCP 客户端（plan23）：配置住 userData/mcp-servers.json（用户资产，含 env token → 原子写）。
  // ⚠️ 启动时全量连接、失败不阻塞（D-063 fail-soft）；不 await —— 连接在后台完成，状态经 IPC 可查。
  const mcp = createMcpManager({
    userDataDir,
    clientVersion: app.getVersion(),
    onWarn: (message) => log.warn(message, {})
  })
  void mcp.connectAll()

  // 批 2：关窗时把当前会话入反思队列（installFlushBeforeClose 调）
  enqueueActiveForReflection = () => {
    const id = getActiveConversationId()
    if (id && getAutoMemoryEnabled() && getMemoryEnabled()) {
      memory.enqueueReflection(id)
    }
  }

  // plan43 S3：开发环境（运行时）→ PATH 覆盖。**两条线共用同一份实现**（终端 / Agent 命令）——
  // 分开写迟早分岔（本项目在 `killProcessTree` 上踩过同款：两套判据必然漂移）。
  //
  // ⚠️ 三条钉死，逐条对应设计依据：
  //   ① **基准 = 启动快照**（`process.env.PATH` 在此时取值，显式兜底为 `''`）：不用实时值，
  //      否则反复注入会层层叠加。**显式 `?? ''` 而非靠下游兜底** —— 类型上它是 `string | undefined`，
  //      靠 `injectRuntimePath` 里的兜底掩盖上游不严谨，是"错误在远处被消化"。
  //   ② **文件级 shim**（`syncRuntimeBin`）：不注入 dirname，避免 conda 那种"选 python 连带 conda.exe"。
  //   ③ **每次 run 现读**（由 `runner.ts` 在 run 开始时求值一次，见那里注释）。
  //      ⚠️ 注意口径：是"**每个 run** 现读"，**不是每条命令现读** —— 后者会让同一个 run 内
  //      用户一改设置就换环境，破坏"run 内不漂移"。2026-09-19 子代理复查抓到过这个口径混乱。
  const bootPath: string = process.env.PATH ?? ''
  const resolveRuntimeEnv = (): RuntimeEnv => {
    const selected = getDevEnvSelected()
    const has = Object.values(selected).some((v) => typeof v === 'string' && v.trim().length > 0)
    if (!has) {
      // ★ 取消全部选择 ⇒ **必须清理旧 shim**。否则 `<userData>/runtime-bin/` 里留着上一轮的
      //   `python.cmd`（内容仍指向已取消的可执行文件）—— "删除即撤销"的承诺不成立，且用户若
      //   之后手把它加进自己的 PATH，会静默改回旧运行时。故这里不是空转，是**撤销动作**。
      syncRuntimeBin(userDataDir, {})
      return { pathOverride: undefined, fingerprint: '' }
    }
    const synced = syncRuntimeBin(userDataDir, selected)
    // 原件缺失（用户卸了/移了）→ **不注入**：注入一个空的中转目录等于把 PATH 头部占住却什么也给不了，
    // 会让用户"看起来配了、实际更糟"。如实退回原环境，缺失详情由设置页呈现。
    if (synced.entries.length === 0) return { pathOverride: undefined, fingerprint: '' }
    return {
      pathOverride: injectRuntimePath(bootPath, synced.dir),
      fingerprint: currentFingerprint(selected, userDataDir)
    }
  }

  // Agent 运行时上下文：内置定义随打包资源分发；工作区惰性解析（用户可切换，免重启）
  const agentCtx = createAgentContext({
    getWorkspaceRoot: () => resolveWorkspaceRoot(userDataDir).root,
    builtinAgentsDir: app.isPackaged
      ? join(process.resourcesPath, 'agents')
      : join(app.getAppPath(), 'resources/agents'),
    userAgentsDir: join(userDataDir, 'agents'),
    // 检查点（plan8 R4）：Agent 每轮改动前的文件快照存这里，供回滚
    checkpointDir: join(userDataDir, 'checkpoints'),
    // 危险操作确认（plan8 R5）：run_command 执行前问用户
    confirmCommand: (req) => confirm.ask(req),
    // plan43 S3：开发环境 → 命令执行时的 PATH 覆盖（每个 agent run 现读）
    resolveRuntimeEnv,
    // 提问口（ask_user）：注入的是**桥本体**（只用到 ask 一个方法）—— runner 不许 import electron，故由组合根注入
    ask,
    // 计划批准（plan27）：planner 出完方案后阻塞等用户点头；不注入 = 闸门不生效（安全默认）
    planApproval,
    background,
    // 记忆（plan19 批 1）：repo 给工具用，确认桥给「确认档」写入问一句。
    // ⚠️ `conversationId` 不在这里补 —— 同一个上下文会被多条会话共用，由 runner 按轮次补。
    memory: {
      repo: memory,
      // 记忆开关（批 1）：每轮由 runner 读一次 —— 改设置即时生效，不用重启
      enabled: () => getMemoryEnabled(),
      confirm: (reason: string, conversationId: string) =>
        confirm.ask({ tool: 'remember', detail: reason, agent: '记忆', where: '', conversationId })
    },
    // Playbook（plan19 批 3）：repo 给工具用。⚠️ 无开关 —— 它是模型显式调用的程序记忆，
    // 不像自动记忆那样会自己花钱；"有消费者才注册"（不传就不下发工具）是唯一门槛。
    playbook: { repo: playbook },
    // 技能（plan22）：只读库，供 use_skill 工具与 system prompt 清单注入。
    // ⚠️ 无开关（D-058：use_skill 是读操作，只读档也可用）；"有消费者才注册"（D-059）在 runner 内判空。
    skills: { store: skillsStore },
    // MCP（plan23）：manager 给工具聚合与转发；执行走确认桥（D-064，conversationId 在 runner 内补）。
    // plan34 S2b：开关走配置 `cfg.enabled`（单一真相源）—— manager 的 connectAll/saveServer 天然跳过被禁者
    mcp: { manager: mcp },
    // L0 检索（plan3/plan4）：随包的 ripgrep 放 resources/ripgrep/（extraResources）。
    // ⚠️ 开发态 `process.resourcesPath` 指向 electron 自己的 resources —— 那里没有我们的 rg，
    //    于是会自动退到环境变量 / PATH（本机 WinGet 装的 rg 15.2.0 能接上）；这不是降级事故。
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    // 回收站（plan7 批 A2）：界面与 Agent 的删除都走它（非硬删）
    trash: (abs) => shell.trashItem(abs)
  })

  // 后台任务状态变化 → 推给所有窗口（右栏「任务」页签据此刷新）
  background.onChange(() => {
    const list = background.list()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.bgChanged, list)
    }
  })

  // ── 内置终端（plan7 批 C）────────────────────────────────────
  //
  // 会话在组合根建、不建在 `ipc.ts` 里：**广播代码必须在这一层** —— `ipc.ts` 里一个裸 `.send(` 都不许有
  // （`tests/unit/stream-envelope.test.ts` 有守卫；那条守卫守的是一次真实事故：绕开唯一发送口就会漏带会话身份、界面串台）。
  // ⚠️ `node-pty` 是**原生模块**：**延迟到第一次真开终端时才 require** —— 这样它加载失败的结果是
  //    "终端开不起来（会话层变成 spawn-failed）"，而**不是整个应用起不来**。
  let ptyModule: PtyModuleLike | null = null
  const cjsRequire = createRequire(__filename)
  const loadPty = (): PtyModuleLike => {
    if (!ptyModule) {
      // 用 createRequire 而不是 `require(...)`：主进程产物是 CJS，而 eslint 禁了裸 require。
      // ⚠️ **不能**提到顶层：顶层加载会让"原生模块坏了"从"终端不可用"升级成"应用起不来"。
      ptyModule = cjsRequire('node-pty') as PtyModuleLike
    }
    return ptyModule
  }

  const terminal = createTerminalSessionStore({
    getPermission: getPermissionPreset,
    getWorkspaceRoot: () => agentCtx.getWorkspaceRoot(),
    // E5：每次起终端现读开关（改设置不必重启应用；活会话不换壳）
    loadProfile: getTerminalLoadProfileEnabled,
    // plan43 S3：每次起终端现读运行环境（同上口径 —— 新开终端跟随新选择，已开的不换壳）
    resolvePath: () => resolveRuntimeEnv().pathOverride,
    pty: { spawn: (file, args, opts) => loadPty().spawn(file, args, opts) }
  })

  // 终端输出 → 推给所有窗口（**进程级**通道，不带会话信封；理由见 shared/ipc.ts 那段注释）
  terminal.onData((sessionId, chunk) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send(IPC.terminalData, { sessionId, seq: chunk.seq, data: chunk.data })
      }
    }
  })
  terminal.onState((sessionId) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.terminalState, sessionId)
    }
  })

  // ── 网络代理（plan7 批 F2）──────────────────────────────────────────────
  //
  // 两件事，**顺序不能反**：
  //   ① 先把模型请求的网络出口换成 `net.fetch` —— 只有它吃 session 的代理配置（Node 原生 fetch 不吃，
  //      实证见 `scripts/probe-main-proxy.cjs`）。不换这一步，下面配什么都是"改了没反应"。
  //   ② 再按落盘意图 `setProxy` 一次 —— 它是**进程级**的，进程没了就没了，每次启动都要重来。
  installElectronFetch()
  log.info('模型请求网络出口已就绪', { kind: httpFetchKind() })

  const network = createNetworkProxy({
    session: {
      // ⚠️ 只作用于**默认 session**：模型请求与内置浏览器都在这一个 session 里，故一次配置两边都生效
      setProxy: (config) => session.defaultSession.setProxy(config),
      resolveProxy: (url) => session.defaultSession.resolveProxy(url)
    },
    store: { read: getNetworkSettings, write: setNetworkSettings },
    // 凭据走 safeStorage：代理地址里的 user:pass 是凭据，不进明文配置
    credentials: { read: getNetworkCredentials, write: setNetworkCredentials },
    log: (message, extra) => log.info(message, extra)
  })
  // await 到"应用成功"为止（这一步要挡住启动：不然第一发模型请求可能跑在老配置上）；
  // 探测"当前生效的代理"要问系统，慢 —— 放后台，界面打开设置页时会自己再取一次。
  const networkAtStart = await network.applyStored(false)
  void network.refresh()
  log.info('网络代理已按落盘意图应用', {
    mode: networkAtStart.proxyMode,
    applied: networkAtStart.applied,
    error: networkAtStart.error
  })

  // 看门狗面包屑（09-19 卡顿排查）：包一层 ipcMain.handle，记每通道进出 —— 停滞告警里
  // 最后一条「> 进了没出」的通道就是占死主进程的元凶。放组合根一处包，**所有通道自动纳入**，
  // 不要求每个 handler 自觉打点（自觉打点必漏，等价于没有）。
  // ⚠️ 诊断注入绝不许拖垮启动：monkeypatch 失败（Electron 内部表示变化、属性不可写）只落 ERROR、照常启动。
  try {
    const rawHandle = ipcMain.handle.bind(ipcMain) as typeof ipcMain.handle
    ipcMain.handle = ((ch: string, fn: (e: Electron.IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
      (rawHandle as (c: string, f: unknown) => void)(ch, (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
        const t0 = performance.now()
        breadcrumb(`> ${ch}`)
        // 抛错也要落一条闭环面包屑 —— 否则「进了没出」会把出错的通道误认成元凶
        try {
          const r = fn(e, ...args)
          if (r instanceof Promise) {
            return r.then(
              (v) => {
                breadcrumb(`< ${ch} ${Math.round(performance.now() - t0)}ms`)
                return v
              },
              (err) => {
                breadcrumb(`× ${ch} ${Math.round(performance.now() - t0)}ms`)
                throw err
              }
            )
          }
          breadcrumb(`< ${ch} ${Math.round(performance.now() - t0)}ms`)
          return r
        } catch (err) {
          breadcrumb(`× ${ch} ${Math.round(performance.now() - t0)}ms`)
          throw err
        }
      })) as typeof ipcMain.handle
  } catch (err) {
    log.error('IPC 面包屑包装器安装失败（诊断降级，不影响功能）', {
      message: err instanceof Error ? err.message : String(err)
    })
  }

  registerIpcHandlers({
    agent: agentCtx,
    userDataDir,
    // 回收站（plan34 S2b 技能删除走它）—— 与 agent 上下文里的 trash 同一份
    trash: (abs) => shell.trashItem(abs),
    memory,
    playbook,
    confirm,
    ask,
    // 计划批准桥（plan27）：ipc 层只做回执转交，桥本体在组合根
    planApproval,
    terminal,
    system,
    network,
    // 执行事件流（plan26 D-077）：组合根建的 sink，ipc 层摊到每轮对话的 recorder 上
    execEventSink,
    // 智能标题（plan26 D-080）：轻调用出口在组合根（它持有模型 Provider）——同 ReflectChat 口径
    titleChat: createTitleChat(),
    // 渲染端回执"落盘完成" → 才真关窗口（plan11 P0-2）
    onFlushDone: () => finishClose?.(),
    // ── 设置独立窗口（2026-09-13）────────────────────────────────
    // 开窗走 IPC：渲染端不 import electron（架构守卫），必须由主进程建窗口
    openSettingsWindow,
    // ⚠️ 广播代码只能在这一层（`ipc.ts` 里一个裸 `.send(` 都不许有，有守卫盯着）。
    onSettingsChanged: (kind) => {
      const n = sendToAll(IPC.settingsChanged, kind)
      log.info('设置变更已广播', { kind, windows: n })
    }
  })
  // HTML 沙箱预览：`jsl-preview://doc/<相对路径>` → 工作区文件，带断脚本/断网响应头（真源见 src/shared/html-preview.ts）
  installPreviewProtocol(() => agentCtx.getWorkspaceRoot())
  createWindow()

  // 内置浏览器：真 Chromium 视图，用户与 Agent 共用同一实例
  // ⚠️ 浏览器视图挂在**主窗口**上（2026-09-13）：设置窗口里没有浏览器面板，
  //    若这里取到设置窗口，`initBrowser` 会把 WebContentsView 挂到错误的窗口上。
  const win = getMainWindow()
  if (win) {
    initBrowser(win)
    // 状态变化推给所有窗口（地址栏/标题/前进后退可用性）
    setBrowserStateListener((state) => {
      // 通道名走 `IPC` 常量（plan54 #4）：裸字面量在改名时会静默断，且没有一道闸会红
      sendToAll(IPC.browserChanged, state)
    })
    // 把真实实现注入 agent 层的浏览器接缝（那边不 import electron）
    setBrowserAdapter({
      currentUrl: browserCurrentUrl,
      navigate: async (url) => {
        const s = await browserNavigate(url)
        return { url: s.url, title: s.title }
      },
      readPage: browserReadPage,
      click: browserClick,
      type: browserType
    })
    log.info('浏览器适配器已注入 agent 接缝')
  } else {
    // plan38 S3：不就绪是**状态**不是"稍后重试能好"的事 —— 留一条硬痕，browser_* 报错时能对上现场
    log.error('浏览器未初始化：主窗口不存在，browser_* 工具将不可用')
  }

  // ── 启动补跑反思队列（批 2 plan19）─────────────────────────────────────
  // 上次会话切走时入了队但没跑完（崩溃 / 关窗口 / 模型不可用）→ 队列留在 meta.json 里。
  // 启动时把队列里的会话逐条出队 + 异步跑反思（不阻塞启动，不 await）。
  // ⚠️ 只在自动记忆开启时跑 —— 用户关了自动记忆就不补跑（省 token）。
  if (getAutoMemoryEnabled() && getMemoryEnabled()) {
    const pending = memory.backend.readMeta().reflectionQueue
    if (pending.length > 0) {
      log.info('启动补跑反思队列', { count: pending.length })
      void (async () => {
        for (;;) {
          const id = memory.dequeueReflection()
          if (!id) break
          await memory.runReflection(id).catch((err) => {
            log.warn('补跑反思失败', {
              conversationId: id,
              error: err instanceof Error ? err.message : String(err)
            })
          })
        }
      })()
    }
  }

  app.on('activate', () => {
    // ⚠️ 判据是"**主窗口**还在不在"，不是"有没有任何窗口"（2026-09-13）：
    //    设置窗口浮着而主窗口被关掉时，`getAllWindows().length !== 0` → 旧写法**不会再建主窗口**，
    //    用户点 Dock 图标什么也不发生（macOS 上这就是"应用假死"的观感）。
    if (!getMainWindow()) {
      createWindow()
      // macOS 关窗即 `teardownAll`（cookie：两个入口都调它）→ blocker 被收掉；窗口重建时按落盘意图重新应用，
      // 否则"设置里开着、实际没生效"。`applyStored` 幂等，window 已存在时不会走到这里。
      system.applyStored()
    }
  })

  // 窗口全关时，把待决的危险操作确认按**拒绝**处理 —— 否则那个 Agent 会一直卡在等待上直到超时。
  // ⚠️ 收尾清单**只有这一处实现**，`before-quit` 与 `window-all-closed` 两个入口都调它。
  //    为什么两个都要挂：Electron 文档写得很死 —— 用户按 **Cmd+Q** 或代码调 `app.quit()` 时
  //    **不会**触发 `window-all-closed`（它先关窗口、直接进 `will-quit`）；只挂一个入口，macOS 上每次退出都留个没人管的 shell。
  const teardownAll = (): void => {
    confirm.abortAll('窗口已全部关闭')
    // 提问同理 —— 没人能作答了，按未作答结束，而不是让那条 Agent 干等满 5 分钟
    ask.abortAll('窗口已全部关闭')
    // 后台命令跟着终止（plan7 批 D 边界①）—— 与确认桥同一口径
    background.killAll()
    // 终端会话同理：**不留没人管的 shell**（它可能正跑着 dev server / 数据库）。
    terminal.killAll()
    // Agent 的常驻 shell 同理 —— `terminal.killAll()` 只管终端面板那份，
    // `run_command` 复用出来的 shell 在另一个注册表里（`shell-session.ts` 的 `liveSessions`），不收到就活下来。
    disposeAllShellSessions()
    // 系统请求也要收（不清掉的话退出瞬间系统仍被我们按着不休眠）。它**只收系统请求、不改用户的落盘选择**
    system.dispose()
  }

  app.on('window-all-closed', teardownAll)
  app.on('before-quit', teardownAll)
  // 数据目录锁正常释放（崩溃时锁文件留在盘上，下次启动靠 pid 存活检测自愈）
  app.on('will-quit', () => releaseBootstrapLock())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})