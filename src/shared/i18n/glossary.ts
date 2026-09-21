/**
 * 术语唯一译法（plan52 D5）。**这份表是判据的输入**，不是给人看的备忘：
 * `tests/unit/i18n.test.ts` 会拿它去查 `zh` / `en` 两张文案表 —— 中文里含某术语的每条文案，
 * 英文同键必须含该术语的唯一译法，否则红。
 * 收的是**界面会出现的既定词**（与 `DIARY/术语词典.md` 同源），不是通用词典。
 */
export const GLOSSARY: Array<{ zh: string; en: string; note?: string }> = [
  { zh: '工作区', en: 'Workspace' },
  { zh: '新建任务', en: 'New task' },
  { zh: '主题', en: 'Theme' },
  { zh: '会话', en: 'Conversation', note: '复数场景按英文语法加 s，不许换词' },
  { zh: '外观', en: 'Appearance' }
]
