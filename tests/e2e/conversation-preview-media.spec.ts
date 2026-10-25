// 原生HTMLMediaElement＋真实IPC/Gateway/协议；不把canPlayType或URL当成播放证明。
import { test, expect, type Locator } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, apiCall } from './helpers'
import type { Attachment } from '../../src/shared/ipc'
import { wavFixture, mp4Fixture } from '../fixtures/conversation-preview/media-fixtures'

async function drop(h: Awaited<ReturnType<typeof launchApp>>, name: string): Promise<Locator> {
  const transfer = await h.page.evaluateHandle(path => { const dt = new DataTransfer(); dt.setData('application/x-jiushililu-path', path); return dt }, name)
  await h.page.locator('.console').first().dispatchEvent('drop', { dataTransfer: transfer })
  const card = h.page.locator('.console .fp-card').filter({ has: h.page.locator('.fp-card-name', { hasText: name }) })
  await expect(card).toBeVisible()
  await card.locator('.fp-card-head').click()
  return card
}

test('切换真实会话后原生播放器暂停并撤销源，不在后台续播', async () => {
  const h = await launchApp()
  try {
    writeFileSync(join(h.workspaceDir, 'switch.wav'), wavFixture())
    const attachment = await apiCall<Attachment>(h.page, 'attachPath', 'switch.wav')
    await apiCall(h.page, 'createConversation', { workspace: h.workspaceDir, model: 'no-request', firstMessage: '媒体目标会话', firstLocalFiles: [{ ...attachment.preview!, name: attachment.name, bytes: attachment.bytes, source: 'draft' }] })
    await apiCall(h.page, 'createConversation', { workspace: h.workspaceDir, model: 'no-request', firstMessage: '切换目标空会话' })
    await h.page.reload()
    await h.page.locator('.conv-item').filter({ hasText: '媒体目标会话' }).click()
    await h.page.locator('.msg-local-files .fp-card-head').click()
    const audio = h.page.locator('.msg-local-files audio')
    await expect.poll(() => audio.evaluate(node => (node as HTMLMediaElement).duration)).toBeGreaterThan(7)
    await audio.evaluate(node => { (node as HTMLMediaElement).muted = true; return (node as HTMLMediaElement).play() })
    await expect.poll(() => audio.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(0.15)
    const old = await audio.elementHandle()
    await h.page.locator('.conv-item').filter({ hasText: '切换目标空会话' }).click()
    await expect(h.page.locator('.msg-local-files audio')).toHaveCount(0)
    expect(await old!.evaluate(node => ({ paused: (node as HTMLMediaElement).paused, src: node.getAttribute('src') }))).toEqual({ paused: true, src: null })
    console.log('MEDIA_SWITCH_EVIDENCE=native-paused,source-revoked')
  } finally { await h.close(); await h.cleanup() }
})

test('真实WAV播放、seek、互斥、折叠停止、元数据后恢复', async () => {
  const h = await launchApp()
  try {
    writeFileSync(join(h.workspaceDir, 'first.wav'), wavFixture())
    writeFileSync(join(h.workspaceDir, 'second.wav'), wavFixture())
    const aCard = await drop(h, 'first.wav')
    const a = aCard.locator('audio')
    await expect.poll(() => a.evaluate(node => (node as HTMLMediaElement).duration)).toBeGreaterThan(7)
    await a.evaluate(node => { (node as HTMLMediaElement).muted = true; return (node as HTMLMediaElement).play() })
    await expect.poll(() => a.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(0.15)
    await a.evaluate(node => { (node as HTMLMediaElement).currentTime = 4 })
    await expect.poll(() => a.evaluate(node => (node as HTMLMediaElement).seeking)).toBe(false)
    await expect.poll(() => a.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(4.15)
    const bCard = await drop(h, 'second.wav')
    const b = bCard.locator('audio')
    await expect.poll(() => b.evaluate(node => (node as HTMLMediaElement).duration)).toBeGreaterThan(7)
    await b.evaluate(node => { (node as HTMLMediaElement).muted = true; return (node as HTMLMediaElement).play() })
    await expect.poll(() => a.evaluate(node => (node as HTMLMediaElement).paused)).toBe(true)
    await expect.poll(() => b.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(0.15)
    const stoppedAt = await a.evaluate(node => (node as HTMLMediaElement).currentTime)
    const detached = await b.elementHandle()
    await bCard.locator('.fp-card-head').click()
    expect(await detached!.evaluate(node => ({ paused: (node as HTMLMediaElement).paused, src: node.getAttribute('src') }))).toEqual({ paused: true, src: null })
    await aCard.locator('.fp-card-head').click()
    await aCard.locator('.fp-card-head').click()
    const reopened = aCard.locator('audio')
    await expect.poll(() => reopened.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThanOrEqual(stoppedAt - 0.1)
    expect(await reopened.evaluate(node => (node as HTMLMediaElement).paused)).toBe(true)
    console.log(`MEDIA_EVIDENCE=${JSON.stringify({ wavTime: stoppedAt, restoredPaused: true, collapsedPaused: true })}`)
  } finally { await h.close(); await h.cleanup() }
})

test('MP4平台实际解码探测与生产协议播放、seek', async () => {
  const h = await launchApp()
  try {
    // 用独立原生播放器实际读同一合成夹具，不以canPlayType字符串推断CI能力。
    const probe = await h.app.evaluate(async ({ BrowserWindow }, bytes) => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        // 合成空页面没有生产页的media-src限制；先排除CSP再判平台解码能力。
        await window.loadURL('data:text/html,<html><body></body></html>')
        return await window.webContents.executeJavaScript(`(${async function (source: string) {
      const player = document.createElement('video')
      player.muted = true
      player.src = `data:video/mp4;base64,${source}`
      document.body.appendChild(player)
      const started = Date.now()
      let playError = ''
      void player.play().catch(error => { playError = String(error.name) })
      try {
        while (Date.now() - started < 8000) {
          if (player.error) return { ok: false, errorCode: player.error.code, width: player.videoWidth, time: player.currentTime, playError }
          if (player.videoWidth > 0 && player.currentTime > 0.15) return { ok: true, errorCode: 0, width: player.videoWidth, time: player.currentTime, playError }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        return { ok: false, errorCode: player.error?.code ?? 0, width: player.videoWidth, time: player.currentTime, playError }
      } finally { player.pause(); player.removeAttribute('src'); player.load(); player.remove() }
        }} )(${JSON.stringify(bytes)})`)
      } finally { window.destroy() }
    }, mp4Fixture().toString('base64'))
    console.log(`MEDIA_PLATFORM_PROBE=${JSON.stringify(probe)}`)
    const unsupported = process.platform !== 'win32' && !probe.ok && probe.errorCode === 4
    if (unsupported) console.log(`MEDIA_SKIP=${JSON.stringify({ component: 'mp4-decode', reason: '独立播放器实际解码返回MEDIA_ERR_SRC_NOT_SUPPORTED', probe, scope: '仅本条MP4故事；WAV/协议/身份不跳过' })}`)
    test.skip(unsupported, '独立播放器实际解码失败：本平台未提供该MP4编码支持')
    expect(probe.ok).toBe(true)
    expect(probe.width).toBe(128)
    writeFileSync(join(h.workspaceDir, 'movie.mp4'), mp4Fixture())
    const movieCard = await drop(h, 'movie.mp4')
    const video = movieCard.locator('video')
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).videoWidth)).toBe(128)
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).duration)).toBeGreaterThan(7)
    await video.evaluate(node => (node as HTMLVideoElement).play())
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0.15)
    await video.evaluate(node => { (node as HTMLVideoElement).currentTime = 5 })
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).seeking)).toBe(false)
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(5.15)
    console.log(`MEDIA_EVIDENCE=${JSON.stringify({ videoWidth: 128, seek: await video.evaluate(node => (node as HTMLVideoElement).currentTime), platformProbe: probe })}`)
  } finally { await h.close(); await h.cleanup() }
})
