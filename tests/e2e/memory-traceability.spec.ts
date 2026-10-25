// 阶段二 S2-40：三故事整链 e2e（经验找到 / 来源看到 / 合并可追踪）。
//
// 与 `memory-runtime.spec.ts` 同一形态：驱动真入口 `out/main/index.js`、真预加载桥、真 IPC、真 fs；
// **只有模型是 127.0.0.1 的合成 HTTP 替身**。每条用例独立 `launchApp`，finally 先自证临时目录再清理。
//
// ⚠️ 本文件只证"可收集 + 判据写对"的静态面（S2-40 只跑 --list）；真实执行归 S2-40V。
// ⚠️ 不要在这里放宽判据换绿：三故事是阶段二的验收面，红就是产品红。

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { apiCall, launchApp, type E2EApp } from './helpers'

/** 自证隔离合法：父目录是 tmpdir + 前缀对 —— 判错就抛在删除之前（同 memory-runtime 纪律） */
function assertIsolated(dir: string, prefix: string): void {
  expect(resolve(dirname(dir))).toBe(resolve(tmpdir()))
  expect(basename(dir).startsWith(prefix)).toBe(true)
}

/** 收尾：先 close 再删除；dataDir/workspaceDir 去重；Windows 句柄延迟重试一次 */
async function cleanupAll(apps: E2EApp[]): Promise<void> {
  const dataDirs = [...new Set(apps.map((a) => a.dataDir))]
  const wsDirs = [...new Set(apps.map((a) => a.workspaceDir))]
  for (const d of dataDirs) assertIsolated(d, 'jsl-e2e-data-')
  for (const d of wsDirs) assertIsolated(d, 'jsl-e2e-ws-')
  for (const d of [...dataDirs, ...wsDirs]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      await new Promise((r) => setTimeout(r, 500))
      rmSync(d, { recursive: true, force: true })
    }
  }
}

/** 合成模型端点：普通对话回固定文本；反思请求（system 含「记忆反思助手」）回注入的候选 JSON */
async function startFake(opts: {
  reply?: string
  reflection?: () => string
}): Promise<{ srv: Server; port: number; bodies: string[] }> {
  const bodies: string[] = []
  const reply = opts.reply ?? '好的，明白了'
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
    })
    req.on('end', () => {
      bodies.push(raw)
      const isReflection = raw.includes('记忆反思助手')
      const content = isReflection ? (opts.reflection?.() ?? '[]') : reply
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { srv, port: (srv.address() as AddressInfo).port, bodies }
}

/** 装一条指向本机替身的模型档案并设为当前（safeStorage 不可用的平台按产品红线会拒存） */
async function useFakeModel(h: E2EApp, port: number, name: string): Promise<void> {
  const saved = await apiCall<{ id?: string }>(h.page, 'saveModel', {
    name,
    providerType: 'openai-compatible',
    baseURL: `http://127.0.0.1:${port}/v1`,
    stream: true,
    timeoutMs: 15000,
    models: [{ id: `${name}-m`, model: `${name}-model` }],
    apiKey: 'e2e-fake-key-never-real'
  })
  await apiCall(h.page, 'setActiveModel', saved.id)
  const sw = await apiCall<{ enabled: boolean }>(h.page, 'setMemorySwitch', true)
  expect(sw.enabled, '记忆开关应开到').toBe(true)
  const auto = await apiCall<{ autoMemoryEnabled?: boolean }>(h.page, 'setMemoryAuto', {
    autoMemoryEnabled: true
  })
  expect(auto.autoMemoryEnabled, '自动记忆（反思入队前置）应开到').toBe(true)
}

/** 平台守卫：saveModel 要用 safeStorage 加密落 Key，无加密服务一律跳过并留日志（同 smoke A 类） */
async function encryptionAvailable(h: E2EApp): Promise<boolean> {
  return h.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
}

/** 读记忆页候选/条目的来源文案与几何（纯文本节点，不猜结构） */
async function readEvidenceNodes(page: Page): Promise<{
  texts: string[]
  boxes: Array<{ w: number; h: number }>
  overflowCount: number
  panelText: string
}> {
  return page.evaluate(() => {
    const panel = document.querySelector('.mem-panel')
    if (!panel) return { texts: [], boxes: [], overflowCount: 0, panelText: '' }
    const nodes = Array.from(panel.querySelectorAll('.mem-evidence'))
    const pr = panel.getBoundingClientRect()
    const boxes = nodes.map((n) => {
      const b = n.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height) }
    })
    const overflowCount = nodes.filter((n) => {
      const b = n.getBoundingClientRect()
      return b.right > pr.right + 1 || b.left < pr.left - 1
    }).length
    return { texts: nodes.map((n) => (n.textContent || '').trim()), boxes, overflowCount, panelText: panel.textContent || '' }
  })
}

