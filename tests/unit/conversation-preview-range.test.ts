// 对话内预览：Range 解析与协议 URL 的命名断言（plan74 执行补充 4.3 / 故事3）。
//
// 直接 import 共享层纯逻辑（parseSingleRange / assetUrlToHandleId），喂字符串断言 —— 不复制规则。
// 重点：越界、多段、畸形一律拒（null），合法单段正确解析；URL 往返不丢字符。
import { describe, it, expect } from 'vitest'
import { parseSingleRange, assetUrlToHandleId, assetPreviewUrl } from '@shared/conversation-preview'

describe('preview Range 解析（协议安全判据）', () => {
  it('合法单段：bytes=0-99 → [0,99]', () => {
    expect(parseSingleRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
  })

  it('开区间：bytes=500- → [500, size-1]', () => {
    expect(parseSingleRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('后缀范围：bytes=-100 → 最后 100 字节', () => {
    expect(parseSingleRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('end 越界夹到 size-1（不报错，守界）', () => {
    expect(parseSingleRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('start 越界 → null（拒，不静默回全量）', () => {
    expect(parseSingleRange('bytes=1000-', 1000)).toBeNull()
    expect(parseSingleRange('bytes=5000-6000', 1000)).toBeNull()
  })

  it('多段（含逗号）→ null（不支持，明确拒）', () => {
    expect(parseSingleRange('bytes=0-99,200-299', 1000)).toBeNull()
  })

  it('畸形 → null', () => {
    expect(parseSingleRange('bytes=-', 1000)).toBeNull()
    expect(parseSingleRange('bytes=abc-def', 1000)).toBeNull()
    expect(parseSingleRange('items=0-99', 1000)).toBeNull()
    expect(parseSingleRange(null, 1000)).toBeNull()
  })

  it('size=0 → null（空文件无段可给）', () => {
    expect(parseSingleRange('bytes=0-0', 0)).toBeNull()
  })
})

describe('preview 协议 URL 往返', () => {
  it('handleId → URL → handleId 不丢字符', () => {
    const id = 'h_ABC123.def-456'
    const url = assetPreviewUrl(id)
    expect(url.startsWith('jsl-preview://asset/')).toBe(true)
    const back = assetUrlToHandleId(new URL(url).pathname)
    expect(back).toBe(id)
  })

  it('畸形 pathname → null', () => {
    expect(assetUrlToHandleId('/a/b')).toBeNull()
    expect(assetUrlToHandleId('/')).toBeNull()
    expect(assetUrlToHandleId('no-slash')).toBeNull()
  })
})
