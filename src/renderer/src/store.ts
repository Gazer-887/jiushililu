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
import type { AskRequest } from '@shared/ask'
import type { BackgroundTask } from '@shared/background'
import type { TodoItem } from '@shared/todo'
import { addUsage, emptyUsage, mergeOptionalMax, type TokenUsage } from '@shared/usage'
import type { TokenSaverTier } from '@shared/token-tier'
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

// 界面状态只放这里；真正的模型请求一律走 IPC 交主进程执行。

export type AppView = 'new' | 'chat' | 'settings'

/** 工作台落盘的**合并窗口**（plan9 §W5 提交点表）：切页签、拖宽这类高频动作只在停下来后写一次盘 */
const WB_PERSIST_DEBOUNCE_MS = 300
let wbPersistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 后台会话的落盘防抖（plan11 P0-1 兜底）：`markDone` 已会立刻落盘，这层防"没等到 done 就被强杀 / 断电"。
 * ⚠️ **每条会话各计一个定时器** —— 共用一个会让并发会话互相推迟对方的落盘。
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

  sidebarWidth: number
  dockWidth: number
  theme: ThemeName
  setTheme: (t: ThemeName) => void
  setSidebarWidth: (w: number) => void
  setDockWidth: (w: number) => void
  persistUIPrefs: (patch: Partial<UIPrefs>) => Promise<void>
  resetUIPrefs: () => Promise<void>
  loadUIPrefs: () => Promise<void>

