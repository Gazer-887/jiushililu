import { createLogger } from '../log'
import type { TokenUsage } from '@shared/usage'

/**
 * 从 Provider 的响应里**取真实 usage**（plan8 R9 的依赖）。
 *
 * ## 为什么单独一个文件、而不是塞进两个 provider
 *
 * 两个协议的 usage **形状完全不同**：
 *   · OpenAI 兼容：**最后一个 chunk** 带 `usage: {prompt_tokens, completion_tokens}`
 *     （且必须显式请求 `stream_options.include_usage`，否则流式里根本不带）
 *   · Anthropic：**分两处报** —— `message_start` 给输入、`message_delta` 给输出
 *
 * 塞进各自的 provider 里的话，两份"取数逻辑"会各自演化、也没法一起测；
 * 放这儿是**纯函数**：给一个已经 `JSON.parse` 过的对象，回一个 `TokenUsage` 或 null。
 *
 * ## 一条硬规矩
 *
 * **认不出来一律返回 null**，绝不硬编一个 `{0,0}` ——
 * 那会被上层当成"这一轮真的没用量"，而真相是"我们不知道"。
 * 二者的区别在账面上很致命：前者会把累计值算小，后者会走估算兜底并**标注**。
 */

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * 把一份原始 usage **拍平成"键路径 → 标量"**（plan8 R9.1 §七①）。
 *
 * ## 为什么要有它
 *
 * "缓存命中"与"推理用量"的字段名**各家不同、还会变**：
 *   · DeepSeek 系 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *   · OpenAI 系 `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`
 *   · Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`
 * 凭记忆写字段名 = 埋一个**永远不生效的解析**（不报错、只是恒为 null，最难查的那类 bug）。
 * 所以先让真机把形状吐出来，照着写。
 *
 * ## 两条自我约束
 *
 * - **始终拍平**（键路径 → 标量），最多走两层：`prompt_tokens_details.cached_tokens` 恰好两层；
 *   再深的只留一个 `{…}` 占位，免得把日志变成一坨嵌套 JSON。
 *   字符串只记**长度**不记内容（usage 里本就不该有正文，但探针不该成为泄露的口子）。
 * - **纯函数**：给对象回对象，不碰 IO —— 好单测，也不会把探针的风险带进解析路径。
 */
export function describeUsageShape(
  usage: unknown,
  maxDepth = 2,
  prefix = '',
  depth = 1
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!usage || typeof usage !== 'object') return out
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'number' && Number.isFinite(value)) out[path] = value
    else if (typeof value === 'boolean') out[path] = value
    else if (typeof value === 'string') out[path] = `string(${value.length})`
    else if (value === null) out[path] = 'null'
    else if (Array.isArray(value)) out[path] = `array(${value.length})`
    else if (typeof value === 'object') {
      if (depth >= maxDepth) out[path] = '{…}' // 深度用尽：留个痕迹，不展开
      else Object.assign(out, describeUsageShape(value, maxDepth, path, depth + 1))
    } else out[path] = typeof value
  }
  return out
}

const log = createLogger('usage')

/**
 * 见过的形状（每种只吐一次）。
 *
 * 为什么要记忆化：usage 每轮都来一条，同一种形状刷屏毫无信息量，
 * 还会把真正稀有的形状（比如突然多出个 `reasoning_tokens`）淹掉。
 */
const seenShapes = new Set<string>()

/**
 * 探针：把**厂商真正报了什么**记进 debug 日志（`app.log`）。
 *
 * 默认看不见是有意的 —— 日志级别在**打包版是 info**（`src/main/index.ts`），
 * 只有开发态（`electron .`）才落盘。既拿到了核对用的真数据，又不给用户的日志添噪音。
 */
function probeShape(protocol: string, usage: unknown): void {
  try {
    const shape = describeUsageShape(usage)
    const key = `${protocol}|${JSON.stringify(shape)}`
    if (seenShapes.has(key)) return
    seenShapes.add(key)
    log.debug(`原始 usage 形状（${protocol}）`, shape)
  } catch {
    // 探针是旁路：它炸了不许影响解析
  }
}

/**
 * 输入里**命中缓存**的那部分 —— 两套字段名都认（plan8 R9.1 §七①）。
 *
 * 真机实测（DeepSeek，2026-09-12）：同一条响应里**两套同报、同值**：
 *   顶层 `prompt_cache_hit_tokens: 2048` ＝ 嵌套 `prompt_tokens_details.cached_tokens: 2048`
 * 先认顶层（DeepSeek 专有、更直白），再退回嵌套（OpenAI 兼容的通用形状）——
 * 这样换端点、换模型时两条路都在，不会因为"少了某个字段"就静默变成没数据。
 */
function pickCached(u: Record<string, unknown>): number | null {
  const hit = u['prompt_cache_hit_tokens']
  if (isNonNegInt(hit)) return hit
  const details = u['prompt_tokens_details']
  if (details && typeof details === 'object') {
    const cached = (details as Record<string, unknown>)['cached_tokens']
    if (isNonNegInt(cached)) return cached
  }
  return null
}

/**
 * 输出里的**推理（思考链）**量：报在 OpenAI 系的嵌套位置（DeepSeek 也报在这里，实测同路）。
 *
 * ⚠️ 注意 `0` 与"没有"的区别：实测 DeepSeek 明确报 `reasoning_tokens: 0`（这轮没思考），
 * 这是**真的 0**，要当数据收下；字段压根不存在才是"没报"（返回 null，不加键）。
 */
function pickReasoning(u: Record<string, unknown>): number | null {
  const details = u['completion_tokens_details']
  if (details && typeof details === 'object') {
    const reasoning = (details as Record<string, unknown>)['reasoning_tokens']
    if (isNonNegInt(reasoning)) return reasoning
  }
  return null
}

/** OpenAI 兼容：`usage.prompt_tokens` / `completion_tokens` */
export function usageFromOpenAIChunk(json: unknown): TokenUsage | null {
  if (!json || typeof json !== 'object') return null
  const usage = (json as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  // 探针跑在**校验之前**：脏数据也要看得见形状（不然"字段名不对"和"厂商没报"分不清）
  probeShape('openai', usage)
  const prompt = u['prompt_tokens']
  const completion = u['completion_tokens']
  // 两个都要是合法非负整数才算数：只报一半的数据宁可不用（半个账比没有账更坏）
  if (!isNonNegInt(prompt) || !isNonNegInt(completion)) return null
  // 缓存/推理是**可选**的：厂商没报就写 **null**（明确的"未知"），不是省略这个键 ——
  // 省略的含义是"这份账不含这条信息"，累加时会被静默跳过，
  // 等于把"没报"偷偷记成 0（详见 `@shared/usage` 的 addOptional 那张表）
  const cached = pickCached(u)
  const reasoning = pickReasoning(u)
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedPromptTokens: cached,
    reasoningTokens: reasoning
  }
}

/**
 * Anthropic：`message_start.message.usage.input_tokens` 与
 * `message_delta.usage.output_tokens` —— 两处各报一半，缺的那半补 0。
 */
export function usageFromAnthropicEvent(json: unknown): TokenUsage | null {
  if (!json || typeof json !== 'object') return null
  const evt = json as Record<string, unknown>
  const type = evt['type']

  if (type === 'message_start') {
    const message = evt['message']
    const usage =
      message && typeof message === 'object' ? (message as Record<string, unknown>)['usage'] : undefined
    if (!usage || typeof usage !== 'object') return null
    const u = usage as Record<string, unknown>
    // 探针（同 OpenAI 那处）：`message_start` 是**输入＋缓存**字段出现的地方
    probeShape('anthropic:message_start', usage)
    const input = u['input_tokens']
    if (!isNonNegInt(input)) return null
    const output = u['output_tokens']
    /**
     * Anthropic 的缓存命中 = `cache_read_input_tokens`（**读**命中）。
     *
     * 隔壁那个 `cache_creation_input_tokens`（这轮**写入**缓存的量）**不收**：
     * 它不是命中，混进来会把命中率算成一个假数字 ——
     * 而假数字正是本文件头注要防的东西（数错了是 bug，口径错了是误导）。
     */
    const cachedRead = u['cache_read_input_tokens']
    return {
      promptTokens: input,
      completionTokens: isNonNegInt(output) ? output : 0,
      cachedPromptTokens: isNonNegInt(cachedRead) ? cachedRead : null,
      // Anthropic 的 usage 里**没有**单列思考量（thinking 计入输出），故这里是明确的"没报"
      reasoningTokens: null
    }
  }

  if (type === 'message_delta') {
    const usage = evt['usage']
    if (!usage || typeof usage !== 'object') return null
    const u = usage as Record<string, unknown>
    // 探针：`message_delta` 是**最终输出**（推理用量若有，多半也在这条）
    probeShape('anthropic:message_delta', usage)
    const output = u['output_tokens']
    if (!isNonNegInt(output)) return null
    // 这半只报输出：输入与缓存都是"这半不认识"→ 明确写 null（合并时才不会把它们当成 0）
    return { promptTokens: 0, completionTokens: output, cachedPromptTokens: null, reasoningTokens: null }
  }

  return null
}
