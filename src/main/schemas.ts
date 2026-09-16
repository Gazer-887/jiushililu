import { z } from 'zod'

// 入参 schema 独立成文件：纯 zod、不 import electron，可脱离主进程单测。
// 所有来自渲染进程的入参一律过这里 —— 坏数据挡在主进程门外。

export const settingsSchema = z.object({
  providerType: z.enum(['openai-compatible', 'anthropic']),
  baseURL: z
    .string()
    .min(1)
    .max(500)
    // 用户可能懒得写协议头，自动补 https://（教材级体验）
    .transform((v) => (v.startsWith('http://') || v.startsWith('https://') ? v : `https://${v}`))
    .refine((v) => {
      try {
        new URL(v)
        return true
      } catch {
        return false
      }
    }, '接口地址不是合法 URL'),
  model: z.string().min(1).max(200),
  // 采样三兄弟可留空：null = 不发送，跟随厂商默认
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  topK: z.number().int().min(1).max(200).nullable(),
  // 防手误闸门，不替厂商定上限（2026-09 查证：DeepSeek V4 最大输出 384K，未来模型可能更大）
  maxTokens: z.number().int().min(1).max(1_000_000),
  timeoutMs: z.number().int().min(1000).max(600000),
  stream: z.boolean(),
  // 上下文窗口是客户端元数据（不发给模型），封顶 1000 万同样只防手误
  contextWindow: z.number().int().min(1024).max(10_000_000),
  reasoningEffort: z.enum(['default', 'low', 'medium', 'high', 'max']),
  maxToolRounds: z.number().int().min(1).max(10000),
  supportsImages: z.boolean(),
  apiKey: z.string().max(400).optional()
})

/** 单条消息（发给模型的通道）：刻意**不含** segments —— 执行分段是本地渲染资产，不随请求出境（plan36 审查坑 2） */
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(200000)
})

/**
 * **发给模型**的消息数组（`chat:send`）：上限 200 是"一次请求别把上下文撑爆"。
 */
export const chatMessagesSchema = z.array(messageSchema).min(1).max(200)

/**
 * 会话 id 的形状（plan11）：主进程按它给每一轮跑**记归属**，故**必填**且格式可控
 * （长度封顶，避免被塞进超长串当键使）。
 */
export const conversationIdSchema = z.string().min(1).max(64)

/** `chat:send` 入参：消息 + **这次跑属于哪条会话**（plan11 §2.1，缺 id 就是串台的起点） */
export const chatSendInputSchema = z.object({
  conversationId: conversationIdSchema,
  messages: chatMessagesSchema,
  // 主 Agent（plan17 G2）：不带 = 内核默认；带了但定义不存在 → runAgent 抛人话错误走 chat:error
  agentName: z.string().max(64).optional()
})

/**
 * 保存一个**端点**（plan7 F5.1）：连接信息 + 整份模型目录。
 *
 * 模型目录逐条 zod 校验而不是整块 `unknown` 塞过去：那是用户手打的模型 ID，
 * 一个空串就会让整个端点变成"一条空连接"，拦住比事后猜便宜得多。
 */
export const modelSaveSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(60),
  providerType: z.enum(['openai-compatible', 'anthropic']),
  baseURL: settingsSchema.shape.baseURL,
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  stream: z.boolean().optional(),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        model: z.string().min(1).max(200),
        name: z.string().max(60).optional(),
        // 模型级"高级设置"：只存改过的字段，故整体可选
        settings: z
          .object({
            temperature: z.number().min(0).max(2).nullable().optional(),
            topP: z.number().min(0).max(1).nullable().optional(),
            topK: z.number().int().min(1).max(200).nullable().optional(),
            maxTokens: z.number().int().min(1).max(1_000_000).optional(),
            contextWindow: z.number().int().min(1000).max(10_000_000).optional(),
            reasoningEffort: z.enum(['default', 'low', 'medium', 'high']).optional(),
            maxToolRounds: z.number().int().min(1).max(1000).optional(),
            supportsImages: z.boolean().optional()
          })
          .optional()
      })
    )
    .min(1)
    .max(50),
  activeModelId: z.string().max(64).optional(),
  apiKey: z.string().max(500),
  source: z.enum(['deepseek', 'custom']).optional()
})

/** 切"端点内的当前模型" */
export const modelEntryPickSchema = z.object({
  profileId: z.string().min(1).max(64),
  entryId: z.string().min(1).max(64)
})

