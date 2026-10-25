// 切片 4 · 真浏览器用户故事（plan79）：Electron 真入口 + 本地页面服务器 + 假 SSE 模型。
// 判据 = 本地服务器真实收到的请求/副作用文件 + 请求体里的真实工具结果；假模型只说不算证据。
import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiCall, launchApp, type E2EApp } from './helpers'

const SERVER_CJS = join(__dirname, '../fixtures/native-browser/server.cjs')

type Frame = Record<string, unknown>
function sseOf(frames: Frame[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
}
function textReply(text: string): string {
  return sseOf([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } }
  ])
}
function toolReply(name: string, args: Record<string, unknown>, callId: string): string {
  return sseOf([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
          }
        }
      ]
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } }
  ])
}
function lastTool(body: string): { name: string; text: string } {
  try {
    const msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'tool' && typeof m.content === 'string') {
        const name = /<tool_output name="([^"]+)"/.exec(m.content)?.[1] ?? '?'
        return { name, text: m.content }
      }
    }
  } catch {
    /* 非 JSON */
  }
  return { name: '', text: '' }
}

class FakeModel {
  hits = 0
  bodies: string[] = []
  port = 0
  respond: (n: number, body: string, res: ServerResponse) => void = (_n, _b, res) =>
    res.end(textReply('（未编排）'))
  private srv: Server | null = null

  async start(): Promise<void> {
    this.srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        this.hits += 1
        this.bodies.push(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        this.respond(this.hits, body, res)
      })
    })
    this.srv.listen(0, '127.0.0.1')
    await once(this.srv, 'listening')
    this.port = (this.srv.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    this.srv?.closeAllConnections?.()
    this.srv?.close()
  }
}

class PageServer {
  port = 0
  private proc: ChildProcess | null = null
  constructor(private readonly effects: string) {}
  async start(): Promise<void> {
    this.proc = spawn(process.execPath, [SERVER_CJS, '0', this.effects])
    const line = await once(this.proc.stdout!, 'data')
    this.port = Number(String(line[0]).match(/READY (\d+)/)![1])
  }
  stop(): void {
    this.proc?.kill()
  }
}

const effectsOf = (name: string): string => join(tmpdir(), `jsl-nb-effects-${name}.jsonl`)
const postsOf = (effects: string): string[] =>
  existsSync(effects)
    ? readFileSync(effects, 'utf8').trim().split('\n').filter((l) => l.includes('"kind":"POST"'))
    : []

async function useFakeModel(page: Page, fake: FakeModel): Promise<void> {
  const saved = await apiCall<{ id?: string }>(page, 'saveModel', {
    name: 'e2e 原生浏览器假端点',
    providerType: 'openai-compatible',
    baseURL: `http://127.0.0.1:${fake.port}/v1`,
    stream: true,
    timeoutMs: 30000,
    models: [{ id: 'nb-entry', model: 'nb-model' }],
    apiKey: 'e2e-fake-key-never-real'
  })
  await apiCall(page, 'setActiveModel', saved.id)
}

async function requireKeyring(h: E2EApp, tag: string): Promise<void> {
  const enc = await h.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
  const skipReason = '该平台 safeStorage 不可用（Key 无法加密落盘）；本用例只在 Windows/macOS 本机跑'
  if (!enc) console.log(`${tag}_SKIP=${JSON.stringify({ encryptionAvailable: enc, reason: skipReason })}`)
  test.skip(!enc, skipReason)
}

async function sendText(page: Page, text: string): Promise<void> {
  const ta = page.locator('textarea.console-input').first()
  await ta.click()
  await ta.pressSequentially(text, { delay: 2 })
  await ta.press('Enter')
}

async function waitIdle(page: Page): Promise<void> {
  await expect(page.locator('.send-btn.stopping')).toHaveCount(0, { timeout: 60_000 })
}

