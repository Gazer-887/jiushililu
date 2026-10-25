// 完整外部PDF快照故事＋旧接口兼容回归。真实Agent写入/edit见conversation-preview-artifacts.spec.ts；
// 真图片/文档/媒体见images/documents/media，保存失败与系统打开另有真实入口故事。
// 仅模型和明确标注的OS打开外设可替换，生产身份/存储/Gateway/协议不复制规则。
import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiCall, launchApp, type E2EApp } from './helpers'
import type { Attachment, Conversation } from '../../src/shared/ipc'

interface Conv {
  id: string
  title: string
  workspace: string
  model: string
}
// 最小合法 PDF（1 页，含可检索文本）—— 无依赖手写，页数/文本可断言。
function makeMinimalPdf(): Buffer {
  const objs: string[] = []
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  objs.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n')
  const text = 'BT /F1 12 Tf 10 100 Td (PREVIEW_SENTINEL_TEXT) Tj ET'
  objs.push(`4 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`)
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const o of objs) {
    offsets.push(pdf.length)
    pdf += o
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

test.describe('对话内预览：完整PDF快照故事与旧接口兼容回归', () => {
  test('完整附件故事：真实拖入工作区外PDF、发送、改源、重启后页面与字节仍是旧快照', async () => {
    const first = await launchApp()
    let current: E2EApp | null = first
    let srv: Server | null = null
    const outsideDir = mkdtempSync(join(tmpdir(), 'pv-pdf-snapshot-'))
    const bodies: string[] = []
    try {
      const enc = await first.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
      const reason = '真实发送的本地假模型需要safeStorage；仅跳此发送故事，不跳格式/身份'
      if (!enc) console.log(`PDF_SNAPSHOT_SKIP=${JSON.stringify({ encryptionAvailable: enc, reason })}`)
      test.skip(!enc, reason)
      const pdfPath = join(outsideDir, 'report.pdf')
      const pdfBytes = makeMinimalPdf(); writeFileSync(pdfPath, pdfBytes)
      srv = createServer((req, res) => {
        let body = ''; req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          bodies.push(body); res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'PDF_SNAPSHOT_REPLY' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        })
      })
      srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
      const saved = await apiCall<{ id: string }>(first.page, 'saveModel', {
        name: 'pdf-snapshot-local-only', providerType: 'openai-compatible',
        baseURL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, stream: true, timeoutMs: 15000,
        models: [{ id: 'snapshot-entry', model: 'snapshot-model' }], apiKey: 'FAKE_LOCAL_KEY'
      })
      await apiCall(first.page, 'setActiveModel', saved.id); await first.page.reload()
      const transfer = await first.page.evaluateHandle(path => {
        const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', path); return dt
      }, pdfPath)
      await first.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
      await expect(first.page.locator('.console .fp-card')).toHaveCount(1)
      await first.page.locator('.console .fp-card-head').click()
      await expect(first.page.locator('.fp-pdf-canvas')).toBeVisible()
      await expect(first.page.locator('.fp-pdf-page-number')).toHaveText('1 / 1')
      await expect(first.page.locator('textarea.console-input').first()).toHaveValue('') // 首轮只有附件，没有用户正文。
      await first.page.locator('textarea.console-input').first().press('Enter')
      await expect(first.page.locator('.msg-assistant')).toContainText('PDF_SNAPSHOT_REPLY')
      const convs = await apiCall<Conv[]>(first.page, 'listConversations')
      const conv = await apiCall<{ id: string; messages: Array<{ messageId?: string; localFiles?: Array<{ assetId: string; source: string; name: string; mime: string; bytes: number }> }> }>(first.page, 'getConversation', convs[0].id)
      const message = conv.messages.find(m => m.localFiles?.length)!
      const file = message.localFiles![0]
      expect(file.source).toBe('history')
      expect(bodies.some(body => body.includes('report.pdf'))).toBe(true)
      for (const body of bodies) {
        expect(body).not.toContain('localFiles'); expect(body).not.toContain('draftId'); expect(body).not.toContain('messageId')
        expect(body).not.toContain(file.assetId); expect(body).not.toContain('PREVIEW_SENTINEL_TEXT')
      }
      writeFileSync(pdfPath, '%PDF-1.4 broken-original-after-send')
      await first.close(); current = null
      current = await launchApp({ reuseDataDir: first.dataDir })
      await current.page.locator('.conv-item').first().click()
      await current.page.locator('.msg-local-files .fp-card-head').click()
      await expect(current.page.locator('.fp-pdf-canvas')).toBeVisible()
      await expect(current.page.locator('.fp-pdf-page-number')).toHaveText('1 / 1')
      const opened = await apiCall<{ ok: boolean; handleId: string }>(current.page, 'previewOpen', { ...file, conversationId: conv.id, messageId: message.messageId })
      expect(opened.ok).toBe(true)
      const bytes = await current.page.evaluate(async id => Array.from(await window.api.previewRead(id)), opened.handleId)
      expect(Buffer.from(bytes)).toEqual(pdfBytes)
      await apiCall(current.page, 'previewRelease', opened.handleId)
    } finally {
      if (current) await current.close()
      if (srv) { srv.closeAllConnections(); await new Promise<void>(resolve => srv!.close(() => resolve())) }
      await first.cleanup(); rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('接口回归：原会话当前文件读取与内容版本（真工具事件另见artifacts故事）', async () => {
    const h = await launchApp()
    try {
      // 直接建立受控当前文件夹具；这不是Agent工具执行证据
      const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
      const artRel = 'agent-output.txt'
      writeFileSync(join(ws.path, artRel), 'AGENT_PRODUCED_CONTENT_V1', 'utf8')

      const conv = await apiCall<Conv>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 'e2e-model'
      })
      await apiCall(h.page, 'switchConversation', null, conv.id)

      // artifact 来源预览：读所属会话工作区的**当前**文件
      const openRes = await apiCall<{
        ok: boolean
        boundedText?: string
        sourceLabel?: string
        sourceVersion?: string
        handleId?: string
      }>(h.page, 'previewOpen', {
        source: 'artifact',
        conversationId: conv.id,
        workspaceRel: artRel,
        name: artRel,
        mime: 'text/plain'
      })
      expect(openRes.ok, 'Agent 产物应能就地预览').toBe(true)
      expect(openRes.sourceLabel, '产物来源标注为当前文件').toBe('current')
      expect(openRes.boundedText, '预览读到工作区当前文件内容').toContain('AGENT_PRODUCED_CONTENT_V1')
      if (openRes.handleId) await apiCall(h.page, 'previewRelease', openRes.handleId)

      // 改工作区文件 → 重新预览应读到新版本（当前文件语义，非快照）
      writeFileSync(join(ws.path, artRel), 'AGENT_PRODUCED_CONTENT_V2', 'utf8')
      const openRes2 = await apiCall<{
        ok: boolean
        boundedText?: string
        sourceVersion?: string
        handleId?: string
      }>(h.page, 'previewOpen', {
        source: 'artifact',
        conversationId: conv.id,
        workspaceRel: artRel,
        name: artRel,
        mime: 'text/plain'
      })
      expect(openRes2.boundedText, '产物刷新应读到新版本').toContain('AGENT_PRODUCED_CONTENT_V2')
      // 版本号应随内容变化（digest 不同）
      expect(openRes.sourceVersion).toMatch(/^[a-f0-9]{16}$/)
      expect(openRes2.sourceVersion, '产物版本应随内容变化').not.toBe(openRes.sourceVersion)
      if (openRes2.handleId) await apiCall(h.page, 'previewRelease', openRes2.handleId)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('故事4：安全边界——伪草稿/缺身份/越界一律拒（真实副作用）', async () => {
    const h = await launchApp()
    try {
      const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')
      writeFileSync(join(ws.path, 'owned.txt'), 'ACTUAL_OWNED_ASSET_SENTINEL')
      const att = await apiCall<Attachment>(h.page, 'attachPath', 'owned.txt')
      const positive = await apiCall<{ ok: boolean; boundedText: string; handleId: string }>(h.page, 'previewOpen', {
        ...att.preview, source: 'draft', name: att.name, bytes: att.bytes
      })
      expect(positive.ok).toBe(true)
      expect(positive.boundedText).toBe('ACTUAL_OWNED_ASSET_SENTINEL')
      await apiCall(h.page, 'previewRelease', positive.handleId)
      const conv = await apiCall<Conv>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 'e2e-model', firstMessage: 'ownership',
        firstLocalFiles: [{ ...att.preview, name: att.name, bytes: att.bytes, source: 'draft' }]
      })

      const saved = await apiCall<Conversation>(h.page, 'getConversation', conv.id)
      const ownMessage = saved.messages[0]
      const history = await apiCall<{ ok: boolean; boundedText: string; handleId: string }>(h.page, 'previewOpen', {
        ...ownMessage.localFiles![0], conversationId: conv.id, messageId: ownMessage.messageId
      })
      expect(history.boundedText).toBe('ACTUAL_OWNED_ASSET_SENTINEL')
      await apiCall(h.page, 'previewRelease', history.handleId)

      // ① history 缺消息身份 → 拒
      const noMsg = await apiCall<{ ok: boolean; errorCode?: string }>(h.page, 'previewOpen', {
        source: 'history',
        conversationId: conv.id,
        assetId: att.preview!.assetId,
        name: 'x.txt',
        mime: 'text/plain'
      })
      expect(noMsg.ok, 'history 缺 messageId 应被拒').toBe(false)

      // ② history 伪消息身份（不属于该会话）→ 拒
      const forged = await apiCall<{ ok: boolean; errorCode?: string }>(h.page, 'previewOpen', {
        source: 'history',
        conversationId: conv.id,
        messageId: 'forged-msg-id',
        assetId: att.preview!.assetId,
        name: 'x.txt',
        mime: 'text/plain'
      })
      expect(forged.ok, 'history 伪消息身份应被拒').toBe(false)

      // ③ draft 未宿主摄取的 assetId → 拒（渲染层不能拿任意 assetId 放行）
      const fakeDraft = await apiCall<{ ok: boolean; errorCode?: string }>(h.page, 'previewOpen', {
        source: 'draft',
        draftId: 'never-registered',
        assetId: att.preview!.assetId,
        name: 'x.txt',
        mime: 'text/plain'
      })
      expect(fakeDraft.ok, '未登记草稿应被拒').toBe(false)

      // ④ history 不存在的会话 → 拒
      const noConv = await apiCall<{ ok: boolean }>(h.page, 'previewOpen', {
        source: 'history',
        conversationId: 'no-such-conv',
        messageId: 'm1',
        assetId: att.preview!.assetId,
        name: 'x.txt',
        mime: 'text/plain'
      })
      expect(noConv.ok, '不存在会话的 history 预览应被拒').toBe(false)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })

  test('接口回归：图片/PDF格式事实与文本内容，真实解码/页面/播放另有完整故事', async () => {
    const h = await launchApp()
    try {
      const ws = await apiCall<{ path: string }>(h.page, 'getWorkspace')

      // ① 图片：真实 1×1 PNG，draft 摄取后预览应拿到 image 能力 + 可解码 URL
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=',
        'base64'
      )
      const pngPath = join(ws.path, 'probe.png')
      writeFileSync(pngPath, png)
      const imgIng = await apiCall<{ ok: boolean; assetId?: string; draftId?: string }>(h.page, 'previewIngestDraft', {
        sourceAbs: pngPath,
        name: 'probe.png',
        mime: 'image/png',
        draftId: 'draft-img'
      })
      expect(imgIng.ok, '图片应能摄取').toBe(true)
      const imgOpen = await apiCall<{
        ok: boolean
        url?: string
        capabilities?: { image?: boolean }
        handleId?: string
      }>(h.page, 'previewOpen', {
        source: 'draft',
        draftId: imgIng.draftId,
        assetId: imgIng.assetId,
        name: 'probe.png',
        mime: 'image/png'
      })
      expect(imgOpen.ok, '图片应能预览').toBe(true)
      expect(imgOpen.capabilities?.image, '应有 image 能力').toBe(true)
      expect(imgOpen.url, '应有可加载的预览 URL').toMatch(/^jsl-preview:\/\//)
      if (imgOpen.handleId) await apiCall(h.page, 'previewRelease', imgOpen.handleId)

      // ② PDF：最小 PDF，预览应拿到 pdf 能力（翻页缩放视图）；解析失败会带 degraded
      const pdfPath = join(ws.path, 'probe.pdf')
      writeFileSync(pdfPath, makeMinimalPdf())
      const pdfIng = await apiCall<{ ok: boolean; assetId?: string; draftId?: string }>(h.page, 'previewIngestDraft', {
        sourceAbs: pdfPath,
        name: 'probe.pdf',
        mime: 'application/pdf',
        draftId: 'draft-pdf'
      })
      expect(pdfIng.ok, 'PDF 应能摄取').toBe(true)
      const pdfOpen = await apiCall<{
        ok: boolean
        url?: string
        capabilities?: { pdf?: boolean }
        degraded?: string
        handleId?: string
      }>(h.page, 'previewOpen', {
        source: 'draft',
        draftId: pdfIng.draftId,
        assetId: pdfIng.assetId,
        name: 'probe.pdf',
        mime: 'application/pdf'
      })
      expect(pdfOpen.ok, 'PDF 应能预览').toBe(true)
      expect(pdfOpen.capabilities?.pdf, '应有 pdf 能力').toBe(true)
      expect(pdfOpen.degraded, '正常 PDF 不应标记降级').toBeUndefined()
      if (pdfOpen.handleId) await apiCall(h.page, 'previewRelease', pdfOpen.handleId)

      // ③ 文本：工作区内文本，artifact 预览应有 text 能力 + 有界内容
      const txtRel = 'probe.txt'
      writeFileSync(join(ws.path, txtRel), 'TEXT_PREVIEW_OK', 'utf8')
      const conv = await apiCall<Conv>(h.page, 'createConversation', {
        workspace: ws.path,
        model: 'e2e-model'
      })
      const txtOpen = await apiCall<{
        ok: boolean
        boundedText?: string
        capabilities?: { text?: boolean }
        handleId?: string
      }>(h.page, 'previewOpen', {
        source: 'artifact',
        conversationId: conv.id,
        workspaceRel: txtRel,
        name: txtRel,
        mime: 'text/plain'
      })
      expect(txtOpen.ok, '文本应能预览').toBe(true)
      expect(txtOpen.capabilities?.text, '应有 text 能力').toBe(true)
      expect(txtOpen.boundedText, '应有界文本内容').toContain('TEXT_PREVIEW_OK')
      if (txtOpen.handleId) await apiCall(h.page, 'previewRelease', txtOpen.handleId)
    } finally {
      await h.close()
      await h.cleanup()
    }
  })
})
