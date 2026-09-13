import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import {
  SHEET_CLIP_COLS,
  SHEET_CLIP_ROWS,
  SHEET_COUNT_LIMIT,
  clipRange,
  colToNum,
  isDocxPreviewable,
  isMemPreviewToken,
  isSheetPreviewable,
  memPreviewUrl,
  numToCol
} from '@shared/office-preview'
import {
  createMemPreviewStore,
  parseDocxBuffer,
  parseSheetBuffer,
  renderOfficePreview
} from '@main/office-preview'

// Office 内嵌预览（2026-09-14）：判定/截断/内存表是纯逻辑；docx/xlsx 解析在 vitest 里
// 直接喂**真实字节**（JSZip 造最小 docx、SheetJS 造 xlsx）—— 桩测不出解析器的真行为。

// ── shared 纯函数 ──────────────────────────────────────────────────────

describe('Office 判定（按扩展名）', () => {
  it('docx 认，doc 不认（老格式走系统打开）', () => {
    expect(isDocxPreviewable('纪要.docx')).toBe(true)
    expect(isDocxPreviewable('纪要.DOCX')).toBe(true)
    expect(isDocxPreviewable('纪要.doc')).toBe(false)
  })

  it('表格认 xlsx/xlsm/xls，csv 不认（csv 是文本，走文本通道）', () => {
    expect(isSheetPreviewable('a.xlsx')).toBe(true)
    expect(isSheetPreviewable('a.XLSM')).toBe(true)
    expect(isSheetPreviewable('a.xls')).toBe(true)
    expect(isSheetPreviewable('a.csv')).toBe(false)
    expect(isSheetPreviewable('无扩展名')).toBe(false)
  })

  it('只看最后一段扩展名（a.docx.txt 不是文档）', () => {
    expect(isDocxPreviewable('a.docx.txt')).toBe(false)
  })
})

describe('列号换算与截断', () => {
  it('列字母 ↔ 序号互转（A=1, Z=26, AA=27）', () => {
    expect(colToNum('A')).toBe(1)
    expect(colToNum('Z')).toBe(26)
    expect(colToNum('AA')).toBe(27)
    expect(numToCol(1)).toBe('A')
    expect(numToCol(27)).toBe('AA')
  })

  it('clipRange 收右下角，左上角不动', () => {
    expect(clipRange('A1:C600', 500, 50)).toBe('A1:C500')
    expect(clipRange('B3:ZZ900', 500, 50)).toBe('B3:AY502')
    expect(clipRange('A1:C5', 500, 50)).toBe('A1:C5') // 没超限原样返回
  })

  it('畸形 / 空引用返回 null（空 sheet 的 !ref 就是 undefined）', () => {
    expect(clipRange(undefined, 500, 50)).toBeNull()
    expect(clipRange('乱写', 500, 50)).toBeNull()
    expect(clipRange('A1', 500, 50)).toBeNull()
  })

  it('截断上限是"正常表格不受影响"的量级', () => {
    expect(SHEET_CLIP_ROWS).toBeGreaterThanOrEqual(200)
    expect(SHEET_CLIP_COLS).toBeGreaterThanOrEqual(20)
    expect(SHEET_COUNT_LIMIT).toBeGreaterThanOrEqual(5)
  })
})

describe('内存预览 URL / token', () => {
  it('URL 形如 jsl-preview://mem/<64位十六进制>', () => {
    const token = 'a'.repeat(32)
    expect(memPreviewUrl(token)).toBe(`jsl-preview://mem/${token}`)
    expect(isMemPreviewToken(token)).toBe(true)
    expect(isMemPreviewToken('短')).toBe(false)
    expect(isMemPreviewToken('A'.repeat(32))).toBe(false) // 大写不算（token 一律小写 hex）
    expect(isMemPreviewToken(`${'a'.repeat(31)}g`)).toBe(false)
  })
})

// ── 内存预览表（TTL / 上限 / 过期）────────────────────────────────────

describe('createMemPreviewStore', () => {
  it('注册后能取回原文', () => {
    let t = 0
    const store = createMemPreviewStore({ now: () => t })
    const token = store.register('<p>你好</p>')
    expect(store.get(token)).toBe('<p>你好</p>')
  })

  it('TTL 过期后取不到（且条目被清掉）', () => {
    let t = 0
    const store = createMemPreviewStore({ ttlMs: 100, now: () => t })
    const token = store.register('x')
    t = 101
    expect(store.get(token)).toBeNull()
  })

  it('超过上限淘汰最旧（防狂点文档吃穿内存）', () => {
    let t = 0
    const store = createMemPreviewStore({ maxEntries: 2, now: () => t })
    const a = store.register('a')
    t = 1
    const b = store.register('b')
    t = 2
    store.register('c')
    expect(store.get(a)).toBeNull() // 最旧的 a 被淘汰
    expect(store.get(b)).toBe('b')
  })
})

