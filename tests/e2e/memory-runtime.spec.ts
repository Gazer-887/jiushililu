// 记忆运行时 e2e（M02 B1-5a/13b/14/15 补证，2026-10-11 [OpenCode·Leo] 建）。
// 走真入口 out/main/index.js、真预加载桥、真 IPC handler + 真 fs；仅模型用本机 127.0.0.1
// HTTP 替身（Q5 起），记忆 store / IPC / preload / App 推送 / 渲染组件不整体桩替代。
// 清理纪律：每个用例 finally 在调 cleanup 前自证 dataDir/workspaceDir 父目录与前缀合法。

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { ModelsView } from '@shared/models'
import { expect, test, type Page } from '@playwright/test'
import { apiCall, launchApp, type E2EApp } from './helpers'

/** 自证隔离合法：父目录是 tmpdir + 前缀对 —— 判错就抛在删除之前 */
function assertIsolated(dir: string, prefix: string): void {
  expect(resolve(dirname(dir))).toBe(resolve(tmpdir()))
  expect(basename(dir).startsWith(prefix)).toBe(true)
}

/** 收尾：每个实例都先自证、目录去重（复用实例共享 dataDir/workspaceDir）、EPERM 等一次 */
async function cleanupAll(apps: E2EApp[]): Promise<void> {
  const dataDirs = [...new Set(apps.map((a) => a.dataDir))]
  const wsDirs = [...new Set(apps.map((a) => a.workspaceDir))]
  for (const d of dataDirs) assertIsolated(d, 'jsl-e2e-data-')
  for (const d of wsDirs) assertIsolated(d, 'jsl-e2e-ws-')
  for (const d of [...dataDirs, ...wsDirs]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Windows 句柄释放延迟（本项目已知态）：等 500ms 再试一次
      await new Promise((r) => setTimeout(r, 500))
      rmSync(d, { recursive: true, force: true })
    }
  }
}

/** 打开右栏工作台的「记忆」面板：空布局走开窗菜单；已有布局（复用 dataDir 时布局持久化）
 *  直接点页签（页签保活：失活隐藏不卸载）。工作台收起态先展开（title 两态）。 */
async function openMemoryPanel(page: Page): Promise<void> {
  const expandBtn = page.locator('[title="展开工作台"]')
  if (await expandBtn.count() > 0) await expandBtn.first().click()
  const emptyPick = page.locator('.wb-empty .wb-pick', { hasText: '记忆' })
  if (await emptyPick.count() > 0) {
    await emptyPick.first().click()
  } else {
    await page.locator('.pane-tab', { hasText: '记忆' }).first().click()
  }
  await page.locator('.mem-panel').first().waitFor({ state: 'visible', timeout: 15_000 })
}

/** 收窄 saveMemory 结果：新建生效条目必带 file（queued 分支不带，下面会分辨） */
function okFile(r: { ok: boolean; file?: string }): string {
  expect(r.ok, 'saveMemory 应成功').toBe(true)
  expect(r.file, '新建生效条目应带回 file').toBeTruthy()
  return r.file as string
}

