// 真实文档呈现：不把URL、能力位或iframe存在当作正文与交互已通过。
import { test, expect } from '@playwright/test'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { launchApp, apiCall } from './helpers'
import type { Attachment } from '../../src/shared/ipc'
import type { PreviewOpenOutput } from '../../src/shared/preview-ipc-types'
import { scannedPdf, minimalDocx } from '../fixtures/conversation-preview/document-fixtures'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

async function dropFile(h: Awaited<ReturnType<typeof launchApp>>, name: string): Promise<void> {
  const transfer = await h.page.evaluateHandle(path => {
    const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', path); return dt
  }, name)
  await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
  // 第二份附件摄取是异步的，不能先点到上一张卡再把它当作新格式失败。
  const head = h.page.locator('.console .fp-card-head').filter({ hasText: name })
  await expect(head).toBeVisible()
  await head.click()
}

test('Markdown真实排版，远程图片与链接不自动联网，原HTML不会执行', async () => {
  const h = await launchApp()
  let hits = 0
  const server = createServer((_req, res) => { hits++; res.end('UNEXPECTED_REMOTE_REQUEST') })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/track`
    writeFileSync(join(h.workspaceDir, 'notes.md'), `# PREVIEW_MD_HEADING\n\n| Name | Value |\n|---|---|\n| x | y |\n\n![REMOTE_IMAGE](${remote})\n\n[External link](${remote})\n\n<script>window.MARKDOWN_SCRIPT_RAN=true</script>`)
    await dropFile(h, 'notes.md')
    const body = h.page.locator('.fp-card-markdown')
    await expect(body.getByRole('heading', { name: 'PREVIEW_MD_HEADING' })).toBeVisible()
    await expect(body.locator('table')).toBeVisible()
    await expect(body).toContainText('图片未加载：REMOTE_IMAGE')
    await expect(body.locator('img')).toHaveCount(0)
    await expect(body.locator('a')).toHaveCount(0)
    expect(await h.page.evaluate(() => (window as unknown as { MARKDOWN_SCRIPT_RAN?: boolean }).MARKDOWN_SCRIPT_RAN)).toBeUndefined()
    expect(hits).toBe(0)
  } finally { await h.close(); await h.cleanup(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('PDF是真页面：非白像素、页码、下一页、缩放、键盘导航；公共HTML仍断脚本', async () => {
  const h = await launchApp()
  try {
    copyFileSync(join(__dirname, '../fixtures/conversation-preview/sample-3page.pdf'), join(h.workspaceDir, 'pages.pdf'))
    await dropFile(h, 'pages.pdf')
    const canvas = h.page.locator('.fp-pdf-canvas')
    await expect(canvas).toBeVisible({ timeout: 7000 })
    await expect(h.page.locator('.fp-pdf-page-number')).toHaveText('1 / 3')
    const nonWhite = () => canvas.evaluate(node => {
      const canvas = node as HTMLCanvasElement
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 200 && (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240)) count++
      return count
    })
    await expect.poll(nonWhite).toBeGreaterThan(100)
    const before = await canvas.evaluate(node => (node as HTMLCanvasElement).width)
    await h.page.getByRole('button', { name: 'PDF下一页' }).click()
    await expect(h.page.locator('.fp-pdf-page-number')).toHaveText('2 / 3')
    await h.page.getByRole('button', { name: 'PDF放大' }).click()
    await expect(h.page.locator('.fp-pdf-zoom')).toHaveText('125%')
    await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBeGreaterThan(before)
    await h.page.locator('.fp-pdf-viewer').focus()
    await h.page.keyboard.press('ArrowRight')
    await expect(h.page.locator('.fp-pdf-page-number')).toHaveText('3 / 3')
    await h.page.keyboard.press('ArrowLeft')
    await expect(h.page.locator('.fp-pdf-page-number')).toHaveText('2 / 3')
    // 同一产品的静态用户HTML不因PDF宿主代码获得脚本许可。
    writeFileSync(join(h.workspaceDir, 'unsafe.html'), '<h1>STATIC_HTML_SENTINEL</h1><script>document.body.textContent="SCRIPT_RAN_SENTINEL"</script>')
    await dropFile(h, 'unsafe.html')
    const frame = h.page.frameLocator('.fp-card-html')
    await expect(frame.locator('body')).toContainText('STATIC_HTML_SENTINEL')
    await expect(frame.locator('body')).not.toHaveText('SCRIPT_RAN_SENTINEL')
  } finally { await h.close(); await h.cleanup() }
})

test('Office真实正文：xlsx不是ZIP直返，工作表能切换', async () => {
  const h = await launchApp()
  try {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['FIRST_SHEET_SENTINEL']]), '第一表')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['SECOND_SHEET_SENTINEL']]), '第二表')
    writeFileSync(join(h.workspaceDir, 'workbook.xlsx'), XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    await dropFile(h, 'workbook.xlsx')
    const frame = h.page.frameLocator('.fp-card-office')
    await expect(frame.locator('body')).toContainText('FIRST_SHEET_SENTINEL', { timeout: 7000 })
    await h.page.getByLabel('工作表').selectOption('1')
    await expect(frame.locator('body')).toContainText('SECOND_SHEET_SENTINEL')
    await expect(frame.locator('body')).not.toContainText('FIRST_SHEET_SENTINEL')
  } finally { await h.close(); await h.cleanup() }
})

