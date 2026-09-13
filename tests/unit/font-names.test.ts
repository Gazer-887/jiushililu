import { describe, expect, it } from 'vitest'
import { parseFontRegistryOutput } from '@shared/font-names'

// 系统字体枚举的**解析层**（plan7 批 F3）：一条测试一个 reg query 的格式坑。
// 主进程只管"跑 reg、喂数据"，这里负责把人看的表格变成干净的 family 名列表。
// ⚠️ 格式以 2026-09-14 真机实测为准（Win11）：值名**不带引号**、可含空格，
//    `Arial Bold Italic (TrueType)    REG_SZ    arialbi.ttf` —— 单测桩必须照抄真格式，
//    编一个"想当然"的格式等于没测（引号版那条测试就是这么把真 bug 漏过去的）。

/** 造一段 reg query 输出（对齐真机输出的缩进与空格分隔） */
function regOutput(entries: Array<[string, string]>): string {
  const header = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\r\n'
  return (
    header +
    entries.map(([name, data]) => `    ${name}    REG_SZ    ${data}`).join('\r\n') +
    '\r\n\r\n'
  )
}

describe('parseFontRegistryOutput（reg query 输出 → family 名列表）', () => {
  it('剥掉 (TrueType) 等类型后缀', () => {
    const fonts = parseFontRegistryOutput(regOutput([['Arial (TrueType)', 'arial.ttf']]))
    expect(fonts).toEqual(['Arial'])
  })

  it('支持 OpenType / Bitmap / Vector 标注', () => {
    const fonts = parseFontRegistryOutput(
      regOutput([
        ['A (OpenType)', 'a.otf'],
        ['B (Bitmap)', 'b.fon'],
        ['C (Vector)', 'c.vf']
      ])
    )
    expect(fonts).toEqual(['A', 'B', 'C'])
  })

  it('值名含空格也能整段截出（截到第一个 REG_SZ 为止，不按单词切）', () => {
    const fonts = parseFontRegistryOutput(
      regOutput([['Arial Bold Italic (TrueType)', 'arialbi.ttf']])
    )
    expect(fonts).toEqual(['Arial'])
  })

  it('连体家族按 & 拆开，各自都是合法 family', () => {
    const fonts = parseFontRegistryOutput(
      regOutput([['Microsoft YaHei & Microsoft YaHei UI (TrueType)', 'msyh.ttc']])
    )
    expect(fonts).toEqual(['Microsoft YaHei', 'Microsoft YaHei UI'])
  })

  it('样式变体剥掉样式词（Bold/Italic/Regular），家族名归一', () => {
    const fonts = parseFontRegistryOutput(
      regOutput([
        ['Arial Bold (TrueType)', 'arialbd.ttf'],
        ['Arial Italic (TrueType)', 'ariali.ttf'],
        ['Arial Bold Italic (TrueType)', 'arialbi.ttf'],
        ['Arial (TrueType)', 'arial.ttf']
      ])
    )
    // 四条注册表记录 → 一个 family
    expect(fonts).toEqual(['Arial'])
  })

  it('不剥独立家族：Arial Black / Segoe UI Variable 的名字就是名字', () => {
    // ⚠️ 设计取舍：CSS 里写 "Arial" 调不出 "Arial Black"，剥了会给用户一个"选了没反应"的名字
    const fonts = parseFontRegistryOutput(
      regOutput([
        ['Arial Black (TrueType)', 'ariblk.ttf'],
        ['Segoe UI Variable (TrueType)', 'SegUIVar.ttf']
      ])
    )
    expect(fonts).toEqual(['Arial Black', 'Segoe UI Variable'])
  })

  it('带引号的变体也认（不同 Windows 版本行为有差异，防一手）', () => {
    const raw = '\r\n    "Arial (TrueType)"    REG_SZ    arial.ttf\r\n'
    expect(parseFontRegistryOutput(raw)).toEqual(['Arial'])
  })

  it('去重后按中英混排排序（localeCompare zh-Hans-CN）', () => {
    const fonts = parseFontRegistryOutput(
      regOutput([
        ['微软雅黑 (TrueType)', 'msyh.ttc'],
        ['Arial (TrueType)', 'arial.ttf'],
        ['微软雅黑 (TrueType)', 'msyh.ttc']
      ])
    )
    expect(fonts).toEqual(fonts.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
    expect(new Set(fonts).size).toBe(fonts.length)
  })

  it('忽略没有 REG_SZ 的行（键名行 / 空行 / 损坏行）', () => {
    const raw = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Fonts',
      '',
      '    Arial (TrueType)    REG_SZ    arial.ttf',
      '    broken line without any marker'
    ].join('\r\n')
    expect(parseFontRegistryOutput(raw)).toEqual(['Arial'])
  })

  it('空输出给空列表，不抛', () => {
    expect(parseFontRegistryOutput('')).toEqual([])
    expect(parseFontRegistryOutput('nothing useful here')).toEqual([])
  })
})
