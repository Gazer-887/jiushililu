// 修正批 · 授权边界与门位时序（A/B/D 组等价断言迁移 + 覆盖）
//
// 来源：独审端在 PLAN/独立审查-原生浏览器-Codex-20261014/ 固定的红证据（门位反例 6 红 + runner 反例 5 红）。
// 本文件把等价断言迁入随 Git 交付的测试；判据仍是**真实副作用**（真实 sendInputEvent / 真实适配器
// 调用次数 / 真实 TaskAuthorizer），不是模型话术。适配器层用无二进制夹具，runner 层用假模型 + 假浏览器外设。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelSettings } from '@shared/ipc'

const fixture = vi.hoisted(() => ({ contents: [] as any[] }))
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents: any
    constructor() {
      const wc = new EventEmitter() as any
      wc.url = 'about:blank'
      wc.dead = false
      wc.isDestroyed = () => wc.dead
      wc.close = () => { wc.dead = true }
      wc.getURL = () => wc.url
      wc.getTitle = () => '修正批夹具'
      wc.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
      wc.loadURL = async (url: string) => { wc.emit('did-start-loading'); wc.url = url; wc.emit('did-stop-loading') }
      // 宿主固定读脚本分流：目标事实（nb:target-probe）按目标返回；其余（矩形定位）返回矩形
      wc.executeJavaScript = vi.fn(async (script: string) => {
        if (typeof script === 'string' && script.includes('nb:target-probe')) {
          if (script.includes('"#submit"')) {
            return { submit: true, desc: 'button[submit]', formAction: 'http://127.0.0.1:8111/submit', formMethod: 'post' }
          }
          if (script.includes('"#read-link"')) return { link: true, desc: 'a' }
          if (script.includes('"#msg"')) return { field: true, desc: 'input[text]' }
          return { desc: 'div' }
        }
        return { x: 0, y: 0, width: 10, height: 10 }
      })
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

const stub = vi.hoisted(() => ({ chat: vi.fn() }))
vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: any[]) => stub.chat(...args),
  chatWithToolsOpenAI: (...args: any[]) => stub.chat(...args)
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: (...args: any[]) => stub.chat(...args),
  chatWithToolsAnthropic: (...args: any[]) => stub.chat(...args)
}))

import { initBrowser, browserNewTab, browserListTabs, browserClick, browserNavigate, browserType,
  browserDrag, browserEvalScript, browserUploadFile, browserHandleDialog, browserCloseTab, browserSelectTab,
  browserConsoleMessages, browserNetworkRequests, browserWaitFor, createBrowserTaskAdapter } from '@main/browser'
import type { BrowserAdapter, BrowserTaskContext } from '@main/agent/browser-bridge'
import { setBrowserAdapter } from '@main/agent/browser-bridge'
import { TaskAuthorizer } from '@main/browser-policy'
import { runAgent } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'

let host: EventEmitter
beforeEach(async () => {
  fixture.contents.length = 0
  host = new EventEmitter()
  Object.assign(host, { contentView: { children: [], addChildView() {}, removeChildView() {} } })
  initBrowser(host as any)
  await browserNewTab('http://127.0.0.1:8111/form')
})
afterEach(() => { host.emit('closed') })

const base = {
  click: browserClick,
  navigate: browserNavigate,
  type: browserType,
  drag: browserDrag,
  evalScript: browserEvalScript,
  uploadFile: browserUploadFile,
  handleDialog: browserHandleDialog,
  listTabs: browserListTabs,
  selectTab: browserSelectTab,
  closeTab: browserCloseTab,
  newTab: browserNewTab,
  consoleMessages: browserConsoleMessages,
  networkRequests: browserNetworkRequests,
  waitFor: browserWaitFor
} as unknown as BrowserAdapter
const wc = (): any => fixture.contents.at(-1)

