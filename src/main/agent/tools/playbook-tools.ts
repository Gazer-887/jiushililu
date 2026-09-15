// Playbook 工具（plan19 批 3）：`save_playbook` 写、`recall_playbook` 按标签召回。
// 依赖倒置（同 memory-tools.ts）：工具层不碰 electron-store 与 IPC，`repo` 由组合根注入。

import type { AgentTool } from '@shared/agent'
import type { PlaybookRepo } from '@main/memory/playbook-core'

export interface PlaybookToolDeps {
  repo: PlaybookRepo
  conversationId: () => string | null
}

export function createPlaybookTools(deps: PlaybookToolDeps): AgentTool[] {
  const savePlaybook: AgentTool = {
    schema: {
      name: 'save_playbook',
      description:
        '把一条**可复用的操作步骤或经验**写进 Playbook（程序记忆）。' +
        '与 remember 不同：remember 存的是"用户偏好"（懂你线），save_playbook 存的是"怎么做某类任务"（会做线）。' +
        'tags 用于条件召回——下次遇到同类任务时，匹配的条目会被自动注入 system prompt。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '短句 kebab-slug，建后不可改' },
          description: { type: 'string', description: '一行摘要' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（如 ["file-edit", "react"]）' },
          body: { type: 'string', description: '正文：具体步骤 / 注意事项 / 常见坑' }
        },
        required: ['name', 'description', 'tags', 'body']
      }
    },
    async execute(args) {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
      const description = typeof args['description'] === 'string' ? args['description'].trim() : ''
      const body = typeof args['body'] === 'string' ? args['body'] : ''
      const tagsRaw = Array.isArray(args['tags']) ? args['tags'] : []
      const tags = tagsRaw.filter((t: unknown): t is string => typeof t === 'string')

      const result = deps.repo.save({ name, description, tags, body, origin: 'model' })
      return result.ok
        ? `已保存 Playbook「${name}」（标签：${tags.join(', ')}）。下次遇到同类任务会自动召回。`
        : `没有写入：${result.reason}`
    }
  }

  const recallPlaybook: AgentTool = {
    schema: {
      name: 'recall_playbook',
      description:
        '按标签召回匹配的 Playbook 条目正文。' +
        'Playbook 存的是"怎么做某类任务"的步骤——当需要回顾某类操作的经验时调用。',
      parameters: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: '要召回的标签（取交集匹配）' }
        },
        required: ['tags']
      }
    },
    async execute(args) {
      const tagsRaw = Array.isArray(args['tags']) ? args['tags'] : []
      const tags = tagsRaw.filter((t: unknown): t is string => typeof t === 'string')
      if (tags.length === 0) return '请提供至少一个标签。'

      const matched = deps.repo.recall(tags)
      if (matched.length === 0) {
        return `没有匹配「${tags.join(', ')}」的 Playbook 条目。`
      }

      // 落 recall 事件
      for (const entry of matched) {
        deps.repo.record({ kind: 'playbook_recall', conversationId: deps.conversationId(), name: entry.name, found: true })
      }

      return matched
        .map((e) => `【${e.name}｜${e.description}】\n${e.body}`)
        .join('\n\n')
    }
  }

  return [savePlaybook, recallPlaybook]
}
