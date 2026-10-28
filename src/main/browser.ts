import { WebContentsView, BrowserWindow, shell, type WebContents } from 'electron'
import type { BrowserBounds, BrowserState } from '@shared/ipc'
import { isExternallyOpenable } from './url-guard'
import { createLogger } from './log'
import type { ElementRect } from './agent/browser-bridge'
import { centerOfRect } from './agent/browser-bridge'
import { classifyBrowserAction, TaskAuthorizer, BrowserGateError, type BrowserTargetInfo } from './browser-policy'
import type { BrowserTaskContext } from './agent/browser-bridge'
import type { BrowserAdapter } from './agent/browser-bridge'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AgentPauseError } from './agent/pause-error'
import { DIALOG_AUTO_DISMISS_MS, RingBuffer, TRACE_CAP, WAIT_DEFAULT_MS, WAIT_MAX_MS, WAIT_POLL_MS } from './agent/browser-utils'

const log = createLogger('browser')

// 内置浏览器（P2 右抽屉「浏览器」）：**真浏览器**，不是占位。
//
// plan60：一批直做 —— 多标签（多 WebContentsView，active 才挂窗口）+ 真输入事件
// （`sendInputEvent`，替掉合成点击；K22 教训）+ CDP 三件（console / network / dialog）。
// 外部浏览器只做兼容（D-157）：这里的操作对象永远是我们自己的 view，不是用户日常浏览器。

interface DialogRecord {
  type: string
  message: string
  url: string
  at: number
}

interface Tab {
  revision: number
  injecting: boolean
  /** 人工输入事实计数（plan79 修正二）：before-input-event 且非 Agent 注入时 +1。
   *  navigate 采纳新基线前核它——加载期间的人为输入不得被吸收进版本基线。 */
  humanInputSeq: number
  id: string
  view: WebContentsView
  url: string
  title: string
  loading: boolean
  console: RingBuffer<string>
  network: RingBuffer<string>
  pendingDialog: DialogRecord | null
  lastDialog: DialogRecord | null
  cdpAttached: boolean
  cdpDead: boolean
}

let hostWindow: BrowserWindow | null = null
let bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
let visible = false
let tabSeq = 0

const tabs = new Map<string, Tab>()
let activeTabId: string | null = null
const taskContext = new AsyncLocalStorage<{ tab: Tab; check(): void }>()
const tabQueues = new Map<string, Promise<unknown>>()

function checkTask(): void { taskContext.getStore()?.check() }
function sendBrowserInput(t: Tab, event: Parameters<WebContents['sendInputEvent']>[0]): void {
  checkTask()
  t.injecting = true
  try { t.view.webContents.sendInputEvent(event) }
  finally { t.injecting = false }
}

/** 适配器方法 → 工具名 的**显式单一映射**（修正 D）：不再按驼峰猜名——猜名曾把
 *  consoleMessages/networkRequests/waitFor 映射成不存在的工具名，只读动作被误判成 risky 拒掉。 */
export const BROWSER_METHOD_TOOLS: Record<string, string> = {
  navigate: 'browser_navigate',
  readPage: 'browser_read_page',
  click: 'browser_click',
  type: 'browser_type',
  hover: 'browser_hover',
  pressKey: 'browser_press_key',
  drag: 'browser_drag',
  screenshot: 'browser_screenshot',
  snapshot: 'browser_snapshot',
  evalScript: 'browser_eval_script',
  consoleMessages: 'browser_console',
  networkRequests: 'browser_network',
  handleDialog: 'browser_dialog',
  newTab: 'browser_tabs',
  listTabs: 'browser_tabs',
  selectTab: 'browser_tabs',
  closeTab: 'browser_tabs',
  uploadFile: 'browser_upload',
  waitFor: 'browser_wait'
}

/** 元素解析片段（选择器优先、可交互元素文本兜底）：resolveRect 与 describeTarget **共用同一段** ——
 *  两处解析分岔会让「读到的元素」和「点到的东西」不是同一个（修正 B 的授权前提）。 */
function resolveElementSnippet(target: string): string {
  return `
      const sel = ${JSON.stringify(target)};
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { /* 非合法选择器，按文本找 */ }
      if (!el) {
        const all = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link]')];
        el = all.find(n => ((n.innerText || n.value || n.getAttribute('aria-label') || '').trim()).includes(sel));
      }`
}

/** 宿主固定读脚本：读取点击/输入**目标元素的事实**（提交控件/普通字段/链接/未知控件）。
 *  只读、不改页面；在授权判定前运行，为分类提供宿主侧事实 —— 模型话术与按钮文案不参与分类。 */
