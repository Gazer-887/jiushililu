import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, ToolSchema } from '@shared/agent'
import type { RunTerminal } from '@shared/execution-outcome'
import { resolveApiUrl } from './url'
import { usageFromOpenAIChunk } from './usage-parsers'
import type { TokenUsage } from '@shared/usage'
import { ProviderError, mapHttpError } from './errors'
import { createSSEParser } from './sse'
import { effortToSend, openaiReasoningFields } from '@shared/reasoning'
import { ToolCallAccumulator, ToolCallIntegrityError } from './tool-accumulator'
import { httpFetch } from './http-client'
import { attachmentTextForModel } from '@shared/attachment-block'
import { createStreamGuard, type StreamGuardOptions } from './stream-guard'
import type { ProviderExecutionContext } from '@shared/request-policy'
import {
  buildProviderHeaders,
  createServiceTierEmitter,
  readServiceTierValue,
  serviceTierForRequest,
  serviceTierForResult,
  withServiceTierField,
  type ServiceTierEmitter
} from './service-tier'
import type { ServiceTierObserver } from './types'

// OpenAI tool-calls 适配（plan6 → P1；D-032 增补流式）：主循环的模型通道。
// DeepSeek / V4 全系原生兼容 OpenAI tool-calls 协议；采样字段与 chat 路径同规则（可空不发）。

/**
 * 出境形状（plan57 片③）：`parts` 是我们的内部字段，**绝不能原样发出去**（严格端点会按未知字段 400）。
 * 带图的轮换 OpenAI 视觉那套 content 数组；其余轮把 `parts` 摘掉、形状与改造前逐字节相同。
 */
export function toOpenAIWireMessage(m: AgentMessage): Record<string, unknown> {
  const { parts } = m
  const rest = {
    role: m.role, content: m.role === 'user' && typeof m.content === 'string' ? attachmentTextForModel(m.content) : m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
  }
  if (!parts?.some((p) => p.type === 'image' || p.type === 'video')) return rest
  return {
    ...rest,
    content: parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: m.role === 'user' ? attachmentTextForModel(p.text) : p.text }
        : p.type === 'video'
          ? // 实测形状（plan57 §八之四）：MiMo token-plan 端点收 `video_url` + base64 data URL，
            // 且 usage 里单独报 `video_tokens`；`{"type":"video",…}` 那种帧序列形状它回 400
            { type: 'video_url', video_url: { url: `data:${p.mime};base64,${p.base64}` } }
          : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } }
    )
  }
}

/** 构造带工具请求体（纯函数，单测覆盖） */
export function buildToolsBody(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: ToolSchema[],
  stream: boolean,
  /** 运行态上下文（S3-30A）：缺省 = 旧请求，一个服务档字段都不加 */
  context?: ProviderExecutionContext
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: messages.map(toOpenAIWireMessage),
    max_tokens: settings.maxTokens,
    stream,
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  }
  if (settings.temperature !== null) body['temperature'] = settings.temperature
  if (settings.topP !== null) body['top_p'] = settings.topP
  if (settings.topK !== null) body['top_k'] = settings.topK
  const effort = effortToSend(settings)
  if (effort !== null) body['reasoning_effort'] = effort
  // 片②（缺口 C）：toggle / budget_tokens 的出境字段，与对话通路同一份判定（R15/R16）
  Object.assign(body, openaiReasoningFields(settings))
  return withServiceTierField(body, context)
}

async function throwHttpError(res: Response): Promise<never> {
  const detail = await res.text().catch(() => '')
  // HTTP 层失败也挂结构化事实（E23-R1）：调用方据此判终态，不必解析文案。
  // ⚠️ detail 只用于映射文案，绝不进入 message/facts —— 厂商正文不得外泄。
  throw new ProviderError(mapHttpError(res.status, detail), res.status, {
    scope: 'request',
    terminal: { state: 'failed', code: 'http-error', httpStatus: res.status },
    usage: null,
    usageComplete: false
  })
}

/** 受控失败（E23-R1）：固定本地文案 + 白名单事实，不带厂商原文/cause。 */
function failRequest(terminal: RunTerminal, usage: TokenUsage | null): never {
  throw new ProviderError('本次请求未正常完成', 0, {
    scope: 'request',
    terminal,
    usage,
    usageComplete: usage !== null
  })
}