// ── 真实字节解析 ──────────────────────────────────────────────────────

/** 造一个最小的合法 docx（三件套：内容类型 + 根关系 + document.xml） */
async function buildMinimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('parseDocxBuffer（真实 docx 字节）', () => {
  it('正文文字出现在 HTML 里', async () => {
    const buf = await buildMinimalDocx('你好，docx 预览')
    const html = await parseDocxBuffer(buf)
    expect(html).toContain('你好，docx 预览')
    expect(html).toContain('<!doctype html>')
  })

  it('损坏 / 非法字节抛异常（调用方转成友好失败，不崩进程）', async () => {
    await expect(parseDocxBuffer(Buffer.from('这不是 zip'))).rejects.toThrow()
  })
})

function buildXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Buffer {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

describe('parseSheetBuffer（真实 xlsx 字节）', () => {
  it('多 sheet 全部转出，单元格文字在 HTML 里', () => {
    const buf = buildXlsx([
      { name: '原料', rows: [['品名', '数量'], ['氧化铈', 120]] },
      { name: '开支', rows: [['月份', '支出'], ['一月', 42]] }
    ])
    const { sheets, clipped, sheetCount } = parseSheetBuffer(buf)
    expect(sheets.map((s) => s.name)).toEqual(['原料', '开支'])
    expect(sheets[0].html).toContain('氧化铈')
    expect(sheets[1].html).toContain('一月')
    expect(clipped).toBe(false)
    expect(sheetCount).toBe(2)
  })

  it('超 500 行的 sheet 被截断且如实标记', () => {
    const rows: (string | number)[][] = [['列A', '列B']]
    for (let i = 1; i <= 600; i += 1) rows.push([i, `第${i}行`])
    const buf = buildXlsx([{ name: '大表', rows }])
    const { sheets, clipped } = parseSheetBuffer(buf)
    expect(clipped).toBe(true)
    const trCount = (sheets[0].html.match(/<tr/g) ?? []).length
    expect(trCount).toBe(SHEET_CLIP_ROWS)
    // 截断处之后的内容不该出现（"第600行"在第 601 行 —— 表头占了第 1 行）
    expect(sheets[0].html).not.toContain('第600行')
  })

  it('sheet 数超上限只给前 12 个，数量如实报告', () => {
    const sheets = Array.from({ length: SHEET_COUNT_LIMIT + 3 }, (_, i) => ({
      name: `表${i + 1}`,
      rows: [['x']]
    }))
    const { sheets: got, clipped, sheetCount } = parseSheetBuffer(buildXlsx(sheets))
    expect(got).toHaveLength(SHEET_COUNT_LIMIT)
    expect(sheetCount).toBe(SHEET_COUNT_LIMIT + 3)
    expect(clipped).toBe(true)
  })
})

// ── 组装层（临时目录真文件）────────────────────────────────────────────

describe('renderOfficePreview', () => {
  it('docx 走通：返回内存沙箱 URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-office-'))
    try {
      writeFileSync(join(dir, '纪要.docx'), await buildMinimalDocx('会议内容一二三'))
      const res = await renderOfficePreview(dir, '纪要.docx')
      expect(res.ok).toBe(true)
      if (res.ok && res.kind === 'docx') {
        expect(res.url).toMatch(/^jsl-preview:\/\/mem\/[0-9a-f]{32}$/)
      } else {
        throw new Error('应返回 docx 结果')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏的 docx：ok=false 且错误信息能看懂（降级到十六进制的依据）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-office-'))
    try {
      writeFileSync(join(dir, '坏.docx'), Buffer.from('PK 乱写的'))
      const res = await renderOfficePreview(dir, '坏.docx')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('解析失败')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('越界路径拒绝（工作区边界只有一条）', async () => {
    const res = await renderOfficePreview('D:\\不存在的根', '..\\外部.docx')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('越出工作区')
  })

  it('不支持的格式直接拒绝（.docx 之外的 Office 老格式不给解析）', async () => {
    const res = await renderOfficePreview('D:\\x', '演示.pptx')
    expect(res.ok).toBe(false)
  })

  it('超 20 MB 上限：读都不读，明说去用系统程序打开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-office-'))
    try {
      // 只写一个超限的"空壳"：大小检查在解析之前，内容是不是合法 docx 无所谓
      writeFileSync(join(dir, '大.docx'), Buffer.alloc(20 * 1024 * 1024 + 1))
      const res = await renderOfficePreview(dir, '大.docx')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('20 MB')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
