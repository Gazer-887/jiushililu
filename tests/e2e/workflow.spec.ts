// 主工作流三故事 e2e（plan78 · 2026-10-13 批次）。
//
// 三故事：正常修改与交付 / 中断与拒绝 / 人工冲突与安全回滚。
// 真入口（helpers 走 `electron .`）+ 真 IPC / 工具 / 文件系统 / 检查点 / UI 点击；
// **只有模型服务是本地假 SSE 端点**（照 smoke.spec.ts A 类范式，不打厂商、不花钱）。
//
// 夹具：tests/fixtures/（sum.cjs 初始缺陷 a-b；随源码交付，CI / 新检出形态可用）。
// 需要 safeStorage（假 Key 走产品自己的加密通路存）→ CI ubuntu 无密钥环时带原因 skip。
//
// ⚠️ 前置：npm run build（helpers 经 package.json main 进 out/main/index.js）。

import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { copyFileSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { apiCall, launchApp, type E2EApp } from './helpers'

const FIXTURE_DIR = join(__dirname, '../fixtures')
const PROMPT = '修好这个项目：sum(a, b) 应该返回两数之和；不要改函数名和导出方式，不引入依赖。'
const NODE_CMD = `"${process.execPath}" sum.test.cjs`
// 拒绝场景的"副作用哨兵"：命令若真执行会在工作区留下这个独有文件；被拒后哨兵不存在 = 命令没跑
const SENTINEL_REL = 'reject-proof.txt'
const SENTINEL_CMD = `node -e "require('fs').writeFileSync('${SENTINEL_REL}','ran')"`
const SUM_FIXED_MARK = 'return a + b'
// ⚠️ code-executor 的声明工具集是 [read_file, write_file, list_dir, search_files, run_command]
// —— **不含 edit**（edit 只在「内核默认」的默认集里）。故本批编排一律用真实的 write_file 落地修改；
// 「executor 缺少精确编辑工具」如实登记为观察项，不在本批顺手改产品。
const sumFixedTextOf = (base: string): string => base.replace('return a - b', 'return a + b')
const readmeFixedTextOf = (base: string): string =>
  base.replace('# sum 小项目', '# sum 小项目\n\n用法：`sum(a, b)` 返回两数之和。')

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

function seedFixture(ws: string): void {
  for (const f of ['sum.cjs', 'sum.test.cjs', 'README.md']) copyFileSync(join(FIXTURE_DIR, f), join(ws, f))
}

// —— 假模型端点（OpenAI 兼容 SSE）——

type Frame = Record<string, unknown>
function sseOf(frames: Frame[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
}
function textReply(text: string): string {
  return sseOf([
    { choices: [{ delta: { content: text } }] },
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
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } }
  ])
}

/**
 * 从请求体里取**最后一条** tool 消息（`{name, text}`）。
 *
 * 编排判据不用全局请求计数：标题生成 / 反思等旁路请求会插进来，跨轮历史是否携带工具消息
 * 也不由本测试掌握 —— 而「最后一条 tool」永远是**本轮此刻**的最新事实，两条问题一起绕开。
 */
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
    /* 非 JSON / 结构异常 → 视为无工具消息 */
  }
  return { name: '', text: '' }
}

/** 在夹具工作区里**真实跑一次** sum 测试：初始缺陷必须非零退出（"预期失败"的注释不算证据） */
function runSumTest(cwd: string): { status: number; output: string } {
  const r = spawnSync(process.execPath, ['sum.test.cjs'], { cwd, encoding: 'utf8' })
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * 从请求体取**指定工具**的最后一条工具结果。
 *
 * ⚠️ 不能在整个请求正文里搜成功字样：方案文本、历史消息、助手的话都可能含同样的字眼 ——
 * 独审实证的假绿空间（"宣称通过"从未执行命令也能满足全请求搜索）。判据必须落在工具结果段上。
 */
function toolResultOf(body: string, tool: string): string {
  try {
    const msgs = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === 'tool' && typeof m.content === 'string') {
        if (m.content.includes(`<tool_output name="${tool}"`)) return m.content
      }
    }
  } catch {
    /* 非 JSON / 结构异常 → 视为没有 */
  }
  return ''
}

class FakeModel {
  hits = 0
  bodies: string[] = []
  port = 0
  /** 由用例编排每次响应（可挂起不结束时 = 模拟长生成） */
  respond: (n: number, body: string, res: ServerResponse) => void = (_n, _b, res) =>
    res.end(textReply('（未编排的请求）'))
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

  /** 含 tools 字段的请求 = agent 轮；无 tools = 标题/反思等辅助请求 */
  agentBodies(): string[] {
    return this.bodies.filter((b) => b.includes('"tools"'))
  }
}

// —— UI 助手 ——

async function useFakeModel(page: Page, fake: FakeModel): Promise<void> {
  const saved = await apiCall<{ id?: string }>(page, 'saveModel', {
    name: 'e2e 主工作流假端点',
    providerType: 'openai-compatible',
    baseURL: `http://127.0.0.1:${fake.port}/v1`,
    stream: true,
    timeoutMs: 30000,
    models: [{ id: 'wf-entry', model: 'wf-model' }],
    apiKey: 'e2e-fake-key-never-real'
  })
  await apiCall(page, 'setActiveModel', saved.id)
}