/** 分栏布局。**渲染端是唯一写入源。**⚠️ 落盘回显不许覆盖它：盘上那份可能比内存旧，set 回去会把"刚开的栏"打回原状 —— 所以 `persistUIPrefs` 只回显宽度与主题，**故意不回显 workbench**。 */
  workbench: WorkbenchLayout
  workbenchSizes: WorkbenchSizes
  setWorkbench: (layout: WorkbenchLayout, sizes?: WorkbenchSizes) => void
  persistWorkbench: () => Promise<void>
  persistWorkbenchSoon: () => void

  wbOpenTab: (paneId: string | null, content: PaneContent) => void
  /** 工作台区**实测可用宽**（渲染端用 ResizeObserver 回报）：存它是为了分栏时拿「**与容器相称的均分**」当默认 —— 拍固定像素会在窄面板里变成一宽一窄。 */
  wbRowWidth: number
  setWbRowWidth: (w: number) => void
  /** 把某个页签挪到**右侧新一栏**（右键页签 → 分栏）—— 新建一栏的**唯一入口**：多栏不是默认形态，常驻的 ＋ 已随工作台标题栏一起去掉。 */
  wbSplitRight: (paneId: string, tabId: string) => void
  /** 打开文件到「预览栏」（plan9 W6）：去重/复用逻辑在纯函数 `openInFilePane`（有单测）—— 最后一栏是"纯文件栏"就复用，否则右侧新开一栏。 */
  wbOpenFile: (path: string, mode?: FileMode) => void
  wbCloseTab: (paneId: string, tabId: string) => void
  wbActivateTab: (paneId: string, index: number) => void
  wbRemovePane: (paneId: string) => void
  wbToggleCollapse: (paneId: string) => void
  /** 切文件页签的「预览 / 编辑」（plan7 批 A3 范围②） */
  wbSetFileMode: (paneId: string, tabId: string, mode: FileMode) => void
  /** 存 / 清草稿（`undefined` = 清掉）；草稿住布局里，所以切页签、重启都还在 */
  wbSetFileDirty: (paneId: string, tabId: string, dirty: string | undefined) => void

  sidebarOpen: boolean
  toggleSidebar: () => void
  dockOpen: boolean
  toggleDock: () => void

  settings: SettingsView | null
  settingsLoaded: boolean
  loadSettings: () => Promise<void>

  conversations: ConversationMeta[]
  activeId: string | null
  workspacePath: string
  setWorkspacePath: (path: string) => void
  loadConversations: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  newSession: () => void
  createConversation: (input: ConversationCreateInput) => Promise<string>
  renameConversation: (id: string, title: string) => Promise<void>
  removeConversation: (id: string) => Promise<void>
  persistActive: () => Promise<void>

  /** **回到第 `index` 条消息之前**（plan10 B 批 ④）。两条纪律，缺一条出事故：① 用主进程回传的权威正文覆盖内存（否则下一次保存会把回滚掉的内容写回去）；② 回滚后**不调用** persistActive（存储已是权威状态）。 */
  rollbackTo: (index: number) => Promise<void>
  undoRollback: () => Promise<void>

  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  /** **落盘失败**提示，与 `streamError` 分开存：这类失败恰好发生在"切会话"那一刻，而切会话会清掉 `streamError`。 */
  saveError: string | null
  rollbackNotice: { hidden: number; total: number } | null
  toolEvents: ToolEvent[]
  /** 思考流（DeepSeek 系 `reasoning_content`）：与正文**分开**存 —— 它是过程不是回答，别混进消息内容 */
  reasoning: string
  todos: TodoItem[]
  subagents: SubagentJobEvent[]
  /** 待作答的提问（全局队列，**不按会话存档**）：它是"有人正等着你答"，与当前看哪条会话无关。
   *  ⚠️ 订阅挂在 `App`（和流式同一层）、队列住在这里 —— 面板在 `ChatView` 里而那个视图是条件渲染，
   *    订阅挂在面板上就会在"切到设置页那会儿"把提问丢掉，而主进程**不会重发**（那条 Agent 白等到超时）。 */
  asks: AskRequest[]
  pushAsk: (req: AskRequest) => void
  /** 按 **id** 摘（不是"摘队首"）：并发多条提问时队首可能已经换人 */
  dropAsk: (id: string) => void
  backgroundTasks: BackgroundTask[]
  setBackgroundTasks: (list: BackgroundTask[]) => void
  /** **后台会话的现场**（plan11 §2.7）：界面同时只显示一条，所以"当前这条"留在顶层字段（消费者一行都不用改），其余正在跑的存这里 —— 切走存档、切回恢复。 */
  runtimes: Record<string, RuntimeSnapshot>
  /** **每条会话的真实用量账本**（plan8 R9）：用量是只增不减的账本，不需要"切走存档、切回恢复"。缺 key = 还没拿到过真实用量 → 界面显示"暂无"，而不是一个看着像真的 0。 */
  usageByConversation: Record<string, ConversationUsage>
  archiveCurrent: () => void
  /** 流式片段落位：**按信封里的会话 id 找目标**（当前显示的改顶层字段，后台的改它的存档）—— 切会话不串台就靠它 */
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
  persistConversation: (id: string) => Promise<void>
  flushAll: () => Promise<void>
  goals: Goal[]
  loadGoals: (conversationId: string) => Promise<void>
  createGoal: (conversationId: string, text: string) => Promise<void>
  actOnGoal: (id: string, action: GoalAction, patch?: { text?: string; doneWhen?: string }) => Promise<void>
  deleteGoal: (id: string) => Promise<void>
  /** 并发提醒（plan11 §2.3）：同时跑第二条会话时提醒一次"两个会话改同一个工作区会互相覆盖"。**只提醒不拦** —— 应用判断不了它们会不会碰同一批文件，把知情权交给用户。 */
  concurrencyNotice: string | null
  dismissConcurrencyNotice: () => void
}

export interface ConversationUsage {
  total: TokenUsage
  last: TokenUsage | null
  /** 最近一轮用的**省 token 档位**（plan8 R9.1 §七②）：不记档位就没法按档比数字。缺 = 老版本主进程没带这个字段 → 界面不显示档位标签，**不替它编默认值**。 */
  tier?: TokenSaverTier
  /** 累计**省下**的估算 token（plan8 R9.1）：**不进** `total` —— 那是厂商真值，这是我们替它做的减法，混一起分不清 */
  avoided: number
}