async function describeTarget(t: Tab, target: string): Promise<BrowserTargetInfo | null> {
  const script = `
    (() => {
      /* nb:target-probe */
      ${resolveElementSnippet(target)}
      if (!el) return null;
      // ── 统一事件路径规则（限定修正批，替代逐例补洞）────────────────────────────
      // ① 沿 parentElement 读**命中节点到根的整条路径**（无硬编码层数截断）；label 另读其
      //    关联目标的路径。危险事实做 **OR 汇总**——不能在最近的 input/a 上停止。
      // ② 防护性截断（>512 层）或读取异常 → 返回 null（未知 → 保守按 risky），
      //    **绝不回退叶节点称普通安全**。
      // ③ 最近控件身份只用于描述与输入语义（field/link 候选），不决定祖先风险消失。
      // 只读宿主事实，不扫描注册监听器（合同内不承诺万能分类）。
      const pathOf = (node) => {
        const out = [];
        let cur = node;
        while (cur) {
          out.push(cur);
          if (cur === document.documentElement) return out;
          cur = cur.parentElement;
          if (out.length > 512) return null;
        }
        return out;
      };
      let nodes;
      try {
        nodes = pathOf(el);
        if (nodes) {
          const lab = nodes.find((n) => n.tagName && n.tagName.toLowerCase() === 'label');
          if (lab) {
            const forId = lab.getAttribute('for');
            const owned = forId ? document.getElementById(forId) : lab.querySelector('input,button,select,textarea');
            if (owned) {
              const lp = pathOf(owned);
              if (!lp) nodes = null;
              else nodes = nodes.concat(lp);
            }
          }
        }
      } catch (e) {
        nodes = null;
      }
      if (!nodes) return null;
      const factsOf = (n) => {
        const tag = n.tagName.toLowerCase();
        const type = (n.getAttribute('type') || '').toLowerCase();
        return {
          tag,
          type,
          role: (n.getAttribute('role') || '').toLowerCase(),
          onclick: n.hasAttribute('onclick'),
          editable: n.isContentEditable === true
        };
      };
      let risk = false;
      let submit = false;
      let file = false;
      let editable = false;
      for (const n of nodes) {
        const f = factsOf(n);
        if ((f.tag === 'button' && (f.type === '' || f.type === 'submit')) ||
            (f.tag === 'input' && (f.type === 'submit' || f.type === 'image'))) {
          submit = true;
          risk = true;
        }
        if (f.tag === 'input' && f.type === 'file') {
          file = true;
          risk = true;
        }
        if (f.tag === 'button') risk = true; // 任意 button 祖先/自身：点击会冒泡到它
        if (f.tag === 'input' && (f.type === 'button' || f.type === 'reset')) risk = true;
        if (f.onclick) risk = true; // 明确 onclick：DOM 属性可读，不是监听器扫描
        if (f.role === 'button') risk = true;
        if (f.editable) {
          editable = true;
          risk = true;
        }
      }
      let ctl = el;
      for (const n of nodes) {
        const t = n.tagName.toLowerCase();
        if (t === 'button' || t === 'input' || t === 'a' || t === 'select' || t === 'textarea' || t === 'label') {
          ctl = n;
          break;
        }
      }
      if (ctl.tagName.toLowerCase() === 'label') {
        const forId = ctl.getAttribute('for');
        const owned = forId ? document.getElementById(forId) : ctl.querySelector('input,button,select,textarea');
        if (owned) ctl = owned;
      }
      const tag = ctl.tagName.toLowerCase();
      const type = (ctl.getAttribute('type') || '').toLowerCase();
      const role = (ctl.getAttribute('role') || '').toLowerCase();
      const form = ctl.closest ? ctl.closest('form') : null;
      const field = (tag === 'input' || tag === 'textarea' || tag === 'select') && !submit && !file &&
        !(tag === 'input' && (type === 'button' || type === 'reset'));
      const link = (tag === 'a' && ctl.hasAttribute('href')) || role === 'link';
      return {
        submit, file, field, editable, link,
        // control = 整条路径已知危险事实的 OR（不被 field/link 身份短路）
        control: risk,
        desc: tag + (type ? '[' + type + ']' : '') + (ctl !== el ? '（关联控件）' : ''),
        formAction: form ? String(form.action || '') : '',
        formMethod: form ? String(form.method || '').toLowerCase() : ''
      };
    })()
  `
  const info = (await t.view.webContents.executeJavaScript(script, true)) as BrowserTargetInfo | null
  return info && typeof info === 'object' ? info : null
}