async function openBrowserPanel(page: Page): Promise<void> {
  await page.locator('[title="展开工作台"], [title="收起工作台"]').first().click()
  await page.waitForSelector('.dock', { timeout: 15000 })
  if ((await page.locator('.wb-empty').count()) > 0) {
    await page.locator('.wb-empty .wb-pick', { hasText: '浏览器' }).first().click()
  }
  await page.waitForSelector('.browser-panel', { timeout: 15000 })
  // view bounds 由 ResizeObserver 异步同步；等一侧再动作
  await page.waitForTimeout(1200)
}

async function answerConfirm(page: Page, allow: boolean): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '危险操作确认' })
  await dialog.waitFor({ timeout: 30_000 })
  await dialog.getByRole('button', { name: allow ? '允许这一次' : '拒绝' }).click()
}

/** 答复并回读卡面元数据（修正 D：真实 tool 名 + 站点归属，不伪装成工作区命令） */
async function answerConfirmWithMeta(
  page: Page,
  allow: boolean
): Promise<{ tool: string; where: string; detail: string }> {
  const dialog = page.getByRole('dialog', { name: '危险操作确认' })
  await dialog.waitFor({ timeout: 30_000 })
  const tool = ((await dialog.locator('.cf-tool').textContent()) ?? '').trim()
  const where = ((await dialog.locator('.cf-where').textContent()) ?? '').trim()
  const detail = ((await dialog.locator('.cf-cmd').textContent()) ?? '').trim()
  await dialog.getByRole('button', { name: allow ? '允许这一次' : '拒绝' }).click()
  return { tool, where, detail }
}

