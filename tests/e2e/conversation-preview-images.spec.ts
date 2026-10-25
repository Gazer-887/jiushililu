import { test, expect } from '@playwright/test'
import { writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, apiCall } from './helpers'
import type { Attachment, Conversation } from '../../src/shared/ipc'
import { imageFixtures } from '../fixtures/conversation-preview/image-fixtures'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')

test('剪贴板图片粘贴共用宿主摄取，缩略图解码；伪图片拒绝且不落盘', async () => {
  const h = await launchApp()
  try {
    const fixture = imageFixtures[0]
    const transfer = await h.page.evaluateHandle(base64 => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' })); return dt
    }, fixture.base64)
    expect(await transfer.evaluate(dt => dt.files.length)).toBe(1)
    const pasted = await h.page.locator('textarea.console-input').evaluate((node, dt) => {
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      const files = event.clipboardData?.files.length ?? 0
      node.dispatchEvent(event)
      return { files, prevented: event.defaultPrevented }
    }, transfer)
    expect(pasted.files).toBe(1)
    expect(pasted.prevented).toBe(true)
    const image = h.page.locator('.console .fp-card-image')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(3)
    const count = readdirSync(join(h.dataDir, 'attachments')).length
    await expect(apiCall(h.page, 'attachPath', { kind: 'clipboard-image', bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow()
    expect(readdirSync(join(h.dataDir, 'attachments'))).toHaveLength(count)
    console.log('CLIPBOARD_PREVIEW_EVIDENCE=decoded-pixels,host-rejected-invalid,one-asset')
  } finally { await h.close(); await h.cleanup() }
})

test('真实输入缩略图与同窗浮层，发送后只持一份媒体字节', async () => {
  const h = await launchApp()
  let current: Awaited<ReturnType<typeof launchApp>> | null = h
  try {
    writeFileSync(join(h.workspaceDir, 'pixel.png'), png)
    const transfer = await h.page.evaluateHandle(() => {
      const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', 'pixel.png'); return dt
    })
    await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
    const thumb = h.page.locator('.console .fp-card-image')
    await expect(thumb).toBeVisible({ timeout: 7000 })
    await expect.poll(() => thumb.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1)
    const enlarge = h.page.getByRole('button', { name: '放大查看pixel.png' })
    await enlarge.click()
    await expect(h.page.getByRole('dialog', { name: 'pixel.png图片预览' })).toBeVisible()
    await h.page.keyboard.press('Escape')
    await expect(h.page.getByRole('dialog')).toHaveCount(0)
    await expect(enlarge).toBeFocused()
    // 通过真实选择/存盘/Gateway链验证parts与本地引用共用同一个已落盘媒体。
    const attachment = await apiCall<Attachment>(h.page, 'attachPath', 'pixel.png')
    expect(attachment.preview?.assetId).toBe(attachment.image?.ref)
    const c = await apiCall<Conversation>(h.page, 'createConversation', {
      workspace: h.workspaceDir, model: 'no-request', firstMessage: 'owned-picture',
      firstParts: [{ type: 'text', text: 'owned-picture' }, attachment.image],
      firstLocalFiles: [{ ...attachment.preview, name: attachment.name, bytes: attachment.bytes, source: 'draft' }]
    })
    const image = c.messages[0].parts?.find(part => part.type === 'image')
    expect(image && image.type === 'image' ? image.ref : null).toBe(c.messages[0].localFiles?.[0].assetId)
    // 两次明确导入各有一份；本地预览没有再向assets复制任何一份。
    expect(readdirSync(join(h.dataDir, 'attachments'))).toHaveLength(2)
    expect(existsSync(join(h.dataDir, 'assets')) ? readdirSync(join(h.dataDir, 'assets')).length : 0).toBe(0)
    writeFileSync(join(h.workspaceDir, 'pixel.png'), 'SOURCE_NO_LONGER_AN_IMAGE')
    await h.close(); current = null
    current = await launchApp({ reuseDataDir: h.dataDir })
    await current.page.locator('.conv-item').first().click()
    const historyImage = current.page.locator('.msg-local-files .fp-card-image')
    await expect(historyImage).toBeVisible()
    await expect.poll(() => historyImage.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1)
    await current.page.getByRole('button', { name: '放大查看pixel.png' }).click()
    await expect(current.page.getByRole('dialog', { name: 'pixel.png图片预览' })).toBeVisible()
    await current.page.keyboard.press('Escape')
    expect(readdirSync(join(h.dataDir, 'attachments'))).toHaveLength(2)
  } finally { if (current) await current.close(); await h.cleanup() }
})


test('PNG/JPEG/GIF/WebP宿主摄取后真实缩略图解码矩阵', async () => {
  const h = await launchApp()
  try {
    for (const fixture of imageFixtures) {
      writeFileSync(join(h.workspaceDir, fixture.name), Buffer.from(fixture.base64, 'base64'))
      const transfer = await h.page.evaluateHandle(name => {
        const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', name); return dt
      }, fixture.name)
      await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
      const card = h.page.locator('.console .fp-card').filter({ hasText: fixture.name })
      const image = card.locator('.fp-card-image')
      await expect(image).toBeVisible()
      await expect.poll(() => image.evaluate(node => ({ width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight }))).toEqual({ width: fixture.width, height: fixture.height })
      expect((await image.boundingBox())!.width).toBeGreaterThan(0)
      console.log(`IMAGE_DECODE=${JSON.stringify({ name: fixture.name, width: fixture.width, height: fixture.height })}`)
    }
  } finally { await h.close(); await h.cleanup() }
})