/** 把**盘上**的用量并进内存账本（plan8 R9 / R9.1）。规矩：**只许往前长**（取 max）—— 覆盖会让数字倒退，而账本倒退比不显示更难解释。
 *  ⚠️ 盘上带回来的只是累计总量、不是某一轮：`last` 保持内存值，不拿历史累计冒充"最近一轮"。 */
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

export interface RuntimeSnapshot {
  messages: ChatMessage[]
  streaming: boolean
  streamError: string | null
  reasoning: string
  toolEvents: ToolEvent[]
  todos: TodoItem[]
  subagents: SubagentJobEvent[]
}

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

function appendToTail(messages: ChatMessage[], text: string): ChatMessage[] {
  const next = messages.slice()
  const last = next[next.length - 1]
  if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + text }
  return next
}

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

/** **分流器**（plan11 §2.7）：改动落到哪儿取决于它在哪条会话上 —— 当前显示的那条改**顶层字段**（消费者一行都不用改），后台那条改**它的存档**。
 *  ⚠️ 回调只返回**改动的字段**（`Partial`）而非整份现场：流式期间它**每来一个字就调一次**，顺手深拷贝整条会话等于把"打字"变成"每字一次全量复制"。
 *  ⚠️ 后台会话没有存档时：告警 + 什么都不做，绝不凭空造一份空的 —— 下一次落盘会把"空内容"静默覆盖到真实会话上（丢数据）；
 *     `sendMessage` 会先种下存档，所以这条理论上走不到，留着是不冒这个险。 */
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

  sidebarWidth: SIDEBAR_DEFAULT,
  dockWidth: DOCK_DEFAULT,
  theme: 'classic',
  setTheme: (t) => {
    const theme = sanitizeTheme(t)
    set({ theme })
    // 写根元素的 data-theme —— CSS 侧靠 html[data-theme='ink'] 覆盖变量，切换即时生效
    document.documentElement.dataset.theme = theme
    void useAppStore.getState().persistUIPrefs({ theme })
  },
  setSidebarWidth: (w) => set({ sidebarWidth: clampWidth(w, SIDEBAR_MIN, SIDEBAR_MAX) }),
  setDockWidth: (w) => set({ dockWidth: clampWidth(w, DOCK_MIN, DOCK_MAX) }),
  persistUIPrefs: async (patch) => {
    // 落盘失败不影响界面（宽度已经改了，只是下次重开回到默认）
    try {
      const next = await window.api.setUIPrefs(patch)
      // theme 走 sanitizeTheme 保底：主进程若返回缺 theme 的数据，UI 会进「两个主题都没选中」的死角。⚠️ 故意**不回显 workbench / workbenchSizes**（盘上那份可能比内存旧）。
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
      // 偏好读不到就用默认值（首启动 / 文件损坏都走这里）
    }
  },

  workbench: emptyLayout(),
  workbenchSizes: emptySizes(),
  setWorkbench: (layout, sizes) =>
    set((s) => ({
      workbench: layout,
      workbenchSizes:
        sizes ??
        // 栏数没变：只把宽度数组长度对齐（拖宽、切页签走这条，宽度原样保留）
        (layout.panes.length === s.workbench.panes.length
          ? normalizeSizes(s.workbenchSizes, layout.panes.length)
          : // 栏数变了（分栏/关栏/开窗）：用「与容器相称的均分」当默认 ——
            // 拍固定像素在窄面板里会得到一宽一窄，均分才像"分栏"而不是"随手拖了一下"
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
    // 列表里带用量账本（存在会话索引里）→ 顺手并进内存，不必等某条会话被打开
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
    // 切模型**优先按档案 id**（它才能定位"哪条连接 + 哪把 Key"）；老会话没 id 就按**名字**找同名档案兜底（主进程兜底），找不到沿用当前档案 —— 三条路都不会让会话打不开，也不会因升级丢模型绑定。
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
    // **存档 / 恢复**：先把"正在显示的这一条"收进存档（否则切回来就没了）；目标会话正在跑（存档里有 streaming）就恢复现场，否则按存储里的内容重建。
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
    // ⚠️ 必须清掉上一轮的过程状态 —— 不然工具卡片与思考会留在新会话里把界面占满、报告看不见
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
  asks: [],
  backgroundTasks: [],
  runtimes: {},
  usageByConversation: {},
  reasoning: '',

  clearToolEvents: () => set({ toolEvents: [] }),

  pushAsk: (req) => set((s) => ({ asks: [...s.asks, req] })),
  dropAsk: (id) => set((s) => ({ asks: s.asks.filter((a) => a.id !== id) })),

  rollbackTo: async (index) => {
    const { activeId } = get()
    if (!activeId) return
    try {
      // `null` = 用户拒了确认框 / 本来就没东西可回滚 —— 两种都**什么都不做**
      const res = await window.api.rollbackConversation(activeId, index)
      if (!res) return
      const visible = res.conversation.messages
      set((s) => ({
        // 权威正文覆盖内存 —— 整件事的关键
        messages: visible,
        rollbackNotice: { hidden: res.total - visible.length, total: res.total },
        conversations: s.conversations.map((c) =>
          c.id === activeId
            ? { ...c, messageCount: res.conversation.messageCount, updatedAt: res.conversation.updatedAt }
            : c
        )
      }))
      // 刻意**不**调用 persistActive：存储里已经是权威状态
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
        rollbackNotice: null,
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
    // 真实用量累加进**那一条会话**的账本。缺字段一律当"厂商没报"：信封另一头是另一个进程，版本不齐 / 事件被截断都可能给不出 usage —— 不许直接炸，也不写假账。
    const usage = e.payload?.usage ?? null
    const avoided = e.payload?.avoided ?? 0
    const tier = e.payload?.tier
    set((s) => {
      const prev = s.usageByConversation[e.conversationId]
      const nextUsage: ConversationUsage | null =
        usage || avoided > 0
          ? {
              total: usage ? addUsage(prev?.total ?? emptyUsage(), usage) : (prev?.total ?? emptyUsage()),
              last: usage ?? prev?.last ?? null,
              avoided: (prev?.avoided ?? 0) + avoided,
              // 档位：这一轮没带就保留上一次的 —— 老版本主进程不带这个字段，直接覆盖会把已记的档位抹掉
              ...(tier ? { tier } : prev?.tier ? { tier: prev.tier } : {})
            }
          : null
      return {
        ...applyToConversation(s, e.conversationId, () => ({ streaming: false })),
        ...(nextUsage ? { usageByConversation: { ...s.usageByConversation, [e.conversationId]: nextUsage } } : {})
      }
    })
    // ⚠️ 落的是**那一条**（不是当前显示的那条）—— 记错这条就等于后台会话没人存（plan11 P0-1）
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
    const conversationId = get().activeId
    if (!content || get().streaming) return
    if (!conversationId) {
      set({ streamError: '该消息没有归属的会话，请先新建会话再发送。' })
      return
    }
    const history = get().messages.filter((m) => m.content.trim().length > 0)
    const payload = [...history, { role: 'user' as const, content }]
    set({
      messages: [...payload, { role: 'assistant', content: '' }],
      streaming: true,
      streamError: null,
      toolEvents: [], // 新一轮，清掉上一轮的工具活动
      reasoning: ''
    })
    // 先把这条会话的现场存进存档 —— 它被切到后台后，属于它的片段才知道该往哪儿落
    get().archiveCurrent()

    const othersRunning = Object.entries(get().runtimes).filter(
      ([id, r]) => id !== conversationId && r.streaming
    )
    if (othersRunning.length > 0) {
      set({
        concurrencyNotice:
          `当前另有 ${othersRunning.length} 条会话正在运行。多条会话同时修改同一工作区会互相覆盖文件：` +
          `请错开运行，或确认它们操作的是否为同一批文件。`
      })
    }

    try {
      await window.api.chatSend({ conversationId, messages: payload })
    } catch {
      // 主进程入参校验失败等；常规错误已通过 chatError 事件送达
      get().markError({ conversationId, payload: '发送失败：请求被主进程拒绝（参数校验未通过）。' })
    }
  },

  stopStreaming: async () => {
    // "停止"必须指名道姓：不指名就是停错会话
    const conversationId = get().activeId
    if (conversationId) await window.api.chatAbort(conversationId)
    // **必须自己把 streaming 收回去**，不能只指望随后的 `chat:done`：那条事件万一没到（订阅被拆、页面在后台、渲染进程刚重载），发送键会永远停在「停止」、点了还是"生成中"，死循环。
    set({ streaming: false })
    await get().persistConversation(conversationId ?? '')
  },

/** 把**指定会话**落盘（plan11 P0-1）：与老的 `persistActive` 只差一个词 —— **谁**（以前所有落盘都写死当前会话，于是后台那条跑完没有任何人会替它存）。 */
  persistConversation: async (id) => {
    if (!id) return
    const s = get()
    const snap = id === s.activeId ? snapshotOf(s) : s.runtimes[id]
    if (!snap) {
      // **绝不"没内容也照写"**（那会把真实会话在盘上覆盖成空的，静默丢数据）；但也不静默跳过 —— 留痕好排查
      console.warn('[store] 想落盘的会话不在内存里，已跳过', { id })
      return
    }
    if (snap.messages.length === 0) return
    cancelScheduledPersist(id)
    try {
      const rec = s.usageByConversation[id]
      const updated = await window.api.saveConversation(id, snap.messages, {
        ...(rec
          ? { usage: rec.total, avoidedTokens: rec.avoided, ...(rec.tier ? { tokenTier: rec.tier } : {}) }
          : {})
      })
      if (updated) {
        // 就地更新列表项（避免整表重拉），标题可能已被自动补上
        const next = get().conversations.map((c) => (c.id === id ? updated : c))
        if (!next.some((c) => c.id === id)) next.push(updated)
        set({ conversations: next })
      }
      if (get().saveError) set({ saveError: null })
    } catch (err) {
      // **保存失败必须让用户看见**（以前裸 `await` + 调用点 `void` = 界面没反应、日志没痕迹）。单用 `saveError` 而不复用 `streamError`：后者会被切会话清掉，而失败恰恰发生在那一刻。
      set({
        saveError: `该对话未能写入磁盘：${err instanceof Error ? err.message : String(err)}`
      })
    }
  },

  persistActive: async () => {
    await get().persistConversation(get().activeId ?? '')
  },

/** 关窗口前把所有在跑的会话落盘（plan11 P0-2）：主进程收到 `flushDone` 才真关窗口，所以这里**必须等所有落盘结束**，不能 `void` 掉。 */
  flushAll: async () => {
    get().archiveCurrent() // 先把当前现场收进存档，flush 的才是最新内容
    const s = get()
    const ids = new Set<string>(Object.keys(s.runtimes))
    if (s.activeId) ids.add(s.activeId)
    await Promise.all([...ids].map((id) => get().persistConversation(id)))
  },

  // ── 目标（plan12）：跨轮次存活的长期意图 ──
  // 目标是**会话的属性**，切会话时像 messages 一样重新拉一份 —— 不进 `runtimes` 分流器（那是给"流式期间每字都在变"的状态用的）。
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
  /** 非法转移会抛出人话理由（由界面显示），这里**不吞掉** */
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

