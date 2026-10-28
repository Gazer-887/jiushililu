// S3-50A 三故事：干净首次接入、FAST 请求与真实档位、双会话独立读取/停止/重启。
// 全部走真 Electron 入口 + 真 preload + 真 IPC；本地假 HTTP 不联网，userData/TEMP 均在阶段私域。
import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { apiCall, launchApp, type E2EApp } from './helpers'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface RunFact {
  request: string | null
  actual: string | null
  observed: string | null
}
interface ModelsView {
  profiles: Array<{ id: string; name: string; models: Array<{ id: string }> }>
}

async function openSettings(h: E2EApp): Promise<Page> {
  await apiCall(h.page, 'openSettingsWindow')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const w = h.app.windows().find((x) => x.url().includes('settings'))
    if (w) {
      await w.waitForSelector('.settings-nav-item', { timeout: 20_000 })
      return w
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('设置独立窗口没打开')
}

async function gotoModelSection(sw: Page): Promise<void> {
  await sw.locator('[data-nav="model"]').click()
  await sw.waitForSelector('.model-head', { timeout: 15_000 })
}

async function closeSettings(h: E2EApp, sw: Page): Promise<void> {
  await sw.locator('.settings-window-back').click()
  await expect
    .poll(() => h.app.windows().filter((w) => w.url().includes('settings')).length, { timeout: 15_000 })
    .toBe(0)
}

const readCall = (id: string, path: string) => ({
  id,
  name: 'read_file',
  arguments: JSON.stringify({ path })
})

async function seedProfile(
  h: E2EApp,
  opts: {
    name: string
    speedMode: 'normal' | 'fast'
    baseURL: string
    apiKey: string
    serviceTiers?: string[]
  }
): Promise<{ id: string }> {
  const saved = await apiCall<{ id: string }>(h.page, 'saveModel', {
    name: opts.name,
    providerType: 'openai-compatible',
    baseURL: opts.baseURL,
    stream: true,
    timeoutMs: 15_000,
    models: [
      {
        id: 's3-50a-model',
        model: 's3-50a-model',
        name: 'S3-50A 模型',
        speedMode: opts.speedMode,
        ...(opts.serviceTiers
          ? { metadata: { serviceTiers: { official: { value: opts.serviceTiers, observedAt: 1758000000000 } } } }
          : {})
      }
    ],
    apiKey: opts.apiKey
  })
  expect(saved.id).toBeTruthy()
  await apiCall(h.page, 'setActiveModel', saved.id)
  await h.page.reload()
  await expect(h.page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  return { id: saved.id }
}

async function readRunFacts(page: Page): Promise<RunFact[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.msg-run-facts')).map((el) => {
      const req = el.querySelector('[data-run-fact="request"]')
      const act = el.querySelector('[data-run-fact="actual"]')
      return {
        request: req ? (req.textContent ?? '').trim() : null,
        actual: act ? (act.textContent ?? '').trim() : null,
        observed: act ? act.getAttribute('data-observed') : null
      }
    })
  )
}

interface StoryServer {
  srv: Server
  port: number
  requests: Array<{ body: string; hasTools: boolean; marker: string }>
}

/** 本地假端点：按最后一条用户消息标记返回 default/missing/400/403/break/hold。 */
async function startStoryServer(): Promise<StoryServer> {
  const requests: StoryServer['requests'] = []
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      let parsed: {
        tools?: unknown[]
        messages?: Array<{ role?: string; content?: unknown }>
      } | null = null
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        parsed = null
      }
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0
      const lastUser = [...(parsed?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
      const marker = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser ?? '')
      requests.push({ body: raw, hasTools, marker })
      if (!hasTools) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'S3-50A 会话' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      if (marker.includes('S3_50A_HOLD')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '挂起中' } }] })}\n\n`)
        return
      }
      if (marker.includes('S3_50A_400') || marker.includes('S3_50A_403')) {
        const status = marker.includes('S3_50A_400') ? 400 : 403
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'S3-50A 本地假失败' } }))
        return
      }
      if (marker.includes('S3_50A_BREAK')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '回复' } }] })}\n\n`)
      setTimeout(() => {
        const frame: Record<string, unknown> = {
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 3 }
        }
        if (marker.includes('S3_50A_DEFAULT')) frame['service_tier'] = 'default'
        else if (marker.includes('S3_50A_STANDARD')) frame['service_tier'] = 'standard'
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, 60)
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { srv, port: (srv.address() as AddressInfo).port, requests }
}

async function closeStoryServer(server: StoryServer | null): Promise<void> {
  if (!server) return
  server.srv.closeAllConnections()
  await new Promise<void>((resolve) => server.srv.close(() => resolve()))
}

async function openConversation(page: Page, title: string): Promise<void> {
  const item = page.locator('.conv-item', { hasText: title }).first()
  await expect(item).toHaveCount(1)
  await item.click()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.conv-item.active')).toContainText(title)
}

