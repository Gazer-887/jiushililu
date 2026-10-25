// 首批安全读写 · R6 真 Electron 故事
// 闭环：读不了不许写 → 合法读后按同一版本写 → 留检查点 → 安全回滚；界面侧：冲突保草稿、明确覆盖才写。
// 走真入口（electron . 进 out/main/index.js）；只有模型是本地 127.0.0.1 假 SSE；判定落在磁盘字节。
// 前置：npm run build。判据与证据说明见交还 03/04。

import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiCall, launchApp, type E2EApp } from './helpers'

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

// —— 假模型端点（OpenAI 兼容 SSE，照 workflow.spec.ts 的口径）——

type Frame = Record<string, unknown>
const sseOf = (frames: Frame[]): string => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
const textReply = (text: string): string =>
  sseOf([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } }
  ])
const toolReply = (name: string, args: Record<string, unknown>, callId: string): string =>
  sseOf([
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

/** 最后一条 tool 消息（`{name, text}`）：编排判据只看"本轮此刻的最新事实" */
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
    /* 非 JSON / 结构异常 → 视作无工具消息 */
  }
  return { name: '', text: '' }
}

class FakeModel {
  hits = 0
  bodies: string[] = []
  port = 0
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
}

// —— UI 助手（与 workflow.spec.ts 同一套选择器）——

async function useFakeModel(page: Page, fake: FakeModel): Promise<void> {
  const saved = await apiCall<{ id?: string }>(page, 'saveModel', {
    name: 'e2e 安全读写假端点',
    providerType: 'openai-compatible',
    baseURL: `http://127.0.0.1:${fake.port}/v1`,
    stream: true,
    timeoutMs: 30000,
    models: [{ id: 'usw-entry', model: 'usw-model' }],
    apiKey: 'e2e-fake-key-never-real'
  })
  await apiCall(page, 'setActiveModel', saved.id)
}

/** safeStorage 守卫：不可用带原因 skip（照 smoke.spec.ts 范式，日志里留原因） */
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
  await expect(page.locator('.send-btn.stopping')).toHaveCount(0, { timeout: 90_000 })
}

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

async function rollbackLatestRun(page: Page): Promise<void> {
  const run = page.locator('.ck-run').first()
  await run.locator('.ck-run-tail button', { hasText: '整轮回滚' }).click()
  await run.locator('.ck-run-tail button', { hasText: '确认回滚' }).click()
}

// ─────────────────── 故事一：读不了就不许写 → 合法修改 → 安全回滚 ───────────────────

test.describe('首批安全读写 · Agent 线', () => {
  test('拒读后写被拒且原字节不变；合法修改落盘、留检查点、整轮回滚可复原', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const fake = new FakeModel()
    await fake.start()
    const binPath = join(h.workspaceDir, 'bin.dat')
    const guardPath = join(h.workspaceDir, 'guard.txt')

    // 编排：读二进制（被拒）→ 直接写（应被拒）→ 读文本（接受）→ 写（成功）→ 总结
    fake.respond = (_n, body, res) => {
      if (!body.includes('"tools"')) return res.end(textReply('会话标题：安全读写'))
      const t = lastTool(body)
      if (t.name === '') return res.end(toolReply('read_file', { path: 'bin.dat' }, 's1'))
      if (t.text.includes('二进制')) return res.end(toolReply('write_file', { path: 'bin.dat', content: 'OVERWRITE_ATTEMPT' }, 's2'))
      if (t.text.includes('请先用 read_file'))
        return res.end(toolReply('read_file', { path: 'guard.txt' }, 's3'))
      if (t.text.includes('GUARD_BASE')) return res.end(toolReply('write_file', { path: 'guard.txt', content: 'GUARD_FIXED\n' }, 's4'))
      if (t.text.includes('已写入')) return res.end(textReply('已完成：被拒的写入没有发生，合法修改已落盘。'))
      return res.end(textReply('（未编排）'))
    }

    try {
      await requireKeyring(h, 'USW1')
      writeFileSync(binPath, Buffer.from([0x41, 0x00, 0x42, 0x43]))
      writeFileSync(guardPath, 'GUARD_BASE\n', 'utf8')
      const binBase = sha(binPath)
      const guardBase = sha(guardPath)

      await useFakeModel(h.page, fake)
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      await sendText(h.page, '先读 bin.dat，再把它整体改写；然后把 guard.txt 改成 GUARD_FIXED。')
      await waitIdle(h.page)
      await expect(h.page.locator('.msg-assistant').last()).toContainText('已完成', { timeout: 30_000 })

      // ① 模型真实收到过"写被拒"的结论（不是界面扮演的）
      const rejected = fake.bodies.map((b) => lastTool(b).text).filter((x) => x.includes('请先用 read_file'))
      expect(rejected.length, '模型必须真实收到写入被拒的工具结果').toBeGreaterThan(0)
      // ② 被拒的写入一个字节都没落
      expect(sha(binPath), '拒读后的写入不得改动原字节').toBe(binBase)
      // ③ 合法读取后的修改真实落盘
      expect(readFileSync(guardPath, 'utf8')).toBe('GUARD_FIXED\n')
      expect(sha(guardPath)).not.toBe(guardBase)

      // ④ 检查点里只有 guard.txt 这一条（被拒的 bin.dat 不该混进回滚记录）
      await ensureChangesPanel(h.page)
      await waitChangeRun(h.page, 'guard.txt')
      expect(await h.page.locator('.ck-file-rel', { hasText: 'bin.dat' }).count(), '被拒的目标不得出现在回滚记录里').toBe(0)

      // ⑤ 真回滚：guard.txt 复原、bin.dat 始终不动
      await rollbackLatestRun(h.page)
      await expect(h.page.locator('.ck-panel > .notice-ok')).toContainText('已回滚：还原 1 个', { timeout: 20_000 })
      expect(readFileSync(guardPath, 'utf8'), '回滚后应恢复原内容').toBe('GUARD_BASE\n')
      expect(sha(binPath), '回滚不该碰被拒的目标').toBe(binBase)
      console.log(
        `USW1_EVIDENCE=${JSON.stringify({
          hits: fake.hits,
          binBase,
          rejectedWrites: rejected.length,
          guardRestored: sha(guardPath)
        })}`
      )
    } finally {
      await fake.stop()
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })
})