/** 打开右栏「记忆」面板（工作台收起态先展开；已有布局直接点页签） */
async function openMemoryPanel(page: Page): Promise<void> {
  const expandBtn = page.locator('[title="展开工作台"]')
  if ((await expandBtn.count()) > 0) await expandBtn.first().click()
  const emptyPick = page.locator('.wb-empty .wb-pick', { hasText: '记忆' })
  if ((await emptyPick.count()) > 0) {
    await emptyPick.first().click()
  } else {
    await page.locator('.pane-tab', { hasText: '记忆' }).first().click()
  }
  await page.locator('.mem-panel').first().waitFor({ state: 'visible', timeout: 15_000 })
}

/**
 * 在聊天输入框发一条消息，并等到**这一条**的确定性回复上屏。
 * ⚠️ S2-40-R1：不能对全局 `.msg-assistant` 做文本 toBeVisible —— 页面上已有同文旧回复时
 * 会一次命中两条（strict mode violation）；改为记录发送前条数、等条数 +1、只断言最新一条。
 */
async function sendText(h: E2EApp, text: string): Promise<void> {
  const replies = h.page.locator('.msg-assistant')
  const before = await replies.count()
  const ta = h.page.locator('textarea').first()
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
  await expect
    .poll(async () => replies.count(), { timeout: 30_000, intervals: [200, 500, 1000] })
    .toBe(before + 1)
  await expect(replies.nth(before)).toContainText('好的，明白了', { timeout: 30_000 })
}

/** 从捕获的请求里取出注入段（含闭合标签）；没有返回 null */
function extractBlock(body: string, tag: string): string | null {
  const i = body.indexOf(`<${tag}>`)
  if (i < 0) return null
  const j = body.indexOf(`</${tag}>`, i)
  if (j < 0) return null
  return body.slice(i, j + tag.length + 3)
}