/** 每轮固定标签，不跟随界面焦点；同标签操作共享进程内队列。 */
export function createBrowserTaskAdapter(
  base: BrowserAdapter,
  signal?: AbortSignal,
  ctx?: BrowserTaskContext
): BrowserAdapter {
  let target = activeTab()
  let revision = target?.revision ?? -1
  /** 开关/取消探针：**每个执行前**的核验都走这里（修正 B：不只在发起确认前核一次） */
  const assertEnabled = (): void => {
    signal?.throwIfAborted()
    if (ctx?.isEnabled && !ctx.isEnabled()) {
      throw new BrowserGateError('内置浏览器已关闭：排队动作已停止（可在设置页重新开启）')
    }
  }
  const assertTargetAlive = (): void => {
    if (!target || tabs.get(target.id) !== target || target.view.webContents.isDestroyed())
      throw new AgentPauseError('目标标签已关闭或不存在，任务已暂停')
  }
  /** 严格核验：开关 + 取消 + 目标身份 + 版本（普通动作的执行前/后） */
  const check = (): void => {
    assertEnabled()
    assertTargetAlive()
    if (target!.revision !== revision) throw new AgentPauseError('页面已变化，任务已暂停；请重新确认目标')
  }
  /** 放宽核验：navigate 自身加载会推高版本，其加载期间只保开关/取消/标签存在 */
  const checkRelaxed = (): void => {
    assertEnabled()
    assertTargetAlive()
  }
  // plan79 切片 2 + 修正批：宿主任务门位。readonly 直通（仍过开关核验）；task/risky 经
  // TaskAuthorizer 问宿主确认桥；缺 ctx/确认服务 = 拒绝，不降级用全局适配器执行。
  const authorizer = ctx ? new TaskAuthorizer(ctx.confirm) : null
  const originOf = (url: string): string => {
    try {
      return new URL(url).origin
    } catch {
      return '(未知站点)'
    }
  }
  /** 权限探针只认实际工具名：browser_task 是确认卡的虚拟名，不能拿来做权限判断。 */
  const assertToolAllowed = (tool: string): void => {
    if (!ctx?.isToolAllowed) return // 旧兼容：未注入探针 = 不启用实时权限收紧
    let allowed = false
    try {
      allowed = ctx.isToolAllowed(tool) === true
    } catch {
      allowed = false // 权限源读取抛错/无效：只读动作也必须 fail-closed
    }
    if (!allowed) throw new BrowserGateError('权限已收紧，已拒绝该浏览器动作')
  }
  const gate = async (prop: string, args: unknown[]): Promise<boolean> => {
    const toolName = BROWSER_METHOD_TOOLS[prop] ?? 'browser_unknown'
    const argMap: Record<string, unknown> = {
      0: args[0],
      1: args[1],
      url: args[0],
      key: args[0],
      target: args[0],
      from: args[0],
      to: args[1],
      filePath: args[1],
      js: args[0],
      text: args[1]
    }
    if (prop === 'newTab') argMap['action'] = 'new'
    else if (prop === 'listTabs') argMap['action'] = 'list'
    else if (prop === 'selectTab') argMap['action'] = 'select'
    else if (prop === 'closeTab') argMap['action'] = 'close'
    else if (prop === 'handleDialog') argMap['action'] = args[0]
    assertEnabled()
    // 点击/输入：先读宿主侧目标事实再分类（只读脚本；不读页面 = 无从区分提交与普通元素）
    if ((prop === 'click' || prop === 'type') && target) {
      argMap['targetInfo'] = await describeTarget(target, String(args[0] ?? ''))
      assertEnabled()
    }
    if (classifyBrowserAction(toolName, argMap) === 'readonly') {
      // 只读不等于"绕过权限源"：有效 read-only 探针为 true；来源抛错/无效、run 失活/取消必须拒绝。
      assertToolAllowed(toolName)
      return false
    }
    if (!ctx || !authorizer) {
      throw new BrowserGateError('浏览器动作缺少宿主任务上下文，已拒绝（不降级执行）')
    }
    // 目标分类/describeTarget 等异步准备之后先核一次：等待期间撤权不得进入确认/缓存分支
    assertToolAllowed(toolName)
    const site =
      toolName === 'browser_navigate' || toolName === 'browser_tabs'
        ? originOf(String(args[0] ?? target?.view.webContents.getURL() ?? ''))
        : originOf(target?.view.webContents.getURL() ?? '')
    const r = await authorizer.authorize({
      tool: toolName,
      args: argMap,
      agent: ctx.agent,
      conversationId: ctx.conversationId,
      site
    })
    if (!r.allowed) throw new BrowserGateError(r.reason ?? '浏览器动作未获授权')
    // ★ 确认/缓存许可返回后重核（修正 B）：等待期间撤权/关开关 → 旧批准不得继续
    assertEnabled()
    assertToolAllowed(toolName)
    return true
  }
  /** gate 是 async：await 返回到调用方还有一个微任务边界，动作前必须再核一次（只读同样适用）。 */
  const assertGateAfterAwait = (prop: string): void => {
    assertToolAllowed(BROWSER_METHOD_TOOLS[prop] ?? 'browser_unknown')
  }
  return new Proxy(base, {
    get(object, property) {
      if (property === 'createTask') return undefined
      if (property === 'assertReady') return check
      if (property === 'currentUrl') return () => { check(); return target!.view.webContents.getURL() }
      const fn = Reflect.get(object, property)
      if (typeof fn !== 'function') return fn
      return (...args: unknown[]) => {
        const tab = target
        const key = tab?.id ?? 'new-tab'
        const previous = tabQueues.get(key) ?? Promise.resolve()
        const operation = previous.catch(() => {}).then(async () => {
          signal?.throwIfAborted()
          if (property === 'newTab') {
            await gate('newTab', args)
            assertGateAfterAwait('newTab')
            const created = await browserNewTab(args[0] as string | undefined)
            target = tabs.get(created.id)!; revision = target.revision
            return created
          }
          // selectTab 是**恢复通道**：当前目标已死时也要能切走（只过门位，不先核旧目标）
          if (property === 'selectTab') {
            await gate('selectTab', args)
            assertGateAfterAwait('selectTab')
            assertEnabled()
            const next = tabs.get(args[0] as string)
            if (!next) return null
            target = next; revision = next.revision
            return { id: next.id, url: next.url, title: next.title }
          }
          // listTabs 是纯读：不要求当前目标存活（它就是用来找恢复目标的）
          if (property === 'listTabs') {
            await gate('listTabs', args)
            assertGateAfterAwait('listTabs')
            return browserListTabs()
          }
          check()
          await gate(property as string, args)
          assertGateAfterAwait(property as string)
          // ★ 门后重核（修正 B）：确认等待期间人工换页/换目标 → 旧批准不得覆盖
          check()
          if (target !== tab) throw new Error('任务目标已改变，未执行旧操作')
          if (property === 'closeTab') {
            if (args[0] !== target!.id) return false
            // 本标签还有**更新**的排队操作时不关它（自己不算——闭包体在 operation 初始化后才跑，
            // 这里引用的是本操作自身的 promise）
            if (tabQueues.get(target!.id) !== operation) return false
            return browserCloseTab(args[0] as string)
          }
          const context = { tab: tab!, check: property === 'navigate' ? checkRelaxed : check }
          // 修正二：导航加载期间的人工输入事实（before-input-event）不能被吸收进新基线 ——
          // 采纳前核对；有介入则暂停且**不更新基线**（后续动作继续暂停，新任务/重读确认可继续）
          const humanBefore = tab!.humanInputSeq
          const result = await taskContext.run(context, () => fn.apply(object, args))
          if (property === 'navigate') {
            if (tab!.humanInputSeq !== humanBefore) {
              throw new AgentPauseError('页面已变化，任务已暂停；请重新确认目标')
            }
            revision = tab!.revision
          }
          check()
          return result
        })
        tabQueues.set(key, operation)
        void operation.finally(() => {
          if (tabQueues.get(key) === operation) tabQueues.delete(key)
        }).catch(() => {})
        if (!signal) return operation
        return new Promise((resolve, reject) => {
          const aborted = (): void => reject(signal.reason)
          signal.addEventListener('abort', aborted, { once: true })
          void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
          if (signal.aborted) aborted()
        })
      }
    }
  })
}

