import { createLogger } from '../log'
import type { TokenUsage } from '@shared/usage'

/**
 * 从 Provider 响应里**取真实 usage**（plan8 R9）。
 *
 * 为什么单独一个文件：两个协议的 usage 形状完全不同 —— OpenAI 兼容在**最后一个 chunk**，且必须显式请求
 * `stream_options.include_usage`（否则流式里根本不带）；Anthropic **分两处报**（`message_start` 给输入、
 * `message_delta` 给输出）。塞进各自 provider 里，两份取数逻辑会各自演化、也没法一起测。
 *
 * ⚠️ **认不出来一律返回 null**，绝不硬编 `{0,0}` —— 那会被上层当成"这一轮真的没用量"，
 * 而真相是"我们不知道"：前者把累计值算小，后者会走估算兜底并**标注**。
 */

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * 把一份原始 usage **拍平成「键路径 → 标量」**（plan8 R9.1 §七①），最多两层、字符串只记**长度**不记内容
 * （探针不该成为泄露的口子）。为什么要它：缓存 / 推理的字段名各家不同还会变，凭记忆写就等于埋一个
 * **永远不生效的解析**（不报错、恒为 null，最难查那类）；给对象回对象、不碰 IO，纯函数好单测。
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

/** 见过的形状（每种只吐一次）：usage 每轮都来，同形状刷屏会把稀有的形状（如突然多出 `reasoning_tokens`）淹掉 */
const seenShapes = new Set<string>()

/** 探针：把**厂商真正报了什么**记进 debug 日志。默认看不见是有意的 —— 打包版日志级别是 info，只有开发态才落盘 */
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
 * 输入里**命中缓存**的那部分 —— 两套字段名都认（plan8 R9.1 §七①）。真机实测（DeepSeek，2026-09-12）：
 * 顶层 `prompt_cache_hit_tokens` 与嵌套 `prompt_tokens_details.cached_tokens` 同报同值；
 * 先认顶层再退回嵌套，换端点 / 换模型时不会因为少了某个字段就静默变成没数据。
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
 * 输出里的**推理（思考链）**量，报在 OpenAI 系的嵌套位置（DeepSeek 也报在这里，实测同路）。
 * ⚠️ 分清 `0` 与"没有"：字段存在且为 0 = 这轮真没思考，要当数据收下；字段压根不存在才是"没报"（返回 null）。
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
  // 缓存 / 推理是**可选**的：厂商没报就写 **null**（明确的"未知"），不是省略这个键 ——
  // 省略的含义是"这份账不含这条信息"，累加时会被静默跳过，等于把"没报"偷偷记成 0（见 `@shared/usage`）
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
 * Anthropic：`message_start.message.usage.input_tokens` 与 `message_delta.usage.output_tokens` 各报一半
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
     * Anthropic 的缓存命中 = `cache_read_input_tokens`（**读**命中）。隔壁 `cache_creation_input_tokens`
     * （这轮**写入**缓存的量）**不收** —— 它不是命中，混进来会把命中率算成假数字（数错了是 bug，口径错了是误导）。
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
