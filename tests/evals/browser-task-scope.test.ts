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

// plan79 切片 2 起 createTask 需要宿主任务上下文（缺 ctx = 拒绝外部作用）；
// 本文件测任务域语义，confirm 恒真表示已授权。
const TASK_CTX = { agent: '任务域测试代理', confirm: async () => true }
import type { BrowserAdapter } from '@main/agent/browser-bridge'

it('切换界面标签不改变任务目标；定位等待中换页则不发送点击', async () => {
  initBrowser({ contentView: { children: [], addChildView() {}, removeChildView() {} },
    on() {} } as any)
  await new Promise((r) => setTimeout(r, 0))
  const first = browserListTabs()[0]!
  const base = { click: browserClick } as BrowserAdapter
  const task = createBrowserTaskAdapter(base, undefined, TASK_CTX)
  await browserNewTab()
  await task.click('button')
  expect(fixture.contents[0].sendInputEvent).toHaveBeenCalledTimes(3)
  expect(fixture.contents[1].sendInputEvent).not.toHaveBeenCalled()
  browserSelectTab(first.id)
  const next = createBrowserTaskAdapter(base, undefined, TASK_CTX)
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
  const first = createBrowserTaskAdapter(base, undefined, TASK_CTX)
  const controller = new AbortController()
  const second = createBrowserTaskAdapter(base, controller.signal, TASK_CTX)
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
  // 2 次只读 JS：分类读（describeTarget）+ 定位读（resolveRect）；被取消的第二次点击零新增
  expect(wc.executeJavaScript, '取消后第二次点击不产生任何只读/执行').toHaveBeenCalledTimes(2)
})

it('可识别的人工键盘操作使页面条件失效，后续操作不会自动换目标', async () => {
  await browserNewTab()
  const wc = fixture.contents.at(-1)
  const task = createBrowserTaskAdapter({ click: browserClick } as BrowserAdapter, undefined, TASK_CTX)
  wc.emit('before-input-event', {}, { key: 'x' })
  await expect(task.click('button')).rejects.toThrow('页面已变化')
  expect(wc.sendInputEvent).not.toHaveBeenCalled()
})
