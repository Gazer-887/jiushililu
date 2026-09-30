import { z } from 'zod'
import {
  ATTACHMENT_REF_RE,
  INPUT_MODALITIES,
  MAX_IMAGES_PER_TURN,
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_VIDEO_BYTES,
  OUTBOUND_IMAGE_MIMES,
  OUTBOUND_VIDEO_MIMES
} from '@shared/content-parts'
import { BUDGET_ENCODINGS, OFF_ENCODINGS, REASONING_KINDS } from '@shared/ipc'

// 入参 schema 独立成文件：纯 zod、不 import electron，可脱离主进程单测。
// 所有来自渲染进程的入参一律过这里 —— 坏数据挡在主进程门外。

/**
 * 思考档名（plan58 R6）：**不再枚举**。官方词表逐厂商不同（OpenAI 有 `xhigh`/`minimal`、
 * Anthropic 有 `xhigh`，DeepSeek 与 Kimi / GLM **没有 `medium`**），全线通用子集只有
 * `{low, high}` —— 一张应用级枚举表必然给某些端点摆出它吃不下的值。
 * 合法性改由**该模型自己声明的** `reasoning.levels` 判（`modelSaveSchema` 的 `superRefine` 逐条核）。
 * 这里的 32 字符上限只为挡手误与脏数据，不替厂商定集合。
 */
const effortNameSchema = z.string().min(1).max(32)

/**
 * 逐模型声明的思考能力（plan58 R6/R7）。`kind` 决定**控件形状**（R7）：
 * `effort` 读 `levels`；`toggle` 读 `enabled`；`budget_tokens` 读 `budget`；`none` 两者都不读。
 * `levels` 是**人工填的**（能力发现接口只有 Anthropic 与 OpenRouter 两处有，我们三家
 * 端点全在"没有发现接口"的那一堆里，见 plan58 §丙）—— 所以它必须能原样存下一个我们
 * 没见过的官方值，否则连"标未实测"的资格都没有。
 */
const reasoningConfigSchema = z.object({
  kind: z.enum(REASONING_KINDS),
  levels: z.array(effortNameSchema).min(1).max(12).optional(),
  enabled: z.boolean().optional(),
  budget: z.number().int().min(0).max(1_000_000).optional(),
  // 片②（缺口 C）：两个出境编码。声明什么发什么，应用层不猜厂商方言（R15/R16）
  budgetEncoding: z.enum(BUDGET_ENCODINGS).optional(),
  offEncoding: z.enum(OFF_ENCODINGS).optional()
})

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
  reasoningEffort: effortNameSchema,
  reasoning: reasoningConfigSchema.optional(),
  maxToolRounds: z.number().int().min(1).max(10000),
  inputModalities: z.array(z.enum(INPUT_MODALITIES)).min(1),
  apiKey: z.string().max(400).optional()
})

/**
 * 存档与出境里的多模态块（plan57 片③）：**只收引用，不收 base64**。
 * 图片正文走 `userData/attachments/`，这里能出现的只有 `ref`（受限文件名形状）——
 * 形状校验就够挡路径穿越，**不必在这里读盘**（校验层与文件层不耦合，schema 才能脱离 electron 单测）。
 */
export const contentPartsSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(200000) }),
    z.object({
      type: z.literal('image'),
      mime: z.enum(OUTBOUND_IMAGE_MIMES),
      ref: z.string().regex(ATTACHMENT_REF_RE),
      bytes: z.number().int().nonnegative().max(MAX_OUTBOUND_IMAGE_BYTES)
    }),
    z.object({
      type: z.literal('video'),
      mime: z.enum(OUTBOUND_VIDEO_MIMES),
      ref: z.string().regex(ATTACHMENT_REF_RE),
      bytes: z.number().int().nonnegative().max(MAX_OUTBOUND_VIDEO_BYTES)
    })
  ])
).min(1).max(MAX_IMAGES_PER_TURN)

/**
 * 单条消息（发给模型的通道）：刻意**不含** segments —— 执行分段是本地渲染资产，不随请求出境（plan36 审查坑 2）。
 * 空正文按角色放行（K8）：否则被「停止生成」留下空正文助手轮的那条会话，从此再也发不出消息。
 * 这比落盘侧 `storedMessageSchema` 松一档（segments 到不了这儿），差额由 agent/context `historyForModel` 兜住。
 */
const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(200000),
    parts: contentPartsSchema.optional()
  })
  .superRefine((m, ctx) => {
    if (m.content.trim().length === 0 && m.role !== 'assistant') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '空正文只允许出现在助手轮' })
    }
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
            reasoningEffort: effortNameSchema.optional(),
            reasoning: reasoningConfigSchema.optional(),
            maxToolRounds: z.number().int().min(1).max(1000).optional(),
            inputModalities: z.array(z.enum(INPUT_MODALITIES)).min(1).optional()
          })
          .optional()
      })
    )
    .min(1)
    .max(50),
  activeModelId: z.string().max(64).optional(),
  apiKey: z.string().max(500),
  source: z.enum(['deepseek', 'custom']).optional()
}).superRefine(reasoningLevelsGuard)

/**
 * 输入框 chip 的单字段补丁（plan58 R2）。**形状闸**只管：定位（端点 + 条目）+ 字段形状；
 * 白名单判档**不在这里** —— handler 会把补丁合进现存档案、整表过 `modelSaveSchema`，
 * 与整表保存走同一道 `reasoningLevelsGuard`（Q13：patch 与 save 的合法性口径必须一致，
 * 两道闸各判各的迟早漂成两个口径）。
 */
