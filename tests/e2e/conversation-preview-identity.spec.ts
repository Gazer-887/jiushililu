// 身份与重启垂直切片：真应用/真实存盘/真实输入组件；模型仅替换为本地确定性端点。
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, apiCall, type E2EApp } from './helpers'
import type { Attachment, Conversation } from '../../src/shared/ipc'
import type { PreviewOpenOutput } from '../../src/shared/preview-ipc-types'
import { imageFixtures } from '../fixtures/conversation-preview/image-fixtures'

test('真实资产：合法草稿/消息放行，错草稿/另一合法消息拒绝；不需要密钥', async () => {
  const h = await launchApp()
  const file = join(h.workspaceDir, 'identity.txt')
  writeFileSync(file, 'IDENTITY_BYTES_SENTINEL')
  try {
    const attachment = await apiCall<Attachment>(h.page, 'attachPath', 'identity.txt')
    expect(attachment.preview?.draftId).toBeTruthy()
    const request = { source: 'draft', ...attachment.preview, name: attachment.name, bytes: attachment.bytes }
    const draft = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', request)
    expect(draft.boundedText).toBe('IDENTITY_BYTES_SENTINEL')
    const claimedPdf = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', {
      ...request, conversationId: 'fake-conversation', messageId: 'fake-message', mime: 'application/pdf'
    })
    expect(claimedPdf.capabilities?.pdf).toBeFalsy()
    expect(claimedPdf.boundedText).toBe('IDENTITY_BYTES_SENTINEL')
    const wrong = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', { ...request, draftId: 'not-host-minted' })
    expect(wrong.errorCode).toBe('forbidden')
    const ref = { ...attachment.preview!, name: attachment.name!, bytes: attachment.bytes, source: 'draft' }
    const conv = await apiCall<Conversation>(h.page, 'createConversation', {
      workspace: h.workspaceDir, model: 'no-request', firstMessage: 'owned', firstLocalFiles: [ref]
    })
    const saved = conv.messages[0].localFiles![0]
    expect(saved.source).toBe('history')
    expect(saved.draftId).toBeUndefined()
    const other = await apiCall<Conversation>(h.page, 'createConversation', {
      workspace: h.workspaceDir, model: 'no-request', firstMessage: 'other'
    })
    const foreign = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', {
      ...saved, conversationId: other.id, messageId: other.messages[0].messageId
    })
    expect(foreign.errorCode).toBe('forbidden')
    const own = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', {
      ...saved, conversationId: conv.id, messageId: conv.messages[0].messageId, mime: 'text/html'
    })
    expect(own.boundedText).toBe('IDENTITY_BYTES_SENTINEL')
    expect(own.capabilities?.html).toBeFalsy()
    await apiCall(h.page, 'previewRelease', draft.handleId)
    await apiCall(h.page, 'previewRelease', claimedPdf.handleId)
    await apiCall(h.page, 'previewRelease', own.handleId)
  } finally { await h.close(); await h.cleanup() }
})

