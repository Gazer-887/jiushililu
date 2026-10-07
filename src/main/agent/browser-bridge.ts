// 浏览器适配器接缝（agent 层专用）。
//
// 为什么要有这一层：agent 层**不得 import electron**（CI 无 Electron 二进制，一旦引入单测即炸，
// 见 tests/unit/architecture.test.ts 的守卫）。但浏览器工具必须驱动真实的 WebContentsView。
// 解法＝依赖倒置：这里只声明接口与一个可注入的槽位，真实实现由 main/index.ts 在启动时注入。

/** 元素矩形（CSS 像素，相对页面视口左上角） */
export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 矩形中心点（真输入事件的落点）。纯函数、单测钉住 ——
 * 点算错 = 点到隔壁元素，比"没点到"更坏（后者会报错，前者静默干错事）。
 */
export function centerOfRect(r: ElementRect): { x: number; y: number } {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}

/** 标签页记录（界面与工具共用同一份；视图本体在 browser.ts 那边按 id 挂） */
export interface TabRecord {
  id: string
  url: string
  title: string
}

export interface BrowserAdapter {
  currentUrl(): string
  navigate(url: string): Promise<{ url: string; title: string }>
  readPage(): Promise<string>
  click(target: string): Promise<string>
  type(target: string, text: string): Promise<string>
  /** 真悬停：真鼠标移到元素中心（K22：合成事件在这里失灵，真输入才作数） */
  hover(target: string): Promise<string>
  /** 真按键：keyDown + keyUp（一对，不拆） */
  pressKey(key: string): Promise<string>
  /** 真拖拽：从一处按住拖到另一处（两处都按选择器/文本解析） */
  drag(from: string, to: string): Promise<string>
  /** 截图：返回 PNG 的 base64（落盘由工具层经注入的 saver 做，这里只管取） */
  screenshot(): Promise<{ base64: string; mime: 'image/png' }>
  /** 可访问性快照：JSON 数组（role/name/selector），供模型定位元素 */
  snapshot(): Promise<string>
  /** 执行脚本（高危：只经 browserControl 开关下发，工具描述里带风险注记） */
  evalScript(js: string): Promise<string>
  /** console 环形缓冲的文本化（监听在 browser.ts 初始化时装，不在这里） */
  consoleMessages(): Promise<string>
  /** CDP Network 域收到的请求摘要（监听同上；未启用时报"无记录"而非空） */
  networkRequests(): Promise<string>
  /** 处理当前挂起的 dialog（无挂起时报最后一条记录，不抛） */
  handleDialog(action: 'accept' | 'dismiss', promptText?: string): Promise<string>
  listTabs(): TabRecord[]
  newTab(url?: string): Promise<TabRecord>
  selectTab(id: string): TabRecord | null
  closeTab(id: string): boolean
  /** 文件上传：经 CDP `DOM.setFileInputFiles`（Electron 无原生 file chooser 拦截） */
  uploadFile(target: string, filePath: string): Promise<string>
  /** 等待条件：文本或选择器出现（轮询，超时报"未出现"而非卡死） */
  waitFor(target: string, timeoutMs?: number): Promise<string>
}

let adapter: BrowserAdapter | null = null

export function setBrowserAdapter(next: BrowserAdapter): void {
  adapter = next
}

/** 取当前适配器；未注入时返回 null（工具会给出明确提示而非崩溃） */
export function getBrowserAdapter(): BrowserAdapter | null {
  return adapter
}