type StateListener = (s: BrowserState) => void
let onState: StateListener | null = null

export function setBrowserStateListener(cb: StateListener): void {
  onState = cb
}

function activeTab(): Tab | null {
  return (activeTabId && tabs.get(activeTabId)) || null
}

function emit(): void {
  const t = activeTab()
  const wc = t?.view.webContents
  onState?.({
    url: t?.url ?? '',
    title: t?.title ?? '',
    loading: t?.loading ?? false,
    canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
    canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    tabs: [...tabs.values()].map((x) => ({ id: x.id, url: x.url, title: x.title })),
    activeTabId: activeTabId ?? ''
  })
}

/** 视图先不加入窗口，等界面说"显示"时再挂（避免它压住整个 UI） */
function attachView(t: Tab): void {
  if (!hostWindow || !visible) return
  for (const other of tabs.values()) {
    if (other.id !== t.id && hostWindow.contentView.children.includes(other.view)) {
      hostWindow.contentView.removeChildView(other.view)
    }
  }
  if (!hostWindow.contentView.children.includes(t.view)) hostWindow.contentView.addChildView(t.view)
  applyBounds()
}

function applyBounds(): void {
  const t = activeTab()
  if (!t || !visible) return
  t.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  })
}

function wireTab(t: Tab): void {
  const wc = t.view.webContents
  wc.on('did-start-loading', () => {
    t.revision += 1
    t.loading = true
    if (t.id === activeTabId) emit()
  })
  wc.on('before-input-event', () => {
    if (!t.injecting) {
      t.revision += 1
      t.humanInputSeq += 1 // 人工输入事实（与 revision 分开记：navigate 要能区分"自身加载演进"与"人介入"）
    }
  })
  wc.on('did-navigate-in-page', () => { t.revision += 1 })
  wc.on('did-stop-loading', () => {
    t.loading = false
    t.url = wc.getURL()
    t.title = wc.getTitle()
    if (t.id === activeTabId) emit()
  })
  wc.on('did-navigate', (_e, url) => {
    t.url = url
    if (t.id === activeTabId) emit()
  })
  wc.on('did-navigate-in-page', (_e, url) => {
    t.url = url
    if (t.id === activeTabId) emit()
  })
  wc.on('page-title-updated', (_e, title) => {
    t.title = title
    if (t.id === activeTabId) emit()
  })
  // console 用原生事件即可（不需要 CDP）：K22 同族 —— 别为能直接拿的东西开重量级通道
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    t.console.push(`[${sourceId}:${line}] ${message}`)
  })
  // 弹窗进新标签（D-157：绝不新建 Electron 窗口；外部 http(s) 交系统浏览器）
  t.view.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url) && /^https?:\/\//i.test(url)) {
      void browserNewTab(url).catch((err) => log.warn('弹窗进新标签失败', { url, err: String(err) }))
    } else if (isExternallyOpenable(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

/**
 * CDP 按需挂载（network / dialog / upload 三件共用；console 不走这里）。
 * 挂不上（debugger 被占）不抛 —— 记死，后续三件报"CDP 未就绪"人话，不静默空记录。
 */
async function ensureCdp(t: Tab): Promise<boolean> {
  if (t.cdpAttached) return true
  if (t.cdpDead) return false
  try {
    await t.view.webContents.debugger.attach('1.3')
    t.cdpAttached = true
    await t.view.webContents.debugger.sendCommand('Network.enable')
    await t.view.webContents.debugger.sendCommand('Page.enable')
    t.view.webContents.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const p = params as { request?: { url?: string; method?: string } }
        t.network.push(`${p.request?.method ?? '?'} ${p.request?.url ?? '?'}`)
      } else if (method === 'Page.javascriptDialogOpening') {
        const p = params as { type?: string; message?: string; url?: string }
        const rec: DialogRecord = {
          type: String(p.type ?? 'alert'),
          message: String(p.message ?? ''),
          url: String(p.url ?? t.url),
          at: Date.now()
        }
        t.pendingDialog = rec
        t.lastDialog = rec
        // 兜底（plan60 §三.4）：无人处理就自动关 —— 页面绝不能被卡死
        setTimeout(() => {
          if (t.pendingDialog === rec) {
            t.pendingDialog = null
            t.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
          }
        }, DIALOG_AUTO_DISMISS_MS)
      }
    })
    t.view.webContents.debugger.on('detach', () => {
      t.cdpAttached = false
    })
    return true
  } catch (err) {
    t.cdpDead = true
    log.warn('CDP 挂载失败（network/dialog/upload 将报未就绪）', { tab: t.id, err: String(err) })
    return false
  }
}