test('真实输入区发送并重启：历史身份与旧字节可见，最终HTTP不含草稿能力', async () => {
  const first = await launchApp()
  let current: E2EApp | null = first
  const outside = mkdtempSync(join(tmpdir(), 'jsl-preview-outside-'))
  const source = join(outside, 'snapshot.txt')
  writeFileSync(source, 'SNAPSHOT_BEFORE_SENTINEL')
  const bodies: string[] = []
  let server: Server | null = null
  try {
    const encryptionAvailable = await first.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    const reason = '模型替身配置需要safeStorage；本用例只跳模型发送，上一身份故事不跳过'
    if (!encryptionAvailable) console.log(`PREVIEW_SEND_SKIP=${JSON.stringify({ encryptionAvailable, reason })}`)
    test.skip(!encryptionAvailable, reason)
    server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        bodies.push(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'LOCAL_IDENTITY_REPLY' }, finish_reason: 'stop' }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 3 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const profile = await apiCall<{ id: string }>(first.page, 'saveModel', {
      name: 'identity-local-fixture', providerType: 'openai-compatible',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      stream: true, timeoutMs: 10000, models: [{ id: 'local', model: 'local-fixture', settings: { inputModalities: ['text', 'image'] } }], apiKey: 'FAKE_LOCAL_KEY'
    })
    await apiCall(first.page, 'setActiveModel', profile.id)
    const dt = await first.page.evaluateHandle(path => {
      const transfer = new DataTransfer()
      transfer.setData('application/x-jiushililu-path', path)
      return transfer
    }, source)
    await first.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: dt })
    await first.page.locator('.console .fp-card-head').click()
    await expect(first.page.locator('.console .fp-card-text')).toContainText('SNAPSHOT_BEFORE_SENTINEL')
    await first.page.locator('textarea').first().fill('USER_BODY_SENTINEL')
    await first.page.locator('textarea').first().press('Enter')
    await expect(first.page.locator('.chat-view')).toContainText('LOCAL_IDENTITY_REPLY')
    const list = await apiCall<Array<{ id: string }>>(first.page, 'listConversations')
    const conv = await apiCall<Conversation>(first.page, 'getConversation', list[0].id)
    const message = conv.messages.find(m => m.localFiles?.length)!
    const asset = message.localFiles![0]
    expect(asset.source).toBe('history')
    expect(asset.draftId).toBeUndefined()
    expect(readFileSync(join(first.dataDir, 'assets', asset.assetId), 'utf8')).toBe('SNAPSHOT_BEFORE_SENTINEL')
    // 继续在真实已有会话里追加另一份附件，验证convSave而不只验证convCreate。
    await expect(first.page.locator('.send-btn.stopping')).toHaveCount(0)
    const secondSource = join(outside, 'second-snapshot.txt')
    writeFileSync(secondSource, 'SECOND_SNAPSHOT_SENTINEL')
    const secondDrop = await first.page.evaluateHandle(path => {
      const transfer = new DataTransfer()
      transfer.setData('application/x-jiushililu-path', path)
      return transfer
    }, secondSource)
    await first.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: secondDrop })
    await first.page.locator('.console .fp-card-head').click()
    await expect(first.page.locator('.console .fp-card-text')).toContainText('SECOND_SNAPSHOT_SENTINEL')
    const picture = imageFixtures[0]
    writeFileSync(join(first.workspaceDir, picture.name), Buffer.from(picture.base64, 'base64'))
    const imageDrop = await first.page.evaluateHandle(name => {
      const transfer = new DataTransfer(); transfer.setData('application/x-jiushililu-path', name); return transfer
    }, picture.name)
    await first.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: imageDrop })
    await expect(first.page.locator('.console .fp-card-image')).toBeVisible()
    await first.page.locator('textarea').first().fill('SECOND_USER_BODY_SENTINEL')
    await first.page.locator('textarea').first().press('Enter')
    await expect.poll(async () => {
      const saved = await apiCall<Conversation>(first.page, 'getConversation', conv.id)
      return saved.messages.filter(m => m.localFiles?.length).length
    }).toBe(2)
    const secondConversation = await apiCall<Conversation>(first.page, 'getConversation', conv.id)
    const secondMessage = secondConversation.messages.find(m => m.content.includes('SECOND_USER_BODY_SENTINEL'))!
    expect(secondMessage.localFiles![0].source).toBe('history')
    expect(secondMessage.localFiles![0].draftId).toBeUndefined()
    const pictureRef = secondMessage.localFiles!.find(file => file.name === picture.name)!
    expect(pictureRef).toBeTruthy()
    await expect.poll(() => bodies.some(body => body.includes('SECOND_USER_BODY_SENTINEL'))).toBe(true)
    expect(bodies.some(body => body.includes('USER_BODY_SENTINEL'))).toBe(true)
    for (const body of bodies) {
      expect(body).not.toContain('localFiles')
      expect(body).not.toContain('draftId')
      expect(body).not.toContain('messageId')
      expect(body).not.toContain(asset.assetId)
      expect(body).not.toContain(secondMessage.localFiles![0].assetId)
      expect(body).not.toContain(pictureRef.assetId)
      expect(body).not.toContain(first.dataDir.replace(/\\/g, '/'))
    }
    expect(bodies.some(body => body.includes(`data:image/png;base64,${picture.base64}`))).toBe(true)
    // 真实UI回滚隐藏第二轮，撤销后附件身份/旧字节复原，不能只测存储API。
    await expect(first.page.locator('.send-btn.stopping')).toHaveCount(0)
    const secondUser = first.page.locator('.msg-user').filter({ hasText: 'SECOND_USER_BODY_SENTINEL' })
    await secondUser.click({ button: 'right' })
    await first.page.getByRole('button', { name: '回到这条之前', exact: true }).click()
    const confirm = first.page.getByRole('dialog', { name: '会话回滚确认' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '回滚对话', exact: true }).click()
    await expect(first.page.locator('.msg-local-files .fp-card-head')).toHaveCount(1)
    await first.page.locator('.rb-bar').getByRole('button', { name: '撤销', exact: true }).click()
    await expect(first.page.locator('.msg-local-files .fp-card-head')).toHaveCount(3)
    const undone = await apiCall<Conversation>(first.page, 'getConversation', conv.id)
    expect(undone.messages.find(m => m.messageId === secondMessage.messageId)?.localFiles).toEqual(secondMessage.localFiles)
    await secondUser.getByRole('button', { name: '编辑这条提问' }).click()
    await confirm.getByRole('button', { name: '回滚对话', exact: true }).click()
    await expect(first.page.locator('.chat-edit-files .fp-card')).toHaveCount(2)
    await first.page.locator('.chat-edit-files .fp-card-head').first().click()
    await expect(first.page.locator('.chat-edit-files .fp-card-text')).toContainText('SECOND_SNAPSHOT_SENTINEL')
    const editInput = first.page.locator('textarea').first()
    await editInput.fill((await editInput.inputValue()).replace('SECOND_USER_BODY_SENTINEL', 'EDITED_USER_BODY_SENTINEL'))
    await editInput.press('Enter')
    await expect.poll(async () => (await apiCall<Conversation>(first.page, 'getConversation', conv.id)).messages.some(m => m.content.includes('EDITED_USER_BODY_SENTINEL') && m.localFiles?.length === 2)).toBe(true)
    await expect(first.page.locator('.send-btn.stopping')).toHaveCount(0)
    expect(readdirSync(join(first.dataDir, 'assets')).length + readdirSync(join(first.dataDir, 'attachments')).length).toBe(3)
    writeFileSync(source, 'SOURCE_CHANGED_SENTINEL')
    writeFileSync(secondSource, 'SECOND_SOURCE_CHANGED_SENTINEL')
    await first.close()
    current = null
    current = await launchApp({ reuseDataDir: first.dataDir })
    await current.page.locator('.conv-item').first().click()
    const heads = current.page.locator('.msg-local-files .fp-card-head')
    await expect(heads).toHaveCount(3)
    await heads.nth(0).click()
    await heads.nth(1).click()
    const contents = current.page.locator('.msg-local-files .fp-card-text')
    await expect(contents.nth(0)).toContainText('SNAPSHOT_BEFORE_SENTINEL')
    await expect(contents.nth(0)).not.toContainText('SOURCE_CHANGED_SENTINEL')
    await expect(contents.nth(1)).toContainText('SECOND_SNAPSHOT_SENTINEL')
    await expect(contents.nth(1)).not.toContainText('SECOND_SOURCE_CHANGED_SENTINEL')
  } finally {
    if (current) await current.close()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    await first.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('真实IPC存档预算降级：输入快照与成功产物卡保留，正文仍显示', async () => {
  const h = await launchApp()
  try {
    writeFileSync(join(h.workspaceDir, 'budget-source.txt'), 'BUDGET_SNAPSHOT')
    writeFileSync(join(h.workspaceDir, 'budget-made.txt'), 'BUDGET_CURRENT_ARTIFACT')
    const attachment = await apiCall<Attachment>(h.page, 'attachPath', 'budget-source.txt')
    const conv = await apiCall<Conversation>(h.page, 'createConversation', {
      workspace: h.workspaceDir, model: 'no-request', firstMessage: 'BUDGET_QUESTION',
      firstLocalFiles: [{ ...attachment.preview!, name: attachment.name, bytes: attachment.bytes, source: 'draft' }]
    })
    // 只合成超预算的存档输入，不假装这是Agent真实执行证明（真实write/edit另有故事）。
    await apiCall(h.page, 'saveConversation', conv.id, [...conv.messages, {
      role: 'assistant', content: 'BUDGET_FINAL_BODY', segments: [
        ...Array.from({ length: 15 }, () => ({ kind: 'thinking', text: 'x'.repeat(150000) })),
        { kind: 'tool', event: { id: 'budget-artifact', name: 'write_file', phase: 'end', artifactPaths: ['budget-made.txt'] } },
        { kind: 'text', text: 'BUDGET_FINAL_BODY' }
      ]
    }])
    const stored = await apiCall<Conversation>(h.page, 'getConversation', conv.id)
    expect(stored.messages[0].localFiles).toEqual(conv.messages[0].localFiles)
    expect(stored.messages[1].segments).toHaveLength(1)
    expect(stored.messages[1].segments![0].kind).toBe('tool')
    await h.page.reload()
    await h.page.locator('.conv-item').first().click()
    await expect(h.page.locator('.msg-assistant .msg-content')).toContainText('BUDGET_FINAL_BODY')
    await h.page.locator('.msg-local-files .fp-card-head').click()
    await expect(h.page.locator('.msg-local-files .fp-card-text')).toContainText('BUDGET_SNAPSHOT')
    await h.page.locator('.tool-artifacts .fp-card-head').click()
    await expect(h.page.locator('.tool-artifacts .fp-card-text')).toContainText('BUDGET_CURRENT_ARTIFACT')
    console.log('BUDGET_UI_EVIDENCE=retained-snapshot,retained-artifact,visible-body')
  } finally { await h.close(); await h.cleanup() }
})

test('假文本二进制（文本扩展名+含NUL）拖入后真实HTTP用户正文不含二进制哨兵，本地卡片明确降级', async () => {
  const h = await launchApp()
  const bodies: string[] = []
  let server: Server | null = null
  try {
    const enc = await h.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    const reason = '本地假模型档案需要safeStorage；仅跳发送故事，不跳格式/协议'
    if (!enc) console.log(`FAKE_TEXT_NUL_SKIP=${JSON.stringify({ encryptionAvailable: enc, reason })}`)
    test.skip(!enc, reason)
    server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        bodies.push(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE_TEXT_NUL_REPLY' }, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const profile = await apiCall<{ id: string }>(h.page, 'saveModel', {
      name: 'fake-text-nul-local', providerType: 'openai-compatible',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      stream: true, timeoutMs: 10000,
      models: [{ id: 'local', model: 'local-fixture' }], apiKey: 'FAKE_LOCAL_KEY'
    })
    await apiCall(h.page, 'setActiveModel', profile.id)
    // 文本扩展名 + 带 NUL 的二进制内容（独特哨兵头 + NUL + 哨兵尾）—— 独立审查 N-1 反例同形
    const fakePath = join(h.workspaceDir, 'fake.log')
    writeFileSync(fakePath, Buffer.concat([
      Buffer.from('BINHEAD'),
      Buffer.alloc(4, 0),
      Buffer.from('NULFAKE_BINARY_TAIL_SENTINEL')
    ]))
    const dt = await h.page.evaluateHandle(path => {
      const transfer = new DataTransfer()
      transfer.setData('application/x-jiushililu-path', path)
      return transfer
    }, fakePath)
    await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: dt })
    await expect(h.page.locator('.console .fp-card')).toHaveCount(1)
    // 本地卡片明确降级（不假装成功读出正文），且仍受身份门保护（草稿id只在本地）
    await h.page.locator('.console .fp-card-head').click()
    await expect(h.page.locator('.console .fp-card-unsupported, .console .fp-card-degraded')).toBeVisible()
    await h.page.locator('textarea').first().fill('NORMAL_USER_TEXT_SENTINEL')
    await h.page.locator('textarea').first().press('Enter')
    await expect(h.page.locator('.chat-view')).toContainText('FAKE_TEXT_NUL_REPLY')
    await expect.poll(() => bodies.length).toBeGreaterThan(0)
    // 只在最终 HTTP 处查正文：二进制哨兵不许进，普通用户文字在
    for (const body of bodies) {
      expect(body).not.toContain('BINHEAD')
      expect(body).not.toContain('NULFAKE_BINARY_TAIL_SENTINEL')
      expect(body).not.toContain('localFiles')
      expect(body).not.toContain('draftId')
    }
    expect(bodies.some(body => body.includes('NORMAL_USER_TEXT_SENTINEL'))).toBe(true)
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    await h.close(); await h.cleanup()
  }
})
