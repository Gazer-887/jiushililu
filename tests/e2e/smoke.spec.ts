// plan48 S1 · 主干冒烟（R6 的"关键用户路径 ≥3 条"）。
//
// **B 类**：不需要 API Key，CI 每次必跑 —— 覆盖"真输入 → 真写盘 → 重启仍可见"与
// 面板搬迁后的跨进程可达性（D-113 在真进程里也验一遍，不只靠 verify-shot 的桩）。
//
// **A 类**：需要 Key，只在 `safeStorage` 可用的平台跑。实测事实（run 35389942880）：
// `E2E_ENV linux encryptionAvailable=false`、win32=true —— 所以 A 类在 ubuntu CI 上
// 会**带原因 skip**（不许静默绿）。Key 走应用自己的加密通路，**不为测试在产品里开明文后门**（D-013）。
//
// ⚠️ 本文件不发任何真实厂商请求：A 类打到测试自己起的假端点（`node:http`，可控 SSE 流）。

import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { apiCall, launchApp, type E2EApp } from './helpers'

interface Conv {
  id: string
  title: string
  workspace: string
  model: string
}
interface ConvMeta {
  id: string
  title: string
}
interface ModelsView {
  activeId: string | null
  profiles: Array<{ id: string }>
}

test.describe('B 类 · 不需要 Key 的主干', () => {
  let h: E2EApp

  test.beforeEach(async () => {
    h = await launchApp()
  })

  test.afterEach(async () => {
    await h?.close()
    await h?.cleanup()
  })

  test('B1 新建任务页吃得下真键盘输入', async () => {
    await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
    const ta = h.page.locator('textarea').first()
    await ta.click()
    // 用真按键序列而不是 fill()：fill 直接赋值，绕过了 IME/keydown 那条路，
    // 而"打字打不进框"这类问题恰好只在按键链路上才暴露（plan8 R6附①同源）
    await ta.pressSequentially('e2e 输入探针', { delay: 12 })
    await expect(ta).toHaveValue(/e2e 输入探针/)
  })

  test('B2 会话写入盘上后，重启仍能读到（走应用自己的写路径，不碰模型）', async () => {
    const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
    const conv = await apiCall<Conv>(h.page, 'createConversation', {
      workspace: ws.path,
      model: 'e2e-model'
    })
    expect(conv.id, '应拿到新会话 id').toBeTruthy()

    const stamp = Date.now()
    await apiCall(h.page, 'saveConversation', conv.id, [
      { role: 'user', content: '持久化探针-用户', createdAt: stamp },
      { role: 'assistant', content: '持久化探针-助手', createdAt: stamp }
    ])

    // 先证"写进去了"，再证"重启还在"—— 两步分开，失败时才知道断在哪一段
    const before = await apiCall<ConvMeta[]>(h.page, 'listConversations')
    expect(before.some((c) => c.id === conv.id), '会话应先出现在列表里').toBe(true)

    await h.close()
    const h2 = await launchApp({ reuseDataDir: h.dataDir })
    try {
      const after = await apiCall<ConvMeta[]>(h2.page, 'listConversations')
      expect(after.some((c) => c.id === conv.id), '重启后会话应还在（这就是"重开仍可见"）').toBe(true)

      const full = await apiCall<{ messages: Array<{ content: string }> }>(
        h2.page,
        'getConversation',
        conv.id
      )
      expect(full.messages.map((m) => m.content)).toContain('持久化探针-助手')
    } finally {
      await h2.close()
      await h2.cleanup()
    }
  })

  test('B3 右栏减负后：工作台只剩 7 项，且留下的项真能开', async () => {
    // 展开工作台（顶栏那颗钮两态标题不同，两态都认）
    const toggle = h.page.locator('[title="展开工作台"], [title="收起工作台"]').first()
    await toggle.click()
    await h.page.waitForSelector('.dock', { timeout: 15_000 })

    // 空工作台的开窗菜单：默认布局是空的，选择器就在 `.wb-empty` 里
    const picks = h.page.locator('.wb-empty .wb-pick')
    await picks.first().waitFor({ timeout: 15_000 })
    const labels = (await picks.allTextContents()).map((t) => t.trim())
    expect(labels, '内置面板应收敛为 7 项').toHaveLength(7)
    expect(labels).not.toContain('Playbook')
    expect(labels).not.toContain('时间线')

    // 留下的项不能只是"列表里有"，得真点得开（资源管理器不起子进程，最干净）
    await h.page.locator('.wb-empty .wb-pick', { hasText: '资源管理器' }).click()
    await h.page.waitForSelector('.pane', { timeout: 15_000 })
    expect(await h.page.locator('.pane-tab').count(), '点开后应有一个页签').toBeGreaterThanOrEqual(1)
  })

  test('B4 Playbook 已迁到设置独立窗口，且在那儿真能列出条目', async () => {
    await apiCall(h.page, 'openSettingsWindow')
    // 设置窗口是**另一个窗口**，得按 URL 找到它 —— 拿主窗口查设置内容会永远查不到
    const deadline = Date.now() + 20_000
    let sw = null as null | (Awaited<ReturnType<typeof h.app.windows>>[number])
    while (Date.now() < deadline && !sw) {
      sw = h.app.windows().find((w) => w.url().includes('settings')) ?? null
      if (!sw) await h.page.waitForTimeout(300)
    }
    expect(sw, '设置独立窗口应已开出').not.toBeNull()
    const settings = sw as NonNullable<typeof sw>
    await settings.waitForSelector('.settings-nav-item', { timeout: 20_000 })

    const nav = (await settings.locator('.settings-nav-item').allTextContents()).map((t) => t.trim())
    expect(nav, '设置导航应有 Playbook 分区').toContain('Playbook')

    await settings.locator('.settings-nav-item', { hasText: 'Playbook' }).click()
    await settings.waitForSelector('.mem-panel .mem-title', { timeout: 15_000 })
    const title = await settings.locator('.mem-panel .mem-title').first().textContent()
    expect(title?.trim(), '该分区渲染的应是 Playbook 面板').toBe('Playbook')
  })
})