test('没有文本层的扫描PDF仍有真实图像像素，损坏PDF有明确错误', async () => {
  const h = await launchApp()
  try {
    const scan = scannedPdf()
    expect(scan.toString('latin1')).toContain('/Subtype /Image')
    expect(scan.toString('latin1')).not.toContain(' Tj')
    writeFileSync(join(h.workspaceDir, 'scan.pdf'), scan)
    await dropFile(h, 'scan.pdf')
    const canvas = h.page.locator('.fp-pdf-canvas')
    await expect(canvas).toBeVisible()
    await expect.poll(() => canvas.evaluate(node => {
      const c = node as HTMLCanvasElement
      const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      let count = 0
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) count++
      return count
    })).toBeGreaterThan(10000)
    copyFileSync(join(__dirname, '../fixtures/conversation-preview/broken.pdf'), join(h.workspaceDir, 'broken.pdf'))
    await dropFile(h, 'broken.pdf')
    await expect(h.page.locator('.fp-pdf-error')).toContainText('PDF解析失败')
  } finally { await h.close(); await h.cleanup() }
})

test('docx正文实际可见，文档里的脚本字样只是文本', async () => {
  const h = await launchApp()
  try {
    writeFileSync(join(h.workspaceDir, 'document.docx'), await minimalDocx('DOCX_BODY_SENTINEL <script>not-executable</script>'))
    await dropFile(h, 'document.docx')
    const body = h.page.frameLocator('.fp-card-office').locator('body')
    await expect(body).toContainText('DOCX_BODY_SENTINEL')
    await expect(body).toContainText('<script>not-executable</script>')
  } finally { await h.close(); await h.cleanup() }
})

test('宿主PDF字节桥只接受本人有效PDF句柄，释放后实际拒读', async () => {
  const h = await launchApp()
  try {
    copyFileSync(join(__dirname, '../fixtures/conversation-preview/sample-1page.pdf'), join(h.workspaceDir, 'one.pdf'))
    const attachment = await apiCall<Attachment>(h.page, 'attachPath', 'one.pdf')
    const opened = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', {
      ...attachment.preview, source: 'draft', name: attachment.name, bytes: attachment.bytes
    })
    expect(opened.ok).toBe(true)
    const data = await h.page.evaluate(async id => Array.from(await window.api.previewRead(id)), opened.handleId!)
    expect(Buffer.from(data).subarray(0, 5).toString()).toBe('%PDF-')
    await apiCall(h.page, 'previewRelease', opened.handleId)
    await expect(apiCall(h.page, 'previewRead', opened.handleId)).rejects.toThrow(/句柄已失效|不属于/)
    writeFileSync(join(h.workspaceDir, 'ordinary.txt'), 'ORDINARY_SENTINEL')
    const text = await apiCall<Attachment>(h.page, 'attachPath', 'ordinary.txt')
    const textHandle = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', {
      ...text.preview, source: 'draft', name: text.name, bytes: text.bytes
    })
    await expect(apiCall(h.page, 'previewRead', textHandle.handleId)).rejects.toThrow(/不属于宿主PDF/)
    await apiCall(h.page, 'previewRelease', textHandle.handleId)
  } finally { await h.close(); await h.cleanup() }
})
