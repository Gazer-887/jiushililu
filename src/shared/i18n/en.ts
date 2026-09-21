import type { Messages } from './index'

/**
 * 英文表（plan52 S1）。类型钉在 `zh` 的形状上：**缺键或多键都在 `npm run typecheck` 就红**，
 * 不等运行时发现（这是选 TS 表而不是 JSON 的全部理由，见 plan52 D2）。
 * 译名以 `./glossary` 为准 —— 同一个术语在两处译成两种样子，是界面最显眼的廉价感来源。
 */
export const en: Messages = {
  common: {
    newTask: 'New task',
    search: 'Search',
    cancel: 'Cancel',
    confirm: 'Confirm'
  },
  sidebar: {
    workspace: 'Workspace',
    emptyConversations: 'No conversations yet.',
    settings: 'Settings',
    tagline: 'A workbench that learns as you work'
  },
  settings: {
    appearanceSection: 'Appearance',
    theme: 'Theme',
    language: 'Language',
    languageHint: 'Applies immediately in every window. Untranslated text falls back to Simplified Chinese.'
  }
}