describe('A · 站点浏览许可不吃外部作用（独审门位反例 1 等价迁移）', () => {
  it('已有浏览许可不应放行未获具体授权的提交按钮（拒绝 → 零真实输入）', async () => {
    const calls: any[] = []
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main',
      // 只批第一张（站点授权）；第二张（提交卡）拒绝
      confirm: async (req) => { calls.push(req); return calls.length === 1 }
    })
    await task.click('#read-link') // 普通链接 → task → 站点授权（第 1 张卡）
    const before = wc().sendInputEvent.mock.calls.length
    await expect(task.click('#submit')).rejects.toThrow('拒绝')
    expect(wc().sendInputEvent.mock.calls.length - before, '未获具体许可前提交应为零输入').toBe(0)
    expect(calls, '提交必须有自己的确认卡（不吃站点许可）').toHaveLength(2)
    expect(calls[1].tool, '第二张卡是真实工具名').toBe('browser_click')
    expect(String(calls[1].detail), '卡面写明提交与表单目标').toContain('提交表单')
    expect(String(calls[1].detail)).toContain('http://127.0.0.1:8111/submit')
  })

  it('批准提交卡后恰好执行一次（正向对照）', async () => {
    const calls: any[] = []
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main', confirm: async (req) => { calls.push(req); return true }
    })
    await task.click('#read-link') // 站点授权（第 1 张卡）
    const before = wc().sendInputEvent.mock.calls.length
    await task.click('#submit') // 提交卡（第 2 张卡）→ 批准
    expect(calls, '站点 + 提交两张卡').toHaveLength(2)
    expect(calls[1].tool).toBe('browser_click')
    expect(wc().sendInputEvent.mock.calls.length - before, '恰好一次真实点击 = 3 个鼠标事件').toBe(3)
  })

  it('适配器调用全路径受控：eval/upload/dialog(accept)/拖拽/非普通输入框 各自确认、拒绝即零作用', async () => {
    const calls: any[] = []
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main', confirm: async (req) => { calls.push(req); return false }
    })
    const js0 = wc().executeJavaScript.mock.calls.length
    const inp0 = wc().sendInputEvent.mock.calls.length
    await expect(task.evalScript('fetch(1)')).rejects.toThrow('拒绝')
    await expect(task.uploadFile('#f', 'C:/tmp/x.txt')).rejects.toThrow('拒绝')
    await expect(task.handleDialog('accept')).rejects.toThrow('拒绝')
    await expect(task.drag('#a', '#b')).rejects.toThrow('拒绝')
    await expect(task.type('#div-x', 'text')).rejects.toThrow('拒绝') // 非普通输入框 → 未知 → 问
    expect(calls.map((c) => c.tool), '每件都有自己真实工具名的确认卡').toEqual([
      'browser_eval_script',
      'browser_upload',
      'browser_dialog',
      'browser_drag',
      'browser_type'
    ])
    expect(wc().sendInputEvent.mock.calls.length - inp0, '全拒绝 → 零真实输入').toBe(0)
    expect(wc().debugger.sendCommand, '全拒绝 → 零 CDP 命令').not.toHaveBeenCalled()
    // 只有 type 的分类只读发生（describeTarget），其余连只读脚本都没跑
    expect(wc().executeJavaScript.mock.calls.length - js0, '拒绝路径最多一次分类只读').toBeLessThanOrEqual(1)
  })
})

