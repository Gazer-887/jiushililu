import { create } from 'zustand'
import type { Goal, GoalAction } from '@shared/goal'
import type {
  ChatDonePayload,
  ChatMessage,
  ConversationCreateInput,
  ConversationMeta,
  SettingsView,
  StreamEnvelope
} from '@shared/ipc'
import type { SubagentJobEvent, ToolEvent } from '@shared/agent'
import type { BackgroundTask } from '@shared/background'
import type { TodoItem } from '@shared/todo'
import { addUsage, emptyUsage, mergeOptionalMax, type TokenUsage } from '@shared/usage'
import { estimateMessageTokens } from '@shared/tokens'
import {
  DOCK_DEFAULT,
  DOCK_MAX,
  DOCK_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampWidth,
  sanitizeTheme,
  type ThemeName,
  type UIPrefs
} from '@shared/splitter'
import {
  activateTab,
  addPane,
  closeTab,
  emptyLayout,
  emptySizes,
  evenWidths,
  moveTab,
  normalizeSizes,
  openInFilePane,
  openTab,
  removePane,
  setFileTabDirty,
  setFileTabMode,
  toggleCollapse,
  type FileMode,
  type PaneContent,
  type WorkbenchLayout,
  type WorkbenchSizes
} from '@shared/workbench'

// 渲染进程状态：界面数据只放这里，真正的模型请求全部走 IPC 由主进程执行。

export type AppView = 'new' | 'chat' | 'settings'

/**
 * 工作台落盘的**合并窗口**（plan9 §W5 提交点表）：切页签、拖宽这类高频动作
 * 只在停下来之后写一次盘 —— 参照实现每帧同步写盘，是它自己被标注的卡顿源。
 */
const WB_PERSIST_DEBOUNCE_MS = 300
let wbPersistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 后台会话的落盘防抖（plan11 P0-1 兜底）。
 *
 * `markDone` 已经会在跑完时立刻落盘，这一层是防"没等到 done 就被强杀 / 断电"——
 * 把最坏情况从"整轮丢"压到"丢几百毫秒的字"。
 *
 * **每条会话各计一个定时器**：共用一个的话，两条并发会话会互相把对方的落盘推迟。
 */
const BACKSTOP_PERSIST_MS = 800
const backstopTimers = new Map<string, ReturnType<typeof setTimeout>>()

function schedulePersist(conversationId: string): void {
  const existing = backstopTimers.get(conversationId)
  if (existing) clearTimeout(existing)
  backstopTimers.set(
    conversationId,
    setTimeout(() => {
      backstopTimers.delete(conversationId)
      void useAppStore.getState().persistConversation(conversationId)
    }, BACKSTOP_PERSIST_MS)
  )
}

function cancelScheduledPersist(conversationId: string): void {
  const timer = backstopTimers.get(conversationId)
  if (timer) {
    clearTimeout(timer)
    backstopTimers.delete(conversationId)
  }
}

interface AppState {
  view: AppView
  setView: (view: AppView) => void

  // ── 抽屉宽度（plan7 批 A0，可拖拽 + 持久化）───────────
  sidebarWidth: number
  dockWidth: number
  /** 主题（plan7：设置里可切换；切换即写 html[data-theme]，持久化到 ui-prefs） */
  theme: ThemeName
  setTheme: (t: ThemeName) => void
  /** 拖动过程中实时改（不落盘） */
  setSidebarWidth: (w: number) => void
  setDockWidth: (w: number) => void
  /** 松手 / 复位时落盘 */
  persistUIPrefs: (patch: Partial<UIPrefs>) => Promise<void>
  resetUIPrefs: () => Promise<void>
  loadUIPrefs: () => Promise<void>

  // ── 工作台分栏布局（plan9 W2）───────────
  /**
   * 分栏布局。**渲染端是唯一写入源。**
   *
   * ⚠️ 落盘回显**不允许覆盖它** —— 主进程返回的是盘上那份（可能比内存旧），
   * 拿它 set 回去会把界面上"刚开的栏"打回原状。这条是两份独立审查都点到的真问题，
   * 所以下面的 persistUIPrefs 只回显宽度与主题，**故意不回显 workbench**。
   */
  workbench: WorkbenchLayout
  workbenchSizes: WorkbenchSizes
  /** 只改内存（拖拽中 / 连续操作时调），不落盘 */
  setWorkbench: (layout: WorkbenchLayout, sizes?: WorkbenchSizes) => void
  /** 显式落盘（**结构变更**走这条：开栏/关栏/换位/开页签/关页签/折叠） */
  persistWorkbench: () => Promise<void>
  /** 合并落盘（**高频动作**走这条：切页签、拖宽 —— 见 plan9 §W5 提交点表） */
  persistWorkbenchSoon: () => void