/** 解析事件流（真文件，不读内存态） */
function readEvents(dataDir: string): Array<Record<string, unknown>> {
  const p = join(dataDir, 'memory', 'events.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** 绝对化 save 返回的 file（主进程实测给绝对路径，相对形态兜底拼 dataDir） */
function absFile(file: string, dataDir: string): string {
  return isAbsolute(file) ? file : join(dataDir, file)
}

// ── 故事一：经验能够找到 ─────────────────────────────────────────────────
test('S2-40 故事一：规范标签参与自动召回、仅自定义标签只手动召回（真保存→真注入→重启仍在）', async () => {
  const apps: E2EApp[] = []
  let srv: Server | null = null
  try {
    const h = await launchApp()
    apps.push(h)
    const fake = await startFake({})
    srv = fake.srv
    if (!(await encryptionAvailable(h))) test.skip(true, 'safeStorage 不可用：Key 无法加密落盘')
    await useFakeModel(h, fake.port, 'e2e-trace-pb')

    // ① 真保存两条：混合标签（含 debug）与纯自定义标签
    const mixed = await apiCall<{ ok: boolean }>(h.page, 'savePlaybook', {
      name: 'e2e-pb-mixed',
      description: '带规范标签的经验',
      tags: ['debug', 'team-rule'],
      body: '调试这类问题时先跑定点单测。'
    })
    const custom = await apiCall<{ ok: boolean }>(h.page, 'savePlaybook', {
      name: 'e2e-pb-custom',
      description: '只有自定义标签的经验',
      tags: ['team-rule'],
      body: '团队规矩：提交前互相看一眼。'
    })
    expect(mixed.ok).toBe(true)
    expect(custom.ok).toBe(true)

    // ② 设置页 Playbook 分区：规范标签提示与"仅自定义标签只能手动召回"必须可见且有几何
    await apiCall(h.page, 'openSettingsWindow')
    const settings = await (async () => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const w = h.app.windows().find((x) => x.url().includes('settings'))
        if (w) return w
        await new Promise((r) => setTimeout(r, 300))
      }
      throw new Error('设置窗没打开')
    })()
    await settings.waitForSelector('.settings-nav-item', { timeout: 20_000 })
    await settings.locator('.settings-nav-item', { hasText: 'Playbook' }).click()
    await settings.waitForSelector('.mem-panel', { timeout: 15_000 })
    // 打开「新建」露出编辑表单里的标签说明
    await settings.locator('.mem-panel button', { hasText: '新建' }).first().click()
    const hint = await settings.evaluate(() => {
      const panel = Array.from(document.querySelectorAll('.mem-panel')).find(
        (n) => (n.querySelector('.mem-title')?.textContent || '').trim() === 'Playbook'
      )
      if (!panel) return null
      const field = Array.from(panel.querySelectorAll('.mem-field')).find(
        (f) => (f.querySelector('span')?.textContent || '').trim() === '标签'
      )
      if (!field) return null
      const text = field.textContent || ''
      const hintNodes = Array.from(field.querySelectorAll('span')).filter((s) => (s.textContent || '').trim().length > 0)
      const boxes = hintNodes.map((n) => {
        const b = n.getBoundingClientRect()
        return { w: Math.round(b.width), h: Math.round(b.height) }
      })
      return { text, boxes }
    })
    expect(hint, 'Playbook 编辑表单应有标签说明').not.toBeNull()
    for (const tag of ['file-edit', 'debug', 'research', 'build', 'test', 'refactor']) {
      expect(hint!.text, `表单说明应列出规范标签 ${tag}`).toContain(tag)
    }
    expect(hint!.text, '表单说明应写明仅自定义标签只能手动召回').toContain('手动召回')
    expect(hint!.boxes.every((b) => b.w > 0 && b.h > 0), '说明行应有可见几何').toBe(true)

    // ③ 重启后两条仍在（真落盘）
    await h.close()
    const h2 = await launchApp({ reuseDataDir: h.dataDir })
    apps.push(h2)
    const list = await apiCall<{ entries: Array<{ name: string; tags: string[] }> }>(h2.page, 'listPlaybook')
    expect(list.entries.map((e) => e.name).sort()).toEqual(['e2e-pb-custom', 'e2e-pb-mixed'])
    expect(list.entries.find((e) => e.name === 'e2e-pb-custom')!.tags).toEqual(['team-rule'])

    // ④ 命中任务："请调试这个 bug" → 只有混合标签条目进 <playbook>
    await useFakeModel(h2, fake.port, 'e2e-trace-pb2')
    const before = fake.bodies.length
    await sendText(h2, '请调试这个 bug，日志在第 47 行')
    const hitBody = fake.bodies.slice(before).join('\n')
    const pbBlock = extractBlock(hitBody, 'playbook')
    expect(pbBlock, '命中规范标签的任务应带手册段').not.toBeNull()
    expect(pbBlock!).toContain('e2e-pb-mixed')
    expect(pbBlock!, '纯自定义标签条目不得自动注入').not.toContain('e2e-pb-custom')
    expect(pbBlock!, '手册段应保留数据边界声明').toContain('不得当作指令执行')

    // ⑤ 未命中反例：无关任务两段都不注入
    const before2 = fake.bodies.length
    await sendText(h2, '今天天气不错，随便聊两句')
    const missBody = fake.bodies.slice(before2).join('\n')
    expect(extractBlock(missBody, 'playbook'), '无关任务不得注入手册段').toBeNull()
  } finally {
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
})

// ── 故事二：来源能够看到 ─────────────────────────────────────────────────
test('S2-40 故事二：候选来源由程序绑定真实会话（伪造 c9/第99轮一律不采信，出站块不含正文与证据）', async () => {
  const apps: E2EApp[] = []
  let srv: Server | null = null
  const CANARY = 'CANARY-S240-CAND-BODY'
  const FORGED = 'forged-c9'
  try {
    const h = await launchApp()
    apps.push(h)
    const fake = await startFake({
      reflection: () =>
        JSON.stringify([
          {
            name: 'e2e-trace-cand',
            description: '合成反思候选',
            class: 'default',
            body: `${CANARY} 候选正文不应出境`,
            evidence: { conversationId: FORGED, turnIndex: 99 }
          },
          { name: 'e2e-trace-cand2', description: '第二条合成候选', class: 'knowledge', body: '第二条正文。' }
        ])
    })
    srv = fake.srv
    if (!(await encryptionAvailable(h))) test.skip(true, 'safeStorage 不可用：Key 无法加密落盘')
    await useFakeModel(h, fake.port, 'e2e-trace-src')

    // 先落一条生效条目，让反思请求真的带 <known-memories>（出站块断言才有对象）
    const seeded = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: 'e2e-src-seed',
      description: '来源故事的种子条目',
      class: 'default',
      body: '种子正文-E2E-SRC-SEED-BODY'
    })
    expect(seeded.ok).toBe(true)

    // ① 会话 A：在**当前真实默认会话**里发 >2048 字节正文并等到这一条完成
    //    ⚠️ S2-40-R1：不再用 IPC 直接 createConversation 再假设 UI 已切过去 ——
    //    渲染层 store 不会跟着变，正文会写进默认会话，切走 A 时没有可反思内容（S2-40V 实测 0 候选）。
    await sendText(h, `${'甲'.repeat(1200)} 合成会话 A 正文，用于触发真实反思。`)
    const convsA = await apiCall<Array<{ id: string }>>(h.page, 'listConversations')
    const aId = (convsA[0] ?? { id: '' }).id
    expect(aId.length, '默认会话应有真实 id').toBeGreaterThan(0)

    // ② 自证持久化：bodyBytes ≥ 2048 且已有 user/assistant 正文（反思前置门的硬条件）
    type ConvView = { bodyBytes?: number; messages?: Array<{ role: string }> }
    let convA: ConvView | null = null
    await expect
      .poll(async () => {
        convA = await apiCall<ConvView | null>(h.page, 'getConversation', aId)
        return convA?.bodyBytes ?? 0
      }, { timeout: 30_000, intervals: [500, 1000] })
      .toBeGreaterThanOrEqual(2048)
    expect((convA?.messages ?? []).map((m) => m.role)).toEqual(
      expect.arrayContaining(['user', 'assistant'])
    )

    // ③ 真实 UI 新建 B：侧栏「在此工作区新建任务」→ 新建页发一条短消息（store 走 IPC 真建 + 真切换）
    await h.page.getByTitle('在此工作区新建任务').click()
    await expect(h.page.locator('.new-task')).toBeVisible({ timeout: 10_000 })
    await sendText(h, '会话 B：切走之后触发对会话 A 的反思。')
    await expect(h.page.locator('.new-task')).toHaveCount(0, { timeout: 30_000 })
    const convsB = await apiCall<Array<{ id: string }>>(h.page, 'listConversations')
    const bId = convsB.find((c) => c.id !== aId)?.id ?? ''
    expect(bId, 'B 应为另一个真实会话 id').not.toBe('')

    // ④ 真事件自证：至少一条 reflection_sample 指向会话 A 且 outcome=completed
    await expect
      .poll(async () => {
        return readEvents(h.dataDir).filter(
          (e) => e.kind === 'reflection_sample' && e.conversationId === aId && e.outcome === 'completed'
        ).length
      }, { timeout: 45_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThanOrEqual(1)

    // ⑤ 候选出现（两条合成候选）
    await expect
      .poll(async () => (await apiCall<{ candidates: Array<{ name: string }> }>(h.page, 'listMemory')).candidates.length, {
        timeout: 45_000,
        intervals: [500, 1000, 2000]
      })
      .toBeGreaterThanOrEqual(2)

    // ③ 候选来源只可能是会话 A，且没有轮次
    const idx = await apiCall<{
      candidates: Array<{ name: string; evidence: { conversationId: string; turnIndex?: number } | null }>
    }>(h.page, 'listMemory')
    const made = idx.candidates.filter((c) => c.name.startsWith('e2e-trace-cand'))
    expect(made.length).toBe(2)
    for (const c of made) {
      expect(c.evidence, `${c.name} 必须绑定真实会话 A`).toEqual({ conversationId: aId })
      expect(c.evidence?.turnIndex, '本阶段不产出轮次（不猜下标、不填 0）').toBeUndefined()
    }

    // ④ 出站块：只含 name/description，不含候选正文、证据、伪造 ID 或会话 A 的额外副本
    const reflectionBody = fake.bodies.find((b) => b.includes('记忆反思助手')) ?? ''
    expect(reflectionBody, '应捕获到反思请求').not.toBe('')
    const known = extractBlock(reflectionBody, 'known-memories')
    expect(known, '有生效条目时反思请求应带 known-memories 块').not.toBeNull()
    expect(known!).toContain('e2e-src-seed')
    expect(known!, '种子正文不得出境').not.toContain('E2E-SRC-SEED-BODY')
    expect(known!, '候选正文不得出境').not.toContain(CANARY)
    expect(known!).not.toContain(FORGED)
    expect(known!).not.toContain(aId)

    // ⑤ 界面：候选显示会话 A；无来源的旧候选/条目显示"来源未记录"
    await openMemoryPanel(h.page)
    // 已生效列表默认折起（折叠态不渲染行）→ 先展开，让「无来源条目」这一态真的出现在屏上。
    // ⚠️ 不再手写候选文件造夹具：store 不为外部新建的候选文件刷新列表（listMemory 读不到）；
    //    改走真实条目态（种子条目 evidence=null → 来源未记录）；候选缺来源的渲染态由 INK 门禁夹具覆盖。
    const entriesToggle = h.page.locator(".mem-entries-toggle")
    if ((await entriesToggle.count()) > 0 && (await h.page.locator(".mem-row").count()) === 0) {
      await entriesToggle.first().click()
    }
    await expect.poll(async () => (await readEvidenceNodes(h.page)).texts.length, { timeout: 20_000 }).toBeGreaterThan(0)
    const ev = await readEvidenceNodes(h.page)
    expect(ev.panelText, '面板不得出现伪造会话 ID').not.toContain(FORGED)
    expect(ev.panelText, '面板不得出现伪造轮次').not.toContain('第 99 轮')
    expect(ev.texts.some((t) => t.startsWith('来源会话：') && t.includes(aId)), '候选应显示会话 A').toBe(true)
    expect(ev.texts, '无来源条目/候选应显示"来源未记录"').toContain('来源未记录')
    expect(ev.boxes.every((b) => b.w > 0 && b.h > 0), '来源行应有可见几何').toBe(true)
    expect(ev.overflowCount, '来源行不得溢出记忆面板').toBe(0)

    // ⑥ 批准后来源不变；重启后仍显示会话 A
    const target = idx.candidates.find((c) => c.name === 'e2e-trace-cand')!
    const targetFile = (target as unknown as { file: string }).file
    // ⚠️ 批准会把候选转成 notes/ 下的正式条目并删掉候选文件 —— 所以必须读返回的新 file，
    //    对着候选路径 readMemory 只会拿到 null（S2-40-R1 实测踩过）。
    const ap = await apiCall<{ ok: boolean; file?: string }>(h.page, 'approveMemory', targetFile)
    expect(ap.ok, '批准应成功').toBe(true)
    expect(ap.file, '批准应带回新条目路径').toBeTruthy()
    const approved = await apiCall<{ evidence: unknown } | null>(h.page, 'readMemory', ap.file as string)
    expect(approved?.evidence).toEqual({ conversationId: aId })

    await h.close()
    const h2 = await launchApp({ reuseDataDir: h.dataDir })
    apps.push(h2)
    await openMemoryPanel(h2.page)
    await expect.poll(async () => (await readEvidenceNodes(h2.page)).texts.length, { timeout: 20_000 }).toBeGreaterThan(0)
    const ev2 = await readEvidenceNodes(h2.page)
    expect(ev2.panelText).not.toContain(FORGED)
    expect(ev2.texts.some((t) => t.includes(aId)), '重启后已生效条目仍显示会话 A').toBe(true)
  } finally {
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
})

// ── 故事三：合并能够追踪 ─────────────────────────────────────────────────
test('S2-40 故事三：正式合并参数乱序仍按创建时间定去留，delete 事件只记 mergedInto，重启可复查', async () => {
  const apps: E2EApp[] = []
  const CANARY = 'CANARY-S240-OLD-BODY'
  try {
    const h = await launchApp()
    apps.push(h)

    // ① 两条正式记忆：先存的较旧，正文带合成 Canary
    const older = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: 'e2e-merge-old',
      description: '较旧的那条',
      class: 'default',
      body: `旧正文 ${CANARY}`
    })
    const newer = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: 'e2e-merge-new',
      description: '较新的那条',
      class: 'default',
      body: '新正文。'
    })
    expect(older.ok).toBe(true)
    expect(newer.ok).toBe(true)
    const olderFile = older.file as string
    const newerFile = newer.file as string

    // ② 参数顺序打乱：把较新的当第一个参数传
    const merged = await apiCall<{ ok: boolean; message: string }>(h.page, 'mergeMemory', newerFile, olderFile)
    expect(merged.ok, '合并应成功').toBe(true)
    expect(merged.message, '响应目标按创建时间决定，指向较新条目').toContain('e2e-merge-new')

    // ③ 旧文件消失、新文件正文按原语义保留
    expect(await apiCall<unknown>(h.page, 'readMemory', olderFile)).toBeNull()
    const kept = await apiCall<{ body: string } | null>(h.page, 'readMemory', newerFile)
    expect(kept?.body).toContain(CANARY)
    expect(existsSync(absFile(olderFile, h.dataDir))).toBe(false)
    expect(existsSync(absFile(newerFile, h.dataDir))).toBe(true)

    // ④ 事件：delete 带 mergedInto=较新名、by=user、无 candidate，且不含 Canary/路径/正文
    const events = readEvents(h.dataDir)
    const mergeDel = events.filter((e) => e.kind === 'delete' && e.name === 'e2e-merge-old')
    expect(mergeDel).toHaveLength(1)
    expect(mergeDel[0]).toMatchObject({ by: 'user', mergedInto: 'e2e-merge-new' })
    expect(mergeDel[0]).not.toHaveProperty('candidate')
    const mergeLine = JSON.stringify(mergeDel[0])
    expect(mergeLine, '事件不得含正文 Canary').not.toContain(CANARY)
    expect(mergeLine, '事件不得含路径').not.toContain('memory/notes')
    expect(mergeLine, '事件不得含正文').not.toContain('旧正文')

    // ⑤ 对照：普通删除的 delete 事件不带 mergedInto
    const plain = await apiCall<{ ok: boolean; file?: string }>(h.page, 'saveMemory', {
      name: 'e2e-merge-plain',
      description: '用于普通删除对照',
      class: 'default',
      body: '普通删除正文。'
    })
    const removed = await apiCall<boolean>(h.page, 'deleteMemory', plain.file as string)
    expect(removed, '普通删除应成功').toBe(true)
    const plainDel = readEvents(h.dataDir).filter((e) => e.kind === 'delete' && e.name === 'e2e-merge-plain')
    expect(plainDel).toHaveLength(1)
    expect(plainDel[0]).not.toHaveProperty('mergedInto')

    // ⑥ 重启后事件仍在、界面只显示较新条目
    await h.close()
    const h2 = await launchApp({ reuseDataDir: h.dataDir })
    apps.push(h2)
    const restartEvents = readEvents(h2.dataDir).filter((e) => e.kind === 'delete' && e.name === 'e2e-merge-old')
    expect(restartEvents).toHaveLength(1)
    expect(restartEvents[0]).toMatchObject({ mergedInto: 'e2e-merge-new' })
    await openMemoryPanel(h2.page)
    await h2.page.locator('.mem-entries-toggle').click()
    await expect(h2.page.locator('.mem-row', { hasText: 'e2e-merge-new' })).toBeVisible({ timeout: 10_000 })
    await expect(h2.page.locator('.mem-row', { hasText: 'e2e-merge-old' })).toHaveCount(0)
  } finally {
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