// ─────────────── 故事二：FilePreviewPane 保存撞上外部修改 → 保草稿 → 明确覆盖 ───────────────

test.describe('首批安全读写 · 界面线', () => {
  test('保存冲突不静默覆盖、草稿保留；用户点「覆盖」才写盘', async () => {
    test.slow()
    const h: E2EApp = await launchApp()
    const file = join(h.workspaceDir, 'conflict.txt')
    const HUMAN = 'HUMAN_VERSION\n'

    try {
      writeFileSync(file, 'ORIGINAL_DRAFT\n', 'utf8')

      // ① 工作台开资源管理器 → 点开文件 → 真 FilePreviewPane
      await h.page.waitForSelector('.new-task, .chat-view', { timeout: 45_000 })
      const toggle = h.page.locator('[title="展开工作台"], [title="收起工作台"]').first()
      await toggle.click()
      await h.page.waitForSelector('.dock', { timeout: 15_000 })
      if ((await h.page.locator('.wb-empty').count()) > 0) {
        await h.page.locator('.wb-empty .wb-pick', { hasText: '资源管理器' }).click()
      } else {
        await h.page.locator('.pane-add').first().click()
        await h.page.locator('.pane-menu .wb-pick', { hasText: '资源管理器' }).click()
      }
      const row = h.page.locator('.ex-row', { hasText: 'conflict.txt' }).first()
      await row.waitFor({ timeout: 20_000 })
      await row.click()
      await h.page.waitForSelector('.fp', { timeout: 20_000 })

      // ② 切到编辑并真打字（Monaco：Ctrl+A 全选后覆盖输入）
      await h.page.locator('.fp-mode').click()
      await h.page.waitForSelector('.monaco-editor', { timeout: 20_000 })
      const input = h.page.locator('.fp .monaco-editor .native-edit-context, .fp .monaco-editor textarea.inputarea').first()
      await input.waitFor({ state: 'attached', timeout: 20_000 })
      await input.focus()
      await expect(input, '键盘输入前必须取得 Monaco 输入面焦点').toBeFocused()
      await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await h.page.keyboard.type('EDITED_BY_UI')
      await expect(h.page.locator('.fp-dirty'), '打字后应显示未保存').toBeVisible({ timeout: 10_000 })

      // ③ 打开之后被外部改掉（真实外部编辑：本进程直接写盘）
      writeFileSync(file, HUMAN, 'utf8')

      // ④ 普通保存 → 冲突可见、不覆盖、草稿仍在
      await h.page.locator('.fp-edit-bar .fp-btn', { hasText: '保存' }).click()
      await expect(h.page.locator('.fp-warn')).toContainText('文件在打开之后已被修改', { timeout: 15_000 })
      expect(readFileSync(file, 'utf8'), '冲突时磁盘人工内容必须原样保留').toBe(HUMAN)
      await expect(h.page.locator('.fp-dirty'), '冲突后草稿不得丢').toBeVisible()

      // ⑤ 用户明确点「覆盖」→ 这时才写盘，且写的是草稿
      const overwrite = h.page.locator('.fp-edit-bar .fp-btn', { hasText: '覆盖' })
      await overwrite.click()
      await expect(h.page.locator('.fp-msg')).toContainText('已保存', { timeout: 15_000 })
      expect(readFileSync(file, 'utf8'), '明确覆盖后才写草稿').toContain('EDITED_BY_UI')
      console.log(`USW2_EVIDENCE=${JSON.stringify({ humanKept: true, final: sha(file) })}`)
    } finally {
      await h.close().catch(() => {})
      await h.cleanup().catch(() => {})
    }
  })
})
