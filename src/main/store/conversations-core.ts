import { randomUUID } from 'node:crypto'
import { addUsage, emptyUsage, type TokenUsage } from '@shared/usage'
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
    stats?: {
      usage?: ConversationMeta['usage']
      avoidedTokens?: number
      /** 最近一次使用的主 Agent（plan17 D9）：给了才更新，不给保持原值——回滚/改名不许抹掉。**空串 = 切回内核默认**（删字段） */
      agentName?: string
      /** 会话正文 UTF-8 字节数（批 2 plan19）：反思前置门用它判断是否值得跑 */
      bodyBytes?: number
    }
  ): ConversationMeta | null
  /**
   * 记一笔**反思用量**（K15）：**累加** —— 每次反思报本次用量，同一条会话多次反思要加得起来。
   * 与 `usage` 的区别：对话那格的总量由渲染端算好后整体写入（那里「没给不许抹」取 max 是对的），
   * 这一格由主进程逐次累加。会话不存在（已删）→ null，不复活。
   */
  addReflectionUsage(id: string, usage: TokenUsage): ConversationMeta | null
  renameConversation(id: string, title: string): ConversationMeta | null
  /**
   * **原子条件改名**（plan26 D-080 智能标题）：仅当当前 title 仍等于 `expected` 时才更新。
   * 智能标题生成是**异步**的（调模型期间用户可能已手动改名）——无条件覆盖会把用户的改名冲掉，
   * 这就是那次竞态的防波堤。返回 null = 条件不成立（标题已被改过）或会话不存在。
   */
  setTitleIfEquals(id: string, expected: string, next: string): ConversationMeta | null
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
 * 这几条路**保存必然被拒**；调用方又是 `void persistActive()`，界面无提示、用户只觉得"这段没存上"。
 * plan36 例外：**带分段的 assistant 即使空正文也保留**——中间轮次可能只有思考/工具没有正文，
 * 丢掉会让渲染索引与磁盘索引错位，`rollbackTo`（按索引移游标）就会切错位置。
 * ⚠️ 发送侧（`chatMessagesSchema`）自 K8 起按角色放行空正文助手轮，**不再与这里同口径**：
 *    那边要的是"发得出去"，这边要的是"存得干净"，把空串挡在模型之外由 `historyForModel` 负责。
 */
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => m.content.trim().length > 0 || (m.role === 'assistant' && (m.segments?.length ?? 0) > 0)
  )
}

/**
 * 落盘预算降级（plan36 坑 4）：`content + segments` 总长超 `MAX_STORED_CHARS` 时，
 * 从**最老**的消息开始丢分段、保正文——分段是回看增强，正文是合同，永远保正文。
 * ⚠️ 必须在 `storedMessagesSchema` 审之前跑：那道门是整条拒存（兜底），这里是能救则救。
 * ⚠️ **空正文消息的 segments 不参与丢弃**（plan36 坑 3 的延伸，2026-09-17 补）：
 * 这类消息（中间轮只有思考/工具没有正文）**靠 segments 才合法**——把它删了就成
 * 「空 content + 无 segments」，`storedMessagesSchema` 会**整批拒存**，比不降级更糟
 * （不降级只是超限，降级后是用户消息全丢）。
 */