  // ── 工作台结构操作（plan9 W3）──
  // 全部只是"纯函数 + 内存 + 落盘"的胶水；模型运算一律在 src/shared/workbench.ts
  wbOpenTab: (paneId: string | null, content: PaneContent) => void
  /**
   * 工作台区**实测可用宽**（渲染端用 ResizeObserver 回报）。
   *
   * 为什么存它：栏数变化时要用「**与容器相称的均分**」当默认值，
   * 而不是拍一个固定像素（`PANE_DEFAULT` 是常数，515px 里开两栏会变成一宽一窄）。
   */
  wbRowWidth: number
  setWbRowWidth: (w: number) => void
  /**
   * 把某个页签挪到**右侧新一栏**（右键页签 → 分栏）。
   *
   * 真机验收后形态改了：**多栏不再是默认形态**，而是"右键页签才出现"的扩展功能 ——
   * 所以这是新建一栏的**唯一入口**（原来那条常驻的 ＋ 已随工作台标题栏一起去掉）。
   */
  wbSplitRight: (paneId: string, tabId: string) => void
  /**
   * 打开文件到「预览栏」（plan9 W6）。
   *
   * 收 `path` 而不是 `PaneContent`，是因为**调用方是文件树**，它手上只有路径；
   * 真正的去重/复用逻辑在 `openInFilePane`（已是纯函数、有单测）：
   * 最后一栏是"纯文件栏"就复用它，否则**在右侧新开一栏**。
   */
  wbOpenFile: (path: string, mode?: FileMode) => void
  wbCloseTab: (paneId: string, tabId: string) => void
  wbActivateTab: (paneId: string, index: number) => void
  wbRemovePane: (paneId: string) => void
  wbToggleCollapse: (paneId: string) => void
  /** 切文件页签的「预览 / 编辑」（plan7 批 A3 范围②） */
  wbSetFileMode: (paneId: string, tabId: string, mode: FileMode) => void
  /** 存 / 清草稿（`undefined` = 清掉）；草稿住布局里，所以切页签、重启都还在 */
  wbSetFileDirty: (paneId: string, tabId: string, dirty: string | undefined) => void

  // ── 抽屉侧栏（面板显隐）───────────
  /** 左侧栏（会话记录 / 设置）是否展开 */
  sidebarOpen: boolean
  toggleSidebar: () => void
  /** 右侧工作台是否展开（plan9 W3 起：展开后显示的是**多栏**工作台） */
  dockOpen: boolean
  toggleDock: () => void

  settings: SettingsView | null
  settingsLoaded: boolean
  loadSettings: () => Promise<void>

  // ── 会话（侧边栏）───────────────
  conversations: ConversationMeta[]
  activeId: string | null
  /** 当前生效的工作区路径（供分支显示等零件感知切换） */
  workspacePath: string
  setWorkspacePath: (path: string) => void
  loadConversations: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  newSession: () => void
  createConversation: (input: ConversationCreateInput) => Promise<string>
  renameConversation: (id: string, title: string) => Promise<void>
  removeConversation: (id: string) => Promise<void>
  /** 把当前消息体落盘（发送完成 / 流结束 / 切走时调用） */
  persistActive: () => Promise<void>

  /**
   * **回到第 `index` 条消息之前**（plan10 B 批 ④）。
   *
   * 两条纪律，缺一条都会出事故：
   *   ① **用主进程回传的权威正文覆盖内存** —— 否则下一次保存会把回滚掉的内容又写回去，
   *      等于"回滚被自己的界面撤销"
   *   ② **回滚后不调用 persistActive** —— 存储那边已经是权威状态，再存一次纯属多余，
   *      而且万一内存与权威不一致还会把错误的状态写回去
   */
  rollbackTo: (index: number) => Promise<void>
  /** 撤销上一次回滚（恢复，不是破坏 —— 不弹确认） */
  undoRollback: () => Promise<void>

  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  /**
   * **落盘失败**提示（与 `streamError` 分开）。
   *
   * 为什么要单独一格：这类失败最容易发生在"切会话 / 点停止 / 关窗口"那一刻，
   * 而切会话会把 `streamError` 清掉 —— 提示一转身就没了，等于没提示。
   */
  saveError: string | null
  /**
   * 刚做完的会话回滚（用于显示「已回滚 M 条 · 撤销」）。
   * `null` = 当前没有可撤销的回滚。
   */
  rollbackNotice: { hidden: number; total: number } | null
  /** 工具执行活动（D-032：界面显示"正在读 xx / 完成 / 失败"）——仅当前轮 */
  toolEvents: ToolEvent[]
  /**
   * 思考流（DeepSeek 系 `reasoning_content`）—— 与正文**分开**存：
   * 它是过程不是回答，用户要看得到"它在想什么"，但不该混进消息内容里。
   * 新一轮开始时清空（见 sendMessage）。
   */
  reasoning: string
  /** 待办清单（plan7 批 D）：Agent 用 update_todos 维护，界面显示在输入框上方 */
  todos: TodoItem[]
  /** 最近一批子代理运行事件（plan7 批 D：右栏「任务」页签） */
  subagents: SubagentJobEvent[]
  /** 后台任务（plan7 批 D）：右栏「任务」页签的"后台任务"区 */
  backgroundTasks: BackgroundTask[]
  setBackgroundTasks: (list: BackgroundTask[]) => void
  /**
   * **后台会话的现场**（plan11 §2.7）。
   *
   * 界面同时只显示一条会话，所以"当前这条"的状态就该在顶层字段里（消费者一行都不用改）；
   * 其余正在跑的会话是**后台态**，存取在这里。切走 → 存档；切回 → 恢复。
   *
   * 为什么不把所有字段都塞进 `runtimes[convId]` 让消费者改读派生值：
   * 那要动 ChatView / InputConsole / TodoPanel / ProcessBlock 一大圈，
   * 而"同时只显示一条"这个语义本来就不需要那份复杂度。
   */
  runtimes: Record<string, RuntimeSnapshot>
  /**
   * **每条会话的真实用量账本**（plan8 R9）。
   *
   * 为什么按会话摊开、而不是像 `messages` 那样只留当前这条：
   * 用量**不需要"切走时存档、切回时恢复"** —— 它是一个只增不减的账本，
   * 各条各记一笔就完了。切会话时界面只是换一个 key 去读，没有中间态可丢。
   *
   * 缺 key = 这条会话还**没拿到过真实用量**（界面据此显示"暂无"，
   * 而不是一个看着像真的 0）。
   */
  usageByConversation: Record<string, ConversationUsage>
  /** 把当前显示会话的现场收进 `runtimes`（切走 / 开跑前调用） */
  archiveCurrent: () => void
  /**
   * 流式片段落位（plan11）：**按信封里的会话 id 找目标** ——
   * 当前显示的那条改顶层字段，后台那条改它的存档。
   * 这就是"切会话不串台"的全部秘密：事件的归属不再靠"谁在显示"来猜。
   */
  appendChunk: (e: StreamEnvelope<string>) => void
  appendReasoning: (e: StreamEnvelope<string>) => void
  pushToolEvent: (e: StreamEnvelope<ToolEvent>) => void
  setTodos: (e: StreamEnvelope<TodoItem[]>) => void
  setSubagents: (e: StreamEnvelope<SubagentJobEvent[]>) => void
  markDone: (e: StreamEnvelope<ChatDonePayload>) => void
  markError: (e: StreamEnvelope<string>) => void
  clearToolEvents: () => void
  sendMessage: (text: string) => Promise<void>
  stopStreaming: () => Promise<void>
  /** 把**指定会话**落盘（plan11 P0-1：后台会话跑完也得有人存它） */
  persistConversation: (id: string) => Promise<void>
  /** 关窗口前把所有在跑的会话落盘（plan11 P0-2）—— 主进程等到回执才真关 */
  flushAll: () => Promise<void>
  // ── 目标（plan12）──
  goals: Goal[]
  loadGoals: (conversationId: string) => Promise<void>
  createGoal: (conversationId: string, text: string) => Promise<void>
  actOnGoal: (id: string, action: GoalAction, patch?: { text?: string; doneWhen?: string }) => Promise<void>
  deleteGoal: (id: string) => Promise<void>
  /**
   * 并发提醒（plan11 §2.3）：同时跑第二条会话时提醒一次"两个会话改同一个工作区会互相覆盖"。
   * **只提醒不拦** —— 应用没法判断两件事会不会碰同一批文件，把知情权交给用户。
   */
  concurrencyNotice: string | null
  dismissConcurrencyNotice: () => void
}

