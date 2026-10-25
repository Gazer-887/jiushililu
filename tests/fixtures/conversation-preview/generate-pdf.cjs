// PDF 夹具生成（无第三方依赖，手写最小合法 PDF）。
// 只用于本地测试与实验，产物放 tests/fixtures/conversation-preview/。
// 页数与关键字符串都在单测里被断言 —— 改这个脚本等于改夹具契约。
const fs = require('node:fs')
const path = require('node:path')

/** 文本流：BT/ET 之间放两行文字，字号 16 */
function contentStream(lines) {
  let body = 'BT\n/F1 16 Tf\n72 720 Td\n20 TL\n'
  for (const t of lines) {
    body += `(${t.replace(/([\\()])/g, '\\$1')}) Tj\nT*\n`
  }
  body += 'ET'
  return body
}

/**
 * 造一份 pages 页的 PDF。
 * @param pages 每页一个对象，值为该页文本行数组
 */
function buildPdf(pages) {
  const objs = []
  // 1 = Catalog，2 = Pages
  const pageObjNums = pages.map((_, i) => 3 + i * 2)
  const contentObjNums = pages.map((_, i) => 4 + i * 2)
  const fontObjNum = 3 + pages.length * 2

  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] =
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`
  pages.forEach((lines, i) => {
    objs[pageObjNums[i]] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R >>`
    const cs = contentStream(lines)
    objs[contentObjNums[i]] = `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`
  })
  objs[fontObjNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let n = 1; n < objs.length; n++) {
    if (objs[n] === undefined) continue
    offsets[n] = pdf.length
    pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`
  }
  const xrefOffset = pdf.length
  const count = objs.length
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let n = 1; n < count; n++) {
    const off = offsets[n] ?? 0
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += xref
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return pdf
}

const outDir = __dirname
fs.mkdirSync(outDir, { recursive: true })

// 三页中文 PDF：页数与关键文本都被测试断言
const three = buildPdf([
  ['Jiushililu PDF fixture page 1', 'Conversation preview stage 1'],
  ['Page two content marker', 'abcdefg sample text'],
  ['Final page third section', 'END-OF-FIXTURE-3']
])
fs.writeFileSync(path.join(outDir, 'sample-3page.pdf'), three, 'utf8')

// 单页 PDF（缩放/翻页边界的另一极）
const one = buildPdf([['Single page fixture', 'one-page-only']])
fs.writeFileSync(path.join(outDir, 'sample-1page.pdf'), one, 'utf8')

// 损坏 PDF：头对、xref 错 —— 用于降级路径（真实内容不可渲染）
const broken = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
fs.writeFileSync(path.join(outDir, 'broken.pdf'), broken, 'utf8')

// 许可证与生成方式说明
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  '# 对话内预览夹具\n\n' +
    '- `sample-3page.pdf`：3 页，可检索文本（Jiushililu PDF fixture / Page two content marker / END-OF-FIXTURE-3），由本目录 `generate-pdf.cjs` 无依赖手写生成，无版权素材。\n' +
    '- `sample-1page.pdf`：单页边界夹具。\n' +
    '- `broken.pdf`：头合法但结构损坏，用于降级路径。\n' +
    '- `generate-pdf.cjs`：再生成用 `node generate-pdf.cjs`，产物确定（同输入同字节）。\n',
  'utf8'
)

console.log('fixtures written to', outDir)
