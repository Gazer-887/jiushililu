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

/** OpenAI 兼容：`usage.prompt_tokens` / `completion_tokens` */
export function usageFromOpenAIChunk(json: unknown): TokenUsage | null {
  if (!json || typeof json !== 'object') return null
  const usage = (json as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const prompt = u['prompt_tokens']
  const completion = u['completion_tokens']
  // 两个都要是合法非负整数才算数：只报一半的数据宁可不用（半个账比没有账更坏）
  if (!isNonNegInt(prompt) || !isNonNegInt(completion)) return null
  return { promptTokens: prompt, completionTokens: completion }
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
    const input = u['input_tokens']
    if (!isNonNegInt(input)) return null
    const output = u['output_tokens']
    return { promptTokens: input, completionTokens: isNonNegInt(output) ? output : 0 }
  }

  if (type === 'message_delta') {
    const usage = evt['usage']
    if (!usage || typeof usage !== 'object') return null
    const u = usage as Record<string, unknown>
    const output = u['output_tokens']
    if (!isNonNegInt(output)) return null
    return { promptTokens: 0, completionTokens: output }
  }

  return null
}