/**
 * 非流 JSON 响应 → AgentChatResult（E23-R1）。
 * ⚠️ 这是**同一响应**的唯一消费点：stream 收到 application/json 时也走它，
 * 不重新发请求 —— 自动模型重放固定为 0。
 */
function resultFromOpenAIJson(
  json: {
    choices?: Array<{
      finish_reason?: string | null
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
    }>
    usage?: unknown
    service_tier?: unknown
  },
  requestedTier: string | null,
  context?: ProviderExecutionContext,
  /** 单请求观察出口（S3-30A-R1）：必须在抛原失败前交出本响应已观察到的真实档位 */
  tierEmitter?: ServiceTierEmitter
): AgentChatResult {
  const usage = usageFromOpenAIChunk(json)
  // 先交出档位、再判终态：截断/拒绝的失败信封不变，但已观测事实不再丢失
  tierEmitter?.observe(readServiceTierValue(json))
  const choice = json.choices?.[0]
  const terminal = openaiFinishReasonToTerminal(choice?.finish_reason)
  // 缺终因 / 未知值 / 截断 / 拒绝一律受控失败，绝不静默当成功
  if (terminal === null) failRequest({ state: 'unknown', code: 'missing-terminal' }, usage)
  if (terminal.state !== 'completed') failRequest(terminal, usage)

  const msg = choice?.message ?? {}
  // 档位只认响应里的真实 service_tier；缺报保持未知态，不从 requested/usage/终态推断
  const serviceTier = serviceTierForResult(requestedTier, readServiceTierValue(json), context)
  return {
    text: typeof msg.content === 'string' && msg.content.length > 0 ? msg.content : null,
    toolCalls: (msg.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '{}'
    })),
    usageComplete: usage !== null,
    ...(usage ? { usage } : {}),
    ...(serviceTier ? { serviceTier } : {})
  }
}

export async function chatWithToolsOpenAI(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal,
  /** 运行态上下文（S3-30A）：缺省 = 旧请求，不发身份/服务档 */
  context?: ProviderExecutionContext,
  /** 单请求服务档观察（S3-30A-R1）：缺省 = 不观察；旧调用者参数位置不变 */
  onServiceTier?: ServiceTierObserver
): Promise<AgentChatResult> {
  const requestedTier = serviceTierForRequest(context)
  const tierEmitter = createServiceTierEmitter(requestedTier, onServiceTier)
  try {
    const res = await httpFetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
      method: 'POST',
      headers: buildProviderHeaders(settings, 'openai-compatible', apiKey, context),
      body: JSON.stringify(buildToolsBody(settings, messages, tools, false, context)),
      signal
    })
    if (!res.ok) await throwHttpError(res)

    return resultFromOpenAIJson(
      (await res.json()) as {
        choices?: Array<{
          finish_reason?: string | null
          message?: {
            content?: string | null
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
          }
        }>
        usage?: unknown
        service_tier?: unknown
      },
      requestedTier,
      context,
      tierEmitter
    )
  } finally {
    // 同一响应只观察一次：已交出真实档位就不再补缺报事件
    tierEmitter.finalize()
  }
}

/**
 * OpenAI `finish_reason` → 业务终态（E23）。
 * ⚠️ **只有这里的映射才决定"这轮算不算完成"**：`[DONE]` 哨兵不是成功依据 ——
 * 上游可能在没给 finish_reason 的情况下直接断流，那种流不该被当成功。
 * 未知值一律 unknown/unsupported-stop，绝不猜成 completed。
 *
 * ⚠️ E23-R1：`function_call` 是**本应用从不发出的 legacy 协议形式**，按合同归 unknown。
 * 收到它说明上游协议形态与预期不符，不能当正常收束。
 */
function openaiFinishReasonToTerminal(reason: string | null | undefined): RunTerminal | null {
  if (reason === null || reason === undefined) return null
  switch (reason) {
    case 'stop':
      return { state: 'completed' }
    case 'tool_calls':
      // 工具是否真的存在由调用方的结构一致性检查确认；这里只标"业务上正常收束"
      return { state: 'completed' }
    case 'length':
      return { state: 'truncated', code: 'token-limit' }
    case 'content_filter':
      return { state: 'denied', code: 'content-filter' }
    default:
      // 含 legacy `function_call`：本应用未发出的协议形式，按 unknown 处理
      return { state: 'unknown', code: 'unsupported-stop' }
  }
}