// B1-5a：列表与删除。全链走真的：隔离真应用保存 → 真渲染列出 → 真点击（含 confirm 对话）
// → 真预加载桥 → 真 registerIpcHandlers handler → 真 fs → 重启重读。
test('B1-5a：真应用保存两条 → 记忆页列出 → 点击删除一条（真桥+真 handler）→ 目标文件不存在 / 另一条保留 / 重启不复现', async () => {
  const apps: E2EApp[] = []
  try {
    const h = await launchApp()
    apps.push(h)

    // ① 隔离真应用保存两条（走真 IPC；main/ipc.ts 把 origin 钉死成 user）
    const keep = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: 'e2e-b1-5a-keep', description: '保留条', class: 'default', body: '这是要保留的正文。'
    })
    const gone = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: 'e2e-b1-5a-gone', description: '删除目标', class: 'default', body: '这是要删掉的正文。'
    })
    const keepFile = okFile(keep)
    const goneFile = okFile(gone)
    expect(keepFile).not.toBe(goneFile)

    // ② 记忆页列出两条（已生效列表默认折起，先展开）
    await openMemoryPanel(h.page)
    await h.page.locator('.mem-entries-toggle').click()
    await expect(h.page.locator('.mem-row')).toHaveCount(2, { timeout: 10_000 })
    await expect(h.page.locator('.mem-row', { hasText: 'e2e-b1-5a-keep' })).toBeVisible()
    await expect(h.page.locator('.mem-row', { hasText: 'e2e-b1-5a-gone' })).toBeVisible()

    // ③ 真点击删除一条：UI 按钮 → confirm 对话 → 真实桥 → 真实 handler
    h.page.on('dialog', (d) => void d.accept())
    await h.page
      .locator('.mem-row', { hasText: 'e2e-b1-5a-gone' })
      .locator('button', { hasText: '删除' })
      .click()

    // ④ 列表移除、另一条保留
    await expect(h.page.locator('.mem-row')).toHaveCount(1, { timeout: 10_000 })
    await expect(h.page.locator('.mem-row', { hasText: 'e2e-b1-5a-keep' })).toBeVisible()
    await expect(h.page.locator('.mem-row', { hasText: 'e2e-b1-5a-gone' })).toHaveCount(0)

    // 阴性对照：同一文件再删一次 → 真 handler 返回 false（前一条是真删了，不是界面假装）
    const second = await apiCall<boolean>(h.page, 'deleteMemory', goneFile)
    expect(second).toBe(false)

    // ⑤ fs 核验：目标文件不存在、另一条在（save 返回的 file 即主进程口径 —— 实测为绝对路径；
    //    相对形态兜底拼 dataDir，store root = userDataDir = dataDir）
    const gonePath = isAbsolute(goneFile) ? goneFile : join(h.dataDir, goneFile)
    const keepPath = isAbsolute(keepFile) ? keepFile : join(h.dataDir, keepFile)
    expect(existsSync(gonePath)).toBe(false)
    expect(existsSync(keepPath)).toBe(true)

    // ⑥ 重启复查：复用同一 dataDir 起第二个实例，目标不复现、保留仍在
    await h.close()
    const h2 = await launchApp({ reuseDataDir: h.dataDir })
    apps.push(h2)
    await openMemoryPanel(h2.page)
    await h2.page.locator('.mem-entries-toggle').click()
    await expect(h2.page.locator('.mem-row')).toHaveCount(1, { timeout: 10_000 })
    await expect(h2.page.locator('.mem-row', { hasText: 'e2e-b1-5a-gone' })).toHaveCount(0)
    await expect(h2.page.locator('.mem-row', { hasText: 'e2e-b1-5a-keep' })).toBeVisible()
    const goneRead = await apiCall<unknown>(h2.page, 'readMemory', goneFile)
    expect(goneRead ?? null, '重启后目标应读不出来').toBeNull()
    const keepRead = await apiCall<{ body?: string } | null>(h2.page, 'readMemory', keepFile)
    expect(keepRead?.body).toContain('保留')
  } finally {
    // 先全部 close 再清理 —— h2 复用 h 的 dataDir/workspaceDir，进程活着删不动目录
    for (const a of apps) {
      try {
        await a.close()
      } catch {
        /* 已关过 */
      }
    }
    await cleanupAll(apps)
  }
})

// ── Q3 B1-13b 注入税显示 ────────────────────────────────────────────────
// 每轮结束主进程按 sumInjectionTax(Est(记忆段), Est(手册段)) 上报，用量牌 `.usage-memory` 显示。
// 本组用本机 HTTP 替身捕获**实际发出去的请求**里的两个注入段，各自按 D-206 口径独立复算
//（宽字符 1 token/字、窄字符 4 字符/token 上取整 —— 独立实现，不复用产品函数），
// 再核 UI 数字、tooltip 与可见几何；覆盖手册段为 0 / 非零两态，并证与厂商 usage 不同源。