/** 一条会话的用量账本：`total` 全程累计，`last` 是最近一轮（null = 还没跑过） */
export interface ConversationUsage {
  total: TokenUsage
  last: TokenUsage | null
  /**
   * 累计**省下**的估算 token（plan8 R9.1）。
   * 它**不进** `total`：那个数字是厂商真值，这个是我们替它做的减法 —— 混在一起就分不清了。
   */
  avoided: number
}

/**
 * 把**盘上**的用量并进内存账本（plan8 R9 / R9.1）。
 *
 * 为什么取 **max** 而不是"盘上的覆盖内存里的"：这两个来源谁更新并不总是知道 ——
 * 刚落盘、界面还没回来；或者反过来。直接覆盖会让数字**倒退**，
 * 而账本倒退比不显示更难解释（用户会以为自己的账丢了）。
 * 所以规矩是：**只许往前长**。
 *
 * ⚠️ 盘上带回来的只是**累计总量**，不是某一轮 —— 所以 `last` 保持内存里的值，
 * 不拿历史累计去冒充"最近一轮"。
 */
function mergeUsage(
  prev: Record<string, ConversationUsage>,
  metas: ConversationMeta[]
): Record<string, ConversationUsage> {
  let next: Record<string, ConversationUsage> | null = null
  for (const m of metas) {
    const stored = m.usage
    const storedAvoided = m.avoidedTokens ?? 0
    if (!stored && storedAvoided === 0) continue
    const cur: ConversationUsage | undefined = (next ?? prev)[m.id]
    /**
     * 缓存命中 / 推理量（plan8 R9.1 §七①）走**取大**合并，与下面那两个主计数同一个道理：
     * 任一来源报过就是"已知"，两边都报就取大的（覆盖会让数字倒退）。
     * 两边都没报才保持未知 —— 那时界面显示"—"，**不写 0**。
     */
    const cached = mergeOptionalMax(cur?.total.cachedPromptTokens, stored?.cachedPromptTokens)
    const reasoning = mergeOptionalMax(cur?.total.reasoningTokens, stored?.reasoningTokens)
    const total: TokenUsage = cur
      ? {
          promptTokens: Math.max(cur.total.promptTokens, stored?.promptTokens ?? 0),
          completionTokens: Math.max(cur.total.completionTokens, stored?.completionTokens ?? 0),
          ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
          ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
        }
      : (stored ?? { promptTokens: 0, completionTokens: 0 })
    const avoided = Math.max(cur?.avoided ?? 0, storedAvoided)
    const same =
      cur &&
      total.promptTokens === cur.total.promptTokens &&
      total.completionTokens === cur.total.completionTokens &&
      (total.cachedPromptTokens ?? null) === (cur.total.cachedPromptTokens ?? null) &&
      (total.reasoningTokens ?? null) === (cur.total.reasoningTokens ?? null) &&
      avoided === cur.avoided
    if (same) continue
    next = { ...(next ?? prev), [m.id]: { total, last: cur?.last ?? null, avoided } }
  }
  return next ?? prev
}

