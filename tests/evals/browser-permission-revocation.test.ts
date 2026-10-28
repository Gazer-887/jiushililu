// 浏览器真实适配器的权限收紧：缓存许可、确认等待、目标分类异步窗口与只读可用性。
// Electron 外设由无二进制夹具替换；不操纵真实桌面/浏览器/网络。
// 分层：场景级（tests/evals）——真实 browser.ts 直接依赖 Electron，unit 层按 no-dead-wiring 守卫禁止引入。
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      wc.loadURL = async (url: string) => {
        wc.emit('did-start-loading')
        wc.url = url
        wc.emit('did-stop-loading')
      }
      wc.executeJavaScript = vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 }))
      wc.sendInputEvent = vi.fn()
      wc.setWindowOpenHandler = vi.fn()
      wc.debugger = {
        isAttached: () => false,
        attach: vi.fn(),
        on: vi.fn(),
        sendCommand: vi.fn(async () => {})
      }
      this.webContents = wc
      fixture.contents.push(wc)
    }
    setBounds() {}
  },
  BrowserWindow: class {},
  shell: {}
}))

import {
  browserClick,
  browserNewTab,
  createBrowserTaskAdapter,
  initBrowser
} from '@main/browser'
import type { BrowserAdapter, BrowserTaskContext } from '@main/agent/browser-bridge'

beforeEach(() => {
  initBrowser({
    contentView: { children: [], addChildView() {}, removeChildView() {} },
    on() {}
  } as never)
})

async function newTask(ctx: BrowserTaskContext, url = 'https://example.com/page'): Promise<BrowserAdapter> {
  await browserNewTab(url)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return createBrowserTaskAdapter(
    { click: browserClick, readPage: async () => 'read text' } as unknown as BrowserAdapter,
    undefined,
    ctx
  )
}

function lastContents(): any {
  return fixture.contents.at(-1)
}