/** D-206 口径独立复算（与 estimateMemoryTokens 同口径、独立实现） */
function estLocal(block: string | null): number {
  if (block === null) return 0
  let wide = 0
  for (const ch of block) if (ch.charCodeAt(0) > 0x2e7f) wide += 1
  return wide + Math.ceil((block.length - wide) / 4)
}

/** formatTokens 本地复算（UI 文本口径） */
function formatUi(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 从请求体全文截取注入段（含闭合标签）；没有该段返回 null */
function extractBlock(body: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const i = body.indexOf(open)
  if (i < 0) return null
  const j = body.indexOf(close, i)
  if (j < 0) return null
  return body.slice(i, j + close.length)
}

/** 本机确定性 HTTP 替身（Q3/Q5 共用）：OpenAI 兼容 SSE，保留每个请求 body，固定 usage 帧 */
async function startFake(): Promise<{ srv: Server; port: number; bodies: string[] }> {
  const bodies: string[] = []
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
    })
    req.on('end', () => {
      bodies.push(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的，明白了' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { srv, port: (srv.address() as AddressInfo).port, bodies }
}

interface ChipRead {
  text: string
  title: string
  width: number
  height: number
}

/** 读用量牌注入税：文本 + `.usage-chip` title + 元素可见几何 */
async function readTaxChip(page: Page): Promise<ChipRead | null> {
  const el = page.locator('.usage-memory').first()
  if ((await el.count()) === 0) return null
  const box = await el.boundingBox()
  return {
    text: ((await el.textContent()) ?? '').trim(),
    title: (await page.locator('.usage-chip').first().getAttribute('title')) ?? '',
    width: box?.width ?? 0,
    height: box?.height ?? 0
  }
}

/** 收尾：先 close 再清理（本组用例不复用 dataDir，但保持与 Q2 同一纪律） */
async function teardownTax(apps: E2EApp[], srv: Server | null): Promise<void> {
  srv?.close()
  for (const a of apps) {
    try {
      await a.close()
    } catch {
      /* 已关过 */
    }
  }
  await cleanupAll(apps)
}

/** 发一轮用户消息，等到替身的确定性回复上屏（不是欢迎语 —— 欢迎语出现≠请求已发） */
async function sendOneRound(h: E2EApp, text: string): Promise<void> {
  const ta = h.page.locator('textarea').first()
  await ta.click()
  await ta.pressSequentially(text, { delay: 8 })
  await ta.press('Enter')
  await expect(h.page.locator('.msg-assistant', { hasText: '好的，明白了' })).toBeVisible({ timeout: 30_000 })
}

/** 在捕获请求里找带记忆段的对话轮，并 JSON 反转义回真实文本
 *  （序列化会把换行变成 \n 字面，直接在原文上估算 narrow 会偏出几个 token） */
function findSystemText(bodies: string[]): string {
  const chat = bodies.find((b) => b.includes('<memory>')) ?? bodies[bodies.length - 1] ?? ''
  try {
    const parsed = JSON.parse(chat) as { messages?: Array<{ role?: string; content?: unknown }> }
    const sys = (parsed.messages ?? []).find((m) => m.role === 'system')
    return typeof sys?.content === 'string' ? sys.content : chat
  } catch {
    return chat
  }
}

test('B1-13b ① 手册段为 0：UI 注入税 = 本机捕获记忆段独立估算；tooltip/可见几何齐；与厂商 usage 不同源', async () => {
  const apps: E2EApp[] = []
  let srv: Server | null = null
  try {
    const h = await launchApp()
    apps.push(h)
    const fake = await startFake()
    srv = fake.srv

    const saved = await apiCall<{ id?: string }>(h.page, 'saveModel', {
      name: 'e2e 税替身', providerType: 'openai-compatible',
      baseURL: `http://127.0.0.1:${fake.port}/v1`, stream: true, timeoutMs: 15000,
      models: [{ id: 'e2e-tax', model: 'e2e-tax-model' }], apiKey: 'e2e-fake-key-never-real'
    })
    const active = await apiCall<ModelsView>(h.page, 'setActiveModel', saved.id)
    expect(active.activeId).toBe(saved.id ?? undefined)

    // 注入开关确保开启（隔离实例默认值不依赖；warnFullAccess 供 Q4 复用同一接缝）
    const sw = await apiCall<{ enabled: boolean }>(h.page, 'setMemorySwitch', true)
    expect(sw.enabled, '记忆开关应开到').toBe(true)

    const mem = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: '税-记忆条', description: '注入税用例用的记忆条目', class: 'default',
      body: '这是注入税用例的正文：用来让记忆段具备可测的估算长度，宽字符占多数读数更稳。'
    })
    okFile(mem)

    await sendOneRound(h, '说一句回显就好')

    // 阳性对照：替身应真收到带记忆段的请求（没真打到，下面的绿没有意义）
    expect(fake.bodies.some((b) => b.includes('<memory>')), '假端点应收到带记忆段的请求').toBe(true)
    const sysText = findSystemText(fake.bodies)
    const memBlock = extractBlock(sysText, 'memory')
    const pbBlock = extractBlock(sysText, 'playbook')
    expect(memBlock, '请求体应带上记忆段').not.toBeNull()
    expect(pbBlock, '无 Playbook 命中时不应有手册段').toBeNull()

    const expected = estLocal(memBlock) + 0
    await expect(h.page.locator('.usage-memory')).toBeVisible({ timeout: 10_000 })
    const chip = await readTaxChip(h.page)
    expect(chip, '用量牌应显示注入税读数').not.toBeNull()
    expect(chip!.text, 'UI 数字应等于捕获记忆段的独立估算').toBe(`记忆税 ${formatUi(expected)}(估)`)
    expect(chip!.title, 'tooltip 应说明是本地估算').toContain(`记忆注入税（本地估算）：约 ${formatUi(expected)} tokens`)
    expect(chip!.width, '注入税元素应有可见宽度').toBeGreaterThan(0)
    expect(chip!.height, '注入税元素应有可见高度').toBeGreaterThan(0)

    // 与厂商 usage 分离：替身固定报 3 + 5 = 8（total 与注入税是两个不同来源的数）
    await expect(h.page.locator('.usage-total')).toHaveText('8')
    expect(expected, '本地估算不应等于厂商 usage 合计（同源才会相等）').not.toBe(8)
  } finally {
    await teardownTax(apps, srv)
  }
})