export function fitStoredBudget<T extends ChatMessage>(messages: T[], maxChars: number): { messages: T[]; stripped: number } {
  const size = (list: T[]): number =>
    list.reduce((n, m) => n + m.content.length + (m.segments ? JSON.stringify(m.segments).length : 0), 0)
  if (size(messages) <= maxChars) return { messages, stripped: 0 }
  let stripped = 0
  const out = messages.map((m) => ({ ...m }))
  for (let i = 0; i < out.length && size(out) > maxChars; i++) {
    if (out[i].segments && out[i].content.trim().length > 0) {
      delete out[i].segments
      stripped++
    }
  }
  return { messages: out, stripped }
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

// ── 智能标题（plan26 D-080）：prompt 组装与清洗是**纯函数**，放这里让单测盯住 ──

/** 智能标题的输入上限（首条 user / 首答各截这么多字符——标题只需知道"在聊什么"） */
const TITLE_INPUT_MAX = 300

/** 组装标题生成的用户消息（配合 IPC 层的 titleChat 轻调用使用） */
export function buildTitlePrompt(firstUser: string, firstAssistant: string): string {
  const u = (firstUser ?? '').trim().slice(0, TITLE_INPUT_MAX)
  const a = (firstAssistant ?? '').trim().slice(0, TITLE_INPUT_MAX)
  return [
    '根据以下对话开头，起一个能概括主题的短标题。',
    '要求：不超过 12 个字；只输出标题本身，不要引号、前缀、标点结尾或解释。',
    '',
    `【用户】${u}`,
    `【助手】${a}`
  ].join('\n')
}

/**
 * 清洗模型产出的标题：去引号/前缀/换行、截断；清洗后为空 = 无效（调用方退 deriveTitle 的既有标题）。
 * ⚠️ 只做清洗不做"创作"——加词、补全一律不做（宁可保留机械标题，不许编一个）。
 */
export function sanitizeGeneratedTitle(raw: string | undefined | null): string | null {
  let t = (raw ?? '').trim()
  if (!t) return null
  t = t.split(/\r?\n/)[0]!.trim() // 只要第一行（模型偶尔带解释行）
  // 常见前缀/包裹：标题：xxx / 【xxx】 / 《xxx》/"xxx" / xxx。
  t = t.replace(/^(标题|题目|title)\s*[:：]\s*/i, '')
  t = t.replace(/^[【《"'「']+/, '').replace(/[】》"'」'。！？!?]+$/, '')
  t = t.trim()
  if (!t) return null
  if (t.length > 24) t = `${t.slice(0, 24)}…`
  return t
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
        ? [
            {
              role: 'user',
              content: input.firstMessage.trim(),
              ...(input.firstParts ? { parts: input.firstParts } : {})
            }
          ]
        : []
      const meta: ConversationMeta = {
        id: randomUUID(),
        title: deriveTitle(input.firstMessage),
        workspace: input.workspace,
        model: input.model,
        // 绑定模型档案（plan7 F5）：有就记上；老数据没有这个字段 → 打开时按名字兜底
        ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
        // 主 Agent（plan17）：创建时选了才记；缺字段 = 内核默认（老会话零回归）
        ...(input.agentName ? { agentName: input.agentName } : {}),
        skills: input.skills ?? [],
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
      // 主 Agent（plan17 D9）：给才更新，不给保持原值（与 usage 的"没给不许抹"同一原则；它不是账，直接覆盖）。空串 = 切回内核默认
      if (typeof stats?.agentName === 'string') {
        if (stats.agentName === '') delete next.agentName
        else next.agentName = stats.agentName
      }
      // 会话正文 UTF-8 字节数（批 2 plan19）：与 messages 同步更新 —— 反思前置门靠它判断
      if (typeof stats?.bodyBytes === 'number' && Number.isFinite(stats.bodyBytes)) {
        next.bodyBytes = Math.max(0, Math.round(stats.bodyBytes))
      }
      // **先正文、后索引**（见上方约定）：索引跟着正文走，不会出现"索引说有、正文没有"
      backend.writeMessages(id, nextLog)
      backend.putMeta(id, next)
      return next
    },

    addReflectionUsage(id, usage) {
      const current = backend.readMeta()[id]
      if (!current) return null
      // **累加**而不是取 max：每次反思报的是**本次**用量，同一条会话反思过三次就该是三次的和。
      // 算术走 `addUsage`（含"报了 0"与"没报"的区分），不在这儿手写 —— 手写的 `?? 0` 会把 null 加成 NaN。
      const next: ConversationMeta = {
        ...current,
        reflectionUsage: addUsage(current.reflectionUsage ?? emptyUsage(), usage)
      }
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

    setTitleIfEquals(id, expected, next) {
      const current = backend.readMeta()[id]
      if (!current) return null
      // 条件不成立 = 期间有人改过（用户手改 / 另一条智能标题先到）——静默让位，不覆盖
      if (current.title !== expected) return null
      const clean = next.trim().slice(0, 60)
      if (clean.length === 0) return null
      const updated: ConversationMeta = { ...current, title: clean, updatedAt: Date.now() }
      backend.putMeta(id, updated)
      return updated
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
