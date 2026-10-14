// 浏览器适配器接缝（agent 层专用）。
//
// 为什么要有这一层：agent 层**不得 import electron**（CI 无 Electron 二进制，一旦引入单测即炸，
import type { ConfirmFn } from '../browser-policy'
// 见 tests/unit/architecture.test.ts 的守卫）。但浏览器工具必须驱动真实的 WebContentsView。
// 解法＝依赖倒置：这里只声明接口与一个可注入的槽位，真实实现由 main/index.ts 在启动时注入。

import { AsyncLocalStorage } from 'node:async_hooks'

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

/** 宿主导入的受控任务上下文（plan79 切片 2）：确认桥与身份；缺失 = 不降级放行外部作用。 */
export interface BrowserTaskContext {
  /** 实际发起代理名（确认卡署名）——每个 job 装配自己的上下文，不共用父的可变实例 */
  agent: string
  conversationId?: string
  /** 宿主**结构化**浏览器确认桥（修正 D：保留真实 tool/站点/发起者，不经命令字符串包装）；null = 无确认服务 */
  confirm: ConfirmFn | null
  /**
   * 内置浏览器开关实时探针（plan79 切片 3）：每个执行前核；false = 排队动作立即停止。
   * 缺省 = 不因未知状态拦截（关停由工具不下发兜底）。
   */
  isEnabled?: () => boolean
}

export interface BrowserAdapter {
  /** 每轮独立固定目标；底层由主进程维护页面身份与同标签排队。 */
  createTask?(signal?: AbortSignal, ctx?: BrowserTaskContext): BrowserAdapter
  assertReady?(): void
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
  /** 列标签：走任务接缝（开关核验 + 排队）；async 化是为了统一过门位（修正 B） */
  listTabs(): Promise<TabRecord[]>
  newTab(url?: string): Promise<TabRecord>
  /** 切换任务目标：只过门位不先核旧目标（它是当前目标死亡时的恢复通道） */
  selectTab(id: string): Promise<TabRecord | null>
  closeTab(id: string): Promise<boolean>
  /** 文件上传：经 CDP `DOM.setFileInputFiles`（Electron 无原生 file chooser 拦截） */
  uploadFile(target: string, filePath: string): Promise<string>
  /** 等待条件：文本或选择器出现（轮询，超时报"未出现"而非卡死） */
  waitFor(target: string, timeoutMs?: number): Promise<string>
}

let adapter: BrowserAdapter | null = null
const taskAdapter = new AsyncLocalStorage<BrowserAdapter>()
export function withBrowserTask<T>(target: BrowserAdapter, action: () => T): T {
  return taskAdapter.run(target, action)
}

export function setBrowserAdapter(next: BrowserAdapter): void {
  adapter = next
}

/** 取当前适配器；未注入时返回 null（工具会给出明确提示而非崩溃） */
export function getBrowserAdapter(): BrowserAdapter | null {
  return taskAdapter.getStore() ?? adapter
}
