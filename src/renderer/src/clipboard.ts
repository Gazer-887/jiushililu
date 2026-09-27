/**
 * 复制到系统剪贴板的**唯一入口**。
 *
 * 为什么不用 `navigator.clipboard`：它要求文档有焦点，窗口不在前台或焦点在别的窗口时
 * 直接抛 `NotAllowedError`（2026-09-27 用户实机报"点复制没反应、对勾不亮"的成因）。
 * 主进程 `clipboard` 无此约束 —— 见 `IPC.clipboardWrite`。
 *
 * 返回 `false` 而不是抛：调用方**必须**决定怎么告诉用户。静默失败是这条链原来唯一的毛病。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    return (await window.api.copyToClipboard(text)) === true
  } catch {
    return false
  }
}
