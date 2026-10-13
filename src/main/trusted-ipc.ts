/** 已登记窗口、主 frame 与确切页面同时成立才允许进入业务。 */
interface Contents {
  mainFrame: unknown
  isDestroyed(): boolean
  getURL(): string
}
interface Event { sender: Contents; senderFrame: { url: string } | null }
type Handler = (event: Event, ...args: unknown[]) => unknown
interface Registrar {
  handle(channel: string, fn: Handler): void
  on(channel: string, fn: Handler): unknown
}

const page = (raw: string): string | null => {
  try { const url = new URL(raw); url.hash = ''; return url.href }
  catch { return null }
}

export function installTrustedIpc(
  ipc: Registrar, contents: () => Contents[], rendererUrl: string
): void {
  const expected = page(rendererUrl)
  if (!expected) throw new Error('可信页面配置无效，拒绝安装 IPC')
  const trusted = (event: Event): boolean => Boolean(
    contents().includes(event.sender) && !event.sender.isDestroyed() &&
    event.senderFrame && event.senderFrame === event.sender.mainFrame &&
    page(event.sender.getURL()) === expected && page(event.senderFrame.url) === expected
  )
  const handle = ipc.handle.bind(ipc)
  const on = ipc.on.bind(ipc)
  ipc.handle = (channel, fn) => handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('不可信 IPC 来源，已拒绝')
    return fn(event, ...args)
  })
  ipc.on = (channel, fn) => on(channel, (event, ...args) => {
    if (!trusted(event)) return
    return fn(event, ...args)
  })
}