test('B1-13b ② 手册段非零：UI 注入税 = 记忆段 + 手册段两段相加（D-206 同尺各自独立估算）', async () => {
  const apps: E2EApp[] = []
  let srv: Server | null = null
  try {
    const h = await launchApp()
    apps.push(h)
    const fake = await startFake()
    srv = fake.srv

    const saved = await apiCall<{ id?: string }>(h.page, 'saveModel', {
      name: 'e2e 税替身2', providerType: 'openai-compatible',
      baseURL: `http://127.0.0.1:${fake.port}/v1`, stream: true, timeoutMs: 15000,
      models: [{ id: 'e2e-tax2', model: 'e2e-tax2-model' }], apiKey: 'e2e-fake-key-never-real'
    })
    const active = await apiCall<ModelsView>(h.page, 'setActiveModel', saved.id)
    expect(active.activeId).toBe(saved.id ?? undefined)
    const sw2 = await apiCall<{ enabled: boolean }>(h.page, 'setMemorySwitch', true)
    expect(sw2.enabled, '记忆开关应开到').toBe(true)

    okFile(
      await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
        name: '税二-记忆条', description: '注入税手册相加用例的记忆', class: 'default',
        body: '这是第二条用例的记忆正文：用来让记忆段具备可测的估算长度，宽字符占多数读数更稳。'
      })
    )
    const pb = await apiCall<{ ok: boolean; file?: string }>(h.page, 'savePlaybook', {
      name: '税二-手册条', description: '注入税手册相加用例', tags: ['test'],
      body: '这是手册段正文：跑测试时应当被条件召回注入，用来让手册段具备可测的估算长度。'
    })
    expect(pb.ok, 'Playbook 应保存成功').toBe(true)

    await sendOneRound(h, '帮我跑一下测试') // 含「测试」→ 活跃标签 test → 命中 entry tags

    expect(fake.bodies.some((b) => b.includes('<memory>')), '假端点应收到带记忆段的请求').toBe(true)
    const sysText = findSystemText(fake.bodies)
    const memBlock = extractBlock(sysText, 'memory')
    const pbBlock = extractBlock(sysText, 'playbook')
    expect(memBlock, '请求体应带上记忆段').not.toBeNull()
    expect(pbBlock, '活跃标签命中时应有手册段').not.toBeNull()

    // 两段相加口径（D-206 同尺：两侧各估一次再相加）
    const expected = estLocal(memBlock) + estLocal(pbBlock)
    await expect(h.page.locator('.usage-memory')).toBeVisible({ timeout: 10_000 })
    const chip = await readTaxChip(h.page)
    expect(chip!.text, 'UI 数字应等于记忆段 + 手册段两段独立估算之和').toBe(`记忆税 ${formatUi(expected)}(估)`)
    expect(chip!.title).toContain(`记忆注入税（本地估算）：约 ${formatUi(expected)} tokens`)
    expect(chip!.width).toBeGreaterThan(0)
    expect(chip!.height).toBeGreaterThan(0)
  } finally {
    await teardownTax(apps, srv)
  }
})

