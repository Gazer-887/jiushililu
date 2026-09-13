import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  Conversation,
  ConversationCreateInput,
  ConversationMeta
} from '@shared/ipc'

// 会话存储的**纯逻辑**（不依赖 electron / fs，便于单测）：标题推导、工作区标签、分组排序、消息规整，
// 以及**六个入口的完整行为**。
//
// 为什么抽成"注入 backend"的形状（plan10 步骤 0）：架构守卫要求单测链路不得出现 electron / electron-store（CI 是 Linux，
// 没有 Electron 二进制），而六个入口的可验证行为与"谁来存"无关 —— 于是把"读一份、写一份"抽成接缝，逻辑留这儿可单测，
// electron-store 的装配留在 `conversations.ts`（两行，没有逻辑可测）。这也是 A 批分层的前置：先有能锁住行为的网，再动存储结构。

/** 把一条消息压成一个可比较的串（前缀比对用；内容一样就算"同一条"） */
function keyOf(m: ChatMessage): string {
  return `${m.role}\u0000${m.content}`
}

/**
 * `prefix` 是不是 `full` 的前缀——**末条允许不同**。
 *
 * 为什么末条要放宽：**流式回复是原地生长的**（先塞一条空助手消息，token 逐段往上长），把末条算进严格比对
 * 的话每吐一个字都判成"不是前缀"，于是每次保存都整份重写，**追加语义就废了**。
 */
function isPrefixWithMutableTail(prefix: ChatMessage[], full: ChatMessage[]): boolean {
  if (prefix.length > full.length) return false
  for (let i = 0; i < prefix.length - 1; i += 1) {
    if (keyOf(prefix[i]!) !== keyOf(full[i]!)) return false
  }
  return true
}

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
  /**
   * 保存消息体。第三个参数是**可选统计**（plan8 R9 用量 / R9.1 省下的量）：给了就更新，不给就**保持原值** ——
   * 回滚 / 改名这类保存不该把账抹掉，而"没有账"与"账为零"是两回事，不能用 undefined 覆盖一个真数字。
   */
  saveConversation(
    id: string,
    messages: ChatMessage[],
    stats?: { usage?: ConversationMeta['usage']; avoidedTokens?: number }
  ): ConversationMeta | null
  renameConversation(id: string, title: string): ConversationMeta | null
  deleteConversation(id: string): void
  /** **回到第 `toIndex` 条消息之前**（B 批 ④ 会话回滚） */
  rollbackConversation(id: string, toIndex: number): RollbackOutcome | null
  /** **撤销上一次回滚**（把被裁掉的尾巴重新接回来） */
  undoRollback(id: string): RollbackOutcome | null
  /** 历史会话用过的工作区路径集合——用于收紧 workspace:set-known 的权限面 */
  knownWorkspaces(): string[]
}

/** 回滚 / 撤销回滚的结果 —— 渲染端**必须用它覆盖内存**（见下方注释） */
export interface RollbackOutcome {
  meta: ConversationMeta
  /** 回滚后**可见**的正文 */
  messages: ChatMessage[]
  /** 完整日志长度（可见 + 被裁掉的尾巴） */
  total: number
  /** 还能不能撤销（= 被裁掉的尾巴还在） */
  canUndo: boolean
}

// ── 回滚的存储形态：**追加 + 游标**（plan10 §2.2，三方独立收敛的那个结论）────
// 正文文件里存的是**完整日志、只追加、从不裁剪**，`meta.messageCount` 同时充当**游标**（可见长度）。于是：回滚 = 把游标
// 往回移（数据一条都不删）；撤销回滚 = 把游标移回末尾（**免费**，这是选这形态最大的理由）；"保留策略（留几轮）"这个问题
// 自动消失（不复制历史，就没有膨胀）。
// ⚠️ 渲染端**必须用回传的 messages 覆盖自己的内存**，否则下一次 `conv:save` 会把已经"回滚掉"的内容又写回来 —— 那就是
// **回滚被自己的界面撤销**（这类功能最经典的事故），返回权威正文就是为了这个。
// ⚠️ 不再单独加 `cursor` 字段：`messageCount` 在用户眼里本来就是**可见条数**，两者是同一个数 —— 老数据没有新字段也照样读得对。

