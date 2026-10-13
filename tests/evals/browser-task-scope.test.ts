import { expect, it, vi } from 'vitest'
// 跨模块场景验证：真实浏览器动作实现，Electron 外设由无二进制夹具替换。
import { EventEmitter } from 'node:events'

const fixture = vi.hoisted(() => ({ contents: [] as any[] }))
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents: any
    constructor() {
      const wc = new EventEmitter() as any
      wc.url = 'about:blank'
      wc.isDestroyed = () => false
      wc.getURL = () => wc.url
      wc.getTitle = () => '页面'
      wc.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
      wc.loadURL = async (url: string) => { wc.emit('did-start-loading'); wc.url = url; wc.emit('did-stop-loading') }
      wc.executeJavaScript = vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 }))
      wc.sendInputEvent = vi.fn()
      wc.setWindowOpenHandler = vi.fn()
      wc.debugger = { isAttached: () => false, attach: vi.fn(), on: vi.fn(), sendCommand: vi.fn(async () => {}) }
      this.webContents = wc
      fixture.contents.push(wc)
    }
    setBounds() {}
  },
  BrowserWindow: class {}, shell: {}
}))

import { initBrowser, browserNewTab, browserListTabs, browserSelectTab, browserClick,
  createBrowserTaskAdapter } from '@main/browser'
import type { BrowserAdapter } from '@main/agent/browser-bridge'

it('切换界面标签不改变任务目标；定位等待中换页则不发送点击', async () => {
  initBrowser({ contentView: { children: [], addChildView() {}, removeChildView() {} },
    on() {} } as any)
  await new Promise((r) => setTimeout(r, 0))
  const first = browserListTabs()[0]!
  const base = { click: browserClick } as BrowserAdapter
  const task = createBrowserTaskAdapter(base)
  await browserNewTab()
  await task.click('button')
  expect(fixture.contents[0].sendInputEvent).toHaveBeenCalledTimes(3)
  expect(fixture.contents[1].sendInputEvent).not.toHaveBeenCalled()
  browserSelectTab(first.id)
  const next = createBrowserTaskAdapter(base)
  let finish!: (r: any) => void
  fixture.contents[0].executeJavaScript.mockImplementationOnce(() => new Promise((r) => { finish = r }))
  const pending = next.click('button')
  await new Promise((r) => setTimeout(r, 0))
  fixture.contents[0].emit('did-start-loading')
  finish({ x: 0, y: 0, width: 10, height: 10 })
  await expect(pending).rejects.toThrow('页面已变化')
  expect(fixture.contents[0].sendInputEvent).toHaveBeenCalledTimes(3)
})

it('同标签操作排队，等待期间取消立即返回且不发送第二次输入', async () => {
  await browserNewTab()
  const wc = fixture.contents.at(-1)
  const base = { click: browserClick } as BrowserAdapter
  const first = createBrowserTaskAdapter(base)
  const controller = new AbortController()
  const second = createBrowserTaskAdapter(base, controller.signal)
  let finish!: (r: any) => void
  wc.executeJavaScript.mockImplementationOnce(() => new Promise((r) => { finish = r }))
  const running = first.click('first')
  await new Promise((r) => setTimeout(r, 0))
  const queued = second.click('second')
  controller.abort()
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
  expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
  finish({ x: 0, y: 0, width: 10, height: 10 })
  await running
  await new Promise((r) => setTimeout(r, 0))
  expect(wc.sendInputEvent).toHaveBeenCalledTimes(3)
  expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
})

it('可识别的人工键盘操作使页面条件失效，后续操作不会自动换目标', async () => {
  await browserNewTab()
  const wc = fixture.contents.at(-1)
  const task = createBrowserTaskAdapter({ click: browserClick } as BrowserAdapter)
  wc.emit('before-input-event', {}, { key: 'x' })
  await expect(task.click('button')).rejects.toThrow('页面已变化')
  expect(wc.sendInputEvent).not.toHaveBeenCalled()
})
