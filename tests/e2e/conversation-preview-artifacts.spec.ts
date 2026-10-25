import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, apiCall } from './helpers'
function tool(name: string, args: unknown, id: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`
}
function text(body: string): string { return `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n\n` }

test('真实工具写入与edit成功才出卡；当前版本刷新，工作区切换与重启不串根', async () => {
  const first = await launchApp()
  let current: Awaited<ReturnType<typeof launchApp>> | null = first
  let server: Server | null = null
  const otherRoot = mkdtempSync(join(tmpdir(), 'jsl-artifact-other-root-'))
  try {
    const enc = await first.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    const reason = '真实生产Provider的本地替身配置需要safeStorage；不代表预览和协议用例可跳过'
    if (!enc) console.log(`ARTIFACT_MODEL_SKIP=${JSON.stringify({ encryptionAvailable: enc, reason })}`)
    test.skip(!enc, reason)
    server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const parsed = JSON.parse(body) as { tools?: unknown; messages?: { role: string; tool_call_id?: string }[] }
        if (!parsed.tools) return res.end(text('fixture-title'))
        const previous = parsed.messages?.filter(m => m.role === 'tool').at(-1)?.tool_call_id
        if (!previous) return res.end(tool('write_file', { path: 'made.txt', content: 'MADE_BEFORE_EDIT' }, 'made'))
        if (previous === 'made') return res.end(tool('edit', { path: 'made.txt', edits: [{ oldText: 'MADE_BEFORE_EDIT', newText: 'MADE_AFTER_EDIT' }] }, 'edited'))
        if (previous === 'edited') return res.end(tool('edit', { path: 'absent.txt', edits: [{ oldText: 'x', newText: 'y' }] }, 'missing'))
        if (previous === 'missing') return res.end(tool('write_file', { path: '../rejected.txt', content: 'NO_SIDE_EFFECT' }, 'rejected'))
        res.end(text('ARTIFACT_RUN_FINISHED'))
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const profile = await apiCall<{ id: string }>(first.page, 'saveModel', {
      name: 'artifact-local-only', providerType: 'openai-compatible',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, stream: true, timeoutMs: 15000,
      models: [{ id: 'fixture-entry', model: 'artifact-fixture' }], apiKey: 'FAKE_LOCAL_KEY'
    })
    await apiCall(first.page, 'setActiveModel', profile.id)
    await apiCall(first.page, 'setPermission', 'write')
    await first.page.reload()
    await first.page.locator('textarea.console-input').first().fill('Create and edit the fixture file')
    await first.page.locator('textarea.console-input').first().press('Enter')
    await expect(first.page.locator('.msg-assistant')).toContainText('ARTIFACT_RUN_FINISHED', { timeout: 20000 })
    expect(readFileSync(join(first.workspaceDir, 'made.txt'), 'utf8')).toBe('MADE_AFTER_EDIT')
    const cards = first.page.locator('.tool-artifacts .fp-card')
    await expect(cards).toHaveCount(2)
    await expect(first.page.locator('.tool-start .fp-card')).toHaveCount(0)
    const card = cards.first()
    await card.locator('.fp-card-head').click()
    await expect(card.locator('.fp-card-text')).toContainText('MADE_AFTER_EDIT')
    await expect(card.locator('.fp-card-meta')).toContainText('15 B')
    writeFileSync(join(first.workspaceDir, 'made.txt'), 'CURRENT_VERSION_SENTINEL')
    writeFileSync(join(otherRoot, 'made.txt'), 'WRONG_ROOT_SENTINEL')
    await apiCall(first.page, 'setKnownWorkspace', otherRoot)
    await card.getByRole('button', { name: '刷新当前文件' }).click()
    await expect(card.locator('.fp-card-text')).toContainText('CURRENT_VERSION_SENTINEL')
    await expect(card.locator('.fp-card-text')).not.toContainText('WRONG_ROOT_SENTINEL')
    await expect(card.locator('.fp-version-note')).toContainText('内容已更新')
    await first.close(); current = null
    current = await launchApp({ reuseDataDir: first.dataDir })
    await current.page.locator('.conv-item').first().click()
    const restored = current.page.locator('.tool-artifacts .fp-card')
    await expect(restored).toHaveCount(2)
    await restored.first().locator('.fp-card-head').click()
    await expect(restored.first().locator('.fp-card-text')).toContainText('CURRENT_VERSION_SENTINEL')
  } finally {
    if (current) await current.close()
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    await first.cleanup(); rmSync(otherRoot, { recursive: true, force: true })
  }
})