/** safeStorage 守卫：不可用带原因 skip（照 smoke.spec.ts 范式） */
async function requireKeyring(h: E2EApp, tag: string): Promise<void> {
  const enc = await h.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
  const skipReason = '该平台 safeStorage 不可用（Key 无法加密落盘）；本用例只在 Windows/macOS 本机跑'
  if (!enc) console.log(`${tag}_SKIP=${JSON.stringify({ encryptionAvailable: enc, reason: skipReason })}`)
  test.skip(!enc, skipReason)
}

/** 在「＋」菜单里选主 Agent（plan17：新建页与对话页共用） */
async function pickAgent(page: Page, name: string): Promise<void> {
  await page.locator('button.plus-btn').first().click()
  await page.locator('.plus-menu .plus-item', { hasText: name }).first().click()
}

async function sendText(page: Page, text: string): Promise<void> {
  const ta = page.locator('textarea.console-input').first()
  await ta.click()
  await ta.pressSequentially(text, { delay: 2 })
  await ta.press('Enter')
}

async function waitIdle(page: Page): Promise<void> {
  try {
    await expect(page.locator('.send-btn.stopping')).toHaveCount(0, { timeout: 90_000 })
  } catch (err) {
    // 卡住时把现场打出来（聊天错误条 / 最后一条助手消息 / 是否有对话框悬着）——否则只有超时一行，无从定位
    const errs = await page.locator('.chat-error').allTextContents().catch(() => [])
    const last = await page.locator('.msg-assistant').last().textContent().catch(() => '')
    const dialogs = await page.locator('[role="dialog"]').count().catch(() => -1)
    console.log(`WAITIDLE_STUCK=${JSON.stringify({ errs, last: (last ?? '').slice(0, 120), dialogs })}`)
    throw err
  }
}

async function approvePlan(page: Page, allow: boolean): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '计划批准' })
  await dialog.waitFor({ timeout: 45_000 })
  await dialog.getByRole('button', { name: allow ? '批准并执行' : '暂不执行' }).click()
}

/** 工具确认卡（write 档下 run_command 每次执行前弹）——与计划批准是两张不同的卡 */
async function answerConfirm(page: Page, allow: boolean): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '危险操作确认' })
  await dialog.waitFor({ timeout: 45_000 })
  await dialog.getByRole('button', { name: allow ? '允许这一次' : '拒绝' }).click()
}

/** 打开工作台「文件变更」面板（照 smoke.spec.ts B3 的入口） */
async function ensureChangesPanel(page: Page): Promise<void> {
  if ((await page.locator('.ck-panel').count()) === 0) {
    if ((await page.locator('.dock').count()) === 0) {
      await page.locator('[title="展开工作台"], [title="收起工作台"]').first().click()
      await page.waitForSelector('.dock', { timeout: 15_000 })
    }
    if ((await page.locator('.wb-empty').count()) > 0) {
      await page.locator('.wb-empty .wb-pick', { hasText: '文件变更' }).click()
    } else {
      await page.locator('.pane-add').first().click()
      await page.locator('.pane-menu .wb-pick', { hasText: '文件变更' }).click()
    }
    await page.waitForSelector('.ck-panel', { timeout: 15_000 })
  }
}

/** 刷新检查点面板，确保最新一轮已展开且包含指定文件（文件行只在展开后渲染） */
async function waitChangeRun(page: Page, rel: string): Promise<void> {
  await expect(async () => {
    await page.locator('.ck-head .ck-btn', { hasText: '刷新' }).first().click()
    const relRow = page.locator('.ck-file-rel', { hasText: rel }).first()
    if ((await relRow.count()) === 0) {
      const toggle = page.locator('.ck-run').first().locator('.ck-run-toggle')
      if ((await toggle.count()) > 0) await toggle.click()
    }
    await expect(relRow).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 30_000 })
}

/** 展开最新一轮的文件差异（列表最新在前；已展开时不重复点击收起） */
async function openLatestDiff(page: Page, rel: string): Promise<void> {
  const run = page.locator('.ck-run').first()
  if ((await run.locator('.ck-file-item').count()) === 0) {
    await run.locator('.ck-run-toggle').click()
  }
  await run.locator('.ck-file-item', { hasText: rel }).locator('button', { hasText: '看差异' }).click()
  await page.waitForSelector('.df-wrap', { timeout: 15_000 })
  await page.waitForSelector('.df-hunk', { timeout: 15_000 })
}

/** 点「退回这一处」→ 二次确认「确认退回」 */
async function clickRevertHunk(page: Page, hunkNo = 1): Promise<void> {
  const hunk = page.locator('.df-hunk').nth(hunkNo - 1)
  await hunk.locator('button', { hasText: '退回这一处' }).click()
  await page.locator('.df-actions button', { hasText: '确认退回' }).click()
}

/** 整轮回滚最新一轮（含二次确认） */
async function rollbackLatestRun(page: Page): Promise<void> {
  const run = page.locator('.ck-run').first()
  await run.locator('.ck-run-tail button', { hasText: '整轮回滚' }).click()
  await run.locator('.ck-run-tail button', { hasText: '确认回滚' }).click()
}

// —— 故事一：正常修改与交付 ——

