import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  Conversation,
  ConversationCreateInput,
  ConversationMeta
} from '@shared/ipc'

// 会话存储的**纯逻辑**（不依赖 electron / fs，便于单测）：
// 标题推导、工作区标签、分组排序、消息规整，以及**六个入口的完整行为**。
//
// 为什么要抽成"注入 backend"的形状（plan10 步骤 0）：
//   `tests/unit/architecture.test.ts` 的架构守卫要求**单测链路的 import 图里不得出现
//   `electron` / `electron-store`**（CI 是 Linux，没有 Electron 二进制）。
//   而六个入口的可验证行为（标题规则、计数、去重、返回值）**与"谁来存"无关** ——
//   于是把"读一份、写一份"抽成接缝，逻辑留在这里（可单测），
//   electron-store 的装配留在 `conversations.ts`（两行，没有逻辑可测）。
//
// 这也是 A 批分层的前置：先有能锁住行为的网（本文件的基线测试），再动存储结构。

/** 存/取的**唯一**接缝：meta 与正文**分开走**（这就是"分层"的形状） */
export interface ConversationsBackend {
  /** 读全部 meta —— **不含正文**。列表与白名单只该付这个代价 */
  readMeta(): Record<string, ConversationMeta>
  putMeta(id: string, meta: ConversationMeta): void
  removeMeta(id: string): void
  readMessages(id: string): ChatMessage[]
  writeMessages(id: string, messages: ChatMessage[]): void
  removeMessages(id: string): void
}

export interface ConversationsRepo {
  listConversations(): ConversationMeta[]
  getConversation(id: string): Conversation | null
  createConversation(input: ConversationCreateInput): Conversation
  saveConversation(id: string, messages: ChatMessage[]): ConversationMeta | null
  renameConversation(id: string, title: string): ConversationMeta | null
  deleteConversation(id: string): void
  /** 历史会话用过的工作区路径集合——用于收紧 workspace:set-known 的权限面 */
  knownWorkspaces(): string[]
}

/**
 * 存盘前规整消息：**把"没有内容"的消息丢掉**。
 *
 * 这不是防御性编程，而是一个**真实存在的数据丢失渠道**：
 * 渲染端在用户按下发送时**立刻**塞一条 `{ role:'assistant', content:'' }` 的占位
 * （流式回复往它身上长，见 `renderer/src/store.ts` 的 `sendMessage`）。而落盘校验
 * 要求 `content` 至少 1 个字符 —— 于是「流式还没吐字就切会话 / 点停止 / 关窗口」
 * 这几条路**保存必然被拒**；调用方又写的是 `void persistActive()`，
 * 界面上一个字都不会出现，用户只会觉得"我这段对话怎么没存上"。
 *
 * 空内容消息在契约里本来就是非法的（发给模型那条路早就把它 filter 掉了），
 * 所以这里不是"放宽校验"，而是**在存储边界把不合法的东西挡在门外**：
 * 先规整、再上严格校验，两道各司其职。
 */
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.content.trim().length > 0)
}

/** 从首条消息推导会话标题：取首个非空行、去 Markdown 标记、截断 */
export function deriveTitle(firstMessage: string | undefined | null): string {
  const line = (firstMessage ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return '新对话'
  const cleaned = line
    .replace(/[#*`>_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
  const text = cleaned.length > 0 ? cleaned : '新对话'
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

/** 工作区展示名：取路径末段（侧边栏一行放得下），完整路径留给悬停提示 */
export function workspaceLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

export interface ConversationGroup {
  workspace: string
  label: string
  items: ConversationMeta[]
}

/** 按工作区分组：组内按更新时间倒序，组间按各自最新时间倒序（最近用过的排上面） */
export function groupByWorkspace(list: ConversationMeta[]): ConversationGroup[] {
  const map = new Map<string, ConversationMeta[]>()
  for (const c of list) {
    const bucket = map.get(c.workspace)
    if (bucket) bucket.push(c)
    else map.set(c.workspace, [c])
  }
  return [...map.entries()]
    .map(([workspace, items]) => ({
      workspace,
      label: workspaceLabel(workspace),
      items: [...items].sort((a, b) => b.updatedAt - a.updatedAt)
    }))
    .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0))
}

// ── 六个入口（plan10 步骤 0 锁行为、A 批改成分层）────────────────────
//
// 三条与"读盘足迹"有关的约定：
//   · **列表与白名单只读 meta**（不碰任何正文文件）—— 这是分层唯一要换来的东西
//   · **每写一条会话只写它自己那份正文**，不再重写全部会话
//   · **写序：先正文、后索引**。反过来的话，索引里会短暂出现
//     "messageCount 说有 N 条、而正文还不存在"的状态，崩在中间就是"点进去空白"

export function createConversationsRepo(backend: ConversationsBackend): ConversationsRepo {
  return {
    /** 列表：只读 meta。meta 里的 messageCount 在每次保存时同步写好 */
    listConversations() {
      return Object.values(backend.readMeta())
    },

    /** 取一条：meta + 正文（两者分开取，缺正文当空处理） */
    getConversation(id) {
      const meta = backend.readMeta()[id]
      if (!meta) return null
      return { ...meta, messages: backend.readMessages(id) }
    },

    createConversation(input) {
      const now = Date.now()
      const messages: ChatMessage[] = input.firstMessage?.trim()
        ? [{ role: 'user', content: input.firstMessage.trim() }]
        : []
      const meta: ConversationMeta = {
        id: randomUUID(),
        title: deriveTitle(input.firstMessage),
        workspace: input.workspace,
        model: input.model,
        skills: input.skills,
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length
      }
      if (messages.length > 0) backend.writeMessages(meta.id, messages)
      backend.putMeta(meta.id, meta)
      return { ...meta, messages }
    },

    /**
     * 保存消息体。标题为默认值时，用首条用户消息自动补一个（用户没手动改过才覆盖）。
     */
    saveConversation(id, messages) {
      const current = backend.readMeta()[id]
      if (!current) return null
      const firstUser = messages.find((m) => m.role === 'user')?.content
      const shouldRetitle = current.title === '新对话' && Boolean(firstUser)
      const next: ConversationMeta = {
        ...current,
        messageCount: messages.length,
        updatedAt: Date.now(),
        title: shouldRetitle ? deriveTitle(firstUser) : current.title
      }
      // **先正文、后索引**（见上方约定）：索引跟着正文走，不会出现"索引说有、正文没有"
      backend.writeMessages(id, messages)
      backend.putMeta(id, next)
      return next
    },

    renameConversation(id, title) {
      const current = backend.readMeta()[id]
      if (!current) return null
      const clean = title.trim().slice(0, 60)
      // 空标题视为"没改"：原样回 meta，**不落盘**（省一次无意义写）
      if (clean.length === 0) return current
      const next: ConversationMeta = { ...current, title: clean, updatedAt: Date.now() }
      backend.putMeta(id, next)
      return next
    },

    deleteConversation(id) {
      const all = backend.readMeta()
      if (!(id in all)) return
      backend.removeMeta(id)
      backend.removeMessages(id)
    },

    knownWorkspaces() {
      return [...new Set(Object.values(backend.readMeta()).map((m) => m.workspace))]
    }
  }
}