describe('B · 统一门位与执行前重核（独审门位反例 2/3/4/5 等价迁移）', () => {
  it('缺宿主上下文 → closeTab 必须拒绝（不再走原同步旁路）', async () => {
    const id = browserListTabs().at(-1)!.id
    const task = createBrowserTaskAdapter(base, undefined, undefined)
    await expect(task.closeTab(id)).rejects.toThrow('宿主任务上下文')
    expect(browserListTabs().some((t) => t.id === id), '没有授权不能关闭目标页').toBe(true)
  })

  it('关开关后 selectTab 拒绝且不重绑目标', async () => {
    const firstId = browserListTabs()[0]!.id
    await browserNewTab() // 当前目标变成第二个标签
    let on = false
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main', confirm: async () => true, isEnabled: () => on
    })
    await expect(task.selectTab(firstId)).rejects.toThrow('已关闭')
    on = true
    const before = wc().sendInputEvent.mock.calls.length
    await task.click('#msg') // 目标应仍是第二个标签
    expect(fixture.contents[0].sendInputEvent, '被拒绝的 select 不得重绑目标').not.toHaveBeenCalled()
    expect(wc().sendInputEvent.mock.calls.length - before).toBe(3)
  })

  it('确认等待中关开关，随后批准也不得再发送输入', async () => {
    let on = true
    let approve!: (value: boolean) => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main',
      isEnabled: () => on,
      confirm: () => { entered(); return new Promise<boolean>((resolve) => { approve = resolve }) }
    })
    const pending = task.click('#msg')
    await waiting
    on = false
    approve(true)
    await expect(pending).rejects.toThrow('已关闭')
    expect(wc().sendInputEvent, '关闭后用户旧批准不能继续真实输入').not.toHaveBeenCalled()
  })

  it('确认等待中人工换页，navigate 不能用旧批准覆盖人工新页面', async () => {
    let approve!: (value: boolean) => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main',
      confirm: () => { entered(); return new Promise<boolean>((resolve) => { approve = resolve }) }
    })
    const pending = task.navigate('http://127.0.0.1:8111/agent-target')
    await waiting
    wc().url = 'http://127.0.0.1:8111/user-page'
    wc().emit('did-start-loading') // 人工导航推高版本
    approve(true)
    await expect(pending).rejects.toThrow('页面已变化')
    expect(wc().url, '人工改页后旧动作应暂停而不是导航覆盖').toBe('http://127.0.0.1:8111/user-page')
  })

  it('定位等待时关开关 → 不点击（执行前最后一次核验）', async () => {
    let on = true
    let finishRect!: (r: unknown) => void
    wc().executeJavaScript.mockImplementation(async (script: string) => {
      if (typeof script === 'string' && script.includes('nb:target-probe')) return { desc: 'div' }
      return new Promise((resolve) => { finishRect = resolve }) // 矩形定位挂起
    })
    const task = createBrowserTaskAdapter(base, undefined, {
      agent: 'main', confirm: async () => true, isEnabled: () => on
    })
    const pending = task.click('#button')
    await new Promise((r) => setTimeout(r, 0)) // 等分类读完成、进入定位
    on = false
    finishRect({ x: 0, y: 0, width: 10, height: 10 })
    await expect(pending).rejects.toThrow('已关闭')
    expect(wc().sendInputEvent, '定位后关开关 → 零输入').not.toHaveBeenCalled()
  })

  it('目标关闭 → 任务暂停；新任务可继续（不毒化队列）', async () => {
    for (const t of browserListTabs()) browserCloseTab(t.id) // 用户关掉所有标签（含目标页）
    expect(browserListTabs(), '无可用目标').toHaveLength(0)
    const task = createBrowserTaskAdapter(base, undefined, { agent: 'main', confirm: async () => true })
    await expect(task.click('#msg')).rejects.toThrow('已暂停')
    await browserNewTab()
    const next = createBrowserTaskAdapter(base, undefined, { agent: 'main', confirm: async () => true })
    const before = wc().sendInputEvent.mock.calls.length
    await next.click('#msg')
    expect(wc().sendInputEvent.mock.calls.length - before, '新任务正常执行').toBe(3)
  })

  it('导航加载期间人工输入不得被吸收进新基线：旧任务暂停零输入，新任务可继续（独审反例等价迁移）', async () => {
    let entered!: () => void
    let complete!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    wc().loadURL = async (url: string) => {
      wc().emit('did-start-loading')
      wc().url = url
      entered()
      await new Promise<void>((resolve) => { complete = resolve })
      wc().emit('did-stop-loading')
    }
    const task = createBrowserTaskAdapter(base, undefined, { agent: 'main', confirm: async () => true })
    const pending = task.navigate('http://127.0.0.1:8111/agent-page')
    await ready
    wc().emit('before-input-event', {}, { type: 'keyDown', key: 'x' }) // 人工输入（非 Agent 注入）
    complete()
    let paused = false
    try {
      await pending
      await task.click('#msg')
    } catch {
      paused = true
    }
    expect(paused, '导航中真实人工输入必须使旧任务暂停，不能继续点击').toBe(true)
    expect(wc().sendInputEvent, '介入后旧任务不得继续输入').not.toHaveBeenCalled()
    // 新任务从当前版本起步，可继续（不把"人工介入"变成永久封锁）
    const next = createBrowserTaskAdapter(base, undefined, { agent: 'main', confirm: async () => true })
    await next.click('#msg')
    expect(wc().sendInputEvent, '新任务正常执行').toHaveBeenCalledTimes(3)
  })

  it('合法导航自身引起的版本变化不算失败（导航后同任务继续点击）', async () => {
    const task = createBrowserTaskAdapter(base, undefined, { agent: 'main', confirm: async () => true })
    const nav = await task.navigate('http://127.0.0.1:8111/next')
    expect(nav.url).toContain('/next')
    const before = wc().sendInputEvent.mock.calls.length
    await task.click('#msg') // 版本基线已随自身导航更新 → 不误报"页面已变化"
    expect(wc().sendInputEvent.mock.calls.length - before).toBe(3)
  })
})