/** 流式 + 工具（D-032 核心）：文本增量实时回调、工具调用参数分片累积；一条通道同时承担"聊天"与"干活" */export async function streamWithToolsOpenAI(
  settings: ModelSettings,
  apiKey: string,
  messages: AgentMessage[],
  tools: ToolSchema[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
  /** 思考增量（DeepSeek 系返回 `reasoning_content`）；不传 = 忽略 */
  onReasoning?: (delta: string) => void,
  /** 两层守卫的时长（plan29 D-090）。不传 = 用默认口径；**单测传短值** */
  guardOpts?: StreamGuardOptions,
  /** 运行态上下文（S3-30A）：缺省 = 旧请求，不发身份/服务档 */
  context?: ProviderExecutionContext,
  /** 单请求服务档观察（S3-30A-R1）：缺省 = 不观察；旧调用者参数位置不变 */
  onServiceTier?: ServiceTierObserver
): Promise<AgentChatResult> {
  const requestedTier = serviceTierForRequest(context)
  // 单请求观察出口（S3-30A-R1）：档位帧一出现就交出，后续断流/取消/缺终帧都不丢已观测事实
  const tierEmitter = createServiceTierEmitter(requestedTier, onServiceTier)
  // 守卫在**这里**建、而不是由调用方传进来：首包口径是"从发起请求到第一个分片"，
  // 只有紧挨着 httpFetch 的地方才数得准；让调用方建就多了一段"还没开始请求但已经在计时"的空转。
  const guard = createStreamGuard(signal, guardOpts)
  try {
    const res = await httpFetch(resolveApiUrl(settings.baseURL, 'chat/completions'), {
      method: 'POST',
      headers: buildProviderHeaders(settings, 'openai-compatible', apiKey, context),
      body: JSON.stringify(buildToolsBody(settings, messages, tools, true, context)),
      signal: guard.signal
    })
    if (!res.ok) await throwHttpError(res)

    // ⚠️ E23-R1：无 body 时**不得再发一次请求** —— 自动模型重放固定为 0。
    //    旧实现会调 chatWithToolsOpenAI 重新 POST，等于用第二个响应掩盖第一次的未知状态。
    if (!res.body) failRequest({ state: 'unknown', code: 'missing-terminal' }, null)

    // ⚠️ E23-R1：端点忽略 stream 回退成 JSON 时，消费**同一响应**，不发新请求（hits 保持 1）。
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.toLowerCase().includes('application/json')) {
      return resultFromOpenAIJson((await res.json()) as never, requestedTier, context, tierEmitter)
    }

    const acc = new ToolCallAccumulator()
    let text = ''
    /**
     * 这一轮的用量（plan8 R9）。⚠️ **主循环这条才是真正花钱的**（一次对话可能调好几轮模型）——
     * 上游只在**最后一个 chunk** 报 usage（且必须显式请求 `stream_options.include_usage`），
     * 所以每个 chunk 都要试着取一次；厂商不报就留 null，上层据此退回估算并**标注**。
     */
    let usage: TokenUsage | null = null
    /** 最后一次看到的真实 service_tier（S3-30A）：缺报保持 null，绝不回填 requested */
    let actualTier: string | null = null
    /** 最后一次看到的 finish_reason（E23）：**业务终态的唯一依据**，`[DONE]` 不算 */
    let finishReason: string | null = null
    /** 上游在 payload 里明确报错（E23）：必须当失败，不能当"没有 delta 就跳过" */
    let upstreamError = false
    /** 业务帧 JSON 损坏（E23）：形似业务消息却解析失败，不能被通用 catch 静默吞掉 */
    let malformedBusinessFrame = false

    const parser = createSSEParser((data) => {
      if (data === '[DONE]') return
      let json: {
        error?: unknown
        usage?: unknown
        service_tier?: unknown
        choices?: Array<{
          finish_reason?: string | null
          delta?: {
            content?: string
            /** DeepSeek 系（reasoner / v4）把思考放这里；OpenAI 系通常不返回内容 */
            reasoning_content?: string
            tool_calls?: Array<Record<string, unknown>>
          }
        }>
      }
      try {
        json = JSON.parse(data) as typeof json
      } catch {
        // 只有**形似业务帧**的损坏才算错；心跳/注释/裸文本仍按协议忽略
        if (/"(choices|error|usage)"\s*:/.test(data)) malformedBusinessFrame = true
        return
      }
      // 顶层 error：上游明确报错，必须当失败（不能因没有 delta 而跳过）
      if (json.error !== undefined && json.error !== null) {
        upstreamError = true
        return
      }
      const chunkUsage = usageFromOpenAIChunk(json)
      if (chunkUsage) usage = chunkUsage
      // 档位帧与 usage 帧相互独立：任何一帧带真实值都收；无档位的后续帧不清空已知值
      const chunkTier = readServiceTierValue(json)
      if (chunkTier !== null) {
        actualTier = chunkTier
        tierEmitter.observe(chunkTier)
      }
      const choice = json.choices?.[0]
      // finish_reason 每帧都可能出现（通常最后一帧），取最后一次非空值
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason
      }
      const delta = choice?.delta
      if (!delta) return
      // 思考增量：**不进 text**，只外送 —— 它是过程，不是回答
      if (delta.reasoning_content) onReasoning?.(delta.reasoning_content)
      if (delta.content) {
        text += delta.content
        onText(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        try {
          acc.pushOpenAI(
            delta.tool_calls as Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          )
        } catch {
          // 冲突已记进 accumulator 的 conflict 状态；finishStrict 会拒绝，
          // 这里吞掉是为了不在解析回调里中断流（真实 provider 同款结构）
        }
      }
    })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // 分片到齐 → 重置分片间隔计时（"还在来数据"与"卡死了"就是靠这一下分开的）
      guard.onChunk()
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.end()

    // ── 业务终态判定（E23）：顺序即优先级，先确定"这轮是什么结局"，再决定要不要交工具 ──
    // ⚠️ 只有**失败形态**才带 terminal（走 ProviderError.facts）；成功直接 return 即代表 completed，
    //    `AgentChatResult` 保持既有 shape，整轮 terminal 由后续 loop/runner 写入 AgentLoopResult。
    const failWith: (terminal: RunTerminal) => never = (terminal) => {
      throw new ProviderError('本次请求未正常完成', 0, {
        scope: 'request',
        terminal,
        usage,
        usageComplete: usage !== null
      })
    }

    if (upstreamError) failWith({ state: 'failed', code: 'upstream-error' })
    if (malformedBusinessFrame) failWith({ state: 'unknown', code: 'malformed-stream' })

    const terminal = openaiFinishReasonToTerminal(finishReason)
    if (terminal === null) failWith({ state: 'unknown', code: 'missing-terminal' })
    if (terminal.state !== 'completed') failWith(terminal)

    // 工具放行只走严格出口：残片/冲突一律拒绝，且**不执行任何该轮工具**
    let toolCalls
    try {
      toolCalls = acc.finishStrict()
    } catch (err) {
      if (err instanceof ToolCallIntegrityError) {
        failWith({ state: 'failed', code: 'incomplete-tool-call' })
      }
      throw err
    }

    // ── 结构一致性（E23-R1）：**先固定结构，再决定工具放行** ──
    // finish_reason 与「工具是否真的存在」必须互相印证；矛盾一律受控失败，绝不执行工具。
    const expectsTools = finishReason === 'tool_calls'
    if (expectsTools && toolCalls.length === 0) {
      // 说本轮是工具调用，却一个完整工具都没解析出来 → 残片或上游谎报
      failWith({ state: 'failed', code: 'incomplete-tool-call' })
    }
    if (!expectsTools && toolCalls.length > 0) {
      // 终态说"正常结束"却冒出工具 → 结构矛盾，执行它等于凭空干活
      failWith({ state: 'failed', code: 'incomplete-tool-call' })
    }

    const serviceTier = serviceTierForResult(requestedTier, actualTier, context)
    return {
      text: text.length > 0 ? text : null,
      toolCalls,
      usageComplete: usage !== null,
      ...(usage ? { usage } : {}),
      ...(serviceTier ? { serviceTier } : {})
    }
  } catch (err) {
    // 守卫开的枪 → 换成**说清是哪一层超时**的话（不是笼统的"请求超时"）
    const timedOut = guard.timeoutMessage()
    if (timedOut) throw new ProviderError(timedOut, 0)
    throw err
  } finally {
    guard.dispose()
    // 只有从未见到真实档位才补 observed=false；已观测到的不补，避免缺报覆盖已知事实
    tierEmitter.finalize()
  }
}