// ── Q4 B1-14 完全访问告知 ────────────────────────────────────────────────
// 真应用：权限档切 full-access → 设置窗口「记忆」分区**真点**「允许模型写记忆」开关
//（关→开 = 风险组合成立）→ `.mem-settings-warn` 当场呈现；再关再开仍告；
// meta.json 落 fullAccessNoticeShownAt（fs 直读 = 落盘重读）。
test('B1-14：真应用开关呈现告知：full-access 下关→开告一次、关→开再告、告知痕迹落盘', async () => {
  const apps: E2EApp[] = []
  try {
    const h = await launchApp()
    apps.push(h)

    // 权限档切到「完全访问」（走真桥），回读确认
    await apiCall(h.page, 'setPermission', 'full-access')
    expect(await apiCall<string>(h.page, 'getPermission')).toBe('full-access')

    // 开设置窗口，按 URL 找到它（拿主窗口查设置内容会永远查不到 —— smoke B4 同款坑）
    await apiCall(h.page, 'openSettingsWindow')
    const deadline = Date.now() + 20_000
    let sw = null as null | (Awaited<ReturnType<typeof h.app.windows>>[number])
    while (Date.now() < deadline && !sw) {
      sw = h.app.windows().find((w) => w.url().includes('settings')) ?? null
      if (!sw) await h.page.waitForTimeout(300)
    }
    expect(sw, '设置独立窗口应已开出').not.toBeNull()
    const settings = sw as NonNullable<typeof sw>
    await settings.locator('.settings-nav-item', { hasText: '记忆' }).click()
    const checkbox = settings.locator('.checkbox', { hasText: '允许模型写记忆' }).locator('input')
    await checkbox.waitFor({ timeout: 15_000 })
    const warn = settings.locator('.mem-settings-warn')

    // 初始 enabled=true（缺省开）：先关一次（不告，warn 不应出现）
    await checkbox.uncheck()
    await expect(warn).toHaveCount(0)

    // 关→开（full-access 生效中）→ 当场告知
    await checkbox.check()
    await expect(warn, '关→开应当场告知').toBeVisible({ timeout: 10_000 })
    await expect(warn).toContainText('完全访问')

    // 再关（不告、提示收起）→ 再开（仍告：风险组合重新成立）
    await checkbox.uncheck()
    await expect(warn).toHaveCount(0)
    await checkbox.check()
    await expect(warn, '关→开再告').toBeVisible({ timeout: 10_000 })

    // 落盘重读：告知痕迹应进 dataDir/memory/meta.json
    const metaRaw = JSON.parse(readFileSync(join(h.dataDir, 'memory', 'meta.json'), 'utf8')) as {
      fullAccessNoticeShownAt?: unknown
    }
    expect(typeof metaRaw.fullAccessNoticeShownAt, '告知痕迹应落 meta.json').toBe('string')
  } finally {
    await teardownTax(apps, null)
  }
})

