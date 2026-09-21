import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh, NAMESPACES } from '@shared/i18n'
import { GLOSSARY } from '@shared/i18n/glossary'
import { LOCALE_DEFAULT, LOCALE_KEYS, sanitizeLocale } from '@shared/splitter'

/**
 * 界面双语的判据（plan52 S1）。四组，各管一件"不测就一定会有人做错"的事：
 * ① 两张表的键集必须**完全一样**（少一键 = 英文界面露 key 或回退中文）；
 * ② 已迁移的组件里不许再留裸中文字面量（这条不测，半年后没人知道哪些没迁 —— plan52 风险 R2）；
 * ③ 术语唯一译法（一词两译是界面最显眼的廉价感）；
 * ④ 非法语言值回默认（盘上数据不可信，与 `sanitizeFontScale` 同一口径）。
 */

const flatten = (obj: unknown, prefix = ''): string[] =>
  obj !== null && typeof obj === 'object'
    ? Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
    : [prefix]

const leaves = (table: Record<string, unknown>): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') out.push([path, node])
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k)
      }
    }
  }
  walk(table, '')
  return out
}

describe('双语文案表：键集必须完全对齐', () => {
  it('en 的叶子键集合与 zh 一模一样（多一键、少一键都算错）', () => {
    expect(flatten(en).sort()).toEqual(flatten(zh).sort())
  })

  it('每条都有值，且英文表里不许混进中文（复制粘贴漏翻的红点）', () => {
    for (const [key, value] of leaves(en)) {
      expect(value.trim().length, `en.${key} 是空的`).toBeGreaterThan(0)
      expect(/[\u4e00-\u9fff]/.test(value), `en.${key} 含未翻译的中文：${value}`).toBe(false)
    }
    for (const [key, value] of leaves(zh)) {
      expect(value.trim().length, `zh.${key} 是空的`).toBeGreaterThan(0)
    }
  })

  it('命名空间由 zh 推导，不另立一份清单（两处清单必然漂移）', () => {
    expect([...NAMESPACES].sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('术语唯一译法', () => {
  it('同一中文术语在英文里只许一种写法', () => {
    const seen = new Map<string, string>()
    for (const g of GLOSSARY) {
      expect(seen.has(g.zh), `「${g.zh}」在表里出现两次`).toBe(false)
      seen.set(g.zh, g.en)
    }
    expect(seen.size).toBe(GLOSSARY.length)
  })

  /**
   * 真正会红的一条：中文含某术语的每条文案，英文同键必须含该术语的**唯一译法**。
   * 允许词尾 s（英文复数）与大小写差异，除此之外换词即红。
   */
  it('含术语的中文文案，英文同键必须用表里的译法', () => {
    const zhLeaves = new Map(leaves(zh))
    const enLeaves = new Map(leaves(en))
    for (const g of GLOSSARY) {
      for (const [key, text] of zhLeaves) {
        if (!text.includes(g.zh)) continue
        const actual = (enLeaves.get(key) ?? '').toLowerCase()
        const want = g.en.toLowerCase()
        expect(
          actual.includes(want) || actual.includes(`${want}s`),
          `${key}：中文含「${g.zh}」，英文却写成了「${enLeaves.get(key)}」（术语表要求 ${g.en}）`
        ).toBe(true)
      }
    }
  })
})

describe('语言值：盘上不可信', () => {
  it('合法值原样、非法与缺失回默认', () => {
    for (const k of LOCALE_KEYS) expect(sanitizeLocale(k)).toBe(k)
    expect(sanitizeLocale('fr')).toBe(LOCALE_DEFAULT)
    expect(sanitizeLocale('')).toBe(LOCALE_DEFAULT)
    expect(sanitizeLocale(undefined)).toBe(LOCALE_DEFAULT)
    expect(sanitizeLocale({ key: 'en' })).toBe(LOCALE_DEFAULT)
  })
})

/**
 * 结构守卫（与 `stream-envelope.test.ts` 同手法）：i18n 迁移期最容易发生的是"新组件继续直接写中文"，
 * 而它不会让任何一道编译或行为检查变红。这里对**已迁移的文件**盯住：文案必须走 `t()`。
 * ⚠️ 当前只盯 **JSX 文本位**；`title` / `placeholder` / `aria-label` 这类属性位还没管（Sidebar 里就有），
 * 随 S2 一起扩 —— 记在这儿，别让这条守卫看起来比它实际更严。
 * 白名单按文件收紧，不做全局扫描（未迁文件还很多，全局扫会把这一批淹死）。
 */
describe('已迁移组件不许留裸中文（plan52 风险 R2）', () => {
  const MIGRATED = ['src/renderer/src/components/Sidebar.tsx']
  const CJK_IN_JSX_TEXT = />\s*[^<{}]*[\u4e00-\u9fff]/

  it.each(MIGRATED)('%s： JSX 文本位不留中文字面量，且确实在用 t()', (rel) => {
    const src = readFileSync(rel, 'utf8')
    // 注释里的中文是合法的（本项目注释合同就是中文），只看非注释行
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).toMatch(/useTranslation\(/)
    const offenders = code.split('\n').filter((l) => CJK_IN_JSX_TEXT.test(l))
    expect(offenders, '这些行还在直接写界面文案：\n' + offenders.join('\n')).toEqual([])
  })
})