/** 一条会话的运行时现场（plan11 §2.7）—— 只有后台会话需要它 */
export interface RuntimeSnapshot {
  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  reasoning: string
  toolEvents: ToolEvent[]
  todos: TodoItem[]
  subagents: SubagentJobEvent[]
}

/** 当前上下文用量估算（口径与主进程一致，见 @shared/tokens） */
export function usedTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m.content), 0)
}

/** 一条会话的现场快照（深拷贝一层 —— 存引用的话，切来切去两边会互相改） */
function snapshotOf(s: {
  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  reasoning: string
  toolEvents: ToolEvent[]
  todos: TodoItem[]
  subagents: SubagentJobEvent[]
}): RuntimeSnapshot {
  return {
    messages: s.messages.map((m) => ({ ...m })),
    streaming: s.streaming,
    streamError: s.streamError,
    reasoning: s.reasoning,
    toolEvents: s.toolEvents.slice(),
    todos: s.todos.slice(),
    subagents: s.subagents.slice()
  }
}

/** 往"最后一条助手消息"后面接字（与旧行为一致：片段只接在回答上） */
function appendToTail(messages: ChatMessage[], text: string): ChatMessage[] {
  const next = messages.slice()
  const last = next[next.length - 1]
  if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + text }
  return next
}

/** 读用视图：顶层字段**本身就是**当前会话的视图 —— 这里不做深拷贝（深拷贝只在存档时做） */
function viewOf(s: {
  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  reasoning: string
  toolEvents: ToolEvent[]
  todos: TodoItem[]
  subagents: SubagentJobEvent[]
}): RuntimeSnapshot {
  return {
    messages: s.messages,
    streaming: s.streaming,
    streamError: s.streamError,
    reasoning: s.reasoning,
    toolEvents: s.toolEvents,
    todos: s.todos,
    subagents: s.subagents
  }
}

/**
 * **分流器**（plan11 §2.7）—— 全计划唯一的新逻辑。
 *
 * 一次改动该落到哪儿，取决于"它在哪条会话上"：
 *   · 就是当前显示的那条 → 改**顶层字段**（消费者一行都不用改）
 *   · 是后台那条 → 改**它的存档**
 *
 * ⚠️ 回调只返回**改动的字段**（`Partial`），不返回整份现场：
 * 流式期间这个方法**每来一个字就调一次**，让它顺手深拷贝整条会话，
 * 等于把"打字"变成"每字一次全量复制" —— 会话越长越慢（老代码只做 `messages.slice()`）。
 *
 * 后台会话**没有存档**时：什么都不做并告警，绝不凭空造一份空的 ——
 * 那会让下一次落盘把"空内容"覆盖到真实会话上（丢数据，而且是静默的）。
 * 存档会在 `sendMessage` 时先种下，所以这条分支理论上走不到，留着是为了**不冒这个险**。
 */
function applyToConversation(
  s: AppState,
  conversationId: string,
  patch: (view: RuntimeSnapshot) => Partial<RuntimeSnapshot>
): Partial<AppState> {
  if (conversationId === s.activeId) {
    const next = patch(viewOf(s))
    const out: Partial<AppState> = {}
    if (next.messages !== undefined) out.messages = next.messages
    if (next.streaming !== undefined) out.streaming = next.streaming
    if (next.streamError !== undefined) out.streamError = next.streamError
    if (next.reasoning !== undefined) out.reasoning = next.reasoning
    if (next.toolEvents !== undefined) out.toolEvents = next.toolEvents
    if (next.todos !== undefined) out.todos = next.todos
    if (next.subagents !== undefined) out.subagents = next.subagents
    return out
  }
  const current = s.runtimes[conversationId]
  if (!current) {
    console.warn('[store] 收到不属于任何已知会话的事件，已丢弃', { conversationId })
    return {}
  }
  return { runtimes: { ...s.runtimes, [conversationId]: { ...current, ...patch(current) } } }
}