// ── Q5 B1-15 写入通知 ────────────────────────────────────────────────
// 模型替身经生产 remember 工具写入（OpenAI 风格 tool_calls 帧：第一回合发工具调用、
// 看请求里出现 tool 结果后第二回合发最终答复），轮末主进程推 memoryNotice，UI `.mem-notice`
// 显示「记住了 X」；约 12s 后轮询观测自动消退（不断言恰好时长）；消息主干零非 user/assistant 行。

/** Q5 替身：首回合回 remember 工具调用，检出 tool 结果后回最终答复 */
async function startRememberFake(name: string): Promise<{ srv: Server; port: number; bodies: string[] }> {
  const bodies: string[] = []
  const args = JSON.stringify({
    name, description: '替身写入的通知用例', class: 'default', body: '这是模型替身经生产 remember 工具写进记忆库的正文。'
  })
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
    })
    req.on('end', () => {
      bodies.push(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 只对**第一回合**（A 的首条）回 remember 工具调用；其余回合回最终答复
      //（B 会话的回合若也回工具调用，会把 B 自己的通知引出来，干扰 A/B 隔离断言）
      if (bodies.length === 1) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_e2e_1', type: 'function', function: { name: 'remember', arguments: args } }
                  ]
                }
              }
            ]
          })}\n\n`
        )
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已经记住了。' } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { srv, port: (srv.address() as AddressInfo).port, bodies }
}

/** Q5 公共起跑：隔离真应用 + remember 替身 + 假档案激活 + 记忆开 + 审批门关（直写生效） */
async function startNoticeApp(memName: string): Promise<{
  apps: E2EApp[]
  h: E2EApp
  fake: { srv: Server; port: number; bodies: string[] }
}> {
  const apps: E2EApp[] = []
  const h = await launchApp()
  apps.push(h)
  const fake = await startRememberFake(memName)
  const saved = await apiCall<{ id?: string }>(h.page, 'saveModel', {
    name: 'e2e 通知替身', providerType: 'openai-compatible',
    baseURL: `http://127.0.0.1:${fake.port}/v1`, stream: true, timeoutMs: 15000,
    models: [{ id: 'e2e-notice', model: 'e2e-notice-model' }], apiKey: 'e2e-fake-key-never-real'
  })
  const active = await apiCall<ModelsView>(h.page, 'setActiveModel', saved.id)
  expect(active.activeId).toBe(saved.id ?? undefined)
  expect((await apiCall<{ enabled: boolean }>(h.page, 'setMemorySwitch', true)).enabled).toBe(true)
  // 审批门关掉 = 模型直写生效（默认开时模型写入落候选、不产生"记住了"通知 —— 逃生开关场景）
  expect(await apiCall<boolean>(h.page, 'setMemoryApprovalGate', false)).toBe(false)
  return { apps, h, fake }
}

test('B1-15 ① 写入通知可见 + 约 12s 轮询消退 + 消息主干零非 user/assistant 行', async () => {
  const { apps, h, fake } = await startNoticeApp('通知-甲')
  const srv = fake.srv
  try {
    const ta = h.page.locator('textarea').first()
    await ta.click()
    await ta.pressSequentially('请记住：我偏好用表格呈现对比数据', { delay: 8 })
    await ta.press('Enter')
    // 会话 id 形状会命中凭据检测（validateMemoryFields 对 evidence.conversationId 同段判定，
    // 保守策略宁可多弹一次确认）→ 真实用户路径：在确认框点「允许这一次」
    const allowBtn = h.page.getByRole('button', { name: '允许这一次' })
    await allowBtn.waitFor({ timeout: 30_000 })
    await allowBtn.click()
    await expect(h.page.locator('.msg-assistant', { hasText: '已经记住了。' })).toBeVisible({ timeout: 30_000 })

    // 替身两回合都应真到达（工具帧 + 最终答复帧）
    expect(fake.bodies.length, '替身应至少收到两回合请求').toBeGreaterThanOrEqual(2)
    expect(fake.bodies.some((b) => b.includes('remember')), '首回合应带 remember 工具调用').toBe(true)

    // 当前会话通知可见（生产通路的 memoryNotice）
    const notice = h.page.locator('.mem-notice')
    await expect(notice, '写入通知应可见').toBeVisible({ timeout: 15_000 })
    await expect(notice).toContainText('记住了 通知-甲')

    // 消息主干没有被插进行为外的行（通知走面板，不进消息流）
    expect(
      await h.page.locator('.msg:not(.msg-user):not(.msg-assistant)').count(),
      '消息主干应只有 user/assistant 两种行'
    ).toBe(0)

    // 约 12s 后自动消退：轮询观测，不硬断言恰好时长
    await expect(notice).toHaveCount(0, { timeout: 25_000 })
  } finally {
    await teardownTax(apps, srv)
  }
})

