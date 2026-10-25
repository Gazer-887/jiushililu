// 附件链接通的命名断言（plan74 第二组，对应 Spec R2 反例 1/2）。
// 直接 import 真实的 userTurnWithMedia 与真实 schema，喂真实 Attachment —— 不用假数据。
// 先红后绿：修前 userTurnWithMedia 不产出 localFiles、schema 剥离它们（审查端反例实测坐实）。
import { describe, it, expect } from 'vitest'
import { userTurnWithMedia } from '@shared/attachment-block'
import { incomingMessagesSchema, storedMessagesSchema } from '@main/schemas'
import type { Attachment } from '@shared/ipc'

const pdfAttachment: Attachment = {
  path: '/some/outside/report.pdf',
  content: '',
  truncated: false,
  bytes: 12345,
  outside: true,
  preview: { assetId: '20261014T153000-0-abc123.pdf', digest: 'deadbeefcafe1234', mime: 'application/pdf' }
}

describe('附件链接通：发送构造 + 存盘 schema 保留本地引用', () => {
  it('userTurnWithMedia 把带 preview 的非媒体附件转成 localFiles（不出站）', () => {
    const turn = userTurnWithMedia('看这个', [pdfAttachment])
    expect(turn.localFiles).toBeDefined()
    expect(turn.localFiles?.length).toBe(1)
    const lf = turn.localFiles?.[0]
    expect(lf?.assetId).toBe('20261014T153000-0-abc123.pdf')
    expect(lf?.source).toBe('draft')
    expect(lf?.mime).toBe('application/pdf')
    expect(lf?.outside).toBe(true)
    // 铁律：PDF 不进 parts（parts 是模型出境内容）
    expect(turn.parts).toBeUndefined()
  })

  it('纯文本轮不产 localFiles（不破坏旧路径）', () => {
    const turn = userTurnWithMedia('你好', [])
    expect(turn.localFiles).toBeUndefined()
    expect(turn.parts).toBeUndefined()
  })

  it('图片附件仍只走 parts，不误入 localFiles', () => {
    const img: Attachment = {
      path: 'a.png',
      content: '',
      truncated: false,
      bytes: 100,
      image: { type: 'image', mime: 'image/png', ref: '20261014T153000-0-img.png', bytes: 100 }
    }
    const turn = userTurnWithMedia('看图', [img])
    expect(turn.parts).toBeDefined()
    expect(turn.localFiles).toBeUndefined()
  })

  it('有宿主预览身份的图片：parts与localFiles引用同一个文件，不复制字节', () => {
    const image: Attachment = {
      name: 'owned.png', path: 'owned.png', content: '', truncated: false, bytes: 100,
      image: { type: 'image', mime: 'image/png', ref: '20261014T153000-0-abc123.png', bytes: 100 },
      preview: { assetId: '20261014T153000-0-abc123.png', mime: 'image/png', digest: 'a'.repeat(16), draftId: 'host-owned' }
    }
    const turn = userTurnWithMedia('看图', [image])
    expect(turn.localFiles?.[0].assetId).toBe(image.image?.ref)
    expect(turn.localFiles?.[0].draftId).toBe('host-owned')
    expect(turn.parts?.filter(part => part.type === 'image')).toHaveLength(1)
  })

  it('incomingMessagesSchema 保留 localFiles + messageId（不再剥离）', () => {
    const parsed = incomingMessagesSchema.safeParse([
      {
        role: 'user',
        content: '看这个',
        localFiles: [
          {
            assetId: '20261014T153000-0-abc123.pdf',
            name: 'report.pdf',
            mime: 'application/pdf',
            bytes: 12345,
            source: 'draft'
          }
        ],
        messageId: 'u-123-abc'
      }
    ])
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data[0].localFiles?.length).toBe(1)
      expect(parsed.data[0].messageId).toBe('u-123-abc')
    }
  })

  it('storedMessagesSchema 落盘保留 localFiles + messageId（重启仍可预览）', () => {
    const parsed = storedMessagesSchema.safeParse([
      {
        role: 'user',
        content: '看这个',
        localFiles: [
          {
            assetId: '20261014T153000-0-abc123.pdf',
            name: 'report.pdf',
            mime: 'application/pdf',
            bytes: 12345,
            source: 'history'
          }
        ],
        messageId: 'u-123-abc'
      }
    ])
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data[0].localFiles?.[0]?.assetId).toBe('20261014T153000-0-abc123.pdf')
      expect(parsed.data[0].messageId).toBe('u-123-abc')
    }
  })

  it('坏 localFiles（缺核心字段）被拒，不静默收下', () => {
    const parsed = incomingMessagesSchema.safeParse([
      { role: 'user', content: 'x', localFiles: [{ name: 'no-asset.pdf' }] }
    ])
    expect(parsed.success).toBe(false)
  })
})
