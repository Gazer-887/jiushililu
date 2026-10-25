import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '@main/providers/http-client'
import {
  chatWithToolsOpenAI,
  streamWithToolsOpenAI
} from '@main/providers/openai-agent'
import {
  chatWithToolsAnthropic,
  streamWithToolsAnthropic
} from '@main/providers/anthropic-agent'
import { ProviderError } from '@main/providers/errors'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import type { ModelSettings } from '@shared/ipc'

/**
 * E23-R1 双协议非流终态与同响应降级（R23-乙 四项缺陷的守护）。
 *
 * 判据来源：真实终态精确实施合同 §3.1 + 反例矩阵 P3 + 补正 V2 §三 + R23-乙 独立实测。
 * 核心原则（三条）：
 *   1. **自动模型重放 = 0** —— 一次调用最多一次 POST，`!res.body` 不得偷偷再发。
 *   2. **同一响应降级** —— Content-Type 是 JSON 就消费**这份**响应，保正文/工具/usage。
 *   3. **业务终因强校验** —— 缺终因→unknown、截断→truncated、拒绝→denied，绝不静默完成。
 */

afterEach(() => setHttpFetch(null))

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'm',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  inputModalities: ['text']
}
const anthropicSettings: ModelSettings = { ...settings, providerType: 'anthropic' }
const tools: ToolSchema[] = [
  { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }
]
const msgs: AgentMessage[] = [{ role: 'user', content: 'hi' }]
const SHORT = { timeouts: { firstByteMs: 5000, idleMs: 5000 } }

/** fetch 计数器：断言「实际发出了几次 POST」 */
let hits = 0

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) return c.close()
      c.enqueue(enc.encode(chunks[i]!))
      i += 1
    }
  })
}

function countFetch(make: () => Response): void {
  hits = 0
  setHttpFetch(async () => {
    hits += 1
    return make()
  })
}

async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p
  } catch (err) {
    return err
  }
}

/** 成功形态：正常 return（不带 terminal，按裁决 C） */
function expectSucceeded(r: unknown): AgentChatResult {
  expect(r).not.toBeInstanceOf(ProviderError)
  expect(r).not.toBeInstanceOf(Error)
  return r as AgentChatResult
}

function factsOf(r: unknown): { terminal?: { state: string; code?: string }; usage?: unknown; usageComplete?: boolean } | undefined {
  return r instanceof ProviderError ? (r.facts as never) : undefined
}

// ══════════════════════════════════════════════════════════════════════════
// 缺陷 1：stream 无 body 不得重放（hits 必须为 1，且受控 unknown）
// ══════════════════════════════════════════════════════════════════════════