/** 新建目标（plan12）：正文与"怎么算做到"都限长 —— 目标是"一句话意图"，不是任务书 */
export const goalCreateSchema = z.object({
  conversationId: conversationIdSchema,
  text: z.string().min(1).max(200),
  doneWhen: z.string().max(200).optional()
})

/** 目标动作：六种之一（合法与否由状态机判，这里只管形状） */
export const goalActionSchema = z.object({
  id: z.string().min(1).max(64),
  action: z.enum(['pause', 'resume', 'complete', 'reopen', 'drop', 'edit']),
  patch: z
    .object({
      text: z.string().max(200).optional(),
      doneWhen: z.string().max(200).optional()
    })
    .optional()
})

/** 落盘消息的**总字数**上限（约 4MB；IPC 结构化克隆按 UTF-16 算，故不能只看条数） */
export const MAX_STORED_CHARS = 2_000_000

/**
 * **从渲染进程进来的**消息数组（还没规整）—— 比落盘要求**松一档**：`content` 允许为空
 * （流式占位是合法中间状态）；`segments` 只按松结构收下、**不逐字段审**（审是 storedMessagesSchema 的事）。
 * 先松收下 → 规整 → 再审 `storedMessagesSchema`。
 */
export const incomingMessagesSchema = z.array(
  z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(200000),
    segments: z.array(z.record(z.string(), z.unknown())).max(1000).optional()
  })
)

/** 落盘的分段（plan36）：kind 与载荷配对校验——text/thinking 必带 text，tool 必带 event */
const segmentSchema = z
  .object({
    kind: z.enum(['text', 'thinking', 'tool']),
    text: z.string().max(200000).optional(),
    event: z
      .object({
        id: z.string().min(1).max(160),
        name: z.string().min(1).max(120),
        phase: z.enum(['start', 'error', 'end']),
        detail: z.string().max(4000).optional(),
        summary: z.string().max(8000).optional(),
        savedTokens: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .superRefine((s, ctx) => {
    if ((s.kind === 'text' || s.kind === 'thinking') && !s.text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${s.kind} 段必须带 text` })
    }
    if (s.kind === 'tool' && !s.event) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool 段必须带 event' })
    }
  })

/**
 * **落盘**的单条消息（`conv:save`）：与发给模型的 `messageSchema` **刻意分两份**（plan36 审查坑 2）——
 * 落盘侧收 `segments?`，模型侧永远不含。空 `content` 仅当"assistant 且带分段"时合法
 * （中间轮次可能只有思考/工具没有正文；丢了它会让回滚的索引错位，坑 3）。
 */
export const storedMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(200000),
    segments: z.array(segmentSchema).max(1000).optional()
  })
  .superRefine((m, ctx) => {
    if (m.segments && m.role !== 'assistant') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'segments 只允许挂在 assistant 上' })
    }
    if (m.content.trim().length === 0 && !(m.role === 'assistant' && (m.segments?.length ?? 0) > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '空 content 且无分段的消息不落盘' })
    }
  })

/**
 * **落盘**的消息数组（`conv:save`）—— 与 `chatMessagesSchema` **刻意不共用上限**：
 * 前者管"一次请求发多少"（200 条），后者管"一条会话能有多长"（2000 条）。
 * ⚠️ 共用 200 会让**超过 200 条之后保存永久静默失败** —— 等于给用户设了道看不见的会话寿命上限。
 * 预算口径（plan36 坑 4）：**content + segments 序列化长度都计入**——segments 会带工具摘要，
 * 只算 content 的门是盲的；超预算的降级在 conversations-core `fitStoredBudget` 做（丢分段保正文）。
 */
export const storedMessagesSchema = z
  .array(storedMessageSchema)
  .max(2000)
  .superRefine((list, ctx) => {
    const total = list.reduce(
      (n, m) => n + m.content.length + (m.segments ? JSON.stringify(m.segments).length : 0),
      0
    )
    if (total > MAX_STORED_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `会话太长（${total} 字，上限 ${MAX_STORED_CHARS} 字），整条无法保存`
      })
    }
  })

// MCP 服务器配置（plan23 D-062）：UI 表单与 manager 校验共用同一口径。
// ⚠️ env 的键值都是自由字符串（token 之类），只限长度防滥用。
export const mcpServerSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'name 需小写字母/数字/-/_ 组成，1~64 字符，以字母或数字开头'),
  transport: z.enum(['stdio', 'sse']),
  command: z.string().max(2048).optional(),
  args: z.array(z.string().max(2048)).max(32).optional(),
  env: z.record(z.string().max(4096)).optional(),
  url: z.string().url().max(2048).optional(),
  enabled: z.boolean()
})
