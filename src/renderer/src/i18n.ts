import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en, zh, NAMESPACES, NAMESPACE_DEFAULT } from '@shared/i18n'
import { LOCALE_DEFAULT, type Locale } from '@shared/splitter'

/**
 * 渲染端的 i18next 实例（plan52 S1）。
 * 真源在 `@shared/i18n` —— 主进程将来产出用户可见串时要复用同一张表（plan52 D4），别在这儿再抄一份。
 */
// ⚠️ 形状是 `{ 语言: { 命名空间: 表 } }` —— 命名空间必须就是 `zh` 的第一层键。
// 想当然地再套一层 `translation` 会让每个键都落空，界面全线退回 key 字面量
// （真渲染门禁三条同时红就是这个形状错，不是断言太严）。
const RESOURCES = {
  zh: Object.fromEntries(NAMESPACES.map((ns) => [ns, zh[ns]])),
  en: Object.fromEntries(NAMESPACES.map((ns) => [ns, en[ns]]))
}

/**
 * ⚠️ 这条**不是**"哪一条没译"的探测器。i18next 的 `missingKeyHandler` 只在**所有语言都查不到**
 * 这个键时才触发（实测：en 缺、zh 有时 `t()` 直接回退中文，回调一次都不进）。
 * 所以它兜的是"键根本没建过"这一种，而"en 漏译"由 `tests/unit/i18n.test.ts` 的
 * **键集对齐判据**在编译/测试期就挡住 —— 那才是缺译的真正防线，别把责任记到这里。
 */
const reportMissing = (langs: readonly string[], ns: string, key: string): void => {
  console.warn('[i18n] 所有语言都查不到这个键（多半是表里漏建，不是漏译）', { key, ns, tried: langs.join(',') })
}

let initialized = false

/** 幂等：`main.tsx` 先调一次，之后 `loadUIPrefs` 只管切语言 */
export function ensureI18n(locale: Locale = LOCALE_DEFAULT): typeof i18n {
  if (!initialized) {
    void i18n.use(initReactI18next).init({
      resources: RESOURCES,
      lng: locale,
      fallbackLng: LOCALE_DEFAULT,
      defaultNS: NAMESPACE_DEFAULT,
      ns: [...NAMESPACES],
      // 缺译由 fallbackLng 兜成中文；saveMissing 只在两边都没有时触发（见 reportMissing 的说明）
      saveMissing: true,
      missingKeyHandler: reportMissing,
      // 文案表已经是成品，不需要复数/插值之外的插件；转义关掉 —— React 自己会转义，双重转义会把 `&` 变成 `&amp;`
      interpolation: { escapeValue: false },
      returnNull: false
    })
    initialized = true
    return i18n
  }
  if (i18n.language !== locale) void i18n.changeLanguage(locale)
  return i18n
}

/**
 * 语言是**文档级**属性（与主题同类）：`<html lang>` 影响字体回退、屏幕阅读器与 CSS `:lang()`，
 * 所以切语言必须同时改它，不能只换文案。
 */
export function applyLocale(locale: Locale): void {
  ensureI18n(locale)
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
}

export { i18n }
