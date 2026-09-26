// plan57 片③：引用 → 出站的物化层判据。
// 这层存在的唯一理由是"别把 base64 留在历史里"，所以判据重点在：读了什么、读了几次。
import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGES_PER_TURN,
  imageGateError,
  materializeParts,
  materializeHistory,
  missingImageNote,
  textOfParts,
  imageCountOf,
  type ContentPart
} from '@shared/content-parts'

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const loader = (calls: string[]) => async (ref: string): Promise<Buffer> => {
  calls.push(ref)
  return FAKE_PNG
}

describe('materializeParts：只在该读的时候读，且一次读够', () => {
  it('文本块原样透传，不触发任何读盘', async () => {
    const calls: string[] = []
    const got = await materializeParts([{ type: 'text', text: '只看字' }], loader(calls))
    expect(got).toEqual([{ type: 'text', text: '只看字' }])
    expect(calls).toEqual([])
  })

  it('图片块物化成 base64，并保留 ref 以便回溯是哪张图', async () => {
    const calls: string[] = []
    const parts: ContentPart[] = [{ type: 'image', mime: 'image/png', ref: 'a.png', bytes: 8 }]
    const got = await materializeParts(parts, loader(calls))
    expect(got).toEqual([
      { type: 'image', mime: 'image/png', base64: FAKE_PNG.toString('base64'), ref: 'a.png' }
    ])
    expect(calls).toEqual(['a.png'])
  })

  it('★ 同一轮里重复引用同一张图 ⇒ 只读一次（这条防的是"每轮重编码"那个已知代价）', async () => {
    const calls: string[] = []
    const one: ContentPart = { type: 'image', mime: 'image/png', ref: 'same.png', bytes: 8 }
    await materializeParts([one, { ...one }, { ...one }], loader(calls))
    expect(calls).toEqual(['same.png'])
  })

  it('不同 ref 各读各的（别把去重做成了"永远只读第一张"）', async () => {
    const calls: string[] = []
    await materializeParts(
      [
        { type: 'image', mime: 'image/png', ref: 'x.png', bytes: 8 },
        { type: 'image', mime: 'image/png', ref: 'y.png', bytes: 8 }
      ],
      loader(calls)
    )
    expect(calls).toEqual(['x.png', 'y.png'])
  })
})

describe('给旧代码用的两个读数', () => {
  const mixed: ContentPart[] = [
    { type: 'text', text: '前' },
    { type: 'image', mime: 'image/png', ref: 'a.png', bytes: 8 },
    { type: 'text', text: '后' }
  ]

  it('textOfParts 只拼文本，绝不把引用字符串混进去', () => {
    expect(textOfParts(mixed)).toBe('前后')
  })

  it('imageCountOf 数得出张数，且无 parts 时是 0 而不是崩', () => {
    expect(imageCountOf(mixed)).toBe(1)
    expect(imageCountOf([{ type: 'text', text: '纯字' }])).toBe(0)
    expect(imageCountOf(undefined)).toBe(0)
  })
})

const img = (ref: string): ContentPart => ({ type: 'image', mime: 'image/png', ref, bytes: 8 })
const txt = (text: string): ContentPart => ({ type: 'text', text })

describe('materializeHistory：旧图折回 marker，只有最近配额内的轮带 base64（D-146 C）', () => {
  it('两轮各一张图 ⇒ 只有末轮物化，前一轮的 parts 整个摘掉（正文 marker 仍在 content）', async () => {
    const calls: string[] = []
    const got = await materializeHistory(
      [
        { content: '第一轮 <file name="a.png" kind="image" />', parts: [txt('第一轮'), img('a.png')] },
        { content: '第二轮 <file name="b.png" kind="image" />', parts: [txt('第二轮'), img('b.png')] }
      ],
      loader(calls)
    )
    expect(calls).toEqual(['b.png'])
    expect(got[0].parts).toBeUndefined()
    expect(got[0].content).toContain('a.png')
    expect(got[1].parts).toEqual([
      { type: 'text', text: '第二轮' },
      { type: 'image', mime: 'image/png', base64: FAKE_PNG.toString('base64'), ref: 'b.png' }
    ])
  })

  it('配额可开大：keepRecentImageTurns=2 时两轮都该带图（防把"1 轮"写死成不可调）', async () => {
    const calls: string[] = []
    const got = await materializeHistory(
      [
        { content: 'A', parts: [img('a.png')] },
        { content: 'B', parts: [img('b.png')] }
      ],
      loader(calls),
      { keepRecentImageTurns: 2 }
    )
    expect(calls).toEqual(['b.png', 'a.png'])
    expect(got[0].parts?.some((p) => p.type === 'image')).toBe(true)
  })

  it('★ 中间夹纯文本轮不许把上一轮的图提前折掉（配额按"带图的轮"数，不按消息条数）', async () => {
    const calls: string[] = []
    await materializeHistory(
      [
        { content: '带图', parts: [img('a.png')] },
        { content: '只是追问一句' }
      ],
      loader(calls)
    )
    expect(calls).toEqual(['a.png'])
  })

  it('纯文本历史一个字都不该读盘，也不凭空长出 parts', async () => {
    const calls: string[] = []
    const got = await materializeHistory([{ content: '早' }, { content: '安' }], loader(calls))
    expect(calls).toEqual([])
    expect(got).toEqual([{ content: '早' }, { content: '安' }])
  })

  it('读不到的图：抛是默认（调用方要看见）；给 onError 才降级成一句人话，且不带 base64', async () => {
    const boom = async (): Promise<Buffer> => {
      throw new Error('ENOENT')
    }
    await expect(materializeParts([img('gone.png')], boom)).rejects.toThrow('ENOENT')
    const got = await materializeParts([img('gone.png')], boom, (ref) => ({
      type: 'text',
      text: missingImageNote(ref)
    }))
    expect(got).toEqual([{ type: 'text', text: '[图片未能送达，文件已不可读：gone.png]' }])
  })
})

describe('能力位闸（D-146 B：发送前拦，不静默降级、不靠解析厂商错误串）', () => {
  it('没图就放行；带图且模型未标记支持 ⇒ 拦，并说清几张、去哪儿改', () => {
    expect(imageGateError(false, 0)).toBeNull()
    expect(imageGateError(true, 3)).toBeNull()
    const err = imageGateError(false, 2) ?? ''
    expect(err).toContain('2 张图片')
    expect(err).toContain('图片输入支持')
  })

  it('★ 超限先于能力位：一条消息最多 8 张，第 9 张报"分几条消息发送"', () => {
    const err = imageGateError(true, MAX_IMAGES_PER_TURN + 1) ?? ''
    expect(err).toContain(String(MAX_IMAGES_PER_TURN))
    expect(err).toContain('分几条消息发送')
  })
})