export const useAppStore = create<AppState>((set, get) => ({
  view: 'new',
  setView: (view) => set({ view }),

  // ── 抽屉宽度 + 主题（plan7 批 A0 / 外观自定义）──
  sidebarWidth: SIDEBAR_DEFAULT,
  dockWidth: DOCK_DEFAULT,
  theme: 'classic',
  setTheme: (t) => {
    const theme = sanitizeTheme(t)
    set({ theme })
    // 切换即时生效：写根元素的 data-theme（CSS 侧由 html[data-theme='ink'] 覆盖变量）
    document.documentElement.dataset.theme = theme
    void useAppStore.getState().persistUIPrefs({ theme })
  },
  setSidebarWidth: (w) => set({ sidebarWidth: clampWidth(w, SIDEBAR_MIN, SIDEBAR_MAX) }),
  setDockWidth: (w) => set({ dockWidth: clampWidth(w, DOCK_MIN, DOCK_MAX) }),
  persistUIPrefs: async (patch) => {
    // 落盘失败不影响界面（宽度已经改了，只是下次重开回到默认）
    try {
      const next = await window.api.setUIPrefs(patch)
      // theme 走 sanitizeTheme 保底：主进程万一返回缺 theme 的数据，
      // 不能让 UI 进入「两个主题都没选中」的死角（真实渲染验证抓到过）
      //
      // ⚠️ 这里**故意不回显 workbench / workbenchSizes**：主进程返回的是盘上那份，
      //    可能比内存旧；回显会把「刚开的栏」打回原状（plan9 §W2 明写的规则）。
      set({
        sidebarWidth: next.sidebarWidth,
        dockWidth: next.dockWidth,
        theme: sanitizeTheme(next.theme)
      })
    } catch {
      // 忽略：布局偏好不是关键数据
    }
  },
  resetUIPrefs: async () => {
    // 「恢复默认布局」—— 布局**要**跟着复位，否则这个按钮对工作台是空操作
    try {
      const next = await window.api.resetUIPrefs()
      set({
        sidebarWidth: next.sidebarWidth,
        dockWidth: next.dockWidth,
        theme: sanitizeTheme(next.theme),
        workbench: next.workbench,
        workbenchSizes: next.workbenchSizes
      })
    } catch {
      set({
        sidebarWidth: SIDEBAR_DEFAULT,
        dockWidth: DOCK_DEFAULT,
        theme: 'classic',
        workbench: emptyLayout(),
        workbenchSizes: emptySizes()
      })
    }
  },
  loadUIPrefs: async () => {
    try {
      const prefs = await window.api.getUIPrefs()
      set({
        sidebarWidth: prefs.sidebarWidth,
        dockWidth: prefs.dockWidth,
        theme: sanitizeTheme(prefs.theme),
        workbench: prefs.workbench,
        workbenchSizes: prefs.workbenchSizes
      })
      // 启动即应用主题（否则刷新/重开会闪回默认主题）
      document.documentElement.dataset.theme = sanitizeTheme(prefs.theme)
    } catch {
      // 保持默认值
    }
  },

  workbench: emptyLayout(),
  workbenchSizes: emptySizes(),
  setWorkbench: (layout, sizes) =>
    set((s) => ({
      workbench: layout,
      workbenchSizes:
        sizes ??
        // 栏数**没变**：只把宽度数组的长度对齐（拖宽、切页签都走这条，宽度原样保留）
        (layout.panes.length === s.workbench.panes.length
          ? normalizeSizes(s.workbenchSizes, layout.panes.length)
          : // 栏数**变了**（分栏/关栏/开窗）：用「与容器相称的均分」当默认。
            // 原来是给每栏拍 PANE_DEFAULT(320)，在 515px 里开两栏会得到一宽一窄；
            // 均分才像"分栏"，而不是像"随手拖了一下"
            evenWidths(layout.panes.length, s.wbRowWidth))
    })),
  persistWorkbench: async () => {
    const { workbench, workbenchSizes } = get()
    await useAppStore.getState().persistUIPrefs({ workbench, workbenchSizes })
  },
  persistWorkbenchSoon: () => {
    if (wbPersistTimer !== null) clearTimeout(wbPersistTimer)
    wbPersistTimer = setTimeout(() => {
      wbPersistTimer = null
      void useAppStore.getState().persistWorkbench()
    }, WB_PERSIST_DEBOUNCE_MS)
  },

  wbOpenTab: (paneId, content) => {
    // 点了面板就必须看得见 —— 否则是"点了没反应"（默认布局是空的）
    set({ dockOpen: true })
    get().setWorkbench(openTab(get().workbench, paneId, content))
    void get().persistWorkbench()
  },
  wbRowWidth: 360,
  setWbRowWidth: (w) => set({ wbRowWidth: Number.isFinite(w) ? w : 0 }),
  wbSplitRight: (paneId, tabId) => {
    const cur = get().workbench
    const at = cur.panes.findIndex((p) => p.id === paneId)
    if (at < 0) return
    const added = addPane(cur, null, at + 1)
    if (added === cur) return // 到栏数上限：原样不动，界面该给提示
    const newPane = added.panes[at + 1]
    const next = moveTab(added, paneId, tabId, newPane.id)
    // 栏数变了 → setWorkbench 会自动给"与容器相称的均分"（不必在这里算宽度）
    get().setWorkbench(next)
    void get().persistWorkbench()
  },
  wbOpenFile: (path, mode = 'preview') => {
    set({ dockOpen: true })
    get().setWorkbench(openInFilePane(get().workbench, path, mode))
    void get().persistWorkbench()
  },
  wbCloseTab: (paneId, tabId) => {
    get().setWorkbench(closeTab(get().workbench, paneId, tabId))
    void get().persistWorkbench()
  },
  wbActivateTab: (paneId, index) => {
    get().setWorkbench(activateTab(get().workbench, paneId, index))
    get().persistWorkbenchSoon() // 切页签是高频动作 → 合并落盘
  },
  wbRemovePane: (paneId) => {
    get().setWorkbench(removePane(get().workbench, paneId))
    void get().persistWorkbench()
  },
  wbToggleCollapse: (paneId) => {
    get().setWorkbench(toggleCollapse(get().workbench, paneId))
    void get().persistWorkbench()
  },
  /** 切「预览 / 编辑」（草稿不动） */
  wbSetFileMode: (paneId, tabId, mode) => {
    get().setWorkbench(setFileTabMode(get().workbench, paneId, tabId, mode))
    get().persistWorkbenchSoon()
  },
  /** 存 / 清草稿：打字时高频触发 → **必须走防抖**，否则每个键都写一次盘 */
  wbSetFileDirty: (paneId, tabId, dirty) => {
    get().setWorkbench(setFileTabDirty(get().workbench, paneId, tabId, dirty))
    get().persistWorkbenchSoon()
  },

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  dockOpen: false,
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),

  settings: null,
  settingsLoaded: false,
  loadSettings: async () => {
    const settings = await window.api.getSettings()
    set({ settings, settingsLoaded: true })
  },

  conversations: [],
  activeId: null,
  workspacePath: '',
  setWorkspacePath: (workspacePath) => set({ workspacePath }),

  loadConversations: async () => {
    const conversations = await window.api.listConversations()
    // 列表里就带着用量账本（它存在会话索引里）→ 顺手并进内存，不必等哪条会话被打开
    set({ conversations, usageByConversation: mergeUsage(get().usageByConversation, conversations) })
  },

  openConversation: async (id) => {
    const prev = get().activeId
    await get().persistConversation(prev ?? '') // 切走前先把当前会话存好（空 id = 什么都没做）
    const conv = await window.api.getConversation(id)
    if (!conv) {
      await get().loadConversations()
      return
    }
    // 会话绑定的工作区若与当前不同，一并切过去（历史按工作区分组的自然结果）
    await window.api.setKnownWorkspace(conv.workspace)
    set({ workspacePath: conv.workspace })
    // 切模型（plan7 F5）：**优先按档案 id** —— 它才能定位"哪条连接 + 哪把 Key"。
    // 老会话没有 id → 按**名字**找同名档案（主进程内部兜底），找不到就沿用当前档案：
    // 三条路都不会让会话打不开，也**不会因为升级而丢模型绑定**。
    if (conv.modelProfileId) {
      try {
        await window.api.setActiveModel(conv.modelProfileId)
        await get().loadSettings()
      } catch {
        // 那条档案可能已被删除 → 回落到当前档案（不打扰用户，因为"能继续用"比"精确匹配"重要）
      }
    } else if (conv.model && conv.model !== get().settings?.model) {
      await window.api.setModel(conv.model)
      await get().loadSettings()
    }
    // **存档 / 恢复**（plan11 §2.7）：
    //   ① 把"正在显示的这一条"收进它的存档（否则切回来就没了）
    //   ② 若目标会话**正在跑**（存档里有 streaming），恢复它的现场 —— 用户切回来能接着看它吐字
    //   ③ 否则按存储里的内容重建
    get().archiveCurrent()
    const snap = get().runtimes[id]
    set({
      activeId: id,
      messages: snap ? snap.messages.slice() : conv.messages,
      view: 'chat',
      streamError: snap ? snap.streamError : null,
      streaming: snap ? snap.streaming : false,
      toolEvents: snap ? snap.toolEvents.slice() : [],
      // 思考流也要清：它是**当前轮**的过程，切会话还留着就成了"上一个任务的幽灵"
      reasoning: snap ? snap.reasoning : '',
      todos: snap ? snap.todos.slice() : [],
      subagents: snap ? snap.subagents.slice() : []
    })
    // 用量账本跟着这条会话一起进来（`conv` 是 meta + 正文，meta 里就带账）
    set((s) => ({ usageByConversation: mergeUsage(s.usageByConversation, [conv]) }))
  },

  newSession: () =>
    set({
      view: 'new',
      activeId: null,
      messages: [],
      streamError: null,
      toolEvents: [],
      reasoning: ''
    }),

  createConversation: async (input) => {
    const conv = await window.api.createConversation(input)
    await get().loadConversations()
    // **这一处原本漏了**：新建任务不清过程状态 → 上一轮的工具卡片与思考残留在新会话里，
    // 把界面占满、报告反倒看不见（用户实测反馈的真凶）
    set({
      activeId: conv.id,
      messages: conv.messages,
      view: 'chat',
      streamError: null,
      toolEvents: [],
      reasoning: ''
    })
    return conv.id
  },

  renameConversation: async (id, title) => {
    await window.api.renameConversation(id, title)
    await get().loadConversations()
  },

  removeConversation: async (id) => {
    await window.api.deleteConversation(id)
    if (get().activeId === id) {
      set({ activeId: null, messages: [], view: 'new' })
    }
    await get().loadConversations()
  },

  messages: [],
  streaming: false,
  streamError: null,
  saveError: null,
  rollbackNotice: null,
  toolEvents: [],
  todos: [],
  subagents: [],
  backgroundTasks: [],
  runtimes: {},
  usageByConversation: {},
  reasoning: '',

  clearToolEvents: () => set({ toolEvents: [] }),

  rollbackTo: async (index) => {
    const { activeId } = get()
    if (!activeId) return
    try {
      // `null` = 用户拒了确认框 / 本来就没东西可回滚 —— 两种都**什么都不做**
      const res = await window.api.rollbackConversation(activeId, index)
      if (!res) return
      const visible = res.conversation.messages
      set((s) => ({
        // ① 权威正文覆盖内存（**这一条是整件事的关键**）
        messages: visible,
        rollbackNotice: { hidden: res.total - visible.length, total: res.total },
        // 侧边栏那条跟着更新（条数与时间都变了）
        conversations: s.conversations.map((c) =>
          c.id === activeId
            ? { ...c, messageCount: res.conversation.messageCount, updatedAt: res.conversation.updatedAt }
            : c
        )
      }))
      // ② 刻意**不**调用 persistActive：存储里已经是权威状态
    } catch (err) {
      // 正在生成回复时主进程会拒绝 —— 理由要原样给用户看
      set({ streamError: err instanceof Error ? err.message : String(err) })
    }
  },

  undoRollback: async () => {
    const { activeId } = get()
    if (!activeId) return
    try {
      const res = await window.api.undoRollbackConversation(activeId)
      if (!res) return
      set((s) => ({
        messages: res.conversation.messages,
        rollbackNotice: null, // 撤完了就没什么可撤销的了
        conversations: s.conversations.map((c) =>
          c.id === activeId
            ? { ...c, messageCount: res.conversation.messageCount, updatedAt: res.conversation.updatedAt }
            : c
        )
      }))
    } catch (err) {
      set({ streamError: err instanceof Error ? err.message : String(err) })
    }
  },
  appendReasoning: (e) =>
    set((s) =>
      applyToConversation(s, e.conversationId, (v) => ({ reasoning: v.reasoning + e.payload }))
    ),

  setTodos: (e) => set((s) => applyToConversation(s, e.conversationId, () => ({ todos: e.payload }))),

  setSubagents: (e) =>
    set((s) => applyToConversation(s, e.conversationId, () => ({ subagents: e.payload }))),

  setBackgroundTasks: (list) => set({ backgroundTasks: list }),

  pushToolEvent: (e) =>
    set((s) =>
      applyToConversation(s, e.conversationId, (v) => {
        // 同一调用（id）的 start→end 就地更新，避免堆两条
        const idx = v.toolEvents.findIndex((x) => x.id === e.payload.id)
        if (idx >= 0) {
          const next = v.toolEvents.slice()
          next[idx] = e.payload
          return { toolEvents: next }
        }
        return { toolEvents: [...v.toolEvents, e.payload] }
      })
    ),

  archiveCurrent: () => {
    const s = get()
    if (!s.activeId) return
    set((prev) => ({ runtimes: { ...prev.runtimes, [s.activeId as string]: snapshotOf(s) } }))
  },

  appendChunk: (e) => {
    set((s) =>
      // ⚠️ 只返回改动的那一个字段（不是整份现场）—— 这个回调**每来一个字就调一次**
      applyToConversation(s, e.conversationId, (v) => ({
        messages: appendToTail(v.messages, e.payload)
      }))
    )
    // 后台会话加一道**防抖落盘**兜底：万一应用被强杀，最多丢几百毫秒的字
    if (e.conversationId !== get().activeId) schedulePersist(e.conversationId)
  },

  markDone: (e) => {
    // 收尾带货（plan8 R9）：真实用量累加进**那一条会话**的账本。
    // `null` = 厂商没报 → 账本一动都不动（宁可显示"暂无"，也不写一笔假账）
    // 缺字段就当"厂商没报"：信封的另一头是**另一个进程**，
    // 版本不齐 / 事件被截断都可能让 payload 给不出 usage —— 这里不许直接炸
    const usage = e.payload?.usage ?? null
    const avoided = e.payload?.avoided ?? 0
    set((s) => {
      const prev = s.usageByConversation[e.conversationId]
      const nextUsage: ConversationUsage | null =
        usage || avoided > 0
          ? {
              total: usage ? addUsage(prev?.total ?? emptyUsage(), usage) : (prev?.total ?? emptyUsage()),
              last: usage ?? prev?.last ?? null,
              avoided: (prev?.avoided ?? 0) + avoided
            }
          : null
      return {
        ...applyToConversation(s, e.conversationId, () => ({ streaming: false })),
        ...(nextUsage ? { usageByConversation: { ...s.usageByConversation, [e.conversationId]: nextUsage } } : {})
      }
    })
    // ⚠️ 落的是**那一条**（不是当前显示的那条）—— plan11 P0-1 就是这一行的缺失
    void get().persistConversation(e.conversationId)
  },

  markError: (e) => {
    set((s) =>
      applyToConversation(s, e.conversationId, () => ({
        streaming: false,
        streamError: e.payload
      }))
    )
    // 错到一半的内容也是内容，照样落盘
    void get().persistConversation(e.conversationId)
  },

  sendMessage: async (text) => {
    const content = text.trim()
    // 并发之后"这次跑属于哪条会话"必须明确（plan11）：没有归属就发不出去
    const conversationId = get().activeId
    if (!content || get().streaming) return
    if (!conversationId) {
      set({ streamError: '这条消息没有归属的会话：请先新建会话再发送' })
      return
    }
    const history = get().messages.filter((m) => m.content.trim().length > 0)
    const payload = [...history, { role: 'user' as const, content }]
    set({
      messages: [...payload, { role: 'assistant', content: '' }],
      streaming: true,
      streamError: null,
      toolEvents: [], // 新一轮，清掉上一轮的工具活动
      reasoning: '' // 思考流同样新一轮重来
    })
    // **先把这条会话的现场存进存档**：它一旦被切到后台，
    // 属于它的片段才知道该往哪儿落（不然只能丢）
    get().archiveCurrent()

    // 并发提醒（plan11 §2.3）：**只提醒一次，不拦** ——
    // 两个会话同时改同一个工作区文件夹会互相覆盖，这是用法层面的风险，
    // 应用没法替用户判断"这两件事会不会碰同一批文件"，所以把知情权交给他。
    const othersRunning = Object.entries(get().runtimes).filter(
      ([id, r]) => id !== conversationId && r.streaming
    )
    if (othersRunning.length > 0) {
      set({
        concurrencyNotice:
          `现在有 ${othersRunning.length} 条会话也在跑。两个会话同时改同一个工作区文件夹会互相覆盖文件 —— ` +
          `要么错开跑，要么留意一下它们动的是不是同一批文件。`
      })
    }

    try {
      await window.api.chatSend({ conversationId, messages: payload })
    } catch {
      // 主进程入参校验失败等；常规错误已通过 chatError 事件送达
      get().markError({ conversationId, payload: '发送失败：请求被主进程拒绝（参数校验未通过）' })
    }
  },

  stopStreaming: async () => {
    // 并发之后"停止"必须指名道姓（plan11）：不指名就是停错会话
    const conversationId = get().activeId
    if (conversationId) await window.api.chatAbort(conversationId)
    // **必须自己把 streaming 收回去**，不能只指望主进程随后发 `chat:done`：
    // 那条事件万一没到（订阅被拆过、页面在后台、渲染进程刚重载），界面就永远停在
    // "生成中"——发送键一直是「停止」，而点它正是这里，点完还是"生成中"，**死循环**。
    // 用户按了停止，界面就必须停止显示"正在生成"：这是**意图**，不是**投影**。
    set({ streaming: false })
    await get().persistConversation(conversationId ?? '')
  },

  /**
   * 把**指定会话**落盘（plan11 P0-1）。
   *
   * 与老的 `persistActive` 的差别只有一个词：**谁**。这个"谁"就是后台会话
   * 跑完之后还能不能留住的分界线 —— 以前所有落盘都写死当前会话，
   * 于是后台那条跑完了，**没有任何人会替它存**。
   */
  persistConversation: async (id) => {
    if (!id) return
    const s = get()
    const snap = id === s.activeId ? snapshotOf(s) : s.runtimes[id]
    if (!snap) {
      // **绝不"没内容也照写"**：那会把一条真实会话在盘上覆盖成空的（静默丢数据）。
      // 但也不静默跳过 —— 留痕，方便排查"为什么这条没存上"。
      console.warn('[store] 想落盘的会话不在内存里，已跳过', { id })
      return
    }
    if (snap.messages.length === 0) return
    // 后台会话的防抖任务已被这次落盘覆盖，取消掉
    cancelScheduledPersist(id)
    try {
      const rec = s.usageByConversation[id]
      const updated = await window.api.saveConversation(id, snap.messages, {
        ...(rec ? { usage: rec.total, avoidedTokens: rec.avoided } : {})
      })
      if (updated) {
        // 就地更新列表项（避免整表重拉），标题可能已被自动补上
        const next = get().conversations.map((c) => (c.id === id ? updated : c))
        if (!next.some((c) => c.id === id)) next.push(updated)
        set({ conversations: next })
      }
      if (get().saveError) set({ saveError: null })
    } catch (err) {
      // **保存失败必须让用户看见**。以前这里是裸 `await`：调用点又写的 `void persistActive()`，
      // 于是失败 = 界面没反应 + 日志没痕迹 + 用户以为在存而实际一个字都没落盘。
      // 单独用一个 `saveError` 而不是复用 `streamError`：切会话时后者会被清掉，
      // 而这条提示恰恰发生在"切会话"那一刻，不能一转身就没了。
      set({
        saveError: `这段对话没能存进磁盘：${err instanceof Error ? err.message : String(err)}`
      })
    }
  },

  persistActive: async () => {
    // 老的"只存当前会话"入口保留（UI 侧调用点多），实现走**按会话**那条
    await get().persistConversation(get().activeId ?? '')
  },

  /**
   * 关窗口前把所有在跑的会话落盘（plan11 P0-2）。   *
   * 主进程收到 `flushDone` 才真关窗口 —— 所以这个函数**必须等到所有落盘都结束**，
   * 不能 `void` 掉（那等于回执比落盘先走，窗口一关内容还是没写下去）。
   */
  flushAll: async () => {
    get().archiveCurrent() // 先把当前现场收进存档，flush 的才是最新内容
    const s = get()
    const ids = new Set<string>(Object.keys(s.runtimes))
    if (s.activeId) ids.add(s.activeId)
    await Promise.all([...ids].map((id) => get().persistConversation(id)))
  },

  // ── 目标（plan12）：跨轮次存活的长期意图 ──
  //
  // 目标是**会话的属性**（plan11 给的会话身份），所以切换会话时像 messages 一样重新拉一份 ——
  // 不放进 plan11 的 `runtimes` 分流器：那是给"流式期间每字都在变"的状态用的，
  // 目标变更很稀疏，切会话时拉一次就够，简单且不会错。
  goals: [] as Goal[],
  loadGoals: async (conversationId: string) => {
    try {
      set({ goals: await window.api.listGoals(conversationId) })
    } catch {
      set({ goals: [] })
    }
  },
  createGoal: async (conversationId: string, text: string) => {
    await window.api.createGoal({ conversationId, text })
    await get().loadGoals(conversationId)
  },
  /** 动作：非法转移会抛出人话理由（由界面显示），这里**不吞掉** */
  actOnGoal: async (id: string, action: GoalAction, patch?: { text?: string; doneWhen?: string }) => {
    await window.api.actOnGoal(id, action, patch)
    const activeId = get().activeId
    if (activeId) await get().loadGoals(activeId)
  },
  deleteGoal: async (id: string) => {
    await window.api.deleteGoal(id)
    const activeId = get().activeId
    if (activeId) await get().loadGoals(activeId)
  },

  concurrencyNotice: null,
  dismissConcurrencyNotice: () => set({ concurrencyNotice: null })
}))