describe('E23-R1 · stream 无 body：hits=1 且受控 unknown，禁止二次 POST', () => {
  it('OpenAI：200 无 body → 只发 1 次请求，unknown/missing-terminal', async () => {
    countFetch(() => new Response(null, { status: 200 }))
    const r = await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r).toBeInstanceOf(ProviderError)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('Anthropic：200 无 body → 只发 1 次请求，unknown/missing-terminal', async () => {
    countFetch(() => new Response(null, { status: 200 }))
    const r = await catchErr(
      streamWithToolsAnthropic(anthropicSettings, 'k', msgs, tools, () => {}, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r).toBeInstanceOf(ProviderError)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('无 body 的错误不带厂商原文与 cause', async () => {
    countFetch(() => new Response(null, { status: 200 }))
    const r = (await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )) as ProviderError
    expect((r as { cause?: unknown }).cause).toBeUndefined()
    expect(JSON.stringify(r.facts)).not.toContain('SECRET')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 缺陷 2：Content-Type JSON 同一响应降级（hits=1，保正文/工具/usage）
// ══════════════════════════════════════════════════════════════════════════

describe('E23-R1 · stream 收到 application/json：消费同一响应、hits=1', () => {
  it('OpenAI：合法 stop + usage → 正常完成，正文与已知账都保留', async () => {
    countFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '同响应正文' }, finish_reason: 'stop' }
            ],
            usage: { prompt_tokens: 11, completion_tokens: 3 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const r = expectSucceeded(
      await streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r.text).toBe('同响应正文')
    expect(r.usage).toMatchObject({ promptTokens: 11, completionTokens: 3 })
    expect(r.usageComplete).toBe(true)
  })

  it('Anthropic：合法 end_turn + usage → 正常完成，正文与已知账都保留', async () => {
    countFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '同响应正文' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 7, output_tokens: 2 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const r = expectSucceeded(
      await streamWithToolsAnthropic(anthropicSettings, 'k', msgs, tools, () => {}, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r.text).toBe('同响应正文')
    expect(r.usage).toMatchObject({ promptTokens: 7, completionTokens: 2 })
    expect(r.usageComplete).toBe(true)
  })

  it('OpenAI：JSON 里是 length → truncated/token-limit，且仍保已知 usage', async () => {
    countFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '被截断' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 20, completion_tokens: 10 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const r = await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r).toBeInstanceOf(ProviderError)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'truncated', code: 'token-limit' })
    expect(factsOf(r)?.usage).toMatchObject({ promptTokens: 20, completionTokens: 10 })
    expect(factsOf(r)?.usageComplete).toBe(true)
  })

  it('Anthropic：JSON 里是 refusal → denied/content-filter', async () => {
    countFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '拒绝' }],
            stop_reason: 'refusal',
            usage: { input_tokens: 5, output_tokens: 1 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const r = await catchErr(
      streamWithToolsAnthropic(anthropicSettings, 'k', msgs, tools, () => {}, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r).toBeInstanceOf(ProviderError)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'denied', code: 'content-filter' })
  })

  it('OpenAI：JSON 缺 finish_reason → unknown/missing-terminal，不静默完成', async () => {
    countFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    const r = await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 缺陷 3：直接非流入口的业务终因校验
// ══════════════════════════════════════════════════════════════════════════

describe('E23-R1 · 非流 chatWithTools*：终因强校验', () => {
  function oaJson(body: unknown): void {
    countFetch(
      () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
  }

  it('OpenAI 正常 stop → 返回正文 + usage，不抛', async () => {
    oaJson({
      choices: [{ message: { content: '正常' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 4 }
    })
    const r = expectSucceeded(await chatWithToolsOpenAI(settings, 'k', msgs, tools))
    expect(hits).toBe(1)
    expect(r.text).toBe('正常')
    expect(r.usage).toMatchObject({ promptTokens: 9, completionTokens: 4 })
    expect(r.usageComplete).toBe(true)
  })

  it('OpenAI 缺 finish_reason → unknown/missing-terminal', async () => {
    oaJson({ choices: [{ message: { content: 'x' } }] })
    const r = await catchErr(chatWithToolsOpenAI(settings, 'k', msgs, tools))
    expect(r).toBeInstanceOf(ProviderError)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('OpenAI length → truncated/token-limit，且保已知 usage', async () => {
    oaJson({
      choices: [{ message: { content: '截断' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 12, completion_tokens: 6 }
    })
    const r = await catchErr(chatWithToolsOpenAI(settings, 'k', msgs, tools))
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'truncated', code: 'token-limit' })
    expect(factsOf(r)?.usage).toMatchObject({ promptTokens: 12, completionTokens: 6 })
  })

  it('OpenAI content_filter → denied/content-filter', async () => {
    oaJson({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] })
    const r = await catchErr(chatWithToolsOpenAI(settings, 'k', msgs, tools))
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'denied', code: 'content-filter' })
  })

  it('OpenAI 合法工具回合 → 返回 toolCalls', async () => {
    oaJson({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    })
    const r = expectSucceeded(await chatWithToolsOpenAI(settings, 'k', msgs, tools))
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }])
  })

  it('OpenAI 明确报 0 的 usage 保留 0，不补造 null', async () => {
    oaJson({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 }
    })
    const r = expectSucceeded(await chatWithToolsOpenAI(settings, 'k', msgs, tools))
    expect(r.usage).toMatchObject({ promptTokens: 0, completionTokens: 0 })
    expect(r.usage).not.toBeNull()
  })

  it('Anthropic 正常 end_turn → 返回正文 + usage', async () => {
    oaJson({
      content: [{ type: 'text', text: '正常' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 3 }
    })
    const r = expectSucceeded(await chatWithToolsAnthropic(anthropicSettings, 'k', msgs, tools))
    expect(r.text).toBe('正常')
    expect(r.usage).toMatchObject({ promptTokens: 8, completionTokens: 3 })
  })

  it('Anthropic 缺 stop_reason → unknown/missing-terminal', async () => {
    oaJson({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } })
    const r = await catchErr(chatWithToolsAnthropic(anthropicSettings, 'k', msgs, tools))
    expect(r).toBeInstanceOf(ProviderError)
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('Anthropic max_tokens → truncated/token-limit', async () => {
    oaJson({
      content: [{ type: 'text', text: '截断' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 30, output_tokens: 15 }
    })
    const r = await catchErr(chatWithToolsAnthropic(anthropicSettings, 'k', msgs, tools))
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'truncated', code: 'token-limit' })
    expect(factsOf(r)?.usage).toMatchObject({ promptTokens: 30, completionTokens: 15 })
  })

  it('Anthropic refusal → denied/content-filter', async () => {
    oaJson({ content: [], stop_reason: 'refusal', usage: { input_tokens: 2, output_tokens: 0 } })
    const r = await catchErr(chatWithToolsAnthropic(anthropicSettings, 'k', msgs, tools))
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'denied', code: 'content-filter' })
  })

  it('Anthropic 合法工具回合 → 返回 toolCalls', async () => {
    oaJson({
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 1 }
    })
    const r = expectSucceeded(await chatWithToolsAnthropic(anthropicSettings, 'k', msgs, tools))
    expect(r.toolCalls?.[0]?.name).toBe('read_file')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 缺陷 4：非流 HTTP 错误携结构化 facts + 隐私
// ══════════════════════════════════════════════════════════════════════════

describe('E23-R1 · 非流 HTTP 错误：facts 挂载与厂商正文不外泄', () => {
  it('OpenAI 401：抛 ProviderError 且带 failed/http-error facts，canary 不出现在 message/facts', async () => {
    countFetch(() => new Response('{"error":"SECRET_CANARY_BODY"}', { status: 401 }))
    const r = (await catchErr(chatWithToolsOpenAI(settings, 'k', msgs, tools))) as ProviderError
    expect(r).toBeInstanceOf(ProviderError)
    expect(r.facts?.terminal).toMatchObject({ state: 'failed', code: 'http-error' })
    expect(r.facts?.terminal).toMatchObject({ httpStatus: 401 })
    expect(r.message).not.toContain('SECRET_CANARY_BODY')
    expect(JSON.stringify(r.facts)).not.toContain('SECRET_CANARY_BODY')
    expect((r as { cause?: unknown }).cause).toBeUndefined()
  })

  it('Anthropic 401：同样挂 facts 且不外泄', async () => {
    countFetch(() => new Response('SECRET_CANARY_BODY', { status: 401 }))
    const r = (await catchErr(chatWithToolsAnthropic(anthropicSettings, 'k', msgs, tools))) as ProviderError
    expect(r).toBeInstanceOf(ProviderError)
    expect(r.facts?.terminal).toMatchObject({ state: 'failed', code: 'http-error' })
    expect(r.message).not.toContain('SECRET_CANARY_BODY')
  })

  it('stream 路径的 HTTP 错误同样带 facts', async () => {
    countFetch(() => new Response('SECRET_CANARY_BODY', { status: 401 }))
    const r = (await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )) as ProviderError
    expect(r).toBeInstanceOf(ProviderError)
    expect(r.facts?.terminal).toMatchObject({ state: 'failed', code: 'http-error' })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 回归守护：非 JSON 流式原行为不得被本单改动破坏
// ══════════════════════════════════════════════════════════════════════════

describe('E23-R1 · 非 JSON 流式既有行为保留', () => {
  const oa = (p: Record<string, unknown>): string => `data: ${JSON.stringify(p)}\n\n`

  it('OpenAI 正常 SSE stop → 完成（hits=1）', async () => {
    countFetch(
      () =>
        new Response(
          sseBody([
            oa({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
            oa({ choices: [{ delta: {}, finish_reason: 'stop' }] })
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
    )
    const r = expectSucceeded(
      await streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(hits).toBe(1)
    expect(r.text).toBe('x')
  })

  it('OpenAI SSE 缺终帧 → unknown/missing-terminal（沿用首版判据）', async () => {
    countFetch(
      () =>
        new Response(
          sseBody([oa({ choices: [{ delta: { content: 'x' }, finish_reason: null }] })]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
    )
    const r = await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('OpenAI SSE 已报 usage → 失败时已知账不丢', async () => {
    countFetch(
      () =>
        new Response(
          sseBody([
            oa({
              choices: [{ delta: { content: 'x' }, finish_reason: 'length' }],
              usage: { prompt_tokens: 4, completion_tokens: 2 }
            })
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
    )
    const r = await catchErr(
      streamWithToolsOpenAI(settings, 'k', msgs, tools, () => {}, undefined, undefined, SHORT)
    )
    expect(factsOf(r)?.terminal).toMatchObject({ state: 'truncated', code: 'token-limit' })
    expect(factsOf(r)?.usage).toMatchObject({ promptTokens: 4, completionTokens: 2 })
  })
})