test.describe('S3-50A 三故事', () => {
  test('故事一：干净首次接入——空状态、模板不自动启用、空 Key/拉取失败/重名可解释', async () => {
    const h = await launchApp()
    try {
      expect(await apiCall<unknown[]>(h.page, 'listConversations')).toHaveLength(0)
      expect((await apiCall<ModelsView>(h.page, 'listModels')).profiles).toHaveLength(0)

      let sw = await openSettings(h)
      await gotoModelSection(sw)
      await expect(sw.locator('.model-row')).toHaveCount(0)
      await sw.locator('.model-add').click()
      await expect(sw.locator('.preset-picker')).toBeVisible()
      expect(await sw.locator('.preset-picker fieldset.preset-group').count()).toBeGreaterThanOrEqual(5)
      // 打开模板面板不等于启用/保存/联网
      expect((await apiCall<ModelsView>(h.page, 'listModels')).profiles).toHaveLength(0)

      const first = await apiCall<{ id: string }>(h.page, 'saveModel', {
        name: 'S3-50A 空 Key',
        providerType: 'openai-compatible',
        baseURL: 'http://127.0.0.1:1/v1',
        stream: true,
        timeoutMs: 5000,
        models: [{ id: 's3-50a-empty', model: 's3-50a-empty-model' }],
        apiKey: ''
      })
      expect(first.id).toBeTruthy()
      await closeSettings(h, sw)
      sw = await openSettings(h)
      await gotoModelSection(sw)
      const row = sw.locator('.model-row', { hasText: 'S3-50A 空 Key' })
      await expect(row).toHaveCount(1)
      // 空 Key 的「测试连接」按钮仍可点，但必须给可解释提示，不得静默或误报成功
      await row.locator('.model-act[title="尚未填写 API Key"]').click()
      await expect(sw.locator('.notice-err')).toContainText(/API Key|尚未保存|请先/)

      await row.locator('[title="编辑该模型"]').click()
      await sw.waitForSelector('.settings-subpage .mc')
      await sw.locator('.mc-link', { hasText: '获取可用模型' }).click()
      await expect(sw.locator('.settings-subpage .notice-err')).toContainText(
        /请先填写 API Key|连不上|失败/
      )

      const before = await apiCall<ModelsView>(h.page, 'listModels')
      const duplicate = await apiCall<{ id: string }>(h.page, 'saveModel', {
        name: 'S3-50A 空 Key',
        providerType: 'openai-compatible',
        baseURL: 'http://127.0.0.1:1/v2',
        stream: true,
        timeoutMs: 5000,
        models: [{ id: 's3-50a-dup', model: 's3-50a-dup-model' }],
        apiKey: ''
      })
      const after = await apiCall<ModelsView>(h.page, 'listModels')
      expect(duplicate.id).not.toBe(first.id)
      expect(after.profiles.length).toBe(before.profiles.length + 1)
      expect(after.profiles.filter((p) => p.name === 'S3-50A 空 Key')).toHaveLength(2)
      expect(new Set(after.profiles.map((p) => p.id)).size).toBe(after.profiles.length)

      await expect(
        apiCall(h.page, 'saveModel', {
          name: 'S3-50A 账号专属',
          providerType: 'openai-compatible',
          baseURL: '',
          stream: true,
          timeoutMs: 5000,
          models: [{ id: 's3-50a-empty-base', model: 'm' }],
          apiKey: ''
        })
      ).rejects.toThrow(/账号专属|占位|地址|baseURL/i)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('故事二：FAST 请求字段与真实档位；400/403/断流不重试', async () => {
    const h = await launchApp()
    let server: StoryServer | null = null
    try {
      const encryptionAvailable = await h.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      test.skip(!encryptionAvailable, '本地假端点发送需要 safeStorage；仅跳本故事')
      server = await startStoryServer()
      await seedProfile(h, {
        name: 'S3-50A FAST 夹具',
        speedMode: 'fast',
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: '{{SECRET_s3_50a_local_only}}',
        serviceTiers: ['priority']
      })
      await h.page.locator('.sidebar .new-task-btn').click()
      await expect(h.page.locator('.new-task')).toBeVisible()

      await h.page.locator('textarea.console-input').fill('S3_50A_DEFAULT 默认档')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      let facts = await readRunFacts(h.page)
      expect(facts[0].request).toBe('请求：FAST')
      expect(facts[0].actual, '服务端回 default 时必须显示实际普通').toBe('实际：普通')
      expect(facts[0].observed).toBe('true')
      const defaultReq = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_DEFAULT'))
      expect(defaultReq).toHaveLength(1)
      expect(defaultReq[0].body).toContain('"service_tier":"priority"')

      await h.page.locator('textarea.console-input').fill('S3_50A_STANDARD 标准档')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(2, {
        timeout: 30_000
      })
      facts = await readRunFacts(h.page)
      expect(facts[1].request).toBe('请求：FAST')
      expect(facts[1].actual, '服务端回 standard 时也必须显示实际普通').toBe('实际：普通')
      expect(facts[1].observed).toBe('true')
      const standardReq = server.requests.filter(
        (r) => r.hasTools && r.marker.includes('S3_50A_STANDARD')
      )
      expect(standardReq).toHaveLength(1)

      await h.page.locator('textarea.console-input').fill('S3_50A_MISSING 缺报档')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(3, {
        timeout: 30_000
      })
      facts = await readRunFacts(h.page)
      expect(facts[2].request).toBe('请求：FAST')
      expect(facts[2].actual, '服务端缺报时必须显示档位未知').toBe('实际：未知')
      expect(facts[2].observed).toBe('false')

      await h.page.locator('textarea.console-input').fill('S3_50A_400 参数失败')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="failed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      await expect(h.page.locator('.chat-error')).toContainText('请求失败（HTTP 400）')
      const bad400 = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_400'))
      expect(bad400, '400 不得重试/重放').toHaveLength(1)

      await h.page.locator('textarea.console-input').fill('S3_50A_403 权限失败')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="failed"]')).toHaveCount(2, {
        timeout: 30_000
      })
      await expect(h.page.locator('.chat-error')).toContainText('无权限（403）')
      const bad403 = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_403'))
      expect(bad403, '403 不得重试/重放').toHaveLength(1)

      await h.page.locator('textarea.console-input').fill('S3_50A_BREAK 断流')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(
        h.page.locator('.msg-terminal[data-terminal-state="unknown"], .msg-terminal[data-terminal-state="failed"]')
      ).toHaveCount(3, { timeout: 30_000 })
      const broken = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_BREAK'))
      expect(broken, '断流不得重试/重放').toHaveLength(1)
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(3)
    } finally {
      await closeStoryServer(server)
      await h.close()
      await h.cleanup()
    }
  })

  test('故事三：双会话独立、停止后不再发、重启只恢复选择不自动执行', async () => {
    const h = await launchApp()
    let server: StoryServer | null = null
    let current: E2EApp | null = h
    try {
      const encryptionAvailable = await h.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      test.skip(!encryptionAvailable, '本地假端点发送需要 safeStorage；仅跳本故事')
      server = await startStoryServer()
      const { id: profileId } = await seedProfile(h, {
        name: 'S3-50A 双会话夹具',
        speedMode: 'normal',
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: '{{SECRET_s3_50a_dual_only}}',
        serviceTiers: ['priority']
      })
      const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
      const convA = await apiCall<{ id: string }>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 's3-50a-model',
        firstMessage: '会话A'
      })
      const convB = await apiCall<{ id: string }>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 's3-50a-model',
        firstMessage: '会话B'
      })
      await apiCall(h.page, 'setUIPrefs', {
        conversationSpeedOverrides: { [convA.id]: 'fast', [convB.id]: 'normal' }
      })
      await h.page.reload()
      await expect(h.page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
      expect(profileId).toBeTruthy()

      await openConversation(h.page, '会话A')
      await h.page.locator('textarea.console-input').fill('S3_50A_A 第一轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      await openConversation(h.page, '会话B')
      await h.page.locator('textarea.console-input').fill('S3_50A_B 第一轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(1, {
        timeout: 30_000
      })
      const aReq = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_A'))
      const bReq = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_B'))
      expect(aReq).toHaveLength(1)
      expect(bReq).toHaveLength(1)
      expect(aReq[0].body, 'A 会话覆盖 FAST 应带 priority').toContain('"service_tier":"priority"')
      expect(bReq[0].body, 'B 会话普通不得带 priority').not.toContain('"service_tier"')

      await openConversation(h.page, '会话A')
      await h.page.locator('textarea.console-input').fill('S3_50A_HOLD 停止轮')
      await h.page.locator('textarea.console-input').press('Enter')
      await expect(h.page.locator('.send-btn.stopping')).toBeVisible({ timeout: 15_000 })
      await h.page.locator('.send-btn.stopping').click()
      await expect(h.page.locator('.msg-terminal[data-terminal-state="cancelled"]')).toHaveCount(1, {
        timeout: 30_000
      })
      const heldCalls = server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_HOLD')).length
      expect(heldCalls).toBe(1)
      await h.page.waitForTimeout(700)
      expect(
        server.requests.filter((r) => r.hasTools && r.marker.includes('S3_50A_HOLD')),
        '停止后队列剩余项不得再启动'
      ).toHaveLength(1)

      const countBeforeRestart = server.requests.filter((r) => r.hasTools).length
      const dataDir = h.dataDir
      await h.close()
      current = null
      current = await launchApp({ reuseDataDir: dataDir })
      await expect(current.page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
      await current.page.waitForTimeout(900)
      expect(
        server.requests.filter((r) => r.hasTools).length,
        '重启只恢复选择，不得自动执行任务'
      ).toBe(countBeforeRestart)
      const prefs = await apiCall<{ conversationSpeedOverrides: Record<string, string> }>(
        current.page,
        'getUIPrefs'
      )
      expect(prefs.conversationSpeedOverrides[convA.id]).toBe('fast')
      expect(prefs.conversationSpeedOverrides[convB.id]).toBe('normal')
      await openConversation(current.page, '会话A')
      await expect(current.page.locator('.speed-select')).toHaveValue('fast')
    } finally {
      if (current) await current.close()
      await closeStoryServer(server)
      await h.cleanup()
    }
  })
})