describe('S3-40C1-R2 浏览器权限收紧', () => {
  it('缓存站点许可后撤权：第二次点击不执行，且按实际工具名判断', async () => {
    let allowed = true
    const names: string[] = []
    const confirms: string[] = []
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async (req) => {
        confirms.push(req.tool)
        return true
      },
      isToolAllowed: (tool) => {
        names.push(tool)
        return allowed
      }
    }
    const task = await newTask(ctx)
    await task.click('button')
    const wc = lastContents()
    const before = wc.sendInputEvent.mock.calls.length
    expect(before).toBeGreaterThan(0)
    expect(confirms).toEqual(['browser_task'])

    allowed = false
    await expect(task.click('button')).rejects.toThrow('权限已收紧')
    expect(wc.sendInputEvent).toHaveBeenCalledTimes(before)
    expect(names).toContain('browser_click')
    expect(names).not.toContain('browser_task')
  })

  it('确认等待期间撤权：批准返回后也不执行', async () => {
    let allowed = true
    let releaseConfirm!: (approved: boolean) => void
    let notifyEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })
    const confirmation = new Promise<boolean>((resolve) => {
      releaseConfirm = resolve
    })
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => {
        notifyEntered()
        return confirmation
      },
      isToolAllowed: () => allowed
    }
    const task = await newTask(ctx)
    const wc = lastContents()
    const pending = task.click('button')

    await entered
    allowed = false
    releaseConfirm(true)
    await expect(pending).rejects.toThrow('权限已收紧')
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
  })

  it('目标分类异步等待期间撤权：不进入确认，也不执行', async () => {
    let allowed = true
    let releaseTarget!: (value: unknown) => void
    const targetInfo = new Promise<unknown>((resolve) => {
      releaseTarget = resolve
    })
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => {
        throw new Error('撤权后不应进入确认')
      },
      isToolAllowed: () => allowed
    }
    const task = await newTask(ctx)
    const wc = lastContents()
    wc.executeJavaScript.mockImplementationOnce(() => targetInfo)
    const pending = task.click('button')

    await new Promise((resolve) => setTimeout(resolve, 0))
    allowed = false
    releaseTarget({ x: 0, y: 0, width: 10, height: 10 })
    await expect(pending).rejects.toThrow('权限已收紧')
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
  })

  it('权限未变：确认后正常执行一次', async () => {
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => true,
      isToolAllowed: () => true
    }
    const task = await newTask(ctx)
    const wc = lastContents()
    await task.click('button')
    expect(wc.sendInputEvent).toHaveBeenCalledTimes(3)
  })

  it('有效只读档仍允许只读动作，且按实际工具名探针', async () => {
    const names: string[] = []
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => true,
      isToolAllowed: (tool) => {
        names.push(tool)
        return tool === 'browser_read_page'
      }
    }
    const task = await newTask(ctx)
    await expect(task.readPage()).resolves.toBe('read text')
    expect(names).toContain('browser_read_page')
    expect(names).not.toContain('browser_task')
    // 前置门与微任务边界门各核一次；只删前置门时这里会掉到 1 次
    expect(names.filter((name) => name === 'browser_read_page').length).toBeGreaterThanOrEqual(2)
  })

  it('gate 后微任务边界来源失效：最终门单独拒绝', async () => {
    let probes = 0
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => true,
      isToolAllowed: () => {
        probes++
        return probes === 1
      }
    }
    const task = await newTask(ctx)
    await expect(task.readPage()).rejects.toThrow('权限已收紧')
    expect(probes).toBe(2)
  })

  it('只读动作遇到权限源抛错：fail-closed，不执行', async () => {
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => true,
      isToolAllowed: () => {
        throw new Error('permission source down')
      }
    }
    const task = await newTask(ctx)
    await expect(task.readPage()).rejects.toThrow('权限已收紧')
  })

  it('排队等待后权限源失效：前一项完成，后一项不执行', async () => {
    let allowed = true
    let releaseFirst!: (value: string) => void
    let notifyFirstEntered!: () => void
    const firstRead = new Promise<string>((resolve) => {
      releaseFirst = resolve
    })
    const firstEntered = new Promise<void>((resolve) => {
      notifyFirstEntered = resolve
    })
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async () => true,
      isToolAllowed: () => allowed
    }
    await browserNewTab('https://example.com/queue')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const task = createBrowserTaskAdapter(
      {
        click: browserClick,
        readPage: async () => {
          notifyFirstEntered()
          return firstRead
        }
      } as unknown as BrowserAdapter,
      undefined,
      ctx
    )
    const first = task.readPage()
    await firstEntered
    const second = task.readPage()
    allowed = false
    releaseFirst('first')
    await expect(first).resolves.toBe('first')
    await expect(second).rejects.toThrow('权限已收紧')
  })

  it('新 run 不继承旧站点批准：同一站点第二次 run 重新确认', async () => {
    const confirms: string[] = []
    const ctx: BrowserTaskContext = {
      agent: '测试代理',
      conversationId: 'c1',
      confirm: async (req) => {
        confirms.push(req.tool)
        return true
      },
      isToolAllowed: () => true
    }
    const run1 = await newTask(ctx)
    await run1.click('button')
    expect(confirms).toEqual(['browser_task'])

    const run2 = await newTask({ ...ctx, conversationId: 'c2' })
    await run2.click('button')
    expect(confirms).toEqual(['browser_task', 'browser_task'])
  })

  it('并发两会话的站点批准互不串：各自确认并各自执行', async () => {
    const confirms: string[] = []
    let entered = 0
    let notifyBoth!: () => void
    const both = new Promise<void>((resolve) => {
      notifyBoth = resolve
    })
    let releaseA!: (approved: boolean) => void
    let releaseB!: (approved: boolean) => void
    const gateA = new Promise<boolean>((resolve) => {
      releaseA = resolve
    })
    const gateB = new Promise<boolean>((resolve) => {
      releaseB = resolve
    })
    const ctxA: BrowserTaskContext = {
      agent: 'A',
      conversationId: 'cA',
      confirm: async () => {
        confirms.push('A')
        entered++
        if (entered === 2) notifyBoth()
        return gateA
      },
      isToolAllowed: () => true
    }
    const ctxB: BrowserTaskContext = {
      agent: 'B',
      conversationId: 'cB',
      confirm: async () => {
        confirms.push('B')
        entered++
        if (entered === 2) notifyBoth()
        return gateB
      },
      isToolAllowed: () => true
    }

    const taskA = await newTask(ctxA, 'https://example.com/a')
    const wcA = lastContents()
    const taskB = await newTask(ctxB, 'https://example.com/b')
    const wcB = lastContents()
    const clickA = taskA.click('button')
    const clickB = taskB.click('button')

    await both
    expect(confirms.sort()).toEqual(['A', 'B'])
    releaseA(true)
    releaseB(true)
    await Promise.all([clickA, clickB])
    expect(wcA.sendInputEvent).toHaveBeenCalledTimes(3)
    expect(wcB.sendInputEvent).toHaveBeenCalledTimes(3)
  }, 15000)
})
