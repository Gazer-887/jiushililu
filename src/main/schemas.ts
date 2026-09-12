import { z } from 'zod'

// 入参 schema 独立成文件：不 import electron，纯 zod，可脱离主进程做单元测试。
// 所有来自渲染进程的入参一律过这里——坏数据挡在主进程门外。

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

/** 单条消息（两条通道共用同一形状） */
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(200000)
})

/**
 * **发给模型**的消息数组（`chat:send`）。
 * 上限 200 是"一次请求别把上下文撑爆"的约束。
 */
export const chatMessagesSchema = z.array(messageSchema).min(1).max(200)

/**
 * 会话 id 的形状（plan11）：主进程要按它给每一轮跑**记归属**，
 * 所以它必须**必填**且格式可控（长度封顶，避免被塞进超长串当键使）。
 */
export const conversationIdSchema = z.string().min(1).max(64)

/** `chat:send` 的入参：消息 + **这次跑属于哪条会话**（plan11 §2.1，缺 id 就是串台的起点） */
export const chatSendInputSchema = z.object({
  conversationId: conversationIdSchema,
  messages: chatMessagesSchema
})

/**
 * 保存一个模型档案（plan11 F5）：**设置就是 `settingsSchema`**，外面套一层名字与 id。
 * 复用同一份设置 schema 的理由：档案里的字段与"当前模型"完全同构 ——
 * 两个 schema 各写一遍必然漂移，而漂移的表现是"某个参数改了不生效"这类难查的怪象。
 */
/**
 * 保存一个**端点**（plan7 F5.1）：连接信息 + 整份模型目录。
 *
 * 为什么模型目录用 zod 逐条校验而不是"整块 unknown 塞过去"：
 * 它是用户手打的模型 ID，一个空串就会让整个端点变成"一条空连接" ——
 * 拦住比事后猜便宜得多。
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
 * **从渲染进程进来的**消息数组（还没规整）—— 刻意比落盘要求**松一档**：
 * `content` 允许为空，因为"流式占位"是合法中间状态。
 * 顺序是：**先松收下 → 规整 → 再上严格校验**（见 `storedMessagesSchema`）。
 */
export const incomingMessagesSchema = z.array(
  z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(200000) })
)

/**
 * **落盘**的消息数组（`conv:save`）—— 与 `chatMessagesSchema` **刻意不共用上限**。
 *
 * 两个约束根本不是一件事：一个是"一次请求发多少"，一个是"一条会话能有多长"。
 * 共用 200 的后果是**超过 200 条消息之后保存永久失败**（而且静默）——
 * 等于给用户设了一道看不见的会话寿命上限。所以：
 *   · 条数放宽到 2000（正常用户碰不到）
 *   · 真正防"把 IPC 撑爆"的是**总字数**，条数只是顺手的一道闸
 *   · **允许空数组** —— 一条还没说过话的会话是合法的
 *   · 空 `content` 仍然拒绝：规整（`normalizeHistory`）该在前面把它挡掉，
 *     走到这里还有空的，就是程序错了，不该被静默吞掉
 */
export const storedMessagesSchema = z
  .array(messageSchema)
  .max(2000)
  .superRefine((list, ctx) => {
    const total = list.reduce((n, m) => n + m.content.length, 0)
    if (total > MAX_STORED_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `会话太长（${total} 字，上限 ${MAX_STORED_CHARS} 字），整条存不下`
      })
    }
  })