describe('D · 显式方法映射与确认桥（独审门位反例 6 等价迁移）', () => {
  it('console/network/wait 映射为只读：无确认服务也可读', async () => {
    const task = createBrowserTaskAdapter(base, undefined, { agent: 'main', confirm: null })
    await expect(task.consoleMessages()).resolves.toContain('console')
    await expect(task.networkRequests()).resolves.toBeTruthy()
    await expect(task.waitFor('#msg', 60)).resolves.toBeTruthy()
  })
})

// ── runner 层（真实 runAgent；仅替换模型与浏览器外设） ──

const settings = {
  providerType: 'openai-compatible', baseURL: 'http://never-used.invalid', model: 'local-fake',
  temperature: null, topP: null, topK: null, maxTokens: 4096, timeoutMs: 30000, stream: true,
  contextWindow: 131072, reasoningEffort: 'default', maxToolRounds: 8, inputModalities: ['text']
} as ModelSettings
const done = { text: '完成', toolCalls: [] }
const call = (name: string, args: unknown) => ({ text: '', toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }] })

function makeRunnerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-nb-auth-'))
  const ws = join(dir, 'ws')
  const agents = join(dir, 'agents')
  mkdirSync(ws)
  mkdirSync(agents)
  const confirms: any[] = []
  const creations: Array<BrowserTaskContext | undefined> = []
  const effects: any[] = []
  const ctx: any = {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: agents,
    userAgentsDir: join(dir, 'user'),
    checkpoints: createCheckpointStore(join(dir, 'checkpoints')),
    confirmCommand: async (req: any) => { confirms.push(req); return true }
  }
  // 只替换浏览器外设：真实 runAgent / createBrowserTools / TaskAuthorizer 走生产实现
  const fakeBase: any = { currentUrl: () => 'http://127.0.0.1:8111/form', assertReady: () => {} }
  fakeBase.createTask = (_signal: any, task?: BrowserTaskContext) => {
    creations.push(task)
    const auth = new TaskAuthorizer(task?.confirm ?? null)
    return {
      ...fakeBase,
      createTask: undefined,
      navigate: async (url: string) => {
        const r = await auth.authorize({ tool: 'browser_navigate', args: { url }, agent: task?.agent ?? '', site: new URL(url).origin })
        if (!r.allowed) throw new Error(r.reason)
        effects.push({ navigate: url, agent: task?.agent })
        return { url, title: '本地页' }
      },
      // 假外设经**真实 TaskAuthorizer** 自授权（与真实门位同策略层；adapter 门位本身由本文件上半段实测）
      pressKey: async (key: string) => {
        const r = await auth.authorize({ tool: 'browser_press_key', args: { key }, agent: task?.agent ?? '', site: 'http://127.0.0.1:8111' })
        if (!r.allowed) throw new Error(r.reason)
        effects.push({ pressKey: key, agent: task?.agent })
        return `已按键 ${key}`
      },
      readPage: async () => '本地页'
    }
  }
  setBrowserAdapter(fakeBase as BrowserAdapter)
  return { dir, ctx, confirms, creations, effects, agents }
}

