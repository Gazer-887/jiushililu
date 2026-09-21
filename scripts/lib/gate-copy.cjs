/**
 * 门禁的文案层（plan52 K21）。
 *
 * 门禁过去把**界面文案的字符串**写死在判据里：那条文案一旦迁进 i18n 表并切到另一种语言，
 * 正向断言假红、定位器静默 no-op（`if (el) el.click()` 不响 → 后面整批在错界面上空转 → **假绿**）。
 * 所以这里给出按**键**取文案的入口，判据里不再出现裸文案。
 *
 * ⚠️ 这份解析同时被 `tests/unit/gate-copy-guard.test.ts` 使用 —— 两处各写一份必然漂移。
 * ⚠️ 只认 `ns: {` 与 `leaf: '值',` 两种行形状（表文件用模板串或跨行拼接时这里认不出，
 *    守卫会**漏判而非误判**；改表写法要回来补用例）。
 */
const fs = require('node:fs')
const path = require('node:path')

const I18N_DIR = path.join(process.cwd(), 'src', 'shared', 'i18n')

/** 把 `src/shared/i18n/<locale>.ts` 解析成 { 'ns.leaf': '文案' } */
function readLocaleTable(locale) {
  const src = fs.readFileSync(path.join(I18N_DIR, `${locale}.ts`), 'utf8')
  const out = {}
  let ns = null
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    const open = line.match(/^([a-zA-Z]\w*):\s*\{\s*$/)
    if (open) {
      ns = open[1]
      continue
    }
    if (/^\}/.test(line)) {
      ns = null
      continue
    }
    const leaf = line.match(/^([a-zA-Z]\w*):\s*'((?:[^'\\]|\\.)*)'\s*,?\s*$/)
    if (leaf && ns) out[`${ns}.${leaf[1]}`] = leaf[2].replace(/\\'/g, "'")
  }
  return out
}

const TABLES = { zh: readLocaleTable('zh'), en: readLocaleTable('en') }

/**
 * 取某语言的文案。键不存在**直接抛** —— 拼错键若返回 undefined，判据会退化成
 * "实际文本永远不等于 undefined"，那是静默假失败里最难查的一种。
 */
function textFor(key, locale = 'zh') {
  const table = TABLES[locale]
  if (!table || !(key in table)) {
    throw new Error(`i18n 表里没有这个键：${locale} / ${key}（门禁判据宁可炸，不拿 undefined 比）`)
  }
  return table[key]
}

/** 键 → 两种语言都接受的文案数组（去重），给 evaluate 里的 `WANT.includes(实际文本)` 用 */
function textsFor(key) {
  return [...new Set([textFor(key, 'zh'), textFor(key, 'en')])]
}

module.exports = { textFor, textsFor, tables: TABLES }