test.describe('故事一 · 正常修改与交付', () => {
  test('拒绝一次不执行；批准后真工具修复并跑测试；Diff 保留；重开续用', async () => {
    test.slow() // 内含两次嵌套轮 + 重启 + 续用一轮，超出默认 120s
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    // 路径定义在用例函数体（不是 try 块内）：respond 闭包要引用它们，块作用域的 const 闭包看不见
    const sumPath = join(h.workspaceDir, 'sum.cjs')
    const readmePath = join(h.workspaceDir, 'README.md')
    // 编排：planner 出方案；executor 依次 read_file → write_file → run_command → 总结。
    // 分支只看「最后一条 tool 消息」+ 本轮是否 README 语境，不依赖请求序号（旁路请求会插队）。
    fake.respond = (_n, body, res) => {
      if (!body.includes('"tools"')) return res.end(textReply('会话标题：修复 sum'))
      const execPhase = body.includes('请按上述方案执行')
      const isReadme = body.includes('README')
      const t = lastTool(body)
      if (!execPhase) {
        return res.end(
          textReply(
            isReadme
              ? '方案：1）读取 README.md；2）在标题下补充一行 sum 用法说明；3）无需跑测试。文件：README.md。'
              : `方案：1）读取 sum.cjs；2）把 sum(a, b) 中的 "return a - b" 改为 "return a + b"，不改函数名与导出；3）运行 ${NODE_CMD} 验证；4）按命令返回（退出码与输出）判定成败。文件：sum.cjs。`
          )
        )
      }
      if (t.text.includes('# sum 小项目'))
        return res.end(
          toolReply('write_file', { path: 'README.md', content: readmeFixedTextOf(readFileSync(readmePath, 'utf8')) }, 'a2')
        )
      if (t.name === 'read_file') {
        return res.end(
          isReadme
            ? toolReply('write_file', { path: 'README.md', content: readmeFixedTextOf(readFileSync(readmePath, 'utf8')) }, 'a2')
            : toolReply('write_file', { path: 'sum.cjs', content: sumFixedTextOf(readFileSync(sumPath, 'utf8')) }, 'a2')
        )
      }
      if (t.name === 'write_file') {
        if (isReadme) return res.end(textReply('README 已更新：补充了 sum(a, b) 的用法说明。'))
        return res.end(toolReply('run_command', { command: NODE_CMD }, 'a3'))
      }
      if (t.name === 'run_command')
        return res.end(textReply('已完成：sum 已修复为 a + b，测试通过（输出 SUM_TESTS_PASS），未改动函数名与导出。'))
      // 兜底 = 第一步：让 executor 从 read_file 起步
      return res.end(toolReply('read_file', { path: isReadme ? 'README.md' : 'sum.cjs' }, 'a1'))
    }

    try {
      await requireKeyring(h, 'WF1')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)
      const sumBase = sha256(sumPath)
      // 先证明**初始缺陷真的失败**（真跑、非零退出）——"预期失败"的注释不算证据
      const initial = runSumTest(h.workspaceDir)
      expect(initial.status, `初始缺陷必须真实失败（非零退出）；输出：${initial.output.slice(0, 160)}`).not.toBe(0)

      // ① 新建页选 detail-planner（带 approval: plan 的规划员）→ 输入需求 → Enter
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await pickAgent(h.page, 'detail-planner')
      await expect(h.page.locator('.picked-hint')).toContainText('detail-planner')
      await sendText(h.page, PROMPT)

      // ② 拒绝一次：本轮不执行，sum.cjs 一字未动，且从无 executor 轮发生
      await approvePlan(h.page, false)
      await waitIdle(h.page)
      expect(sha256(sumPath), '拒绝后 sum.cjs 必须与初始缺陷版一致').toBe(sumBase)
      expect(
        fake.agentBodies().some((b) => b.includes('请按上述方案执行')),
        '拒绝后不应出现 executor 轮'
      ).toBe(false)

      // ③ 重新发一轮并批准：executor 依次 read_file → write_file → run_command（确认卡点「允许这一次」）→ 总结
      await sendText(h.page, PROMPT)
      await approvePlan(h.page, true)
      // 到场诊断：万一确认卡没来，直接看清 executor 轮走到哪一步
      console.log(
        `WF1_DIAG=${JSON.stringify({
          turns: fake.agentBodies().map((b) => ({ exec: b.includes('请按上述方案执行'), last: lastTool(b).name })),
          errors: await h.page.locator('.chat-error').allTextContents()
        })}`
      )
      await answerConfirm(h.page, true)
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('已完成', { timeout: 30_000 })

      const sumFixed = sha256(sumPath)
      expect(sumFixed, '批准执行后 sum.cjs 应为修复版').not.toBe(sumBase)
      expect(readFileSync(sumPath, 'utf8'), 'sum.cjs 应含 return a + b').toContain(SUM_FIXED_MARK)
      const execBodies = fake.agentBodies().filter((b) => b.includes('请按上述方案执行'))
      // 只认 run_command 的**真实工具结果**：全请求搜索会把方案/历史里的成功字样当证据（独审实证的假绿空间）
      const runOut = execBodies.map((b) => toolResultOf(b, 'run_command')).filter((s) => s.length > 0).pop() ?? ''
      expect(runOut.length, '必须拿到 run_command 的真实工具结果').toBeGreaterThan(0)
      expect(runOut, '真实命令输出应含测试通过标记').toContain('SUM_TESTS_PASS')
      expect(runOut, '真实命令应以 exit_code=0 结束').toContain('exit_code=0')

      // ④ 文件变更面板：看差异 → 保留（不做回滚，落盘修复版维持）
      await ensureChangesPanel(h.page)
      await waitChangeRun(h.page, 'sum.cjs')
      await openLatestDiff(h.page, 'sum.cjs')
      const hunks = await h.page.locator('.df-hunk').count()
      expect(hunks, 'Diff 应显示改动块').toBeGreaterThan(0)
      const diffBox = await h.page.locator('.df-wrap').first().boundingBox()
      console.log(`WF1_DIFF=${JSON.stringify({ hunks, box: diffBox })}`)
      // 保留 = 不做退回操作；断言文件维持修复版
      expect(sha256(sumPath), '看 Diff 后不做退回，文件应维持修复版').toBe(sumFixed)

      console.log(
        `WF1_EVIDENCE=${JSON.stringify({
          hits: fake.hits,
          agentTurns: fake.agentBodies().length,
          sumBefore: sumBase,
          sumAfter: sumFixed,
          nodeCmd: NODE_CMD
        })}`
      )

      // ⑤ 正常关闭 → 沿用同一数据目录重开 → 会话/文件/检查点还在 → 主动发下一轮改 README
      await h.close()
      const h2 = await launchApp({ reuseDataDir: h.dataDir })
      try {
        await h2.page.waitForSelector('.chat-view, .new-task', { timeout: 45_000 })
        await h2.page.locator('.conv-item').first().click()
        await h2.page.waitForSelector('.chat-view', { timeout: 15_000 })
        await expect(h2.page.locator('.msg-user').first()).toContainText('修好这个项目', { timeout: 15_000 })
        expect(sha256(sumPath), '重开后续文件仍是修复版').toBe(sumFixed)
        await ensureChangesPanel(h2.page)
        await waitChangeRun(h2.page, 'sum.cjs')
        // 主动一轮：更新 README（planner → 批准 → executor read/edit）
        const readmeBase = sha256(readmePath)
        await sendText(h2.page, '请把 README.md 更新为说明 sum(a, b) 返回两数之和（在标题下补一行即可）。')
        await approvePlan(h2.page, true)
        await waitIdle(h2.page)
        await expect(h2.page.locator('.msg-assistant').last()).toContainText('README 已更新', { timeout: 30_000 })
        expect(sha256(readmePath), 'README 应被真实修改').not.toBe(readmeBase)
        expect(readFileSync(readmePath, 'utf8'), 'README 应含用法说明').toContain('两数之和')
        console.log(
          `WF1_RESTART=${JSON.stringify({ readmeBefore: readmeBase, readmeAfter: sha256(readmePath), resumeHits: fake.hits })}`
        )
      } finally {
        await h2.close()
        await h2.cleanup()
      }
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })
})