/**
 * 存盘前规整消息：**把"没有内容"的消息丢掉**。这不是防御性编程，而是一条**真实的数据丢失渠道**：渲染端一按发送就塞空
 * `assistant` 占位（流式往它身上长），而落盘校验要求 `content` 至少 1 个字符 —— 于是「没吐字就切会话 / 点停止 / 关窗口」
 * 这几条路**保存必然被拒**；调用方又是 `void persistActive()`，界面无提示、用户只觉得"这段没存上"。空内容消息在契约里本就非法。
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
// 三条与"读盘足迹"有关的约定：**列表与白名单只读 meta**（不碰任何正文文件，这是分层唯一要换来的东西）；
// **每写一条会话只写它自己那份正文**（不再重写全部会话）；**写序：先正文、后索引** —— 反过来的话索引里会
// 短暂出现"messageCount 说有 N 条、而正文还不存在"的状态，崩在中间就是"点进去空白"。

export function createConversationsRepo(backend: ConversationsBackend): ConversationsRepo {
  /** 按游标切出**可见**正文（游标越界一律夹紧 —— 老数据/手改文件都不该让界面炸） */
  function visibleOf(meta: ConversationMeta, log: ChatMessage[]): ChatMessage[] {
    const cursor = Math.max(0, Math.min(meta.messageCount, log.length))
    return log.slice(0, cursor)
  }

  return {
    /** 列表：只读 meta。meta 里的 messageCount 在每次保存时同步写好 */
    listConversations() {
      return Object.values(backend.readMeta())
    },

    /** 取一条：meta + **可见**正文（游标之后的部分是"被回滚掉的尾巴"，不给界面） */
    getConversation(id) {
      const meta = backend.readMeta()[id]
      if (!meta) return null
      return { ...meta, messages: visibleOf(meta, backend.readMessages(id)) }
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
        // 绑定模型档案（plan7 F5）：有就记上；老数据没有这个字段 → 打开时按名字兜底
        ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
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
     * ⚠️ 有了游标之后，这里要**对账**而不是"照单全收"：磁盘上还躺着可能更长的**完整日志**（含被回滚掉的尾巴）。设 `v` = 可见、
     * `t` = 被回滚掉的尾巴、`m` = 渲染端交上来的：① `m` 比 `v` 长（`v` 是它的前缀）→ **真有新消息**：日志 = `m`、`t` **作废**；
     * ② 与之等长 → **原地更新 / 原样回传**：日志 = `m + t`、游标不动 —— **尾巴必须留着**（撤销靠它）；③ `m` 比 `v` 短
     * （`m` 是 `v` 的前缀）→ **回滚**：日志原样不动、只移游标；④ 认不出前缀 → **整份重写**（安全优先，不猜）。
     * 🐞 情形 ② 修的是 0.13.6 一个真 bug：原先 ① 的条件写成 `m.length >= v.length`（把"等长"也划了进去），于是**回滚之后
     * 只要发生一次保存**（切会话 / 点停止 / 关窗口都触发）尾巴就被抹掉，**"撤销"从此静默失效**（回滚看着成功，只有点撤销时才"什么都没发生"）。
     */
    saveConversation(id, messages, stats) {
      const current = backend.readMeta()[id]
      if (!current) return null
      const log = backend.readMessages(id)
      const visible = visibleOf(current, log)
      const tail = log.slice(visible.length)

      let nextLog: ChatMessage[]
      let cursor: number
      if (messages.length > visible.length && isPrefixWithMutableTail(visible, messages)) {
        nextLog = messages // ① 有新消息：尾巴作废
        cursor = messages.length
      } else if (messages.length === visible.length && isPrefixWithMutableTail(visible, messages)) {
        nextLog = [...messages, ...tail] // ② 原地更新 / 原样：**尾巴留着**
        cursor = messages.length
      } else if (messages.length < visible.length && isPrefixWithMutableTail(messages, visible)) {
        nextLog = log // ③ 回滚：不裁数据，只移游标
        cursor = messages.length
      } else {
        nextLog = messages // ④ 整份重写
        cursor = messages.length
      }

      // 补标题的依据仍是"首条 user 消息"（口径与分层前一致，不动它 —— 这条有基线测试钉着）
      const firstUser = nextLog.find((m) => m.role === 'user')?.content
      const shouldRetitle = current.title === '新对话' && Boolean(firstUser)
      const next: ConversationMeta = {
        ...current,
        messageCount: cursor,
        updatedAt: Date.now(),
        title: shouldRetitle ? deriveTitle(firstUser) : current.title
      }
      // 用量账本（plan8 R9）：**只长不缩**，且"没给"不许把已有的抹掉。取 max 而不是直接覆盖：并发两条会话
      // 同时落盘时，晚到的那个若拿着较旧的快照，覆盖会让账**倒退**（用户看着数字变小，比不显示更费解）。
      const usage = stats?.usage
      if (usage) {
        const prev = current.usage
        next.usage = prev
          ? {
              promptTokens: Math.max(prev.promptTokens, usage.promptTokens),
              completionTokens: Math.max(prev.completionTokens, usage.completionTokens)
            }
          : usage
      }
      // 省下的量（plan8 R9.1）：同一条"只长不缩"的规矩
      if (typeof stats?.avoidedTokens === 'number') {
        next.avoidedTokens = Math.max(current.avoidedTokens ?? 0, Math.round(stats.avoidedTokens))
      }
      // **先正文、后索引**（见上方约定）：索引跟着正文走，不会出现"索引说有、正文没有"
      backend.writeMessages(id, nextLog)
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

    /**
     * **回到第 `toIndex` 条消息之前**（保留 `messages[0..toIndex)`）。只移游标、**不删数据** —— 所以这一次操作
     * 天然可撤销，"误点丢消息"这个最坏情况根本不会发生。`toIndex` 夹到 `[0, 日志长度]`：越界不该让界面炸。
     */
    rollbackConversation(id, toIndex) {
      const current = backend.readMeta()[id]
      if (!current) return null
      const log = backend.readMessages(id)
      const target = Math.max(0, Math.min(Math.floor(toIndex), log.length))
      const next: ConversationMeta = { ...current, messageCount: target, updatedAt: Date.now() }
      backend.putMeta(id, next)
      return {
        meta: next,
        messages: log.slice(0, target),
        total: log.length,
        canUndo: target < log.length
      }
    },

    /** 把游标移回末尾 = 撤销上一次回滚（尾巴一直都在盘上，所以这是零成本的） */
    undoRollback(id) {
      const current = backend.readMeta()[id]
      if (!current) return null
      const log = backend.readMessages(id)
      if (current.messageCount === log.length) {
        // 没什么可撤销的（比如回滚后已经又说过话了，尾巴早作废）—— 原样回，不落盘
        return { meta: current, messages: log, total: log.length, canUndo: false }
      }
      const next: ConversationMeta = { ...current, messageCount: log.length, updatedAt: Date.now() }
      backend.putMeta(id, next)
      return { meta: next, messages: log, total: log.length, canUndo: false }
    },

    knownWorkspaces() {
      return [...new Set(Object.values(backend.readMeta()).map((m) => m.workspace))]
    }
  }
}