test('B1-15 ② A/B 会话隔离：A 写入通知在切到真实 createConversation 建的 B 后不显示', async () => {
  const { apps, h, fake } = await startNoticeApp('通知-乙')
  const srv = fake.srv
  try {
    const ta = h.page.locator('textarea').first()
    await ta.click()
    await ta.pressSequentially('请记住：我偏好暗色界面', { delay: 8 })
    await ta.press('Enter')
    const allowBtn = h.page.getByRole('button', { name: '允许这一次' })
    await allowBtn.waitFor({ timeout: 30_000 })
    await allowBtn.click()
    await expect(h.page.locator('.msg-assistant', { hasText: '已经记住了。' })).toBeVisible({ timeout: 30_000 })

    const notice = h.page.locator('.mem-notice')
    await expect(notice, 'A 会话的写入通知应可见').toBeVisible({ timeout: 15_000 })
    await expect(notice).toContainText('记住了 通知-乙')

    // UI 真实新建 B：侧栏「＋ 新建任务」→ 新建页发一条（store.createConversation 走 IPC 真建、
    // 刷新侧栏并把 activeId 切到 B；直接 invoke createConversation 不会同步渲染层 store）
    const convsA = await apiCall<Array<{ id: string }>>(h.page, 'listConversations')
    const aId = (convsA[0] ?? { id: '' }).id
    expect(aId.length, '默认会话应有 id').toBeGreaterThan(0)

    await h.page.getByTitle('在此工作区新建任务').click()
    await expect(h.page.locator('.new-task')).toBeVisible({ timeout: 10_000 })
    const ta2 = h.page.locator('textarea').first()
    await ta2.click()
    await ta2.pressSequentially('随便聊一句别的', { delay: 8 })
    await ta2.press('Enter')

    // 先确认 B 会话已激活（新建页收起 + B 的回复上屏）—— 否则隔离断言没有意义
    await expect(h.page.locator('.new-task')).toHaveCount(0, { timeout: 30_000 })
    await expect(h.page.locator('.msg-assistant', { hasText: '已经记住了。' }).last()).toBeVisible({ timeout: 15_000 })
    // 切到 B 后：A 的「记住了 通知-乙」不得显示。一次性读通知实况（B 可能显示自己的
    // 「这次没有写成记忆」；通知缺失同样算隔离生效 —— not.toContainText 要求元素存在，不适用）
    const noticeEl = h.page.locator('.mem-notice')
    const shownNotice =
      (await noticeEl.count()) > 0 ? ((await noticeEl.first().textContent()) ?? '') : ''
    expect(shownNotice, '切到 B 后 A 的写入通知不得显示').not.toContain('记住了 通知-乙')
    // B 确为另一个真实会话 id（listConversations 出现第二个）
    const convsB = await apiCall<Array<{ id: string }>>(h.page, 'listConversations')
    const bId = convsB.find((c) => c.id !== aId)?.id ?? ''
    expect(bId, 'B 应为另一个 id').not.toBe('')
  } finally {
    await teardownTax(apps, srv)
  }
})
