// 只替系统打开外设，不替生产IPC、句柄归属、路径/格式判断或存储。
import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, apiCall } from './helpers'
import type { Attachment } from '../../src/shared/ipc'
import type { PreviewOpenOutput } from '../../src/shared/preview-ipc-types'
test('未知/PPTX就地降级，主动系统打开的是受限副本而非任意路径；撤销后拒绝', async () => {
  const h = await launchApp()
  try {
    await h.app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { previewSystemOpened: string[] }
      state.previewSystemOpened = []
      shell.openPath = async (path: string) => { state.previewSystemOpened.push(path); return '' }
    })
    const bytes = Buffer.from('PK\u0000OWNED_PPTX_SNAPSHOT')
    writeFileSync(join(h.workspaceDir, 'local-deck.pptx'), bytes)
    const transfer = await h.page.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', 'local-deck.pptx'); return dt })
    await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
    const card = h.page.locator('.console .fp-card')
    await expect(card).toBeVisible()
    await card.locator('.fp-card-head').click()
    await expect(card.locator('.fp-card-unsupported')).toContainText('暂不支持内嵌预览')
    await expect(card).toContainText('仅本地查看，不发给模型')
    await card.getByRole('button', { name: '用系统程序打开' }).click()
    await expect.poll(() => h.app.evaluate(() => (globalThis as unknown as { previewSystemOpened: string[] }).previewSystemOpened.length)).toBe(1)
    const opened = await h.app.evaluate(() => (globalThis as unknown as { previewSystemOpened: string[] }).previewSystemOpened)
    expect(opened[0].replace(/\\/g, '/')).toContain(`${h.dataDir.replace(/\\/g, '/')}/assets/`)
    expect(readFileSync(opened[0])).toEqual(bytes)
    const attachment = await apiCall<Attachment>(h.page, 'attachPath', 'local-deck.pptx')
    const handle = await apiCall<PreviewOpenOutput>(h.page, 'previewOpen', { ...attachment.preview, source: 'draft', name: attachment.name, bytes: attachment.bytes })
    await apiCall(h.page, 'previewRelease', handle.handleId)
    expect(await apiCall(h.page, 'openWorkspacePathInSystem', '', handle.handleId)).toMatchObject({ ok: false })
    expect(await apiCall(h.page, 'openWorkspacePathInSystem', '', 'not-a-real-handle')).toMatchObject({ ok: false })
    expect((await h.app.evaluate(() => (globalThis as unknown as { previewSystemOpened: string[] }).previewSystemOpened)).length).toBe(1)
  } finally { await h.close(); await h.cleanup() }
})
