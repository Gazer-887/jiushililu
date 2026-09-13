import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, hexDump, imageMimeOf } from '@shared/fs-tree'

// 二进制预览的纯逻辑（plan7 批 A3）
// ① 哪些扩展名算图片（判错 = 用户看到乱码，或者图片显示不出来）
// ② 十六进制转储的**格式** —— 它是"降级展示"，格式乱了就没法用来辨认文件类型

describe('imageMimeOf（按扩展名判图片）', () => {
  it('常见图片格式都能认出来', () => {
    expect(imageMimeOf('a.png')).toBe('image/png')
    expect(imageMimeOf('a.jpg')).toBe('image/jpeg')
    expect(imageMimeOf('a.jpeg')).toBe('image/jpeg')
    expect(imageMimeOf('a.gif')).toBe('image/gif')
    expect(imageMimeOf('a.webp')).toBe('image/webp')
    expect(imageMimeOf('a.svg')).toBe('image/svg+xml')
  })

  it('大小写不敏感（Windows 上 `PNG` 很常见）', () => {
    expect(imageMimeOf('SHOT.PNG')).toBe('image/png')
    expect(imageMimeOf('Icon.SvG')).toBe('image/svg+xml')
  })

  it('非图片返回 null', () => {
    expect(imageMimeOf('a.ts')).toBeNull()
    expect(imageMimeOf('a.bin')).toBeNull()
    expect(imageMimeOf('README')).toBeNull() // 无扩展名
    expect(imageMimeOf('.gitignore')).toBeNull() // 点开头（点在下标 0）
  })

  it('只看最后一段扩展名（`a.png.txt` 不是图片）', () => {
    expect(imageMimeOf('a.png.txt')).toBeNull()
  })

  it('体积上限是个"能用的图都能过"的值（不要小到把正常截图挡在外面）', () => {
    // 一张 4K 截图通常 2–6MB；上限若小于它，用户会觉得"图片预览根本没用"
    expect(MAX_IMAGE_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024)
  })
})

describe('hexDump（十六进制转储）', () => {
  it('每行 16 字节：偏移 + 十六进制 + ASCII 栏', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const out = hexDump(bytes)
    // 别钉空格的**具体个数** —— 改一下对齐就碎，且碎掉时看不出错在哪；钉结构就好
    expect(out.startsWith('00000000  ')).toBe(true)
    expect(out).toContain('89 50 4e 47 0d 0a 1a 0a')
    expect(out.endsWith('|.PNG....|')).toBe(true)
  })

  it('可打印字符原样显示，其余打点（右侧那栏就是用来认格式的）', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x41])
    const out = hexDump(bytes)
    expect(out).toContain('|PK..A|')
  })

  it('超过 maxBytes 就截断（不把整个文件转成一坨文本）', () => {
    const bytes = new Uint8Array(100).fill(0x41)
    const out = hexDump(bytes, 32)
    expect(out.split('\n')).toHaveLength(2) // 32 字节 = 2 行
  })

  it('偏移随行递增（不然没法定位）', () => {
    const bytes = new Uint8Array(48).fill(0)
    const lines = hexDump(bytes).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('00000000')).toBe(true)
    expect(lines[1].startsWith('00000010')).toBe(true)
    expect(lines[2].startsWith('00000020')).toBe(true)
  })

  it('空输入返回空串（不抛异常）', () => {
    expect(hexDump(new Uint8Array(0))).toBe('')
  })

  it('非法的 maxBytes 不会炸（负数 / NaN）', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(hexDump(bytes, -1)).toBe('')
    expect(hexDump(bytes, Number.NaN)).toBe('')
  })
})
