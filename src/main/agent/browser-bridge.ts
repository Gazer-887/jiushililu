// 浏览器适配器接缝（agent 层专用）。
//
// 为什么要有这一层：agent 层**不得 import electron**（CI 无 Electron 二进制，一旦引入单测即炸，
// 见 tests/unit/architecture.test.ts 的守卫）。但浏览器工具必须驱动真实的 WebContentsView。
// 解法＝依赖倒置：这里只声明接口与一个可注入的槽位，真实实现由 main/index.ts 在启动时注入。

export interface BrowserAdapter {
  currentUrl(): string
  navigate(url: string): Promise<{ url: string; title: string }>
  readPage(): Promise<string>
  click(target: string): Promise<string>
  type(target: string, text: string): Promise<string>
}

let adapter: BrowserAdapter | null = null

export function setBrowserAdapter(next: BrowserAdapter): void {
  adapter = next
}

/** 取当前适配器；未注入时返回 null（工具会给出明确提示而非崩溃） */
export function getBrowserAdapter(): BrowserAdapter | null {
  return adapter
}
