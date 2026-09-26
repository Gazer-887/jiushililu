import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ATTACH_LIMIT, readAttachment } from '@main/workspace-fs'
import { attachmentsDir, readAttachmentImage, saveAttachmentImage } from '@main/attachments-store'
import { MAX_OUTBOUND_IMAGE_BYTES } from '@shared/content-parts'

// 附件读取（③ 文件拖进会话 / 文件选择框 **共用**这一份；两入口只差"路径从哪来"）
//
// ⚠️ 两层边界待遇不同，**不许一起放松**：绝对路径（主人显式拖进来的）放行并打 outside 标记，
// 相对路径（自家文件树给的）越界一律拒绝 —— 这条线被放松过一次，必须由断言钉住。

/** 最小能过 png 判据的字节：魔数开头 + 一个 NUL（NUL 才让它走二进制分支，不是扩展名） */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

describe('readAttachment（路径 → 附件）', () => {
  let root = ''
  let outsideDir = ''
  let userData = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jsl-attach-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'jsl-outside-'))
    userData = mkdtempSync(join(tmpdir(), 'jsl-userdata-'))
    writeFileSync(join(root, 'a.txt'), 'hello 附件', 'utf8')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'b.txt'), 'nested', 'utf8')
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(ATTACH_LIMIT + 100), 'utf8')
    writeFileSync(join(outsideDir, 'secret.txt'), '工作区外的东西', 'utf8')
    writeFileSync(join(root, 'shot.png'), PNG_BYTES)
    writeFileSync(join(root, 'clip.mp4'), Buffer.concat([PNG_BYTES, PNG_BYTES]))
    writeFileSync(join(root, 'huge.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_OUTBOUND_IMAGE_BYTES + 1, 0)]))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('工作区相对路径 → 读成附件（文件树拖出来就是这条路）', async () => {
    const a = await readAttachment(root, 'a.txt', userData)
    expect(a.name).toBe('a.txt')
    expect(a.content).toBe('hello 附件')
    expect(a.truncated).toBe(false)
    expect(a.path.startsWith(root)).toBe(true)
  })

  it('子目录里的相对路径也能读', async () => {
    const a = await readAttachment(root, 'sub/b.txt', userData)
    expect(a.name).toBe('b.txt')
    expect(a.content).toBe('nested')
  })

  it('绝对路径也认 —— **只要在工作区内**（系统拖进来的就是这条路）', async () => {
    const a = await readAttachment(root, join(root, 'a.txt'), userData)
    expect(a.content).toBe('hello 附件')
    // 在工作区内就不该带"外面"的标记
    expect(a.outside).toBeUndefined()
  })

  it('**工作区外的文件放行，但要标出来**（2026-09-12 用户定案）', async () => {
    // 拖进会话是主人的显式动作（同粘贴）—— 拦下保护不到任何东西，只会让人觉得"拖不进去"
    const outside = join(outsideDir, 'secret.txt')
    const a = await readAttachment(root, outside, userData)
    expect(a.content).toBe('工作区外的东西')
    expect(a.path).toBe(outside)
    expect(a.outside).toBe(true)
  })

  it('用 .. 往外跳仍被拒绝（相对路径这条线**不能松**，它只该来自自家文件树）', async () => {
    const err = (await readAttachment(root, '../secret.txt', userData).catch((e) => e)) as Error
    expect(err.message).toContain('越出了工作区')
    // 被拒的**原始载荷**与**当时的边界**都要原样回显 —— 否则看不出到底是谁越界、边界在哪
    expect(err.message).toContain('../secret.txt')
    expect(err.message).toContain(root)
  })

  it('超过 64KB 截断并**标注**（不假装读全了）', async () => {
    const a = await readAttachment(root, 'big.txt', userData)
    expect(a.truncated).toBe(true)
    expect(a.content.length).toBe(ATTACH_LIMIT)
  })

  it('读不了的文件，错误信息**带上是哪个文件**（不是一句"文件不存在"）', async () => {
    const missing = join(root, 'nope.txt')
    const err = (await readAttachment(root, 'nope.txt', userData).catch((e) => e)) as Error
    expect(err.message).toContain(missing)
  })
})

