// 记忆工具（plan19 §0.3 条 7）：`remember` 写、`recall` 读正文。
// 依赖倒置（同 `goal-tools.ts`）：工具层不碰 electron-store 与 IPC，`repo` 与确认桥由组合根注入。
// ⚠️ 证据指针**不由模型填** —— 会话 id 与轮次由运行时给，否则模型可以伪造来源。

import type { AgentTool } from '@shared/agent'
import { MEMORY_CLASSES, MEMORY_LIMITS, type MemoryClass } from '@shared/memory'
import type { MemoryRepo } from '@main/memory/memory-core'

export interface MemoryToolDeps {
  repo: MemoryRepo
  /** 当前会话 id（写事件与证据指针用） */
  conversationId: () => string | null
  /** 当前轮次（证据指针用）；不给则证据留空 */
  turnIndex?: () => number
  /** 确认桥。判定落「确认档」时问一句；**不给 = 直接拒** —— 宁可拒，不可默默放过 */
  confirm?: (reason: string) => Promise<boolean>
}

const READ_NOTE =
  '只读记忆库本身（notes/），**不读会话正文** —— 要回顾聊天请用别的途径。'

export function createMemoryTools(deps: MemoryToolDeps): AgentTool[] {
  const remember: AgentTool = {
    schema: {
      name: 'remember',
      description:
        '把一条**跨会话长期有用**的信息写进记忆库（用户偏好、项目事实、外部指针）。' +
        '只在用户明确要求记住、或明确表达了长期偏好时调用；一次性的任务细节不要写。' +
        '涉及权限与授权的表述会被拒绝（那属于设置里的权限档，不归记忆管）。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '简短标识（建后不可改，作为取用名）。例：prefers-tables'
          },
          description: {
            type: 'string',
            description: `一行摘要，会被注入到后续对话的提示里（≤${MEMORY_LIMITS.maxDescriptionChars} 字）`
          },
          class: {
            type: 'string',
            enum: [...MEMORY_CLASSES],
            description: 'style=表达偏好；default=做事默认；knowledge=项目事实（需证据）'
          },
          body: { type: 'string', description: '正文（想记住的具体内容）' }
        },
        required: ['name', 'description', 'class', 'body']
      }
    },
    async execute(args) {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
      const description = typeof args['description'] === 'string' ? args['description'].trim() : ''
      const cls = args['class']
      const body = typeof args['body'] === 'string' ? args['body'].trim() : ''
      if (!MEMORY_CLASSES.includes(cls as MemoryClass)) {
        return `错误：class 只能是 ${MEMORY_CLASSES.join(' / ')}`
      }

      const conversationId = deps.conversationId()
      const turnIndex = deps.turnIndex ? deps.turnIndex() : null
      // 会话级指针也是证据；轮次拿不到就不写（**不编造**）
      const evidence =
        conversationId === null
          ? null
          : turnIndex === null
            ? { conversationId }
            : { conversationId, turnIndex }

      const first = deps.repo.save({
        name,
        description,
        class: cls as MemoryClass,
        body,
        origin: 'model',
        evidence
      })
      if (first.ok) return `已记住「${name}」。用户可在工作台的记忆页签里查看或删除它。`
      if (first.needsConfirm !== true) return `没有写入：${first.reason}`

      if (!deps.confirm) return `没有写入：${first.reason}`
      const agreed = await deps.confirm(first.reason)
      if (!agreed) return '用户没有确认，这条没有写入。'

      const second = deps.repo.save({
        name,
        description,
        class: cls as MemoryClass,
        body,
        origin: 'model',
        evidence,
        confirmed: true
      })
      return second.ok ? `已记住「${name}」（用户已确认）。` : `没有写入：${second.reason}`
    }
  }

  const recall: AgentTool = {
    schema: {
      name: 'recall',
      description: `按名取一条记忆的**正文**（索引里只有一行摘要，细节在这里）。${READ_NOTE}`,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '记忆的 name' } },
        required: ['name']
      }
    },
    async execute(args) {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
      const index = deps.repo.list()
      const hit = index.entries.find((e) => e.name === name)
      if (!hit) {
        deps.repo.record({ kind: 'recall', conversationId: deps.conversationId(), name, found: false })
        return `没有名为「${name}」的记忆。可用条目：${index.entries.map((e) => e.name).join('、') || '（无）'}`
      }
      deps.repo.record({ kind: 'recall', conversationId: deps.conversationId(), name, found: true })
      const full = deps.repo.get(hit.file)
      const text = full?.body ?? hit.description
      return `【${hit.name}｜${hit.description}】\n${text}`
    }
  }

  return [remember, recall]
}