/** 初始化（应用启动时调用一次）：建首个空白标签但先不显示 */
export function initBrowser(win: BrowserWindow): void {
  hostWindow = win
  void browserNewTab('about:blank').catch((err) => log.warn('首标签创建失败', { err: String(err) }))
  win.on('closed', () => {
    tabs.clear()
    activeTabId = null
    hostWindow = null
  })
}

/** 显示/隐藏：只有显示时才挂 active 视图，避免隐形原生视图挡住界面 */
export function setBrowserVisible(next: boolean): void {
  if (!hostWindow) return
  if (next === visible) return
  visible = next
  const t = activeTab()
  if (next) {
    if (t) attachView(t)
  } else {
    for (const other of tabs.values()) {
      if (hostWindow.contentView.children.includes(other.view)) hostWindow.contentView.removeChildView(other.view)
    }
  }
}

/** 渲染进程算好区域后传过来（CSS 像素，相对窗口内容区左上角） */
export function setBrowserBounds(rect: BrowserBounds): void {
  bounds = rect
  if (visible) applyBounds()
}

export function getBrowserState(): BrowserState {
  const t = activeTab()
  const wc = t?.view.webContents
  return {
    url: t?.url ?? '',
    title: t?.title ?? '',
    loading: t?.loading ?? false,
    canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
    canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    tabs: [...tabs.values()].map((x) => ({ id: x.id, url: x.url, title: x.title })),
    activeTabId: activeTabId ?? ''
  }
}

// ── 标签页 ────────────────────────────────────────────────────────────────

export interface TabInfo {
  id: string
  url: string
  title: string
}

export function browserListTabs(): TabInfo[] {
  return [...tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title }))
}

