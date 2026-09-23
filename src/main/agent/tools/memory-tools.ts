// 记忆工具（plan19 §0.3 条 7）：`remember` 写、`recall` 读正文。
// 依赖倒置（同 `goal-tools.ts`）：工具层不碰 electron-store 与 IPC，`repo` 与确认桥由组合根注入。
// ⚠️ 证据指针**不由模型填** —— 会话 id 与轮次由运行时给，否则模型可以伪造来源。

import type { AgentTool } from '@shared/agent'
import { MODEL_MEMORY_CLASSES, MEMORY_LIMITS, type MemoryClass } from '@shared/memory'
import type { MemoryRepo } from '@main/memory/memory-core'

export interface MemoryToolDeps {
  repo: MemoryRepo
  /** 当前会话 id（写事件与证据指针用） */
  conversationId: () => string | null
  /** 当前轮次（证据指针用）；不给则证据留空 */
  turnIndex?: () => number
  /** 确认桥。判定落「确认档」时问一句；**不给 = 直接拒** —— 宁可拒，不可默默放过 */
  confirm?: (reason: string) => Promise<boolean>
  /**
   * 本轮**用户原话**（plan19 批 4 纠正识别用）。不给 = 不做纠正判定（退化为批 1 行为）。
   * ⚠️ 这个数据只有循环层有（`args.history` 最后一条 user），故由装配处注入 ——
   * 工具层自己拿不到，也**不许**去猜。
   */
  lastUserMessage?: () => string | null
}

/**
 * 否定词（plan19 §九 批 4 落盘的"纠正"识别启发式）。
 * ⚠️ 光有否定词**不算纠正** —— 必须与"同名条目被改写"同时成立（因果链，见 `remember.execute`）。
 * 这是刻意的保守：宁可漏记，不可假记（假记会污染"重复纠正率"这个核心读数）。
 */
const NEGATION_WORDS = [
  '不对',
  '不是',
  '错了',
  '撤回',
  '收回',
  '不要',
  '取消',
  '有别',
  '别这样',
  '我说的是'
] as const

/** 用户原话里有没有否定词 */
function hasNegation(text: string): boolean {
  return NEGATION_WORDS.some((w) => text.includes(w))
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
            // plan25 D-073：模型可见的分类不含 profile —— 画像只由反思或用户手动产生，
            // 工具层连选项都不给（save 层另有兜底闸拦 origin='model' 的 profile）
            enum: [...MODEL_MEMORY_CLASSES],
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
      if (!MODEL_MEMORY_CLASSES.includes(cls as (typeof MODEL_MEMORY_CLASSES)[number])) {
        return `错误：class 只能是 ${MODEL_MEMORY_CLASSES.join(' / ')}`
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

      // ── 批 4：纠正通路（plan19 §九 批 4）────────────────────────────
      // 判据 9 的「同名 → 拒绝」防的是**重复写入**；但"用户说不对、模型改写同一条"是**纠正**，
      // 两者必须分开 —— 否则模型永远改不了自己写错的记忆（批 1 的拒绝理由还叫它"先编辑那一条"，
      // 而当时**根本没有编辑通路**，等于让它去做一件做不到的事）。
      // 口子只开在因果链成立时：**用户原话含否定词 + 同名条目确实存在**。
      const lastUser = deps.lastUserMessage?.() ?? ''
      const conflict = deps.repo.findConflict(name)
      const isCorrection = conflict !== null && hasNegation(lastUser)
      const editFile = isCorrection ? conflict.file : undefined

      // `fromCorrection` 只带"这轮用户否过"那半边，撞没撞名由 core 侧与 `file` 一起判
      // （v2 条件 ①+②）。core 若把这条改写成候选，会把它随候选带走 —— 届时**不记此刻的账**。
      const submit = (confirmed: boolean) =>
        deps.repo.save({
          name,
          description,
          class: cls as MemoryClass,
          body,
          origin: 'model',
          evidence,
          ...(isCorrection ? { fromCorrection: true } : {}),
          ...(editFile === undefined ? {} : { file: editFile }),
          ...(confirmed ? { confirmed: true } : {})
        })

      const PENDING =
        `已将「${name}」提交为**待确认提案**：用户批准之前不会生效、也不会注入后续对话。` +
        '（要改现有条目请等批准结果，不要重复提交同一条）'

      const first = submit(false)
      if (first.ok) {
        // 审批门开着 —— 这条还没生效。回话必须说实话：说"已记住"会让模型下一轮当它已经存在，
        // 而用户看见的是"模型说记了、我却没在库里找到"，两头都是假账。
        if ('queued' in first) return PENDING
        if (!isCorrection) return `已记住「${name}」。用户可在工作台的记忆页签里查看或删除它。`
        // 因果链成立 → 落 correct 事件（重复纠正率的唯一数据来源）
        deps.repo.record({ kind: 'correct', conversationId, name, ...(turnIndex === null ? {} : { turnIndex }) })
        return `已更正「${name}」。用户可在工作台的记忆页签里查看。`
      }
      if (first.needsConfirm !== true) return `没有写入：${first.reason}`

      if (!deps.confirm) return `没有写入：${first.reason}`
      const agreed = await deps.confirm(first.reason)
      if (!agreed) return '用户没有确认，这条没有写入。'

      const second = submit(true)
      if (second.ok) {
        // 确认桥只服务直写通路（gate 关掉时）。真走到 queued 说明门又开了 —— 同样说实话，不报"已记住"。
        if ('queued' in second) return PENDING
        // 直写 + 用户已在确认桥点头 ⇒ 这一笔已经生效，纠正的账就在这一刻落。
        // （§四之二 要求"逃生开关关掉时行为与 v1 一致"，这里就是那半边；漏了它，
        //  命中确认档的纠正一条都不记 —— 重复纠正率会偏，而没有任何一条判据会红。）
        if (isCorrection) {
          deps.repo.record({ kind: 'correct', conversationId, name, ...(turnIndex === null ? {} : { turnIndex }) })
        }
        return `已记住「${name}」（用户已确认）。`
      }
      return `没有写入：${second.reason}`
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
