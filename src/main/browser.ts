import { WebContentsView, BrowserWindow } from 'electron'
import type { BrowserBounds, BrowserState } from '@shared/ipc'

// 内置浏览器（P2 右抽屉「浏览器」）：**真浏览器**，不是占位。
//
// 方案说明：Electron 33 已移除 <webview> 标签，改用 WebContentsView ——
// 一个真实的 Chromium 视图，由主进程管理、挂在主窗口上，按渲染进程给的矩形定位。
//
// **关键能力：Agent 可直接操控它**——同一份 WebContents 既供用户点击浏览，
// 也供内核的浏览器工具（browser_navigate / browser_read_page / browser_click / browser_type）
// 驱动。用户看到的就是 Agent 在操作的那个页面，不是两个世界。

let view: WebContentsView | null = null
let hostWindow: BrowserWindow | null = null
let bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
let visible = false

/** 当前状态（渲染进程同步用） */
const state: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}

type StateListener = (s: BrowserState) => void
let onState: StateListener | null = null

export function setBrowserStateListener(cb: StateListener): void {
  onState = cb
}

function emit(): void {
  if (!view) return
  const wc = view.webContents
  state.canGoBack = wc.navigationHistory.canGoBack()
  state.canGoForward = wc.navigationHistory.canGoForward()
  onState?.({ ...state })
}

/** 初始化（应用启动时调用一次）：建视图但先不显示 */
export function initBrowser(win: BrowserWindow): void {
  hostWindow = win
  view = new WebContentsView({
    webPreferences: {
      // 浏览器视图同样遵守隔离基线：不暴露 Node、不开 nodeIntegration
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 初始加载一个空白页（否则 URL 为空时导航接口会报错）
  void view.webContents.loadURL('about:blank')

  const wc = view.webContents
  wc.on('did-start-loading', () => {
    state.loading = true
    emit()
  })
  wc.on('did-stop-loading', () => {
    state.loading = false
    state.url = wc.getURL()
    state.title = wc.getTitle()
    emit()
  })
  wc.on('did-navigate', (_e, url) => {
    state.url = url
    emit()
  })
  wc.on('did-navigate-in-page', (_e, url) => {
    state.url = url
    emit()
  })
  wc.on('page-title-updated', (_e, title) => {
    state.title = title
    emit()
  })

  // 视图先不加入窗口，等界面说"显示"时再挂（避免它压住整个 UI）
  win.on('closed', () => {
    view = null
    hostWindow = null
  })
}

/** 显示/隐藏：只有显示时才挂到窗口上，避免隐形的原生视图挡住界面 */
export function setBrowserVisible(next: boolean): void {
  if (!view || !hostWindow) return
  if (next === visible) return
  visible = next
  if (next) {
    hostWindow.contentView.addChildView(view)
    applyBounds()
  } else {
    hostWindow.contentView.removeChildView(view)
  }
}

/** 渲染进程算好区域后传过来（CSS 像素，相对窗口内容区左上角） */
export function setBrowserBounds(rect: BrowserBounds): void {
  bounds = rect
  if (visible) applyBounds()
}

function applyBounds(): void {
  if (!view) return
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  })
}

export function getBrowserState(): BrowserState {
  return { ...state }
}

// ── 导航（界面按钮与 Agent 工具共用同一实现）────────────────

export async function browserNavigate(url: string): Promise<BrowserState> {
  if (!view) throw new Error('浏览器尚未初始化')
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
  await view.webContents.loadURL(normalized)
  state.url = view.webContents.getURL()
  state.title = view.webContents.getTitle()
  return getBrowserState()
}

export function browserGoBack(): BrowserState {
  if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack()
  return getBrowserState()
}

export function browserGoForward(): BrowserState {
  if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward()
  return getBrowserState()
}

export function browserReload(): BrowserState {
  view?.webContents.reload()
  return getBrowserState()
}

/** 读取当前页面文本（Agent 用；与 fetch_url 的区别是它能拿到 JS 渲染后的内容） */
export async function browserReadPage(): Promise<string> {
  if (!view) throw new Error('浏览器尚未初始化')
  const text = (await view.webContents.executeJavaScript(
    'document.body ? document.body.innerText : ""',
    true
  )) as string
  const title = view.webContents.getTitle()
  const url = view.webContents.getURL()
  return `页面标题：${title}\n地址：${url}\n\n${text.slice(0, 20000)}`
}

/** 点击元素（Agent 用）：按 CSS 选择器或可见文本匹配 */
export async function browserClick(target: string): Promise<string> {
  if (!view) throw new Error('浏览器尚未初始化')
  const script = `
    (() => {
      const sel = ${JSON.stringify(target)};
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { /* 非合法选择器，按文本找 */ }
      if (!el) {
        const all = [...document.querySelectorAll('a,button,input[type=submit],[role=button]')];
        el = all.find(n => (n.innerText || n.value || '').trim().includes(sel));
      }
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'CLICKED:' + (el.innerText || el.tagName || '').trim().slice(0, 60);
    })()
  `
  const res = (await view.webContents.executeJavaScript(script, true)) as string
  if (res === 'NOT_FOUND') return `未找到可点击的元素：${target}`
  return `已点击 ${res.replace('CLICKED:', '')}`
}

/** 在输入框中输入文本（Agent 用） */
export async function browserType(target: string, text: string): Promise<string> {
  if (!view) throw new Error('浏览器尚未初始化')
  const script = `
    (() => {
      const sel = ${JSON.stringify(target)};
      let el = null;
      try { el = document.querySelector(sel); } catch (e) {}
      if (!el) {
        const all = [...document.querySelectorAll('input,textarea,[contenteditable=true]')];
        el = all[0];
      }
      if (!el) return 'NOT_FOUND';
      el.focus();
      const val = ${JSON.stringify(text)};
      if (el.isContentEditable) { el.innerText = val; }
      else {
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
        if (setter) setter.call(el, val); else el.value = val;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'TYPED';
    })()
  `
  const res = (await view.webContents.executeJavaScript(script, true)) as string
  return res === 'NOT_FOUND' ? `未找到可输入的元素：${target}` : `已在 ${target} 输入文本`
}

/** Agent 工具用：当前地址（判断是否已打开页面） */
export function browserCurrentUrl(): string {
  return view?.webContents.getURL() ?? ''
}