export async function browserNewTab(url?: string): Promise<TabInfo> {
  if (!hostWindow) throw new Error('浏览器尚未初始化')
  tabSeq += 1
  const id = `tab-${tabSeq}`
  const view = new WebContentsView({
    webPreferences: {
      // 浏览器视图同样遵守隔离基线：不暴露 Node、不开 nodeIntegration
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const t: Tab = {
    revision: 0,
    injecting: false,
    humanInputSeq: 0,
    id,
    view,
    url: url ?? 'about:blank',
    title: '',
    loading: false,
    console: new RingBuffer<string>(TRACE_CAP),
    network: new RingBuffer<string>(TRACE_CAP),
    pendingDialog: null,
    lastDialog: null,
    cdpAttached: false,
    cdpDead: false
  }
  wireTab(t)
  tabs.set(id, t)
  activeTabId = id
  attachView(t)
  // 初始加载一个空白页（否则 URL 为空时导航接口会报错）
  await view.webContents.loadURL(t.url)
  emit()
  return { id, url: t.url, title: t.title }
}

export function browserSelectTab(id: string): TabInfo | null {
  const t = tabs.get(id)
  if (!t) return null
  activeTabId = id
  attachView(t)
  emit()
  return { id: t.id, url: t.url, title: t.title }
}

export function browserCloseTab(id: string): boolean {
  const t = tabs.get(id)
  if (!t) return false
  if (hostWindow?.contentView.children.includes(t.view)) hostWindow.contentView.removeChildView(t.view)
  try {
    const wc = t.view.webContents as WebContents & { destroy?: () => void }
    if (typeof wc.destroy === 'function') wc.destroy()
  } catch (err) {
    // destroy 不可用就只摘除视图（老 Electron 无此方法）：泄漏一个 view，比崩强，记一条可查
    log.warn('标签视图无法销毁（仅摘除）', { tab: id, err: String(err) })
  }
  try {
    if (t.cdpAttached) t.view.webContents.debugger.detach()
  } catch {
    /* 已 detach 或已销毁，无视 */
  }
  tabs.delete(id)
  if (activeTabId === id) {
    const rest = [...tabs.keys()]
    activeTabId = rest.length > 0 ? rest[rest.length - 1]! : null
    const next = activeTab()
    if (next) attachView(next)
  }
  emit()
  return true
}

// ── 导航（界面按钮与 Agent 工具共用同一实现）───────────────────────────────

function needTab(): Tab {
  checkTask()
  const t = taskContext.getStore()?.tab ?? activeTab()
  if (!t) throw new Error('浏览器没有打开的标签页')
  return t
}

export async function browserNavigate(url: string): Promise<BrowserState> {
  const t = needTab()
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
  await t.view.webContents.loadURL(normalized)
  t.url = t.view.webContents.getURL()
  t.title = t.view.webContents.getTitle()
  return { ...getBrowserState(), url: t.url, title: t.title }
}

export function browserGoBack(): BrowserState {
  const t = activeTab()
  if (t?.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack()
  return getBrowserState()
}

export function browserGoForward(): BrowserState {
  const t = activeTab()
  if (t?.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward()
  return getBrowserState()
}

export function browserReload(): BrowserState {
  activeTab()?.view.webContents.reload()
  return getBrowserState()
}

/** 外部浏览器打开（plan60 §四小入口：控制权交回用户，属兼容不属能力） */
export async function browserOpenExternal(url: string): Promise<string> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`
  if (!isExternallyOpenable(target)) return `拒绝：在外部浏览器中打开被拒（只允许 http(s)）：${target}`
  await shell.openExternal(target)
  return `已在外部浏览器中打开：${target}`
}

/** 读取当前页面文本（Agent 用；与 fetch_url 的区别是它能拿到 JS 渲染后的内容） */
export async function browserReadPage(): Promise<string> {
  const t = needTab()
  const text = (await t.view.webContents.executeJavaScript(
    'document.body ? document.body.innerText : ""',
    true
  )) as string
  const title = t.view.webContents.getTitle()
  const url = t.view.webContents.getURL()
  return `页面标题：${title}\n地址：${url}\n\n${text.slice(0, 20000)}`
}

// ── 元素定位（真输入三件共用）：先滚到可见，再取矩形 ───────────────────────

async function resolveRect(t: Tab, target: string): Promise<ElementRect | null> {
  const script = `
    (() => {
      ${resolveElementSnippet(target)}
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()
  `
  const r = (await t.view.webContents.executeJavaScript(script, true)) as ElementRect | null
  checkTask()
  if (!r || r.width <= 0 || r.height <= 0) return null
  return r
}

/**
 * 点击元素（Agent 用）：**真鼠标** —— 矩形中心先后 dispatch mouseMove / mouseDown / mouseUp。
 * K22 教训：`setPointerCapture` 这类实现会吃掉合成 `.click()`，而判据照不出来 ——
 * 所以点击路径里**不许出现合成 click**（结构守卫见 tests/unit/browser-plan60.test.ts）。
 */
export async function browserClick(target: string): Promise<string> {
  const t = needTab()
  const rect = await resolveRect(t, target)
  if (!rect) return `未找到可点击的元素：${target}`
  const p = centerOfRect(rect)
  sendBrowserInput(t, { type: 'mouseMove', x: p.x, y: p.y })
  sendBrowserInput(t, { type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  sendBrowserInput(t, { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  return `已点击 ${target}（${p.x},${p.y}）`
}

/** 真悬停：真鼠标移到元素中心（悬停预览这类交互，合成 mouseover 同样不可靠） */
export async function browserHover(target: string): Promise<string> {
  const t = needTab()
  const rect = await resolveRect(t, target)
  if (!rect) return `未找到可悬停的元素：${target}`
  const p = centerOfRect(rect)
  sendBrowserInput(t, { type: 'mouseMove', x: p.x, y: p.y })
  return `已悬停 ${target}（${p.x},${p.y}）`
}

/** 命名按键 → Electron Accelerator 键名；sendInputEvent 的 keyCode 只认字符串
 *  （数字键码整个事件被判「Invalid event object」——plan79 故事二实测断点）。
 *  Enter 必须补一个 char('\r') 才有 keypress——只发 keyDown 时页面收得到 keydown
 *  但隐式表单提交不触发（同批探针 V1 vs V3 实证）；单字符同理靠 char 落字。 */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right'
}

/** 会产生字符的命名键：char 事件的 keyCode 用这个字符（真实键盘上 Enter 的字符是 CR） */
const KEY_CHARS: Record<string, string> = { enter: '\r', return: '\r' }

export async function browserPressKey(key: string): Promise<string> {
  const t = needTab()
  const trimmed = key?.trim()
  if (!trimmed) return '错误：key 不能为空'
  const low = trimmed.toLowerCase()
  const code = KEY_ALIASES[low] ?? trimmed
  sendBrowserInput(t, { type: 'keyDown', keyCode: code })
  const char = KEY_CHARS[low] ?? (code.length === 1 ? code : null)
  if (char) sendBrowserInput(t, { type: 'char', keyCode: char })
  sendBrowserInput(t, { type: 'keyUp', keyCode: code })
  return `已按键 ${key}`
}

/** 真拖拽：起点按下、终点松开（滑块 / 画布这类，合成事件拖不动） */
export async function browserDrag(from: string, to: string): Promise<string> {
  const t = needTab()
  const a = await resolveRect(t, from)
  if (!a) return `未找到拖拽起点：${from}`
  const b = await resolveRect(t, to)
  if (!b) return `未找到拖拽终点：${to}`
  const pa = centerOfRect(a)
  const pb = centerOfRect(b)
  sendBrowserInput(t, { type: 'mouseMove', x: pa.x, y: pa.y })
  sendBrowserInput(t, { type: 'mouseDown', x: pa.x, y: pa.y, button: 'left', clickCount: 1 })
  sendBrowserInput(t, { type: 'mouseMove', x: pb.x, y: pb.y })
  sendBrowserInput(t, { type: 'mouseUp', x: pb.x, y: pb.y, button: 'left', clickCount: 1 })
  return `已从 ${from} 拖到 ${to}`
}

/**
 * 在输入框中输入文本（Agent 用）：**先真点击聚焦**（受信任的 focus，下拉建议这类才跟得上），
 * 再走 DOM 设值（CJK 与 React 受控组件的兼容路 —— `char` 事件对 CJK 与受控组件都不可靠，
 * 全真键盘在这里是"更真但更残"，选兼容。分工写死，不许悄悄换边）。
 */
export async function browserType(target: string, text: string): Promise<string> {
  const t = needTab()
  const rect = await resolveRect(t, target)
  if (!rect) return `未找到可输入的元素：${target}`
  const p = centerOfRect(rect)
  const wc = t.view.webContents
  sendBrowserInput(t, { type: 'mouseMove', x: p.x, y: p.y })
  sendBrowserInput(t, { type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  sendBrowserInput(t, { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  const script = `
    (() => {
      const el = document.activeElement;
      if (!el) return 'NO_FOCUS';
      const val = ${JSON.stringify(text)};
      if (el.isContentEditable) { el.innerText = val; }
      else {
        const setter = Object.getOwnPropertyDescriptor(
          el.constructor.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'TYPED';
    })()
  `
  checkTask()
  const res = (await wc.executeJavaScript(script, true)) as string
  return res === 'TYPED' ? `已在 ${target} 输入文本` : `聚焦失败，未输入：${target}`
}

/** 截图：PNG 原字节的 base64（落盘由工具层经注入的 saver 做，这里只管取） */
export async function browserScreenshot(): Promise<{ base64: string; mime: 'image/png' }> {
  const t = needTab()
  const image = await t.view.webContents.capturePage()
  return { base64: image.toPNG().toString('base64'), mime: 'image/png' }
}

/** 可访问性快照：JSON 数组（role/name/selector），供模型定位元素（上限 100 行） */
export async function browserSnapshot(): Promise<string> {
  const t = needTab()
  const script = `
    (() => {
      const els = [...document.querySelectorAll(
        'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],h1,h2,h3'
      )].slice(0, 100);
      const path = (el) => {
        const parts = [];
        let n = el;
        while (n && n !== document.body && parts.length < 5) {
          let s = n.tagName.toLowerCase();
          if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
          const cls = (n.className && typeof n.className === 'string' ? n.className.trim().split(/\\s+/)[0] : '');
          if (cls) s += '.' + cls;
          parts.unshift(s);
          n = n.parentElement;
        }
        return parts.join(' > ');
      };
      return JSON.stringify(els.map((el, i) => ({
        i,
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).slice(0, 60),
        selector: path(el)
      })));
    })()
  `
  return (await t.view.webContents.executeJavaScript(script, true)) as string
}

/**
 * 执行脚本（高危：只经 browserControl 开关下发，工具描述里带风险注记）。
 * 返回 JSON 化结果（上限 4KB，超了截断 —— 脚本吐 1MB 回模型就是 token 事故）。
 */
export async function browserEvalScript(js: string): Promise<string> {
  const t = needTab()
  if (!js.trim()) return '错误：js 不能为空'
  try {
    const res = await t.view.webContents.executeJavaScript(js, true)
    const text = typeof res === 'string' ? res : JSON.stringify(res)
    return text.length > 4096 ? `${text.slice(0, 4096)}\n（已截断）` : text
  } catch (err) {
    return `脚本执行失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** console 环形缓冲的文本化（未启用监听时报"无记录"而非空 —— 空会让人以为页面没输出） */
export async function browserConsoleMessages(): Promise<string> {
  const t = needTab()
  const list = t.console.list()
  if (list.length === 0) return '暂无 console 记录（页面尚未输出，或监听未就绪）'
  return list.slice(-50).join('\n')
}

/** CDP Network 域收到的请求摘要（CDP 挂不上时报未就绪，不静默空） */
export async function browserNetworkRequests(): Promise<string> {
  const t = needTab()
  if (!(await ensureCdp(t))) return 'CDP 未就绪：网络记录不可用（debugger 被占用或已分离）'
  const list = t.network.list()
  if (list.length === 0) return '暂无网络请求记录（该标签页尚未发请求）'
  return list.slice(-50).join('\n')
}

/** 处理挂起的 dialog（无挂起时报最后一条记录；兜底自动 dismiss 保证页面不卡死） */
export async function browserHandleDialog(action: 'accept' | 'dismiss', promptText?: string): Promise<string> {
  const t = needTab()
  if (!(await ensureCdp(t))) return 'CDP 未就绪：dialog 不可处理（页面由兜底自动关闭，不会卡死）'
  if (!t.pendingDialog) {
    return t.lastDialog
      ? `当前无挂起 dialog（最后一条：${t.lastDialog.type}「${t.lastDialog.message.slice(0, 100)}」已自动关闭）`
      : '当前无挂起 dialog（本标签页尚未弹出过）'
  }
  const rec = t.pendingDialog
  t.pendingDialog = null
  try {
    checkTask()
    await t.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      ...(promptText !== undefined ? { promptText } : {})
    })
    return `已${action === 'accept' ? '接受' : '关闭'} dialog（${rec.type}）：${rec.message.slice(0, 100)}`
  } catch (err) {
    t.pendingDialog = rec
    return `处理 dialog 失败：${err instanceof Error ? err.message : String(err)}（已恢复挂起）`
  }
}

/** 文件上传：经 CDP `DOM.setFileInputFiles`（Electron 无原生 file chooser 拦截，只能走 CDP） */
export async function browserUploadFile(target: string, filePath: string): Promise<string> {
  const t = needTab()
  if (!(await ensureCdp(t))) return 'CDP 未就绪：文件上传不可用'
  try {
    const dbg = t.view.webContents.debugger
    await dbg.sendCommand('DOM.enable')
    const doc = (await dbg.sendCommand('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } }
    const q = (await dbg.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: target
    })) as { nodeId: number }
    if (!q.nodeId) return `未找到文件选择框：${target}（只支持 CSS 选择器）`
    checkTask()
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [filePath] })
    return `已为 ${target} 设置文件：${filePath}`
  } catch (err) {
    return `文件上传失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** 等待条件：文本或选择器出现（轮询；超时报"未出现"而非卡死） */
export async function browserWaitFor(target: string, timeoutMs: number = WAIT_DEFAULT_MS): Promise<string> {
  const t = needTab()
  const cap = Math.min(Math.max(timeoutMs, 0), WAIT_MAX_MS)
  const script = `
    (() => {
      const sel = ${JSON.stringify(target)};
      try { if (document.querySelector(sel)) return true; } catch (e) {}
      return (document.body?.innerText ?? '').includes(sel);
    })()
  `
  const start = Date.now()
  for (;;) {
    checkTask()
    const hit = (await t.view.webContents.executeJavaScript(script, true)) as boolean
    checkTask()
    if (hit) return `条件已出现：${target}（${Date.now() - start}ms）`
    if (Date.now() - start >= cap) return `超时未出现：${target}（${cap}ms）`
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
  }
}

/** Agent 工具用：当前地址（判断是否已打开页面） */
export function browserCurrentUrl(): string {
  return activeTab()?.view.webContents.getURL() ?? ''
}