// —— 故事二：中断与拒绝 ——

test.describe('故事二 · 中断与拒绝', () => {
  test('生成等待点取消：回到可继续、不冒完成、不开下一轮、重开不自动重放', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    fake.respond = (_n, body, res) => {
      if (!body.includes('"tools"')) return res.end(textReply('会话标题：取消'))
      if (body.includes('继续，简单回答')) return res.end(textReply('好的，已继续。'))
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('read_file', { path: 'sum.cjs' }, 'x1'))
      // 工具结果已回、模型生成挂起 —— 真实等待点：在这里被取消（不 end = SSE 流保持开着）
    }

    try {
      await requireKeyring(h, 'WF2')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)
      const sumPath = join(h.workspaceDir, 'sum.cjs')
      const sumBase = sha256(sumPath)

      // ① 发消息 → 第一轮返回 read_file（真执行）→ 第二轮生成挂起
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, '先读一下 sum.cjs，再告诉我它的行为。')
      await h.page.waitForSelector('.tool-item.tool-end', { timeout: 45_000 })
      await expect.poll(() => fake.agentBodies().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
      await h.page.waitForSelector('.send-btn.stopping', { timeout: 15_000 })

      // ② 点「停止生成」→ 回空闲；不再开下一轮请求；不冒完成
      const agentTurnsAtStop = fake.agentBodies().length
      await h.page.locator('.send-btn.stopping').click()
      await waitIdle(h.page)
      await h.page.waitForTimeout(2500)
      expect(fake.agentBodies().length, '取消后不应再发起新的 agent 轮请求').toBe(agentTurnsAtStop)
      const allText = (await h.page.locator('.msg-assistant').allTextContents()).join('\n')
      expect(allText, '取消后不得出现"已完成"假象').not.toContain('已完成')
      expect(allText, '取消后不得出现未发送过的最终文本').not.toContain('好的，已继续')
      expect(sha256(sumPath), '取消场景不应改动文件').toBe(sumBase)
      console.log(`WF2_CANCEL=${JSON.stringify({ agentTurnsAtStop, hits: fake.hits })}`)

      // ③ 用户主动重发：正常完成；无旧 ID / 排队确认串入（不弹任何对话框）
      await sendText(h.page, '继续，简单回答就好了：这个文件什么行为？')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('好的，已继续。', { timeout: 30_000 })
      expect(await h.page.locator('[role="dialog"]').count(), '重发轮不应弹出旧轮的确认/批准卡').toBe(0)

      // ④ 关闭 → 重开：不得自动重放被取消的旧任务
      await h.close()
      const turnsBefore = fake.agentBodies().length
      const h2 = await launchApp({ reuseDataDir: h.dataDir })
      try {
        await h2.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
        await h2.page.waitForTimeout(3500)
        expect(fake.agentBodies().length, '重开不得自动重放旧任务').toBe(turnsBefore)
        console.log(`WF2_REOPEN=${JSON.stringify({ turnsBefore, turnsAfter: fake.agentBodies().length })}`)
      } finally {
        await h2.close()
        await h2.cleanup()
      }
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('工具确认拒绝：命令未执行、结果不冒成功、拒绝后仍可继续', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const sumPath = join(h.workspaceDir, 'sum.cjs')
    fake.respond = (_n, body, res) => {
      if (!body.includes('"tools"')) return res.end(textReply('会话标题：拒绝'))
      if (body.includes('跳过测试')) return res.end(textReply('好的，那就跳过测试；结论以已完成的修改为准。'))
      const execPhase = body.includes('请按上述方案执行')
      const t = lastTool(body)
      if (!execPhase) {
        return res.end(
          textReply(
            `方案：1）读取 sum.cjs；2）把 "return a - b" 改为 "return a + b"，不改函数名与导出；3）运行 ${NODE_CMD} 验证。文件：sum.cjs。`
          )
        )
      }
      if (t.text.includes('function sum'))
        return res.end(
          toolReply('write_file', { path: 'sum.cjs', content: sumFixedTextOf(readFileSync(sumPath, 'utf8')) }, 'r2')
        )
      if (t.name === 'write_file') return res.end(toolReply('run_command', { command: SENTINEL_CMD }, 'r3'))
      if (t.name === 'run_command') {
        return res.end(
          t.text.includes('用户拒绝')
            ? textReply('测试命令被用户拒绝执行，未能验证；修改本身已落盘。')
            : textReply('哨兵命令已执行：reject-proof.txt 已生成。')
        )
      }
      return res.end(toolReply('read_file', { path: 'sum.cjs' }, 'r1'))
    }

    try {
      await requireKeyring(h, 'WF2B')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)
      const sumPath = join(h.workspaceDir, 'sum.cjs')

      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await pickAgent(h.page, 'detail-planner')
      await sendText(h.page, PROMPT)
      await approvePlan(h.page, true)
      await answerConfirm(h.page, false) // 拒绝执行命令
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('被用户拒绝', { timeout: 30_000 })

      // 被拒绝的命令**没有发生**：工具结果段如实交付"拒绝"；磁盘上哨兵文件不存在（若执行过必留下）
      const rejectOut = fake.bodies.map((b) => toolResultOf(b, 'run_command')).filter((s) => s.includes('用户拒绝')).pop() ?? ''
      expect(rejectOut, '工具结果段应如实回报拒绝').toContain('用户拒绝执行该命令')
      expect(existsSync(join(h.workspaceDir, SENTINEL_REL)), '被拒绝的命令不得执行（哨兵文件不存在）').toBe(false)
      // edit 在拒绝之前完成：文件已是修复版
      expect(readFileSync(sumPath, 'utf8'), '拒绝之前的真实编辑应已落盘').toContain(SUM_FIXED_MARK)
      console.log(`WF2B_REJECT=${JSON.stringify({ hits: fake.hits, agentTurns: fake.agentBodies().length })}`)

      // 拒绝后仍可继续（正向对照）：同一命令再发一轮 → 批准 → 允许执行 → **哨兵真实产生**
      await sendText(h.page, '没关系，再试一次这条命令。')
      await approvePlan(h.page, true)
      await answerConfirm(h.page, true) // 这一次允许执行
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('哨兵命令已执行', { timeout: 30_000 })
      expect(existsSync(join(h.workspaceDir, SENTINEL_REL)), '放行后哨兵应真实产生').toBe(true)
      expect(readFileSync(join(h.workspaceDir, SENTINEL_REL), 'utf8'), '哨兵内容应为命令所写').toBe('ran')
      expect(await h.page.locator('[role="dialog"]').count(), '批准/确认答复后不应有对话框悬着').toBe(0)
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('假绿钉子：文本宣称成功但从未执行命令——判据必须抓住', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const sumPath = join(h.workspaceDir, 'sum.cjs')
    // 方案与最终文本里**都带**成功字样，但**从不调用 run_command**
    fake.respond = (_n, body, res) => {
      if (!body.includes('"tools"')) return res.end(textReply('会话标题：假绿钉子'))
      const execPhase = body.includes('请按上述方案执行')
      const t = lastTool(body)
      if (!execPhase) {
        return res.end(textReply('方案：跑测试并确认 SUM_TESTS_PASS 输出即完成。文件：sum.cjs。'))
      }
      if (t.name === '') return res.end(toolReply('read_file', { path: 'sum.cjs' }, 'g1'))
      if (t.name === 'read_file') {
        return res.end(textReply('已完成：测试通过，输出 SUM_TESTS_PASS，执行成功。'))
      }
      return res.end(textReply('（未编排）'))
    }

    try {
      await requireKeyring(h, 'WF2G')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)

      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await pickAgent(h.page, 'detail-planner')
      await sendText(h.page, PROMPT)
      await approvePlan(h.page, true)
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('已完成', { timeout: 30_000 })

      // 界面照显示"已完成"；但证据判据必须抓住：真实 run_command 结果从未出现
      const runOuts = fake.bodies.map((b) => toolResultOf(b, 'run_command')).filter((s) => s.length > 0)
      expect(runOuts, '从未执行命令 → 不存在 run_command 工具结果（旧的全请求搜索会在这里假绿）').toHaveLength(0)
      expect(
        fake.bodies.some((b) => b.includes('SUM_TESTS_PASS')),
        '全请求里确实能搜到成功字样——这正是旧判据无效的原因'
      ).toBe(true)
      expect(readFileSync(sumPath, 'utf8'), '未执行命令 → sum.cjs 应仍是缺陷版').toContain('return a - b')
      console.log(`WF2G_FALSE_GREEN_GUARD=${JSON.stringify({ runToolResults: runOuts.length })}`)
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })
})

