import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '@shared/i18n'
// 门禁与守卫共用同一份解析实现 —— 两处各写一份必然漂移
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateCopy = require('../../scripts/lib/gate-copy.cjs') as {
  tables: { zh: Record<string, string>; en: Record<string, string> }
  textFor: (key: string, locale?: 'zh' | 'en') => string
  textsFor: (key: string) => string[]
}

/**
 * K21 守卫：门禁判据里**不许出现等于 i18n 表内文案的裸字符串**。
 *
 * 起因是实测不是假设：把 ui-prefs 桩的默认语言改成 en 整轮跑 `verify-shot`，稳定红 2 条；
 * 另有定位器在英文态**静默 no-op**（`if (el) el.click()` 不响），后面整批在错界面上空转 ——
 * 那种不叫假红，叫**假绿**，比红贵得多。
 *
 * 四条判据各挡一种坏法：
 * ① CJS 解析出的表必须与 TS 真表逐键逐值相同（两份实现分叉 = 静默漏判）；
 * ② 门禁里每处裸文案都必须被豁免清单**精确**声明条数（多一条 = 新写硬编码）；
 * ③ 豁免条目若实见 0 次即红（少一条 = 那处已改走 textsFor，豁免该删 —— 逼 S3 迁完就清）；
 * ④ 写不出理由的豁免等于把问题改个名字。
 */

const GATE = 'scripts/verify-shot.cjs'

/** 已登记豁免：表键 → { 门禁里以完整字面量出现的条数, 理由 } */
const EXEMPT: Record<string, { count: number; reason: string }> = {
  'sidebar.settings': {
    count: 1,
    reason:
      '设置窗**标题**刻意锁「设置」（不随界面语言变），这条断言的是"标题没被页面 <title> 顶掉"，与翻译无关'
  },
  'common.cancel': {
    count: 2,
    reason:
      '回滚二次确认框与关闭守卫条的按钮**尚未走 t()**（plan52 S3 范围）。' +
      'S3 迁移那一批要同时把这条删掉、门禁改走 textsFor —— 删不掉就是漏迁'
  }
}
const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l)

/** 一行里所有完整字符串字面量（单引号与双引号两种写法） */
const literalsIn = (line: string): string[] =>
  [...line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2])

const flatten = (obj: Record<string, unknown>, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[prefix ? `${prefix}.${k}` : k] = v
    else if (v && typeof v === 'object') Object.assign(out, flatten(v as Record<string, unknown>, prefix ? `${prefix}.${k}` : k))
  }
  return out
}

describe('K21 守卫：门禁不许把界面文案写死进判据', () => {
  /** 表键 → 该键任一语言的文案在门禁里以完整字面量出现的次数 */
  const hitsByKey = new Map<string, number>()
  for (const table of Object.values(gateCopy.tables) as Array<Record<string, string>>) {
    const valueToKey = new Map(Object.entries(table).map(([k, v]) => [v, k]))
    for (const line of readFileSync(GATE, 'utf8').split(/\r?\n/)) {
      if (isComment(line)) continue
      for (const lit of literalsIn(line)) {
        const key = valueToKey.get(lit)
        if (key) hitsByKey.set(key, (hitsByKey.get(key) ?? 0) + 1)
      }
    }
  }

  it('① CJS 解析表与 TS 真表逐键逐值相同（两份实现一漂移就静默漏判）', () => {
    expect(gateCopy.tables.zh).toEqual(flatten(zh as unknown as Record<string, unknown>))
    expect(gateCopy.tables.en).toEqual(flatten(en as unknown as Record<string, unknown>))
  })

  it('② 每处裸文案都被豁免清单精确声明（多一条、少一条都红）', () => {
    const problems: string[] = []
    for (const [key, n] of hitsByKey) {
      const declared = EXEMPT[key]
      if (!declared) problems.push(`键 ${key}「${gateCopy.tables.zh[key]}」实见 ${n} 次，没有豁免`)
      else if (declared.count !== n) problems.push(`键 ${key} 声明 ${declared.count} 次、实见 ${n} 次`)
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('③ 豁免不许过期（实见 0 次就得删 —— S3 迁完忘删，这条当场红）', () => {
    const stale = Object.entries(EXEMPT)
      .filter(([key, e]) => (hitsByKey.get(key) ?? 0) === 0 && e.count > 0)
      .map(([key]) => `${key}（声明 ${EXEMPT[key].count} 次，实见 0 次）`)
    expect(stale, '这些豁免已无对应硬编码，删掉它们：' + stale.join('、')).toEqual([])
  })

  it('④ 每条豁免都写了理由，且键真的在表里', () => {
    for (const [key, e] of Object.entries(EXEMPT)) {
      expect(e.reason.trim().length, `豁免 ${key} 没写理由`).toBeGreaterThan(10)
      expect(key in gateCopy.tables.zh, `豁免 ${key} 不在表里（键改名了？）`).toBe(true)
    }
  })

  it('textFor 对坏键直接抛（拿 undefined 当判据是最难查的静默假失败）', () => {
    expect(() => gateCopy.textsFor('common.压根没有这个键')).toThrow(/i18n 表里没有这个键/)
    expect(gateCopy.textsFor('common.newTask').length).toBeGreaterThan(0)
  })
})