describe('片③ 图片附件：落盘给引用，绝不把 base64 带回渲染层', () => {
  let root = ''
  let userData = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jsl-img-ws-'))
    userData = mkdtempSync(join(tmpdir(), 'jsl-img-user-'))
    writeFileSync(join(root, 'shot.png'), PNG_BYTES)
    writeFileSync(join(root, 'shot2.png'), Buffer.concat([PNG_BYTES, Buffer.from([0xff])]))
    writeFileSync(join(root, 'clip.mp4'), Buffer.concat([PNG_BYTES, PNG_BYTES]))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('超单图上限的图：拦下并报"约几 MB"，不写盘也不发（D-146 B：不静默降级）', async () => {
    writeFileSync(join(root, 'huge.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_OUTBOUND_IMAGE_BYTES + 1, 0)]))
    const err = (await readAttachment(root, 'huge.png', userData).catch((e) => e)) as Error
    expect(err.message).toContain('huge.png')
    expect(err.message).toContain('超过单张图')
    expect(existsSync(attachmentsDir(userData))).toBe(false)
  })

  it('png → 写进 userData/attachments，返回 ImageRef；content 是空串', async () => {
    const a = await readAttachment(root, 'shot.png', userData)
    expect(a.content).toBe('')
    expect(a.bytes).toBe(PNG_BYTES.length)
    expect(a.image?.mime).toBe('image/png')
    expect(a.image?.bytes).toBe(PNG_BYTES.length)
    // 字节真在盘上，且落在 userData 而不是工作区
    expect(readdirSync(attachmentsDir(userData))).toEqual([a.image!.ref])
    expect(readFileSync(join(attachmentsDir(userData), a.image!.ref))).toEqual(PNG_BYTES)
  })

  it('★ 出境形状里不许有 base64：附件载荷整个 JSON 化后不含图字节', async () => {
    const a = await readAttachment(root, 'shot.png', userData)
    const wire = JSON.stringify(a)
    expect(wire).not.toContain(PNG_BYTES.toString('base64'))
    expect(wire.length).toBeLessThan(400)
  })

  it('★ 同一毫秒连存两张（时钟冻结）⇒ 序号顺延，后一张不许把前一张覆盖掉', () => {
    // 冻结时钟才是真风险形状：名字里那 6 位随机段由时刻异或序号导出，时刻一样、序号不顺延就同名
    const now = () => new Date(1_770_000_000_000)
    const a = saveAttachmentImage(userData, { mime: 'image/png', buf: Buffer.from([1, 2, 3]), now })
    const b = saveAttachmentImage(userData, { mime: 'image/png', buf: Buffer.from([4, 5, 6]), now })
    expect(b!.ref).not.toBe(a!.ref)
    // 覆盖的现场是"两张都在名单上、内容却只剩一份" ⇒ 字节要各自读得回来
    expect(readAttachmentImage(userData, a!.ref)).toEqual(Buffer.from([1, 2, 3]))
    expect(readAttachmentImage(userData, b!.ref)).toEqual(Buffer.from([4, 5, 6]))
  })

  it('引用读回：形状不合法（想穿越）与文件已清理，各报各的，都不静默返回空', () => {
    expect(() => readAttachmentImage(userData, '../../x.png')).toThrow('引用形状不合法')
    expect(() => readAttachmentImage(userData, 'nope.png')).toThrow('引用形状不合法')
    expect(() => readAttachmentImage(userData, '20260101T000000-0-abcdef.png')).toThrow('不存在')
  })

  it('非图片的二进制仍拒（判据是 NUL，扩展名表只作补充），理由要说清收哪些类型', async () => {
    const err = (await readAttachment(root, 'clip.mp4', userData).catch((e) => e)) as Error
    expect(err.message).toContain('clip.mp4')
    expect(err.message).toContain('png/jpg/gif/webp')
  })

})