// —— 故事三：人工冲突与安全回滚 ——

/** 三故事共用的「修复 sum」假模型编排（planner 方案 → read → write_file → 总结） */
function wireFixSum(fake: FakeModel, sumPath: string, onAfterRead?: (body: string) => string | null): void {
  fake.respond = (_n, body, res) => {
    if (!body.includes('"tools"')) return res.end(textReply('会话标题：修复'))
    const execPhase = body.includes('请按上述方案执行')
    const t = lastTool(body)
    if (!execPhase) {
      return res.end(
        textReply('方案：1）读取 sum.cjs；2）把 "return a - b" 改为 "return a + b"，不改函数名与导出。文件：sum.cjs。')
      )
    }
    if (t.text.includes('function sum')) {
      const override = onAfterRead?.(body)
      if (override) return res.end(override)
      return res.end(
        toolReply('write_file', { path: 'sum.cjs', content: sumFixedTextOf(readFileSync(sumPath, 'utf8')) }, 'z2')
      )
    }
    if (t.name === 'write_file') return res.end(textReply('已修复 sum 为 a + b（未跑测试）。'))
    return res.end(toolReply('read_file', { path: 'sum.cjs' }, 'z1'))
  }
}

/** 走完一遍「选 planner → 发需求 → 批准 → 完成」并等空闲 */
async function runFixSumOnce(h: E2EApp, prompt = PROMPT): Promise<void> {
  await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
  await pickAgent(h.page, 'detail-planner')
  await sendText(h.page, prompt)
  await approvePlan(h.page, true)
  await waitIdle(h.page)
}

