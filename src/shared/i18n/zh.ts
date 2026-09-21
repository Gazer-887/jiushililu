/**
 * 界面文案真源（plan52 S1）：**这份是权威**，`en.ts` 的类型钉在它上面（`typeof zh`）。
 * 键按**界面区**命名而不是按组件文件 —— 组件会重构，文案 id 不该跟着漂。
 * ⚠️ 只放"给用户看的界面骨架"：模型提示词、日志、`NOTEBOOK/` 文档都不进这里（见 plan52 §一 非目标）。
 */
export const zh = {
  common: {
    newTask: '新建任务',
    search: '搜索',
    cancel: '取消',
    confirm: '确认'
  },
  sidebar: {
    workspace: '工作区',
    emptyConversations: '暂无会话。',
    settings: '设置',
    tagline: '会自己长经验的工作台'
  },
  settings: {
    appearanceSection: '外观',
    theme: '主题',
    language: '界面语言',
    languageHint: '切换即时生效，所有窗口同步。缺译部分回退简体中文。'
  }
} as const
