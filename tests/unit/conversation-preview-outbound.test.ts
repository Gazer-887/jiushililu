// 对话内预览：模型出站白名单（plan74 执行补充 4.1，硬断言）。
//
// 唯一目的：钉死「本地预览引用绝不进模型出站体」。PDF/音频/Office 只在 localFiles，
// 图片/视频在 parts（可出站）—— 最终 HTTP 请求体里**不得出现** assetId / 绝对路径 / 句柄 / 二进制。
//
// 直接 import 真实出站装配（content-parts / 白名单清洗），不复制规则。
import { describe, it, expect } from 'vitest'
import { materializeHistory, textOfParts, type ContentPart } from '@shared/content-parts'
import type { ChatMessage } from '@shared/ipc'

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

/** 出站后请求体里禁止出现的本地预览痕迹。 */
const FORBIDDEN = ['assetId', 'localFiles', 'assets/', 'messageId', 'handleId', 'preview://']

function bodyOf(messages: unknown): string {
  return JSON.stringify(messages)
}

describe('conversation-preview-outbound：本地引用不出站', () => {
  it('materializeHistory 不把 localFiles/messageId 带进出站体', async () => {
    // 一条带本地 PDF 引用的用户消息（PDF 只进 localFiles，不进 parts）
    const msg: ChatMessage = {
      role: 'user',
      content: '帮我看这个文件',
      messageId: 'msg-123',
      localFiles: [
        {
          assetId: '20261014T120000-0-abcdef.pdf',
          name: '报告.pdf',
          mime: 'application/pdf',
          bytes: 1234,
          source: 'history'
        }
      ]
    }
    const out = await materializeHistory([msg], async () => FAKE_PNG)
    const body = bodyOf(out)
    for (const token of FORBIDDEN) {
      expect(body.includes(token), `出站体不应包含 ${token}`).toBe(false)
    }
    // 出站体只剩 role/content（与 parts 无关的纯文本轮）
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe('帮我看这个文件')
  })

  it('图片仍在 parts 正常物化出站（本地/出站分离不破坏媒体通路）', async () => {
    const parts: ContentPart[] = [
      { type: 'text', text: '看这张图' },
      { type: 'image', mime: 'image/png', ref: '20261014T120000-0-abc123.png', bytes: FAKE_PNG.length }
    ]
    const msg: ChatMessage = { role: 'user', content: textOfParts(parts), parts }
    const out = await materializeHistory([msg], async () => FAKE_PNG)
    const wire = out[0].parts
    expect(wire).toBeDefined()
    // 图片物化成 base64 出站（这是既有合法通路）
    expect(wire?.some((p) => p.type === 'image')).toBe(true)
    // 但 localFiles 这种本地字段绝不出现
    const body = bodyOf(out)
    expect(body.includes('localFiles')).toBe(false)
    expect(body.includes('assetId')).toBe(false)
  })

  it('音频/Office 本地引用不出站、不调用媒体加载器', async () => {
    let loadCalls = 0
    const msg: ChatMessage = {
      role: 'user',
      content: '听这段录音',
      localFiles: [
        { assetId: '20261014T120000-0-aaaaaa.mp3', name: '录音.mp3', mime: 'audio/mpeg', bytes: 999, source: 'history' },
        { assetId: '20261014T120000-0-bbbbbb.docx', name: '文档.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 888, source: 'history' }
      ]
    }
    const out = await materializeHistory([msg], async () => {
      loadCalls++
      return FAKE_PNG
    })
    // 音频/Office 没有 parts → 不触发任何媒体加载
    expect(loadCalls).toBe(0)
    const body = bodyOf(out)
    expect(body.includes('audio')).toBe(false)
    expect(body.includes('mp3')).toBe(false)
    expect(body.includes('assetId')).toBe(false)
  })
})