test.describe('故事三 · 人工冲突与安全回滚', () => {
  test('人工改动后 Agent 提交被拦：冲突暂停可见、未盲写；重读后可继续', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const sumPath = join(h.workspaceDir, 'sum.cjs')
    const HUMAN_NOTE = '// 人工备注：这一行是人工加的'
    const humanVersion = `${HUMAN_NOTE}\nfunction sum(a, b) {\n  return a - b\n}\n\nmodule.exports = { sum }\n`
    const expectFixed = `${HUMAN_NOTE}\nfunction sum(a, b) {\n  return a + b\n}\n\nmodule.exports = { sum }\n`
    wireFixSum(fake, sumPath, (body) => {
      if (body.includes('人工备注')) return null // 恢复轮：读到人工版 → 照常写修复版（含备注）
      // 第一轮：Agent 已读基线 → 人工此刻改盘 → 再让 Agent 提交（内容基于它读到的旧版，应被冲突拦下）
      const intended = sumFixedTextOf(readFileSync(sumPath, 'utf8'))
      writeFileSync(sumPath, humanVersion, 'utf8')
      return toolReply('write_file', { path: 'sum.cjs', content: intended }, 'z3')
    })

    try {
      await requireKeyring(h, 'WF3A')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)

      // ① Agent 读基线 → 人工改盘 → Agent write_file 提交 → 冲突拦下、整轮暂停
      await runFixSumOnce(h)
      await expect(h.page.locator('.chat-error')).toContainText('文件已变更，已暂停写入', { timeout: 30_000 })
      expect(readFileSync(sumPath, 'utf8'), '人工内容必须原样保留（未盲写）').toBe(humanVersion)
      // 冲突后整轮中止：没有任何后续请求携带 write_file 的工具结果（即没有继续下一步）
      expect(
        fake.agentBodies().every((b) => !b.includes('name="write_file"')),
        '冲突后不得继续后续工具'
      ).toBe(true)
      const noSuccess = (await h.page.locator('.msg-assistant').allTextContents()).join('\n')
      expect(noSuccess, '冲突轮不得冒成功').not.toContain('已修复 sum 为 a + b')
      console.log(`WF3A_CONFLICT=${JSON.stringify({ hits: fake.hits, content: 'human-kept' })}`)

      // ② 用户重读后继续：再发一轮 → read（读到人工版）→ edit → 成功；人工备注保留
      await sendText(h.page, '请重新读取文件后继续修复。')
      await approvePlan(h.page, true)
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('已修复', { timeout: 30_000 })
      expect(readFileSync(sumPath, 'utf8'), '恢复轮应保留人工备注并完成修复').toBe(expectFixed)
      console.log(`WF3A_RECOVER=${JSON.stringify({ final: sha256(sumPath) })}`)
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('查看差异后退回：mtime 变化被拦；同 mtime 不同字节亦不得依据陈旧差异覆盖；重开差异后可退回', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const sumPath = join(h.workspaceDir, 'sum.cjs')

    try {
      await requireKeyring(h, 'WF3B')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)
      const defect = readFileSync(sumPath, 'utf8')
      const fixed = defect.replace('return a - b', 'return a + b')
      wireFixSum(fake, sumPath)

      // ① 正常修复一轮 → 打开差异（此时 DiffView 记下当前 mtime）
      await runFixSumOnce(h)
      expect(readFileSync(sumPath, 'utf8')).toBe(fixed)
      // 把 mtime 归整秒（utimes 只有毫秒精度，NTFS 记 100ns —— 不归整，后面就无法构造"完全相等"）
      const wholeSecond = Math.floor(Date.now() / 1000) * 1000
      utimesSync(sumPath, new Date(wholeSecond), new Date(wholeSecond))
      await ensureChangesPanel(h.page)
      await waitChangeRun(h.page, 'sum.cjs')
      // 取本轮 runId 与 UI 打开差异时读到的 mtime（此时双方读到的是同一个值）
      const runs = await apiCall<Array<{ runId: string; fileCount: number }>>(h.page, 'listCheckpoints')
      const runId = runs[0]!.runId
      const sides = await apiCall<{ ok: boolean; mtimeMs?: number }>(h.page, 'getCheckpointSides', runId, 'sum.cjs')
      expect(sides.ok, 'sides 应可读').toBe(true)
      const mtime0 = sides.mtimeMs!
      await openLatestDiff(h.page, 'sum.cjs')
      console.log(`WF3B_OPEN=${JSON.stringify({ runId, mtime0, wholeSecond })}`)

      // ② 实验 A：看差异之后人工改盘（mtime 自然变化）→ 点旧退回 → 必须被拦
      const humanA = fixed.replace('return a + b', 'return a + 1 // human-A')
      writeFileSync(sumPath, humanA, 'utf8')
      await clickRevertHunk(h.page)
      await expect(h.page.locator('.df-wrap .notice-err')).toContainText('文件在查看差异之后被修改过', {
        timeout: 15_000
      })
      expect(readFileSync(sumPath, 'utf8'), '被拦后磁盘应保持人工内容').toBe(humanA)
      console.log(`WF3B_MTIME_CHANGED=${JSON.stringify({ blocked: true })}`)

      // ③ 实验 B：同 mtime 不同字节（改内容后把 mtime 精确回拨到打开差异时的值——整秒值可精确复现）
      const humanB = fixed.replace('return a + b', 'return a + 2 // human-B')
      writeFileSync(sumPath, humanB, 'utf8')
      utimesSync(sumPath, new Date(mtime0), new Date(mtime0))
      const mtimeB = statSync(sumPath).mtimeMs
      console.log(`WF3B_SAME_MTIME_PREP=${JSON.stringify({ mtime0, mtimeB, exact: mtimeB === mtime0 })}`)
      await clickRevertHunk(h.page)
      // 期望：同样被拦（mtime 相同不等于内容未变）。若这里放行，即为「依据陈旧差异覆盖未知新内容」实证缺陷。
      await expect(h.page.locator('.df-wrap .notice-err')).toBeVisible({ timeout: 15_000 })
      const contentAfterB = readFileSync(sumPath, 'utf8')
      console.log(
        `WF3B_SAME_MTIME=${JSON.stringify({ exactMtime: mtimeB === mtime0, keptHuman: contentAfterB === humanB })}`
      )
      expect(mtimeB, '本实验要求 mtime 精确相等（否则拦的是 mtime 变化，实验无效）').toBe(mtime0)
      expect(contentAfterB, '同 mtime 不同字节：不得依据陈旧差异覆盖（人工内容须保留）').toBe(humanB)

      // ④ 实验 C：在最新内容上重开差异 → 退回成功，恢复缺陷版（核字节）
      const humanC = fixed.replace('return a + b', 'return a + 3 // human-C')
      writeFileSync(sumPath, humanC, 'utf8')
      await h.page.locator('.df-wrap .ck-btn', { hasText: '收起' }).click()
      await openLatestDiff(h.page, 'sum.cjs')
      await clickRevertHunk(h.page)
      await expect(h.page.locator('.df-wrap .notice-ok')).toContainText('已退回第 1 处', { timeout: 15_000 })
      expect(readFileSync(sumPath, 'utf8'), '在最新内容上退回应恢复缺陷版').toBe(defect)
      console.log(`WF3B_REVERT_OK=${JSON.stringify({ restored: true })}`)
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('整轮回滚链：先备份当前内容再恢复原版；对自己的备份轮回滚可复原修复版', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const sumPath = join(h.workspaceDir, 'sum.cjs')

    try {
      await requireKeyring(h, 'WF3C')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)
      const defect = readFileSync(sumPath, 'utf8')
      const fixed = defect.replace('return a - b', 'return a + b')
      wireFixSum(fake, sumPath)

      await runFixSumOnce(h)
      expect(readFileSync(sumPath, 'utf8')).toBe(fixed)
      await ensureChangesPanel(h.page)
      await waitChangeRun(h.page, 'sum.cjs')

      // ① 整轮回滚 → 恢复缺陷版；面板出现「已回滚」徽章 + 新的「回滚前的自动备份」轮
      const runsBefore = await apiCall<Array<{ runId: string; fileCount: number }>>(h.page, 'listCheckpoints')
      await rollbackLatestRun(h.page)
      await expect(h.page.locator('.ck-panel > .notice-ok')).toContainText('已回滚：还原 1 个', { timeout: 20_000 })
      expect(readFileSync(sumPath, 'utf8'), '回滚后应恢复原版（缺陷版）').toBe(defect)
      // 「已回滚」徽章在被回滚的那一轮上（它现在排在"回滚前自动备份"新轮之后，不能只看 first）
      await expect(h.page.locator('.ck-badge-done').first()).toContainText('已回滚', { timeout: 15_000 })
      // 新的自动备份轮（回滚前快照）
      await waitChangeRun(h.page, 'sum.cjs')
      const runsAfter = await apiCall<Array<{ runId: string; fileCount: number }>>(h.page, 'listCheckpoints')
      expect(runsAfter.length, '回滚后应多出一轮"回滚前的自动备份"').toBeGreaterThan(runsBefore.length)
      console.log(`WF3C_ROLLBACK=${JSON.stringify({ before: runsBefore.length, after: runsAfter.length })}`)

      // ② 对"回滚前自动备份"轮再回滚 → 恢复修复版（退错了还能再退回来）
      await rollbackLatestRun(h.page)
      await expect(h.page.locator('.ck-panel > .notice-ok')).toContainText('已回滚：还原 1 个', { timeout: 20_000 })
      expect(readFileSync(sumPath, 'utf8'), '对备份轮回滚应恢复修复版').toBe(fixed)
      console.log(`WF3C_RESTORE=${JSON.stringify({ final: sha256(sumPath) })}`)
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })

  test('部分回滚：一个目标备份缺失 → 准确报告、不标已回滚、未失败目标保持现状', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const sumPath = join(h.workspaceDir, 'sum.cjs')
    const readmePath = join(h.workspaceDir, 'README.md')
    // 一次改两个文件：sum.cjs 与 README.md（read → write → read README → write README → 总结）
    fake.respond = (_n, body, res) => {
      if (!body.includes('"tools"')) return res.end(textReply('会话标题：双文件'))
      const execPhase = body.includes('请按上述方案执行')
      const t = lastTool(body)
      if (!execPhase) {
        return res.end(textReply('方案：1）读取并修复 sum.cjs；2）读取并更新 README.md。文件：sum.cjs、README.md。'))
      }
      if (t.text.includes('function sum'))
        return res.end(
          toolReply('write_file', { path: 'sum.cjs', content: sumFixedTextOf(readFileSync(sumPath, 'utf8')) }, 'd2')
        )
      if (t.name === 'write_file' && t.text.includes('sum.cjs'))
        return res.end(toolReply('read_file', { path: 'README.md' }, 'd3'))
      if (t.text.includes('# sum 小项目'))
        return res.end(
          toolReply('write_file', { path: 'README.md', content: readmeFixedTextOf(readFileSync(readmePath, 'utf8')) }, 'd4')
        )
      if (t.name === 'write_file') return res.end(textReply('两个文件都已处理：sum 修复、README 补充用法。'))
      return res.end(toolReply('read_file', { path: 'sum.cjs' }, 'd1'))
    }

    try {
      await requireKeyring(h, 'WF3D')
      seedFixture(h.workspaceDir)
      await useFakeModel(h.page, fake)
      const sumPath = join(h.workspaceDir, 'sum.cjs')
      const readmePath = join(h.workspaceDir, 'README.md')
      const defect = readFileSync(sumPath, 'utf8')
      const fixed = defect.replace('return a - b', 'return a + b')
      const readmeSeeded = readFileSync(readmePath, 'utf8')

      await runFixSumOnce(h)
      expect(readFileSync(sumPath, 'utf8')).toBe(fixed)
      expect(readFileSync(readmePath, 'utf8')).toContain('两数之和')

      // ① 破坏一个备份：从 run1 的 manifest 找到 README 的备份文件并删除（模拟备份缺失/被清理）
      const runs = await apiCall<Array<{ runId: string }>>(h.page, 'listCheckpoints')
      const runId = runs[0]!.runId
      const cpDir = join(h.dataDir, 'checkpoints', runId)
      const manifest = JSON.parse(readFileSync(join(cpDir, 'manifest.json'), 'utf8')) as {
        changes: Array<{ rel: string; backup: string | null }>
      }
      const readmeChange = manifest.changes.find((c) => c.rel === 'README.md')!
      const backupAbs = join(cpDir, 'files', readmeChange.backup!)
      require('node:fs').unlinkSync(backupAbs)
      console.log(`WF3D_INJECT=${JSON.stringify({ runId, removed: readmeChange.backup })}`)

      // ② 整轮回滚 → 部分成功：准确报告、不显示「已回滚」、README 保持当前内容
      await ensureChangesPanel(h.page)
      await waitChangeRun(h.page, 'sum.cjs')
      const readmeBefore = readFileSync(readmePath, 'utf8')
      await rollbackLatestRun(h.page)
      await expect(h.page.locator('.ck-panel > .notice-err')).toContainText('失败 1 个', { timeout: 20_000 })
      expect(readFileSync(sumPath, 'utf8'), '备份完好的目标应恢复原版').toBe(defect)
      expect(readFileSync(readmePath, 'utf8'), '备份缺失的目标不得被动').toBe(readmeBefore)
      // 失败 → 不标 rolledBackAt → 不出现「已回滚」徽章
      await expect(h.page.locator('.ck-run').first().locator('.ck-badge-done')).toHaveCount(0)
      expect(readmeBefore, 'README 应仍是修复版（未被回滚）').toContain('两数之和')
      expect(readmeSeeded.length, '夹具基线仍可读（对照）').toBeGreaterThan(0)
      console.log(`WF3D_PARTIAL=${JSON.stringify({ sumRestored: true, readmeKept: true })}`)
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })
})
