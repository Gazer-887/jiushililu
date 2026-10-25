// 用真实磁盘路径冲突制造保存失败，不把onSubmit替换成假的成功/失败函数。
import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, apiCall } from './helpers'
test('真实会话保存失败保留原输入和草稿，修复磁盘前提后同一附件可重试', async () => {
  const h = await launchApp()
  const server = createServer((_req, res) => {
    _req.resume(); _req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'RETRY_ACCEPTED_SENTINEL' } }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  const meta = join(h.dataDir, 'conversations.json')
  const backup = join(h.dataDir, 'owned-meta-before-failure.json')
  let injected = false
  try {
    const enc = await h.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    const reason = '本地假模型档案需要safeStorage；仅跳发送故事，不跳资产/协议'
    if (!enc) console.log(`SEND_FAILURE_SKIP=${JSON.stringify({ encryptionAvailable: enc, reason })}`)
    test.skip(!enc, reason)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const profile = await apiCall<{ id: string }>(h.page, 'saveModel', {
      name: 'retry-local-only', providerType: 'openai-compatible', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      models: [{ id: 'retry-entry', model: 'retry-fixture' }], apiKey: 'FAKE_LOCAL_KEY', stream: true, timeoutMs: 10000
    })
    await apiCall(h.page, 'setActiveModel', profile.id)
    await h.page.reload()
    writeFileSync(join(h.workspaceDir, 'keep.txt'), 'DRAFT_BYTES_SENTINEL')
    const transfer = await h.page.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', 'keep.txt'); return dt })
    await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
    await expect(h.page.locator('.console .fp-card')).toHaveCount(1)
    await h.page.locator('textarea.console-input').first().fill('KEEP_USER_INPUT_SENTINEL')
    if (existsSync(meta)) renameSync(meta, backup)
    mkdirSync(meta); injected = true
    await h.page.locator('.send-btn').click()
    await expect(h.page.locator('.console .fp-card')).toHaveCount(1)
    await expect(h.page.locator('textarea.console-input').first()).toHaveValue('KEEP_USER_INPUT_SENTINEL')
    await expect(h.page.locator('.console-error')).toBeVisible()
    rmdirSync(meta); injected = false
    if (existsSync(backup)) renameSync(backup, meta)
    await h.page.locator('.send-btn').click()
    await expect(h.page.locator('.msg-assistant')).toContainText('RETRY_ACCEPTED_SENTINEL', { timeout: 15000 })
    const card = h.page.locator('.msg-local-files .fp-card')
    await expect(card).toHaveCount(1)
    await card.locator('.fp-card-head').click()
    await expect(card.locator('.fp-card-text')).toContainText('DRAFT_BYTES_SENTINEL')
  } finally {
    if (injected) { rmdirSync(meta); if (existsSync(backup)) renameSync(backup, meta) }
    await h.close(); await h.cleanup(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