test.describe('真浏览器用户故事（模型端点=确定性替身）', () => {
  test('故事一：默认 Agent（不选浏览器角色）真实打开本地页面并填写', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('story1')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const url = `http://127.0.0.1:${srv.port}/`
    fake.respond = (_n, body, res) => {
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url }, 'n1'))
      if (t.name === 'browser_navigate') return res.end(toolReply('browser_read_page', {}, 'n1b'))
      if (t.name === 'browser_read_page') return res.end(toolReply('browser_type', { target: '#msg', text: 'hello-native' }, 'n2'))
      if (t.name === 'browser_type') return res.end(textReply('已完成：页面已打开并填写 hello-native。'))
      return res.end(textReply('（未编排）'))
    }
    try {
      await requireKeyring(h, 'NB1')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `打开 ${url} ，在留言框填写 hello-native`)
      await answerConfirm(h.page, true)
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('已完成', { timeout: 30_000 })
      const bodies = fake.bodies.join('\n')
      expect(bodies, '真实工具结果应回报页面文本').toContain('sum')
      const typed = fake.bodies.some((b) => {
        const t = lastTool(b).text
        return t.includes('#msg') || t.includes('输入')
      })
      expect(typed, '填写结果应回报给模型').toBe(true)
      expect(postsOf(effects), '故事一只读+填写，不得提交').toHaveLength(0)
      console.log(`NB1_EVIDENCE=${JSON.stringify({ hits: fake.hits })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('故事二：拒绝提交=服务器零副作用；批准恰好一次', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('story2')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const url = `http://127.0.0.1:${srv.port}/`
    fake.respond = (_n, body, res) => {
      let msgs: Array<{ role: string; content?: unknown }> = []
      try {
        msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
      } catch {
        /* 非 JSON 请求体：当无历史处理 */
      }
      let lastUserSubmit = -1
      msgs.forEach((m, i) => {
        if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('请提交')) lastUserSubmit = i
      })
      if (lastUserSubmit >= 0) {
        // 提交阶段只看本轮用户消息之后的工具结果（跨轮历史里的旧结果不算数，
        // 否则第二次「请提交」会把上一轮被拒的结果再读一遍）
        const recent = [...msgs.slice(lastUserSubmit + 1)]
          .reverse()
          .find((m) => m.role === 'tool' && typeof m.content === 'string')
        if (recent) {
          return res.end(textReply(String(recent.content).includes('拒绝') ? '提交已被用户拒绝，未发生。' : '提交已完成。'))
        }
        return res.end(toolReply('browser_press_key', { key: 'Enter' }, 's3'))
      }
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url }, 's0'))
      if (t.name === 'browser_navigate') return res.end(toolReply('browser_click', { target: '#msg' }, 's1'))
      if (t.name === 'browser_click') return res.end(toolReply('browser_type', { target: '#msg', text: 'native-submit' }, 's2'))
      if (t.name === 'browser_type') return res.end(toolReply('browser_read_page', {}, 's2b'))
      return res.end(textReply('留言已填写，等待提交指令。'))
    }
    try {
      await requireKeyring(h, 'NB2')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `打开 ${url} 并定位提交按钮`)
      await answerConfirm(h.page, true)
      await waitIdle(h.page)
      await sendText(h.page, '请提交')
      await answerConfirm(h.page, false)
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('拒绝', { timeout: 30_000 })
      expect(postsOf(effects), '拒绝后服务器 POST 为零').toHaveLength(0)
      await sendText(h.page, '请提交')
      await answerConfirm(h.page, true)
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('提交已完成', { timeout: 30_000 })
      expect(postsOf(effects), '批准后 POST 恰好一次').toHaveLength(1)
      console.log(`NB2_EVIDENCE=${JSON.stringify({ posts: postsOf(effects).length })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('故事三：关闭内置浏览器后新动作不执行，本地服务器零请求', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('story3')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const url = `http://127.0.0.1:${srv.port}/`
    fake.respond = (_n, body, res) => {
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url }, 'q1'))
      return res.end(textReply('页面已打开（这不应发生：开关已关）。'))
    }
    try {
      await requireKeyring(h, 'NB3')
      await useFakeModel(h.page, fake)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await apiCall(h.page, 'openSettingsWindow')
      let settings: Page | null = null
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !settings) {
        settings = h.app.windows().find((w) => w.url().includes('settings')) ?? null
        if (!settings) await h.page.waitForTimeout(300)
      }
      expect(settings, '设置窗应打开').not.toBeNull()
      const sw = settings!
      await sw.waitForSelector('.settings-nav-item', { timeout: 20000 })
      await sw.locator('label.checkbox', { hasText: '启用内置浏览器' }).locator('input').uncheck()
      await sw.close()
      await sendText(h.page, `打开 ${url}`)
      await waitIdle(h.page)
      await h.page.waitForTimeout(2000)
      expect(existsSync(effects), '关停后服务器应零请求（无 GET 记录）').toBe(false)
      console.log(`NB3_EVIDENCE=${JSON.stringify({ hits: fake.hits })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('故事四：只批准浏览、提交被拦（拒绝提交卡 → POST=0；修正 A 独审红转绿）', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('story4')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const url = `http://127.0.0.1:${srv.port}/`
    fake.respond = (_n, body, res) => {
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url }, 's4-nav'))
      if (t.name === 'browser_navigate') return res.end(toolReply('browser_click', { target: '#go' }, 's4-submit'))
      if (t.name === 'browser_click') {
        return res.end(textReply(String(t.text).includes('拒绝') ? '提交已被用户拒绝，未发生。' : '提交已完成。'))
      }
      return res.end(textReply('（未编排）'))
    }
    try {
      await requireKeyring(h, 'NB4')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `仅打开 ${url} 查看，不要提交表单`)
      const card1 = await answerConfirmWithMeta(h.page, true) // 站点浏览授权
      expect(card1.tool, '站点卡是 browser_task').toBe('browser_task')
      expect(card1.where, '卡面写站点').toContain('站点：http://127.0.0.1:')
      const card2 = await answerConfirmWithMeta(h.page, false) // 提交卡：明确拒绝（不是等待超时）
      expect(card2.tool, '提交卡是真实工具名').toBe('browser_click')
      expect(card2.where).toContain('站点：http://127.0.0.1:')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('拒绝', { timeout: 30_000 })
      expect(postsOf(effects), '拒绝提交卡后真实 POST 为零').toHaveLength(0)
      console.log(`NB4_EVIDENCE=${JSON.stringify({ posts: postsOf(effects).length })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('故事五：明确批准该提交 → POST 恰好一次（正向对照）', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('story5')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const url = `http://127.0.0.1:${srv.port}/`
    fake.respond = (_n, body, res) => {
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url }, 's5-nav'))
      if (t.name === 'browser_navigate') return res.end(toolReply('browser_click', { target: '#go' }, 's5-submit'))
      if (t.name === 'browser_click') {
        return res.end(textReply(String(t.text).includes('拒绝') ? '提交已被用户拒绝，未发生。' : '提交已完成。'))
      }
      return res.end(textReply('（未编排）'))
    }
    try {
      await requireKeyring(h, 'NB5')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `打开 ${url} 并提交表单`)
      await answerConfirm(h.page, true) // 站点浏览授权
      const card2 = await answerConfirmWithMeta(h.page, true) // 提交卡：明确批准
      expect(card2.tool).toBe('browser_click')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('提交已完成', { timeout: 30_000 })
      expect(postsOf(effects), '批准提交卡后真实 POST 恰好一次').toHaveLength(1)
      console.log(`NB5_EVIDENCE=${JSON.stringify({ posts: postsOf(effects).length })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })
  for (const [caseName, target, actionTool] of [
    ['提交按钮子元素', '#go-label', 'browser_click'],
    ['按钮型输入框', '#input-submit', 'browser_click'],
    ['输入工具点击按钮', '#input-submit', 'browser_type']
  ] as const) {
    test(`故事六·${caseName}：具体提交卡拒绝 → POST=0；明确批准 → 恰好一次`, async () => {
      test.slow()
      const h: E2EApp = await launchApp()
      const fake = new FakeModel()
      await fake.start()
      const effects = effectsOf(`submit-${caseName}`)
      if (existsSync(effects)) unlinkSync(effects)
      const srv = new PageServer(effects)
      await srv.start()
      const url = `http://127.0.0.1:${srv.port}/`
      const actArgs = { target, ...(actionTool === 'browser_type' ? { text: '不能触发提交' } : {}) }
      fake.respond = (_n, body, res) => {
        let msgs: Array<{ role: string; content?: unknown }> = []
        try {
          msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
        } catch {
          /* 非 JSON 请求体 */
        }
        let retryIdx = -1
        msgs.forEach((m, i) => {
          if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('再试一次')) retryIdx = i
        })
        if (retryIdx >= 0) {
          const recent = [...msgs.slice(retryIdx + 1)]
            .reverse()
            .find((m) => m.role === 'tool' && typeof m.content === 'string')
          if (recent) {
            return res.end(textReply(String(recent.content).includes('拒绝') ? '第一次已被拒绝。' : '第二次已完成。'))
          }
          return res.end(toolReply(actionTool, actArgs, 'retry'))
        }
        const t = lastTool(body)
        if (t.name === '') return res.end(toolReply('browser_navigate', { url }, 'nav'))
        if (t.name === 'browser_navigate') return res.end(toolReply(actionTool, actArgs, 'act1'))
        if (t.name === actionTool) {
          return res.end(textReply(String(t.text).includes('拒绝') ? '第一次已被拒绝。' : '第一次已完成。'))
        }
        return res.end(textReply('（未编排）'))
      }
      try {
        await requireKeyring(h, 'NB6')
        await useFakeModel(h.page, fake)
        await openBrowserPanel(h.page)
        await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
        await sendText(h.page, `只打开 ${url} 查看，不提交`)
        await answerConfirm(h.page, true) // 站点浏览授权
        const card1 = await answerConfirmWithMeta(h.page, false) // 具体卡：明确拒绝
        expect(card1.tool, '具体卡是真实工具名').toBe(actionTool)
        expect(card1.where, '卡面写站点').toContain('站点：http://127.0.0.1:')
        expect(card1.detail, '卡面写实际目标').toContain(target)
        if (actionTool === 'browser_click' && target === '#go-label') {
          expect(card1.detail, '祖先提交控件被识别为提交').toContain('提交表单')
        }
        await waitIdle(h.page)
        await expect(h.page.locator('.msg-assistant').last()).toContainText('第一次已被拒绝', { timeout: 30_000 })
        expect(postsOf(effects), `${caseName}：拒绝具体卡后 POST 为零`).toHaveLength(0)
        await sendText(h.page, '再试一次')
        const card2 = await answerConfirmWithMeta(h.page, true) // 明确批准
        expect(card2.tool).toBe(actionTool)
        await waitIdle(h.page)
        await expect(h.page.locator('.msg-assistant').last()).toContainText('第二次已完成', { timeout: 30_000 })
        expect(postsOf(effects), `${caseName}：明确批准后 POST 恰好一次`).toHaveLength(1)
        console.log(`NB6_EVIDENCE=${JSON.stringify({ caseName, posts: postsOf(effects).length })}`)
      } finally {
        srv.stop()
        await fake.stop()
        await h.close().catch(() => {})
        await h.cleanup().catch(() => {})
      }
    })
  }
  test('故事七·深层提交包装：0/1/6/7/20 层逐层确认（拒绝=0，批准=1；超旧上限仍识别提交）', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('deep-matrix')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const base = `http://127.0.0.1:${srv.port}`
    const depths = [0, 1, 6, 7, 20]
    fake.respond = (_n, body, res) => {
      let msgs: Array<{ role: string; content?: unknown }> = []
      try {
        msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
      } catch {
        /* 非 JSON */
      }
      let posIdx = -1
      msgs.forEach((m, i) => {
        if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('最后再试一次')) posIdx = i
      })
      if (posIdx >= 0) {
        const recent = [...msgs.slice(posIdx + 1)]
          .reverse()
          .find((m) => m.role === 'tool' && typeof m.content === 'string')
        if (!recent) return res.end(toolReply('browser_navigate', { url: `${base}/?depth=${depths[4]}` }, 'pos-nav'))
        if (String(recent.content).includes('<tool_output name="browser_navigate"')) {
          return res.end(toolReply('browser_click', { target: '#deep-label' }, 'pos-click'))
        }
        return res.end(textReply(String(recent.content).includes('拒绝') ? '深层也被拒绝了。' : '深层批准已完成。'))
      }
      const navs = msgs.filter(
        (m) => m.role === 'tool' && typeof m.content === 'string' && String(m.content).includes('<tool_output name="browser_navigate"')
      ).length
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url: `${base}/?depth=${depths[0]}` }, 'n0'))
      if (t.name === 'browser_navigate') return res.end(toolReply('browser_click', { target: '#deep-label' }, `c${navs}`))
      if (t.name === 'browser_click') {
        if (String(t.text).includes('拒绝') && navs < depths.length) {
          return res.end(toolReply('browser_navigate', { url: `${base}/?depth=${depths[navs]}` }, `n${navs}`))
        }
        return res.end(textReply('五轮均已拒绝。'))
      }
      return res.end(textReply('（未编排）'))
    }
    try {
      await requireKeyring(h, 'NB7')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `逐个测 0/1/6/7/20 层包装的提交按钮`)
      await answerConfirmWithMeta(h.page, true) // 站点浏览授权
      const seen: Array<{ tool: string; detail: string }> = []
      for (let i = 0; i < depths.length; i++) {
        // 场景名/URL参数不是实际前提：从真实 WebContents 回读DOM包装层数。
        await h.page.getByRole('dialog', { name: '危险操作确认' }).waitFor({ timeout: 30000 })
        const actual = await h.app.evaluate(async ({ webContents }) => {
          const wc = webContents.getAllWebContents().find((w) => /\?depth=/.test(w.getURL()))
          if (!wc) throw new Error('真实浏览器页面未找到')
          return await wc.executeJavaScript(
            "(()=>{let n=document.getElementById('deep-label');const b=document.getElementById('deep-submit');let k=0;while(n.parentElement!==b){n=n.parentElement;if(!n)throw Error('无提交祖先');k++}return k})()"
          )
        })
        console.log('DEPTH_DOM_EVIDENCE=' + JSON.stringify({ expected: depths[i], actual }))
        expect(actual, '真实DOM包装层数必须与场景参数一致').toBe(depths[i])
        seen.push(await answerConfirmWithMeta(h.page, false))
      }
      expect(seen.map((c) => c.tool), '每层包装都是具体提交卡').toEqual(['browser_click', 'browser_click', 'browser_click', 'browser_click', 'browser_click'])
      expect(seen[3].detail, '7 层包装（超旧 6 层上限）仍识别为提交').toContain('提交表单')
      expect(seen[4].detail, '20 层包装仍识别为提交').toContain('提交表单')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('五轮均已拒绝', { timeout: 30_000 })
      expect(postsOf(effects), '五轮拒绝后 POST 为零').toHaveLength(0)
      await sendText(h.page, '最后再试一次')
      // 新一轮 run 的站点授权卡（授权元数据只存本轮内存、不落盘——按轮重建是契约行为）
      const site2 = await answerConfirmWithMeta(h.page, true)
      expect(site2.tool, '新一轮站点卡').toBe('browser_task')
      expect(site2.detail, '新一轮站点卡文案').toContain('允许在')
      const pos = await answerConfirmWithMeta(h.page, true)
      expect(pos.tool, '正向卡是具体提交卡').toBe('browser_click')
      expect(pos.detail, '深层提交的正向卡').toContain('提交表单')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('深层批准已完成', { timeout: 30_000 })
      expect(postsOf(effects), '深层明确批准后 POST 恰好一次').toHaveLength(1)
      console.log(`NB7_EVIDENCE=${JSON.stringify({ depths, posts: postsOf(effects).length })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('故事八·onclick 链接与字段外层：普通链接连续、危险变体逐次确认（拒绝=0，批准=1）', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('onclick-variants')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const base = `http://127.0.0.1:${srv.port}`
    const actions = [
      { tool: 'browser_click', args: { target: '#plain-link' } },
      { tool: 'browser_click', args: { target: '#inline-link' } },
      { tool: 'browser_click', args: { target: '#wrapped-input' } },
      { tool: 'browser_type', args: { target: '#wrapped-input', text: '不能触发提交' } },
      { tool: 'browser_click', args: { target: '#inline-link' } }
    ]
    fake.respond = (_n, body, res) => {
      let msgs: Array<{ role: string; content?: unknown }> = []
      try {
        msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
      } catch {
        /* 非 JSON */
      }
      const done = msgs.filter(
        (m) => m.role === 'tool' && typeof m.content === 'string' && /<tool_output name="browser_(click|type)"/.test(String(m.content))
      ).length
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url: `${base}/` }, 'nav'))
      if (t.name === 'browser_navigate') return res.end(toolReply(actions[0].tool, actions[0].args, 'a0'))
      if (done < actions.length) {
        const a = actions[done]
        return res.end(toolReply(a.tool, a.args, `a${done}`))
      }
      return res.end(textReply(String(t.text).includes('拒绝') ? '动作序列完成（末次被拒）。' : '动作序列完成（末次已批准）。'))
    }
    try {
      await requireKeyring(h, 'NB8')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `按顺序测普通链接、onclick 链接、外层 onclick 字段`)
      await answerConfirm(h.page, true) // 站点浏览授权
      // 第一张具体卡应属于 onclick 链接（证明普通链接无卡、连续可用）
      const c1 = await answerConfirmWithMeta(h.page, false)
      expect(c1.detail, '第一张具体卡属于 onclick 链接而非普通链接').toContain('#inline-link')
      expect(c1.tool).toBe('browser_click')
      const c2 = await answerConfirmWithMeta(h.page, false)
      expect(c2.detail, '字段外层 onclick 的点击需具体确认').toContain('#wrapped-input')
      expect(c2.tool).toBe('browser_click')
      const c3 = await answerConfirmWithMeta(h.page, false)
      expect(c3.tool, '输入工具的聚焦路径同样受保护').toBe('browser_type')
      expect(c3.detail).toContain('#wrapped-input')
      expect(postsOf(effects), '三拒后 POST 为零').toHaveLength(0)
      const c4 = await answerConfirmWithMeta(h.page, true) // 正向：明确批准 onclick 链接
      expect(c4.detail).toContain('#inline-link')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('动作序列完成（末次已批准）', { timeout: 30_000 })
      expect(postsOf(effects), '明确批准后 POST 恰好一次').toHaveLength(1)
      console.log(`NB8_EVIDENCE=${JSON.stringify({ posts: postsOf(effects).length })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('故事九·label 变体：普通 label 连续、关联提交/自身 onclick 逐次确认（拒绝=0，批准=1）', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const effects = effectsOf('label-variants')
    if (existsSync(effects)) unlinkSync(effects)
    const srv = new PageServer(effects)
    await srv.start()
    const base = `http://127.0.0.1:${srv.port}`
    const actions = [
      { tool: 'browser_click', args: { target: '#lbl-text' } },
      { tool: 'browser_click', args: { target: '#lbl-submit' } },
      { tool: 'browser_click', args: { target: '#lbl-risk' } },
      { tool: 'browser_click', args: { target: '#lbl-submit' } }
    ]
    fake.respond = (_n, body, res) => {
      let msgs: Array<{ role: string; content?: unknown }> = []
      try {
        msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
      } catch {
        /* 非 JSON */
      }
      const done = msgs.filter(
        (m) => m.role === 'tool' && typeof m.content === 'string' && /<tool_output name="browser_click"/.test(String(m.content))
      ).length
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('browser_navigate', { url: `${base}/` }, 'nav'))
      if (t.name === 'browser_navigate') return res.end(toolReply(actions[0].tool, actions[0].args, 'a0'))
      if (done < actions.length) {
        const a = actions[done]
        return res.end(toolReply(a.tool, a.args, `a${done}`))
      }
      return res.end(textReply(String(t.text).includes('拒绝') ? '标签序列完成（末次被拒）。' : '标签序列完成（末次已批准）。'))
    }
    try {
      await requireKeyring(h, 'NB9')
      await useFakeModel(h.page, fake)
      await openBrowserPanel(h.page)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, `按顺序测普通 label、关联提交 label、onclick label`)
      await answerConfirm(h.page, true) // 站点浏览授权
      const c1 = await answerConfirmWithMeta(h.page, false)
      expect(c1.detail, '第一张具体卡属于关联提交的 label 而非普通 label').toContain('#lbl-submit')
      const c2 = await answerConfirmWithMeta(h.page, false)
      expect(c2.detail, 'label 自身 onclick 需具体确认').toContain('#lbl-risk')
      expect(postsOf(effects), '两拒后 POST 为零').toHaveLength(0)
      const c3 = await answerConfirmWithMeta(h.page, true) // 正向：明确批准关联提交的 label
      expect(c3.detail).toContain('#lbl-submit')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('标签序列完成（末次已批准）', { timeout: 30_000 })
      expect(postsOf(effects), '明确批准后 POST 恰好一次').toHaveLength(1)
      console.log(`NB9_EVIDENCE=${JSON.stringify({ posts: postsOf(effects).length })}`)
    } finally {
      srv.stop()
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

})