describe('A/D · runner 接线（确认桥全档注入 / 计划批准前收窄）', () => {
  it.each(['read-only', 'full-access'] as const)('D：%s 档合法导航实际可达（不再"确认服务不可用"）', async (permission) => {
    const f = makeRunnerFixture()
    stub.chat.mockReset()
    stub.chat.mockResolvedValueOnce(call('browser_navigate', { url: 'http://127.0.0.1:8111/form' })).mockResolvedValue(done)
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', permission, nativeBrowser: true,
      history: [{ role: 'user', content: '打开本地页面' }]
    })
    expect(f.effects, '导航必须真的发生').toHaveLength(1)
    expect(f.confirms[0]?.kind, '浏览器卡走结构化 kind').toBe('browser')
  })

  it('D：full-access 档也不免除合同要求的未知风险确认（Enter 仍逐次问）', async () => {
    const f = makeRunnerFixture()
    stub.chat.mockReset()
    stub.chat
      .mockResolvedValueOnce(call('browser_navigate', { url: 'http://127.0.0.1:8111/form' }))
      .mockResolvedValueOnce(call('browser_press_key', { key: 'Enter' }))
      .mockResolvedValue(done)
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', permission: 'full-access', nativeBrowser: true,
      history: [{ role: 'user', content: '打开并回车提交' }]
    })
    const tools = f.confirms.map((c) => c.tool)
    expect(tools, '站点卡 + Enter 卡').toEqual(['browser_task', 'browser_press_key'])
  })

  it('D：浏览器确认卡保留真实工具与站点（不伪装成工作区命令）', async () => {
    const f = makeRunnerFixture()
    stub.chat.mockReset()
    stub.chat.mockResolvedValueOnce(call('browser_navigate', { url: 'http://127.0.0.1:8111/form' })).mockResolvedValue(done)
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', permission: 'write', nativeBrowser: true,
      history: [{ role: 'user', content: '打开本地页面' }]
    })
    expect(f.confirms[0].tool, '真实工具名').toBe('browser_task')
    expect(f.confirms[0].where, '站点而非文件工作区').toBe('http://127.0.0.1:8111')
    expect(f.confirms[0].agent, '发起者署名').toBe('内核默认')
    expect(f.confirms[0].kind).toBe('browser')
  })

  it('A：计划批准前不得借公共浏览器执行提交点击（独审 runner 反例 3 等价迁移）', async () => {
    const f = makeRunnerFixture()
    writeFileSync(join(f.agents, 'planner.md'), '---\nname: planner\ndescription: 只规划\ntools: [read_file]\napproval: plan\n---\n先规划，不执行。')
    let approvalRequests = 0
    f.ctx.planApproval = { request: async () => { approvalRequests += 1; return false } }
    stub.chat.mockReset()
    stub.chat.mockResolvedValueOnce(call('browser_click', { target: '#submit' })).mockResolvedValue(done)
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', agentName: 'planner', permission: 'write',
      nativeBrowser: true, history: [{ role: 'user', content: '先拟方案，不批准执行' }]
    })
    expect(approvalRequests).toBe(1)
    expect(f.effects, '计划最终被拒绝，之前也不应实际点击提交').toHaveLength(0)
    expect(f.confirms, '批准前连站点授权卡都不该出现').toHaveLength(0)
  })

  it('A：规划角色仍可用只读浏览器能力（navigate/read_page 在表内，写作用不在）', async () => {
    const f = makeRunnerFixture()
    writeFileSync(join(f.agents, 'planner.md'), '---\nname: planner\ndescription: 只规划\ntools: [read_file]\napproval: plan\n---\n先规划，不执行。')
    f.ctx.planApproval = { request: async () => false }
    stub.chat.mockReset()
    stub.chat.mockResolvedValue(done)
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', agentName: 'planner', permission: 'write',
      nativeBrowser: true, history: [{ role: 'user', content: '先拟方案' }]
    })
    const schemas = stub.chat.mock.calls[0]?.[3] as Array<{ name: string }>
    const names = schemas.map((s) => s.name)
    expect(names, '规划阶段可读页面').toContain('browser_navigate')
    expect(names).toContain('browser_read_page')
    expect(names, '批准前不得有写作用工具').not.toContain('browser_click')
    expect(names).not.toContain('browser_eval_script')
    expect(names).not.toContain('browser_upload')
  })
})