test.describe('A 类 · 需要 Key（本机 Windows 跑）', () => {
  test('A1 真发消息 → 流式上屏 → 落盘（打到本地假端点，不花钱）', async () => {
    const first = await launchApp()
    let srv: Server | null = null
    let hits = 0
    const fake = '九十里路 e2e 流式回复'

    try {
      const enc = await first.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
      test.skip(!enc, '该平台 safeStorage 不可用（Key 无法加密落盘）；A 类只在 Windows/macOS 本机跑')

      // 假端点：OpenAI 兼容的 SSE 分帧，格式照 src/main/providers/openai.ts 的解析口径
      srv = createServer((req, res) => {
        hits += 1
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fake.slice(0, 5) } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fake.slice(5) } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`)
        res.end('data: [DONE]\n\n')
        req.resume()
      })
      srv.listen(0, '127.0.0.1')
      await once(srv, 'listening')
      const port = (srv.address() as AddressInfo).port

      // Key 经**应用自己的通路**保存（它会用 safeStorage 加密），测试不碰明文落盘
      const saved = await apiCall<{ id?: string }>(first.page, 'saveModel', {
        name: 'e2e 假端点',
        providerType: 'openai-compatible',
        baseURL: `http://127.0.0.1:${port}/v1`,
        stream: true,
        timeoutMs: 15000,
        models: [{ id: 'e2e-entry', model: 'e2e-model' }],
        apiKey: 'e2e-fake-key-never-real'
      })
      const active = await apiCall<ModelsView>(first.page, 'setActiveModel', saved.id)
      expect(active.activeId, '假端点应被设为当前模型').toBe(saved.id ?? undefined)

      // 走真界面：打字 + Enter —— 这才是 R6 原话里那条"新建任务 → 发消息 → 流式上屏"
      const ta = first.page.locator('textarea').first()
      await ta.click()
      await ta.pressSequentially('给我一句回显', { delay: 12 })
      await ta.press('Enter')

      await expect(first.page.locator('.msg-assistant').first()).toContainText(fake, {
        timeout: 30_000
      })
      // ⚠️ 阳性对照（plan8 R6附②）：假端点没被真打到，上面那条绿就没有意义。
      //    顺手把 hits 打出来 —— 本条只 1.8s 就"上屏"，看数字才知道它是真跑了一趟还是空转。
      console.log(`A1_EVIDENCE=${JSON.stringify({ hits, port, activeId: active.activeId })}`)
      expect(hits, '假端点应至少收到一次请求').toBeGreaterThan(0)
    } finally {
      srv?.close()
      await first.close()
      await first.cleanup()
    }
  })
})
