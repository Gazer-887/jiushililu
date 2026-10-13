import { expect, it, vi } from 'vitest'
import { installTrustedIpc } from '@main/trusted-ipc'

it.each(['http://localhost:5173/', 'file:///app/index.html'])('开发与生产页面：主窗和设置合法，销毁和页面伪装拒绝（%s）', (url) => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const ipc = { handle: (name: string, fn: any) => { handlers.set(name, fn) }, on: vi.fn() }
  let destroyed = false
  const mainFrame = { url: url + '#/chat' }
  const settingsFrame = { url: url + '#/settings' }
  const main = { mainFrame, getURL: () => mainFrame.url, isDestroyed: () => destroyed }
  const settings = { mainFrame: settingsFrame, getURL: () => settingsFrame.url, isDestroyed: () => false }
  const business = vi.fn(() => '成功')
  installTrustedIpc(ipc, () => [main, settings], url)
  ipc.handle('write', business)
  const call = handlers.get('write')!
  expect(call({ sender: main, senderFrame: mainFrame })).toBe('成功')
  expect(call({ sender: settings, senderFrame: settingsFrame })).toBe('成功')
  business.mockClear()
  destroyed = true
  expect(() => call({ sender: main, senderFrame: mainFrame })).toThrow('不可信')
  settingsFrame.url = url + '?spoof=true#/settings'
  expect(() => call({ sender: settings, senderFrame: settingsFrame })).toThrow('不可信')
  expect(business).not.toHaveBeenCalled()
})

it('注册入口在业务之前拒绝未知对象、子 frame、换页和销毁对象', async () => {
  const handlers = new Map<string, (...a: any[]) => any>()
  const listeners = new Map<string, (...a: any[]) => any>()
  const ipc = { handle: (c: string, f: any) => { handlers.set(c, f) },
    on: (c: string, f: any) => { listeners.set(c, f); return ipc } }
  const frame = { url: 'file:///app/index.html#/chat' }
  const wc = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }
  const business = vi.fn(() => '通过')
  installTrustedIpc(ipc, () => [wc], 'file:///app/index.html')
  ipc.handle('read', business)
  ipc.on('notify', business)
  const event = { sender: wc, senderFrame: frame }
  expect(handlers.get('read')!(event)).toBe('通过')
  expect(listeners.get('notify')!(event)).toBe('通过')
  business.mockClear()
  for (const e of [
    { sender: { ...wc }, senderFrame: frame },
    { sender: wc, senderFrame: { ...frame } },
    { sender: wc, senderFrame: null }
  ]) {
    expect(() => handlers.get('read')!(e)).toThrow('不可信')
    listeners.get('notify')!(e)
  }
  frame.url = 'file:///app/other.html'
  expect(() => handlers.get('read')!(event)).toThrow('不可信')
  expect(business).not.toHaveBeenCalled()
})