export const modelPatchEntrySchema = z.object({
  profileId: z.string().min(1).max(64),
  entryId: z.string().min(1).max(64),
  patch: z
    .object({
      reasoningEffort: effortNameSchema.optional(),
      reasoning: reasoningConfigSchema.optional()
    })
    .refine((p) => p.reasoningEffort !== undefined || p.reasoning !== undefined, {
      message: '补丁为空：至少要带一个要改的字段'
    })
})

/**
 * 逐模型白名单校验（plan58 R6 的落点，Q13 / Q6b 都落在这一条）。
 *
 * ⚠️ **三条判定必须分清，混起来就会把存量档案全拒掉**：
 * 1. `reasoning` 没填 ⇒ **不判**。存量档案（盘上 `deepseek-flash` / `mimo-*` 都存着 `high`）
 *    没有 `reasoning` 字段，若这里也判，用户下次点保存就被拒 ⇒ 那是拿新校验打断老数据，
 *    正是"演进限制"要防的事。R6 修法第 3 条同源：不给老档案凭空造档。
 * 2. `reasoning` 填了但 `levels` 没填 ⇒ **不判**，但界面须标「未实测」（R9）。
 *    我们三家端点全是 openai-compatible 代理，档名吃得对不对**一格都没实测过**，
 *    自动探测也覆盖不到（能力发现接口只有 Anthropic / OpenRouter 有）⇒ 白名单只能人工填，
 *    没填就不许替它下结论。
 * 3. `levels` 填了 ⇒ **它就是唯一合法性来源**。同一个档名在声明了的模型上放行、
 *    没声明的模型上拒绝（Q13 两向都测），拒绝时带上已声明的档位，让界面能说清为什么。
 *
 * `'default'` 是**哨兵不是厂商档**（R8）⇒ 任何 kind 下都放行，用户随时能切回"不发字段"。
 */
/** 守卫的入参只声明**读得到的那两个字段**，其余结构 zod 会自己补 —— 手写 `Record<string, unknown>` 会让值退成 `unknown`。 */
type ReasoningGuardShape = {
  models: Array<{
    settings?: {
      reasoningEffort?: string
      reasoning?: { kind?: string; levels?: string[] }
    }
  }>
}

function reasoningLevelsGuard(val: ReasoningGuardShape, ctx: z.RefinementCtx): void {
  val.models.forEach((m, i) => {
    const s = m.settings
    if (!s) return
    const effort = s.reasoningEffort
    if (effort === undefined || effort === 'default') return
    const cfg = s.reasoning as { kind?: string; levels?: string[] } | undefined

    // ★ 这里**只判一条**：声明了 `kind:'effort'` 且填了 `levels` 时，它就是唯一合法性来源。
    //   09-28 改判（R11′，用户裁定「出境层统一裁决」）：原先这里还有三条"形态与档位矛盾 ⇒ 拒"
    //   （`none` / `toggle` / `budget_tokens` 各一条），现已撤掉 —— 那些形态下档位是
    //   **inert 数据**（`shared/reasoning.ts · effortToSend` 第 2 条保证它永不出境；该判定
    //   09-29 从 `main/providers/effort.ts` 搬进 `shared/`，好让界面用同一份判"设了没生效"），
    //   拒它没有技术道理，只制造一个**用户解不开的死结**：存量模型存着 `high` 时，
    //   用户第一次把该模型标为"不支持思考"会被拒，而要把档位改回 `default` 得先能操作那个下拉。
    //   ⇒ 存形状只管形状；**发不发一律由出境层裁决**。
    if (cfg?.kind !== 'effort') return
    const levels = cfg.levels
    if (!levels || levels.length === 0) return // 见判定 2
    if (levels.includes(effort)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['models', i, 'settings', 'reasoningEffort'],
      message: `档位不在该模型声明的支持列表内（已声明：${levels.join('、')}）`
    })
  })
}

/** 切"端点内的当前模型" */
export const modelEntryPickSchema = z.object({
  profileId: z.string().min(1).max(64),
  entryId: z.string().min(1).max(64)
})

/**
 * 「拉取可用模型」入参（plan47 S1）：吃未保存的草稿——协议 + 地址 + Key 即可，`id` 可选。
 * 复用 `settingsSchema` 的 baseURL 归一（自动补 https:// + 合法 URL 校验），与 `settingsTest` 同一条入参规矩。
 */
export const modelFetchAvailableSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  providerType: z.enum(['openai-compatible', 'anthropic']),
  baseURL: settingsSchema.shape.baseURL,
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  apiKey: z.string().max(500).optional()
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
    parts: contentPartsSchema.optional(),
    segments: z.array(z.record(z.string(), z.unknown())).max(1000).optional(),
    /** plan46：消息时间戳（可选 —— 旧数据无该字段，渲染层据此决定是否显示时间） */
    createdAt: z.number().int().nonnegative().optional()
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
    parts: contentPartsSchema.optional(),
    segments: z.array(segmentSchema).max(1000).optional(),
    /** plan46：消息时间戳（可选 —— 旧存档无此字段，渲染层无则不显示时间，不编造） */
    createdAt: z.number().int().nonnegative().optional()
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
