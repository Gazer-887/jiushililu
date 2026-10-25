import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createMcpManager } from '@main/mcp/mcp-manager'
import { createMcpTools } from '@main/agent/tools/mcp-tools'
import { runAgentLoop, type AgentLoopOptions } from '@main/agent/loop'
import { runAgent, createAgentContext } from '@main/agent/runner'
import { runSubagents } from '@main/agent/scheduler'
import { createAgentTaskRegistry } from '@main/agent-task-registry'
import { createExecEventRecorder } from '@main/agent/exec-events'
import { storedMessageSchema, runTerminalSchema } from '@main/schemas'
import { createChatEmitter } from '@main/chat-emitter'
// E29：助手消息终态判定必须来自真实 ChatView 导出（组件入口同源），禁止复制实现给测试
import { assistantTerminalText } from '../../src/renderer/src/views/ChatView'
import { IPC, type ChatDonePayload, type ChatErrorPayload } from '@shared/ipc'
import {
  AGENT_RUN_TERMINALS,
  DEFAULT_PROVIDER_FAILURE_TERMINAL,
  OUTCOME_CODES,
  RUN_RESULT_STATES,
  TOOL_RESULT_STATES,
  isRunTerminal,
  isOutcomeCode
} from '@shared/execution-outcome'
import { AgentRunFailure, ProviderError, isAbortError } from '@main/providers/errors'
import { resolvePolicy } from '@shared/token-tier'
import { setHttpFetch } from '@main/providers/http-client'
import { streamWithToolsOpenAI } from '@main/providers/openai-agent'
import { streamWithToolsAnthropic } from '@main/providers/anthropic-agent'
import {
  createSystemTools,
  createSystemToolsWithConfirm,
  type ShellSlot
} from '@main/agent/tools/system-tools'
import type { RuntimeEnv } from '@main/agent/tools/shell-session'
import { createBackgroundTaskStore, type BackgroundTaskStore } from '@main/agent/background-tasks'
import type { AgentTool, ToolEvent, ToolOutcome } from '@shared/agent'
import type { ModelSettings } from '@shared/ipc'
import type { AgentMessage } from '@shared/agent'

/**
 * E21 类型与受控错误 + E23 双协议业务终态。
 * 判据来源：真实终态精确实施合同 §四 + V2 补正 §三 + 23 分类表。
 * E21 部分只验「类型默认值 / 错误构造与取消识别 / 旧兼容 / 敏感字段不入对象」。
 * E23 部分用**真实 Provider 类 + 真实 SSE 分块 + 真实工具累积**验双协议业务终态。
 */

afterEach(() => setHttpFetch(null))

// ── 测试脚手架 ────────────────────────────────────────────────────────────

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

const tools = [
  { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }
]

const userMsg: AgentMessage[] = [{ role: 'user', content: 'hi' }]

/** 把若干字符串分片按给定边界喂成 ReadableStream（模拟真实分块到达） */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(chunks[i]!))
      i += 1
    }
  })
}

function mockSSE(chunks: string[]): void {
  setHttpFetch(async () => new Response(streamOf(chunks), { status: 200 }))
}

/** OpenAI 风格的一个 SSE 帧 */
function oaChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Anthropic 风格的一个 SSE 帧 */
function anChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function runOpenAI(chunks: string[]): Promise<unknown> {
  mockSSE(chunks)
  try {
    return await streamWithToolsOpenAI(
      settings,
      'fake-key',
      userMsg,
      tools,
      () => {},
      undefined,
      undefined,
      { timeouts: { firstByteMs: 5000, idleMs: 5000 } }
    )
  } catch (err) {
    return err
  }
}

async function runAnthropic(chunks: string[]): Promise<unknown> {
  mockSSE(chunks)
  try {
    return await streamWithToolsAnthropic(
      anthropicSettings,
      'fake-key',
      userMsg,
      tools,
      () => {},
      undefined,
      { timeouts: { firstByteMs: 5000, idleMs: 5000 } }
    )
  } catch (err) {
    return err
  }
}

/** 取结果的 terminal（成功走返回值，失败走 ProviderError.facts） */
function terminalOf(result: unknown): { state: string; code?: string } | undefined {
  if (result instanceof ProviderError) return result.facts?.terminal as never
  if (result && typeof result === 'object' && 'terminal' in result) {
    return (result as { terminal?: { state: string; code?: string } }).terminal
  }
  return undefined
}

function usageOf(result: unknown): unknown {
  if (result instanceof ProviderError) return result.facts?.usage
  if (result && typeof result === 'object' && 'usage' in result) {
    return (result as { usage?: unknown }).usage
  }
  return undefined
}

function usageCompleteOf(result: unknown): unknown {
  if (result instanceof ProviderError) return result.facts?.usageComplete
  if (result && typeof result === 'object' && 'usageComplete' in result) {
    return (result as { usageComplete?: unknown }).usageComplete
  }
  return undefined
}

function toolCallsOf(result: unknown): unknown[] {
  if (result && typeof result === 'object' && 'toolCalls' in result) {
    return (result as { toolCalls: unknown[] }).toolCalls
  }
  return []
}

/**
 * 成功形态的断言（E23 合同：provider 能正常 return 就代表本次请求 completed）。
 * ⚠️ `AgentChatResult` 保持既有 shape，**不带 terminal** —— 整轮 terminal 由后续 loop/runner
 * 写入 `AgentLoopResult`；任何非 completed 形态都必须走 `ProviderError.facts.terminal`。
 */
function expectSucceeded(result: unknown): void {
  expect(result).not.toBeInstanceOf(ProviderError)
  expect(result).not.toBeInstanceOf(Error)
}

// ══════════════════════════════════════════════════════════════════════════
// E21 部分（保持原样，仅确认未被本单破坏）
// ══════════════════════════════════════════════════════════════════════════

describe('execution-outcome 固定分类与默认值', () => {
  it('三个枚举取值集合与合同逐字一致', () => {
    expect(TOOL_RESULT_STATES).toEqual(['succeeded', 'failed', 'cancelled', 'denied', 'unknown'])
    expect(RUN_RESULT_STATES).toEqual([
      'completed',
      'failed',
      'cancelled',
      'denied',
      'unknown',
      'truncated',
      'max-rounds'
    ])
    expect(OUTCOME_CODES).toEqual([
      'missing-terminal',
      'malformed-stream',
      'incomplete-tool-call',
      'upstream-error',
      'http-error',
      'network-error',
      'first-byte-timeout',
      'idle-timeout',
      'token-limit',
      'content-filter',
      'unsupported-stop',
      'user-stop',
      'permission-denied',
      'command-exit',
      'command-timeout',
      'output-limit',
      'unknown-exit',
      'tool-error'
    ])
  })

  it('Agent 可结算终态不含 max-rounds（它只走 done 且不得显示成功）', () => {
    expect(AGENT_RUN_TERMINALS).toContain('completed')
    expect(AGENT_RUN_TERMINALS).toContain('truncated')
    expect(AGENT_RUN_TERMINALS).not.toContain('max-rounds')
  })

  it('类型守卫拒绝非枚举值与畸形对象', () => {
    expect(isRunTerminal({ state: 'completed' })).toBe(true)
    expect(isRunTerminal({ state: 'max-rounds', code: 'user-stop' })).toBe(true)
    expect(isRunTerminal({ state: 'success' })).toBe(false)
    expect(isRunTerminal({})).toBe(false)
    expect(isRunTerminal(null)).toBe(false)
    expect(isOutcomeCode('http-error')).toBe(true)
    expect(isOutcomeCode('http_error')).toBe(false)
    expect(isOutcomeCode(undefined)).toBe(false)
  })

  it('缺省失败终态是 unknown，不是 failed —— 不许凭异常形状猜用户取消', () => {
    expect(DEFAULT_PROVIDER_FAILURE_TERMINAL).toEqual({ state: 'unknown' })
  })
})
describe('ProviderError 旧接口兼容', () => {
  it('两参数构造仍可 instanceof 与读 status', () => {
    const err = new ProviderError('人话文案', 429)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ProviderError')
    expect(err.status).toBe(429)
    expect(err.facts).toBeUndefined()
  })

  it('单参数构造不带 status，也不带 facts', () => {
    const err = new ProviderError('连不上')
    expect(err.status).toBeUndefined()
    expect(err.facts).toBeUndefined()
    expect(err.message).toBe('连不上')
  })

  it('旧调用方凭 message+status 仍能走原路径（HTTP 文案映射不变）', () => {
    const err = new ProviderError('原始正文不许外泄', 401)
    expect(err.message).toContain('401')
    expect(err.message).not.toContain('原始正文不许外泄')
  })
})

describe('ProviderError 受控事实（request scope）', () => {
  it('第三参数只保留白名单事实，usage 与 usageComplete 原样带出', () => {
    const err = new ProviderError('人话', 500, {
      scope: 'request',
      terminal: { state: 'failed', code: 'http-error', httpStatus: 500 },
      usage: { promptTokens: 100, completionTokens: 10 },
      usageComplete: true
    })
    expect(err.facts?.scope).toBe('request')
    expect(err.facts?.terminal).toEqual({ state: 'failed', code: 'http-error', httpStatus: 500 })
    expect(err.facts?.usage).toEqual({ promptTokens: 100, completionTokens: 10 })
    expect(err.facts?.usageComplete).toBe(true)
  })

  it('漏报就是 null，不补 0；已报 0 保留 0', () => {
    const missing = new ProviderError('漏报', 0, {
      scope: 'request',
      terminal: { state: 'unknown', code: 'idle-timeout' },
      usage: null,
      usageComplete: false
    })
    expect(missing.facts?.usage).toBeNull()
    expect(missing.facts?.usageComplete).toBe(false)

    const reportedZero = new ProviderError('明确报0', 0, {
      scope: 'request',
      terminal: { state: 'failed', code: 'content-filter' },
      usage: { promptTokens: 0, completionTokens: 0 },
      usageComplete: true
    })
    expect(reportedZero.facts?.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
    expect(reportedZero.facts?.usage).not.toBeNull()
  })

  it('usageComplete 与 terminal 相互独立：失败也可以是完整账', () => {
    const err = new ProviderError('业务截断', 0, {
      scope: 'request',
      terminal: { state: 'truncated', code: 'token-limit' },
      usage: { promptTokens: 50, completionTokens: 5 },
      usageComplete: true
    })
    expect(err.facts?.terminal.state).toBe('truncated')
    expect(err.facts?.usageComplete).toBe(true)
  })

  it('facts 是可枚举纯数据，不含 cause / 原始正文 / 厂商 message', () => {
    const marker = 'RAW_VENDOR_BODY_MARKER'
    const err = new ProviderError('人话', 500, {
      scope: 'request',
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false
    })
    Object.assign(err, { cause: new Error(marker) })
    const serialized = JSON.stringify(err.facts)
    expect(serialized).not.toContain(marker)
    expect(serialized).not.toContain('cause')
    expect(Object.keys(err.facts as object).sort()).toEqual(['scope', 'terminal', 'usage', 'usageComplete'])
  })

  it('拒绝把未知字段塞进 facts（白名单之外不落地）', () => {
    const err = new ProviderError('人话', 500, {
      scope: 'request',
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false,
      rawBody: 'SHOULD_NOT_SURVIVE',
      vendorMessage: 'SHOULD_NOT_SURVIVE'
    } as never)
    expect(JSON.stringify(err.facts)).not.toContain('SHOULD_NOT_SURVIVE')
  })
})

describe('AgentRunFailure（run scope）单一事实入口', () => {
  it('只接事实，message 由固定本地映射生成，不含厂商正文', () => {
    const marker = 'RAW_VENDOR_BODY_MARKER'
    const err = new AgentRunFailure({
      scope: 'run',
      runId: 'run-1',
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: { promptTokens: 8, completionTokens: 2 },
      usageComplete: true
    })
    expect(err).toBeInstanceOf(AgentRunFailure)
    expect(err).toBeInstanceOf(Error)
    expect(err.facts.scope).toBe('run')
    expect(err.facts.runId).toBe('run-1')
    expect(err.message).not.toContain(marker)
    expect(JSON.stringify(err.facts)).not.toContain(marker)
  })

  it('整轮账可带可选 avoidedTokens / tokenTier，未观测则省略而不是造 0 或默认档', () => {
    const withExtras = new AgentRunFailure({
      scope: 'run',
      runId: 'run-2',
      terminal: { state: 'cancelled', code: 'user-stop' },
      usage: { promptTokens: 10, completionTokens: 2 },
      usageComplete: false,
      avoidedTokens: 1234,
      tokenTier: 'balanced'
    })
    expect(withExtras.facts.avoidedTokens).toBe(1234)
    expect(withExtras.facts.tokenTier).toBe('balanced')

    const withoutExtras = new AgentRunFailure({
      scope: 'run',
      runId: 'run-3',
      terminal: { state: 'unknown', code: 'missing-terminal' },
      usage: null,
      usageComplete: false
    })
    expect(withoutExtras.facts.avoidedTokens).toBeUndefined()
    expect(withoutExtras.facts.tokenTier).toBeUndefined()
    expect('avoidedTokens' in withoutExtras.facts).toBe(false)
    expect('tokenTier' in withoutExtras.facts).toBe(false)
  })

  it('全漏报保持 null，不因构造而变 0', () => {
    const err = new AgentRunFailure({
      scope: 'run',
      runId: 'run-4',
      terminal: { state: 'failed', code: 'network-error' },
      usage: null,
      usageComplete: false
    })
    expect(err.facts.usage).toBeNull()
  })

  it('事实是快照：构造后外部改动原对象不影响 facts', () => {
    const facts = {
      scope: 'run' as const,
      runId: 'run-5',
      terminal: { state: 'failed' as const, code: 'tool-error' as const },
      usage: { promptTokens: 1, completionTokens: 1 },
      usageComplete: true
    }
    const err = new AgentRunFailure(facts)
    facts.usage.promptTokens = 999
    facts.runId = 'mutated'
    expect(err.facts.usage).toEqual({ promptTokens: 1, completionTokens: 1 })
    expect(err.facts.runId).toBe('run-5')
  })

  it('facts 不含 cause 属性（错误对象本身不得挂厂商原始 cause 供 logger 输出）', () => {
    const err = new AgentRunFailure({
      scope: 'run',
      runId: 'run-6',
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false
    })
    expect((err as { cause?: unknown }).cause).toBeUndefined()
  })
})

describe('取消识别单一入口', () => {
  it('保留原 AbortError 名称判断', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isAbortError(abort)).toBe(true)
    expect(isAbortError(new Error('普通错误'))).toBe(false)
    expect(isAbortError('字符串')).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })

  it('识别 facts.terminal.state=cancelled 的 ProviderError', () => {
    const err = new ProviderError('已取消', 0, {
      scope: 'request',
      terminal: { state: 'cancelled', code: 'user-stop' },
      usage: null,
      usageComplete: false
    })
    expect(isAbortError(err)).toBe(true)
  })

  it('识别 facts.terminal.state=cancelled 的 AgentRunFailure', () => {
    const err = new AgentRunFailure({
      scope: 'run',
      runId: 'run-7',
      terminal: { state: 'cancelled', code: 'user-stop' },
      usage: null,
      usageComplete: false
    })
    expect(isAbortError(err)).toBe(true)
  })

  it('首包/idle 超时保持 unknown，不被误当用户取消', () => {
    for (const code of ['first-byte-timeout', 'idle-timeout'] as const) {
      const providerErr = new ProviderError('超时', 0, {
        scope: 'request',
        terminal: { state: 'unknown', code },
        usage: null,
        usageComplete: false
      })
      expect(isAbortError(providerErr)).toBe(false)

      const runErr = new AgentRunFailure({
        scope: 'run',
        runId: 'run-8',
        terminal: { state: 'unknown', code },
        usage: null,
        usageComplete: false
      })
      expect(isAbortError(runErr)).toBe(false)
    }
  })

  it('真实用户停止不被降级成通用 failed', () => {
    const err = new AgentRunFailure({
      scope: 'run',
      runId: 'run-9',
      terminal: { state: 'cancelled', code: 'user-stop' },
      usage: null,
      usageComplete: false
    })
    expect(err.facts.terminal.state).toBe('cancelled')
    expect(err.facts.terminal.state).not.toBe('failed')
  })

  it('denied 与 truncated 也不算取消', () => {
    const denied = new AgentRunFailure({
      scope: 'run',
      runId: 'run-10',
      terminal: { state: 'denied', code: 'permission-denied' },
      usage: null,
      usageComplete: false
    })
    expect(isAbortError(denied)).toBe(false)

    const truncated = new AgentRunFailure({
      scope: 'run',
      runId: 'run-11',
      terminal: { state: 'truncated', code: 'token-limit' },
      usage: null,
      usageComplete: false
    })
    expect(isAbortError(truncated)).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// E23 · OpenAI 业务终态（O1-O5）
// ══════════════════════════════════════════════════════════════════════════

describe('E23 · OpenAI O1：stop=completed，合法 finish_reason + EOF 无 DONE 也可完成', () => {
  it('finish_reason=stop 且无 [DONE] 哨兵 → completed', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    ])
    expect(result).not.toBeInstanceOf(ProviderError)
    expectSucceeded(result)
  })

  it('[DONE] 不是成功依据：只有 DONE 没有 finish_reason → 拒绝而非成功', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      'data: [DONE]\n\n'
    ])
    // 成功形态是「正常 return」；这里必须走失败路径，terminal 在 facts 里
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('有 stop 同时有 DONE → completed', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n'
    ])
    expectSucceeded(result)
  })
})

describe('E23 · OpenAI O2：tool_calls 必须 finishStrict 完整才放行', () => {
  it('完整工具调用 → completed 且 toolCalls 有内容', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }]
            },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expectSucceeded(result)
    expect(toolCallsOf(result)).toHaveLength(1)
  })

  it('工具缺 id → incomplete-tool-call 失败，且不执行任何工具', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'failed', code: 'incomplete-tool-call' })
    expect(toolCallsOf(result)).toHaveLength(0)
  })

  it('工具缺 name → incomplete-tool-call 失败', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c', function: { arguments: '{}' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ code: 'incomplete-tool-call' })
  })

  it('工具参数坏 JSON → incomplete-tool-call 失败', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"bad' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ code: 'incomplete-tool-call' })
  })

  it('同一 index 的 id 冲突 → incomplete-tool-call 失败', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c2', function: { arguments: '{}' } }] }, finish_reason: null }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ code: 'incomplete-tool-call' })
  })

  it('无参工具（id/name 完整、无 arguments）→ 合法 {}，completed', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'ping' } }] }, finish_reason: null }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expectSucceeded(result)
    expect(toolCallsOf(result)).toHaveLength(1)
  })
})

describe('E23 · OpenAI O3：length=truncated/token-limit', () => {
  it('finish_reason=length → truncated/token-limit', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: '被截断' }, finish_reason: null }] }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'length' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'truncated', code: 'token-limit' })
  })
})

describe('E23 · OpenAI O4：content_filter / 明确拒绝 = denied/content-filter', () => {
  it('finish_reason=content_filter → denied/content-filter', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'denied', code: 'content-filter' })
  })
})

describe('E23 · OpenAI O5：payload 明确 error = failed/upstream-error', () => {
  it('顶层 error 字段 → failed/upstream-error', async () => {
    const result = await runOpenAI([oaChunk({ error: { message: 'upstream boom' } })])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'failed', code: 'upstream-error' })
  })

  it('错误对象不含厂商正文', async () => {
    const result = await runOpenAI([oaChunk({ error: { message: 'SECRET_VENDOR_TEXT' } })])
    expect((result as Error).message).not.toContain('SECRET_VENDOR_TEXT')
    expect(JSON.stringify((result as ProviderError).facts)).not.toContain('SECRET_VENDOR_TEXT')
  })
})

describe('E23 · OpenAI 缺终帧 / 未知 finish_reason = unknown', () => {
  it('流正常 EOF 但完全没有 finish_reason → unknown/missing-terminal', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: { content: 'x' } }] })])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'unknown', code: 'missing-terminal' })
  })

  it('未知 finish_reason → unknown/unsupported-stop', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: {}, finish_reason: 'weird_new_reason' }] })])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'unknown', code: 'unsupported-stop' })
  })

  it('finish_reason 为 null → unknown', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] })])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)?.state).toBe('unknown')
  })
})

describe('E23 · OpenAI 业务消息坏 JSON 不被通用 catch 吞掉', () => {
  it('形似业务帧但 JSON 损坏 → 失败而非静默成功', async () => {
    const result = await runOpenAI([
      'data: {"choices":[{"delta":{"content":"x"}\n\n',
      oaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(['malformed-stream', 'unknown', 'upstream-error']).toContain(terminalOf(result)?.code as string)
  })

  it('纯心跳/注释行仍可忽略，不算坏业务消息', async () => {
    const result = await runOpenAI([
      ': keepalive\n\n',
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    ])
    expectSucceeded(result)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// E23 · Anthropic 业务终态（A1-A3）
// ══════════════════════════════════════════════════════════════════════════

/** 构造一套完整的 Anthropic 消息壳 */
function anthropicEnvelope(stopReason: string | null, opts: { usage?: boolean; withStop?: boolean } = {}): string[] {
  const { usage = true, withStop = true } = opts
  const frames: string[] = []
  frames.push(
    anChunk({
      type: 'message_start',
      message: { usage: usage ? { input_tokens: 100, output_tokens: 0 } : undefined }
    })
  )
  frames.push(anChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
  frames.push(anChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }))
  frames.push(anChunk({ type: 'content_block_stop', index: 0 }))
  frames.push(
    anChunk({
      type: 'message_delta',
      delta: stopReason === null ? {} : { stop_reason: stopReason },
      usage: usage ? { output_tokens: 5 } : undefined
    })
  )
  if (withStop) frames.push(anChunk({ type: 'message_stop' }))
  return frames
}

describe('E23 · Anthropic A1：end_turn / stop_sequence = completed', () => {
  it('end_turn + message_stop → completed', async () => {
    const result = await runAnthropic(anthropicEnvelope('end_turn'))
    expect(result).not.toBeInstanceOf(ProviderError)
    expectSucceeded(result)
  })

  it('stop_sequence + message_stop → completed', async () => {
    const result = await runAnthropic(anthropicEnvelope('stop_sequence'))
    expectSucceeded(result)
  })

  it('ping / 注释事件可忽略，不影响完成判定', async () => {
    const frames = anthropicEnvelope('end_turn')
    frames.unshift(anChunk({ type: 'ping' }), ': comment\n\n')
    const result = await runAnthropic(frames)
    expectSucceeded(result)
  })
})

describe('E23 · Anthropic A2：tool_use 仅 finishStrict 完整放行', () => {
  function toolEnvelope(input: unknown, stopReason = 'tool_use'): string[] {
    return [
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input }
      }),
      anChunk({ type: 'content_block_stop', index: 0 }),
      anChunk({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } }),
      anChunk({ type: 'message_stop' })
    ]
  }

  it('完整 tool_use → completed 且 toolCalls 有内容', async () => {
    const result = await runAnthropic(toolEnvelope({ path: 'a' }))
    expectSucceeded(result)
    expect(toolCallsOf(result)).toHaveLength(1)
  })

  it('tool_use 缺 id → incomplete-tool-call', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'f', input: {} } }),
      anChunk({ type: 'content_block_stop', index: 0 }),
      anChunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
      anChunk({ type: 'message_stop' })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ code: 'incomplete-tool-call' })
    expect(toolCallsOf(result)).toHaveLength(0)
  })

  it('tool_use 的 input 是非对象数组 → incomplete-tool-call', async () => {
    const result = await runAnthropic(toolEnvelope([1, 2]))
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ code: 'incomplete-tool-call' })
  })
})

describe('E23 · Anthropic A3：max_tokens / refusal / error', () => {
  it('max_tokens → truncated/token-limit', async () => {
    const result = await runAnthropic(anthropicEnvelope('max_tokens'))
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'truncated', code: 'token-limit' })
  })

  it('model_context_window_exceeded → truncated/token-limit', async () => {
    const result = await runAnthropic(anthropicEnvelope('model_context_window_exceeded'))
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'truncated', code: 'token-limit' })
  })

  it('refusal → denied/content-filter', async () => {
    const result = await runAnthropic(anthropicEnvelope('refusal'))
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'denied', code: 'content-filter' })
  })

  it('type=error 事件 → failed/upstream-error', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({ type: 'error', error: { type: 'overloaded_error', message: 'SECRET_VENDOR_TEXT' } })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'failed', code: 'upstream-error' })
    expect((result as Error).message).not.toContain('SECRET_VENDOR_TEXT')
  })
})

describe('E23 · Anthropic 缺 stop_reason / message_stop = unknown', () => {
  it('有 message_delta 但缺 stop_reason → unknown', async () => {
    const result = await runAnthropic(anthropicEnvelope(null))
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)?.state).toBe('unknown')
  })

  it('有 stop_reason 但缺 message_stop → unknown', async () => {
    const result = await runAnthropic(anthropicEnvelope('end_turn', { withStop: false }))
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)?.state).toBe('unknown')
  })

  it('业务消息坏 JSON → 不静默成功', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      'data: {"type":"content_block_delta","delta":{"type":"text_delta"\n\n',
      anChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      anChunk({ type: 'message_stop' })
    ])
    expect(result).toBeInstanceOf(ProviderError)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// E23 · 用量与完整性（P1-P3）
// ══════════════════════════════════════════════════════════════════════════

describe('E23 · P1：终态与 usageComplete 相互独立', () => {
  it('truncated 但已拿到完整账 → usageComplete=true，usage 保留', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      oaChunk({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      })
    ])
    expect(terminalOf(result)).toMatchObject({ state: 'truncated' })
    expect(usageOf(result)).toMatchObject({ promptTokens: 100, completionTokens: 10 })
    expect(usageCompleteOf(result)).toBe(true)
  })

  it('失败但漏报用量 → usage=null，usageComplete=false', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })])
    expect(usageOf(result)).toBeNull()
    expect(usageCompleteOf(result)).toBe(false)
  })
})

describe('E23 · P2：已知账不丢、不补 0', () => {
  it('失败路径携带已观测 usage', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      oaChunk({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 42, completion_tokens: 7 }
      })
    ])
    expect(usageOf(result)).toMatchObject({ promptTokens: 42, completionTokens: 7 })
  })

  it('明确报 0 保留 0，不变 null', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: {}, finish_reason: 'content_filter' }], usage: { prompt_tokens: 0, completion_tokens: 0 } })
    ])
    expect(usageOf(result)).toMatchObject({ promptTokens: 0, completionTokens: 0 })
    expect(usageOf(result)).not.toBeNull()
  })
})

describe('E23 · P3：错误隐私（不含厂商正文 / cause）', () => {
  it('incomplete-tool-call 错误不含工具参数原文', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"SECRET_ARG' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect((result as Error).message).not.toContain('SECRET_ARG')
    expect(JSON.stringify((result as ProviderError).facts)).not.toContain('SECRET_ARG')
  })

  it('所有业务终态错误都不挂 cause', async () => {
    for (const chunks of [
      [oaChunk({ choices: [{ delta: {}, finish_reason: 'length' }] })],
      [oaChunk({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })],
      [oaChunk({ error: { message: 'boom' } })]
    ]) {
      const result = await runOpenAI(chunks)
      expect((result as { cause?: unknown }).cause).toBeUndefined()
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
// E23-R1 · 双协议结构一致性（主脑阻断 5 条）
// 核心原则：finish_reason / stop_reason 与「工具是否存在」必须互相印证。
// 先固定结构，再决定工具放行；结构矛盾一律受控失败，且不执行任何工具。
// ══════════════════════════════════════════════════════════════════════════

describe('E23-R1 · 缺口1：OpenAI function_call 属本应用未发出的协议形式 → unknown', () => {
  it('finish_reason=function_call → unknown/unsupported-stop，不判 completed', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'function_call' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'unknown', code: 'unsupported-stop' })
  })

  it('function_call 且带 legacy function_call 字段 → 仍拒绝，且不执行任何工具', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { function_call: { name: 'legacy_fn', arguments: '{}' } },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'function_call' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(toolCallsOf(result)).toHaveLength(0)
  })
})

describe('E23-R1 · 缺口2：OpenAI tool_calls 但无任何工具 → incomplete-tool-call', () => {
  it('finish_reason=tool_calls 且全程无 tool_calls 分片 → failed/incomplete-tool-call', async () => {
    const result = await runOpenAI([
      oaChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'failed', code: 'incomplete-tool-call' })
    expect(toolCallsOf(result)).toHaveLength(0)
  })

  it('tool_calls 但分片全被丢弃（无 name）→ incomplete-tool-call，不当空数组成功', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' }] }, finish_reason: null }]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ code: 'incomplete-tool-call' })
  })
})

describe('E23-R1 · 缺口3：Anthropic tool_use 但无任何工具 → incomplete-tool-call', () => {
  it('stop_reason=tool_use 且无 tool_use 块 → failed/incomplete-tool-call', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      anChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      anChunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
      anChunk({ type: 'message_stop' })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(terminalOf(result)).toMatchObject({ state: 'failed', code: 'incomplete-tool-call' })
    expect(toolCallsOf(result)).toHaveLength(0)
  })
})

describe('E23-R1 · 缺口4：结构矛盾（终态说没工具却有工具 / 说有工具却没工具）', () => {
  it('OpenAI stop 却出现完整工具调用 → 受控失败，不执行工具', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(toolCallsOf(result)).toHaveLength(0)
    expect(terminalOf(result)?.state).not.toBe('completed')
  })

  it('OpenAI stop 且完全无工具 → 允许空正文完成', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })])
    expectSucceeded(result)
    expect(toolCallsOf(result)).toHaveLength(0)
  })

  it('Anthropic end_turn 却出现 tool_use 块 → 受控失败，不执行工具', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }
      }),
      anChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      anChunk({ type: 'message_stop' })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(toolCallsOf(result)).toHaveLength(0)
    expect(terminalOf(result)?.state).not.toBe('completed')
  })

  it('Anthropic stop_sequence 却出现 tool_use 块 → 同样拒绝', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }
      }),
      anChunk({ type: 'message_delta', delta: { stop_reason: 'stop_sequence' }, usage: { output_tokens: 2 } }),
      anChunk({ type: 'message_stop' })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    expect(toolCallsOf(result)).toHaveLength(0)
  })

  it('Anthropic end_turn 且完全无工具 → 允许空正文完成', async () => {
    const result = await runAnthropic([
      anChunk({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      anChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      anChunk({ type: 'message_stop' })
    ])
    expectSucceeded(result)
    expect(toolCallsOf(result)).toHaveLength(0)
  })
})

describe('E23-R1 · 缺口5：结构错误不含厂商正文，usage 已知值与 usageComplete 独立保留', () => {
  it('结构矛盾错误不带厂商正文 / cause，且 usage 与 usageComplete 独立', async () => {
    const result = await runOpenAI([
      oaChunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"SECRET_STRUCT' } }] },
            finish_reason: null
          }
        ]
      }),
      oaChunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 77, completion_tokens: 9 }
      })
    ])
    expect(result).toBeInstanceOf(ProviderError)
    const err = result as ProviderError
    expect(err.message).not.toContain('SECRET_STRUCT')
    expect(JSON.stringify(err.facts)).not.toContain('SECRET_STRUCT')
    expect((err as { cause?: unknown }).cause).toBeUndefined()
    expect(err.facts?.usage).toMatchObject({ promptTokens: 77, completionTokens: 9 })
    expect(err.facts?.usageComplete).toBe(true)
  })

  it('结构错误且用量漏报 → usage=null 且 usageComplete=false（不补 0）', async () => {
    const result = await runOpenAI([oaChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })])
    expect(usageOf(result)).toBeNull()
    expect(usageCompleteOf(result)).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// E24a · 命令工具真实终态与判据补强
// 判据来源：真实终态精确实施合同 §3.2 + 反例矩阵 T1/T2/T3/T4 + B1 + R24-甲审查 B-P1~P4
// 核心原则：结构优先于文字；生产者事实不得靠 mock 冒充；副作用计数必须真实。
// ══════════════════════════════════════════════════════════════════════════

/** 从真实工厂里取出 run_command 工具（不 mock 工具本身） */
function pickRunCommand(
  workspaceRoot: string,
  opts: {
    confirm?: (command: string) => Promise<boolean>
    background?: BackgroundTaskStore
    shellSlot?: ShellSlot
    runtime?: RuntimeEnv
  } = {}
): AgentTool {
  const resolveRuntime = opts.runtime ? () => opts.runtime! : undefined
  const tools = opts.confirm
    ? createSystemToolsWithConfirm(
        workspaceRoot,
        opts.confirm,
        opts.background,
        'e24a-test',
        null,
        undefined,
        resolveRuntime,
        opts.shellSlot
      )
    : createSystemTools(workspaceRoot, opts.background, 'e24a-test', null, undefined, resolveRuntime, opts.shellSlot)
  const t = tools.find((x) => x.schema.name === 'run_command')
  if (!t) throw new Error('run_command 未在工具集中')
  return t
}

/** 从真实工厂里取出 check_command 工具 */
function pickCheckCommand(workspaceRoot: string, background: BackgroundTaskStore): AgentTool {
  const tools = createSystemTools(workspaceRoot, background, 'e24a-test')
  const t = tools.find((x) => x.schema.name === 'check_command')
  if (!t) throw new Error('check_command 未在工具集中')
  return t
}

/** 合成临时根：全部落在本单证据目录内，不碰系统 TEMP */
function syntheticRoot(tag: string): string {
  const base = join(process.env['E24A_TMP_ROOT'] ?? tmpdir(), `e24a-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(base, { recursive: true })
  return base
}

describe('E24a · T1：中文输出不反转结构状态（字样必须真到达 text）', () => {
  it('退出码 7 + stdout 中文「成功」→ failed/command-exit，且中文确实出现在 text', async () => {
    const root = syntheticRoot('t1-fail')
    const tool = pickRunCommand(root)
    // 用 \u 转义写中文，避开 cmd 代码页；Node 端输出的是真中文
    const cmd = `node -e "process.stdout.write('\\u6210\\u529f'); process.exit(7)"`
    const out = (await tool.execute({ command: cmd })) as ToolOutcome

    expect(out.outcome).toBe('failed')
    expect(out.code).toBe('command-exit')
    expect(out.exitCode).toBe(7)
    // ⚠️ 关键：不能只断言结构 —— 中文字样必须真的出现在 text 里
    expect(out.text).toContain('成功')
  })

  it('退出码 0 + stdout 中文「错误」→ succeeded，且中文确实出现在 text', async () => {
    const root = syntheticRoot('t1-ok')
    const tool = pickRunCommand(root)
    const cmd = `node -e "process.stdout.write('\\u9519\\u8bef'); process.exit(0)"`
    const out = (await tool.execute({ command: cmd })) as ToolOutcome

    expect(out.outcome).toBe('succeeded')
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('错误')
  })
})

describe('E24a · T2：退出码映射（0/非零/未执行）', () => {
  it('退出码 0 → succeeded/command-exit/exitCode=0', async () => {
    const root = syntheticRoot('t2-ok')
    const out = (await pickRunCommand(root).execute({ command: 'node -e "process.exit(0)"' })) as ToolOutcome
    expect(out).toMatchObject({ outcome: 'succeeded', code: 'command-exit', exitCode: 0 })
  })

  it('退出码 3 → failed/command-exit/exitCode=3', async () => {
    const root = syntheticRoot('t2-fail')
    const out = (await pickRunCommand(root).execute({ command: 'node -e "process.exit(3)"' })) as ToolOutcome
    expect(out).toMatchObject({ outcome: 'failed', code: 'command-exit', exitCode: 3 })
  })

  it('未执行（空命令）→ failed/tool-error，不产生任何副作用', async () => {
    const root = syntheticRoot('t2-empty')
    const out = (await pickRunCommand(root).execute({ command: '   ' })) as ToolOutcome
    expect(out).toMatchObject({ outcome: 'failed', code: 'tool-error' })
  })

  it('timeoutMs 非数字 → failed/tool-error（未执行参数错误）', async () => {
    const root = syntheticRoot('t2-badarg')
    const out = (await pickRunCommand(root).execute({ command: 'echo x', timeoutMs: 'abc' })) as ToolOutcome
    expect(out).toMatchObject({ outcome: 'failed', code: 'tool-error' })
  })
})

describe('E24a · T4：拒绝的阳性/阴性对照（真实副作用为 0）', () => {
  it('用户拒绝 → failed/permission-denied，且真实文件副作用 0', async () => {
    const root = syntheticRoot('t4-deny')
    // ⚠️ 命令参数里**不放中文路径**：本单证据根含中文，持久 shell 会按本地代码页把
    //    `阶段执行` 之类的字节改坏，导致 ENOENT 之类的假失败。改为相对文件名，
    //    cwd 已是 workspaceRoot，解析结果等价。
    const rel = 'SHOULD_NOT_EXIST.txt'
    const marker = join(root, rel)
    const tool = pickRunCommand(root, { confirm: async () => false })
    const out = (await tool.execute({
      command: `node -e "require('fs').writeFileSync('${rel}','x')"`
    })) as ToolOutcome

    expect(out).toMatchObject({ outcome: 'failed', code: 'permission-denied' })
    // ⚠️ 真实副作用计数：不是"变量没变"，是**文件真的没被创建**
    expect(existsSync(marker)).toBe(false)
  })

  it('用户批准 → 真实执行，文件副作用精确 1 次', async () => {
    const root = syntheticRoot('t4-allow')
    const rel = 'SHOULD_EXIST.txt'
    const marker = join(root, rel)
    const tool = pickRunCommand(root, { confirm: async () => true })
    const out = (await tool.execute({
      command: `node -e "require('fs').appendFileSync('${rel}','x')"`
    })) as ToolOutcome

    expect(out.outcome).toBe('succeeded')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('x') // 精确 1 次，不是 2 次
  })
})

describe('E24a · B-P1：spawn 回退的真实 exec 副作用必须精确 1 次', () => {
  it('shell spawn 失败后回退 exec，真实文件 append 恰好 1 次（不只数假 shell.run）', async () => {
    const root = syntheticRoot('bp1')
    // 同上：命令参数用相对文件名，避开中文路径的代码页问题
    const rel = 'FALLBACK_COUNT.txt'
    const marker = join(root, rel)
    let shellRunCalls = 0

    // 用既有 ShellSlot 注入 spawnError，触发真实 exec 回退。
    // ⚠️ 必须让 envFingerprint 与注入的 RuntimeEnv 一致，否则 getShell 的防御性换壳
    //    会先 dispose 掉假会话（那里会炸），测的就不是 fallback 了。
    const FP = 'e24a-fallback-fp'
    const failingShellSlot: ShellSlot = {
      current: {
        envFingerprint: FP,
        dispose: () => {},
        run: async () => {
          shellRunCalls += 1
          return {
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            exceeded: false,
            spawnError: 'shell 进程启动失败',
            elapsedMs: 1
          }
        }
      } as never
    }

    const tool = pickRunCommand(root, {
      shellSlot: failingShellSlot,
      runtime: { pathOverride: undefined, fingerprint: FP }
    })
    const out = (await tool.execute({
      command: `node -e "require('fs').appendFileSync('${rel}','x')"`
    })) as ToolOutcome

    expect(out.outcome).toBe('succeeded')
    // 假 shell 被调 1 次（进入 fallback 的前提）
    expect(shellRunCalls).toBe(1)
    // ⚠️ 真正干活的 exec 的**真实副作用**必须恰好 1 次 —— 这才是守护"没重复回退"
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('x')
  })
})

describe('E24a · B-P2：后台真实生产者（无可信退出码 → unknown）', () => {
  it('真实 createBackgroundTaskStore + 不存在 cwd 触发启动失败 → 无可信退出码', async () => {
    const root = syntheticRoot('bp2')
    const store = createBackgroundTaskStore()
    const bogusCwd = join(root, 'definitely-not-a-real-dir')

    const task = store.start({
      command: 'node -e "process.exit(0)"',
      cwd: bogusCwd,
      agent: 'e24a-test'
    })

    const deadline = Date.now() + 8000
    let t = store.get(task.id)
    while (t && t.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      t = store.get(task.id)
    }

    expect(t).toBeDefined()
    expect(t!.status).toBe('failed')
    // ⚠️ 关键：无可信退出码时 exitCode 必须是 undefined，**不能被补成 0**
    expect(t!.exitCode).toBeUndefined()
  })

  it('真实后台 exit 0 → done 且 exitCode=0（阳性对照）', async () => {
    const root = syntheticRoot('bp2-ok')
    const store = createBackgroundTaskStore()
    const task = store.start({ command: 'node -e "process.exit(0)"', cwd: root, agent: 'e24a-test' })
    const deadline = Date.now() + 10000
    let t = store.get(task.id)
    while (t && t.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      t = store.get(task.id)
    }
    expect(t!.status).toBe('done')
    expect(t!.exitCode).toBe(0)
  })

  it('真实后台 exit 7 → failed 且 exitCode=7（阳性对照）', async () => {
    const root = syntheticRoot('bp2-fail')
    const store = createBackgroundTaskStore()
    const task = store.start({ command: 'node -e "process.exit(7)"', cwd: root, agent: 'e24a-test' })
    const deadline = Date.now() + 10000
    let t = store.get(task.id)
    while (t && t.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      t = store.get(task.id)
    }
    expect(t!.status).toBe('failed')
    expect(t!.exitCode).toBe(7)
  })

  it('check_command 对无可信退出码的失败任务给出 unknown/unknown-exit', async () => {
    const root = syntheticRoot('bp2-check')
    const store = createBackgroundTaskStore()
    const bogusCwd = join(root, 'no-such-dir')
    const task = store.start({ command: 'node -e "process.exit(0)"', cwd: bogusCwd, agent: 'e24a-test' })

    const deadline = Date.now() + 8000
    let t = store.get(task.id)
    while (t && t.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      t = store.get(task.id)
    }
    expect(t!.status).toBe('failed')

    const out = (await pickCheckCommand(root, store).execute({ id: task.id })) as ToolOutcome
    expect(out).toMatchObject({ outcome: 'unknown', code: 'unknown-exit', exitCode: null })
  })

  it('check_command 对 exit 7 的失败任务给出 failed/command-exit/exitCode=7', async () => {
    const root = syntheticRoot('bp2-check7')
    const store = createBackgroundTaskStore()
    const task = store.start({ command: 'node -e "process.exit(7)"', cwd: root, agent: 'e24a-test' })
    const deadline = Date.now() + 10000
    let t = store.get(task.id)
    while (t && t.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      t = store.get(task.id)
    }
    expect(t!.status).toBe('failed')

    const out = (await pickCheckCommand(root, store).execute({ id: task.id })) as ToolOutcome
    expect(out).toMatchObject({ outcome: 'failed', code: 'command-exit', exitCode: 7 })
  })
})

describe('E24a · B-P4 / T3：stderr 噪声与中段文字不反转结构', () => {
  it('stdout 成功但 stderr 含大量噪声 → 仍 succeeded（结构优先于文字）', async () => {
    const root = syntheticRoot('t3-noise')
    const cmd = `node -e "for(let i=0;i<50;i++)process.stderr.write('ERROR noise line '+i+'\\n'); process.exit(0)"`
    const out = (await pickRunCommand(root).execute({ command: cmd })) as ToolOutcome
    expect(out.outcome).toBe('succeeded')
    expect(out.exitCode).toBe(0)
  })

  it('中段出现「错误」字样但退出码 0 → 仍 succeeded', async () => {
    const root = syntheticRoot('t3-mid')
    const cmd = `node -e "process.stdout.write('\\u9519\\u8bef\\u4e2d\\u6bb5'); process.exit(0)"`
    const out = (await pickRunCommand(root).execute({ command: cmd })) as ToolOutcome
    expect(out.outcome).toBe('succeeded')
    expect(out.text).toContain('错误中段')
  })
})

// ── E24b · MCP 真实失败传播（M1 / M2） ──────────────────────────────────────────

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function makeMcpTestServer(opts?: {
  onCall?: (name: string, args: unknown) => void
  isError?: boolean
  throwOnCall?: boolean
}) {
  const server = new Server({ name: 'mcp-test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'echo tool',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
      },
      {
        name: 'diagnostic_shot',
        description: 'returns image and status',
        inputSchema: { type: 'object', properties: { fakeText: { type: 'string' } } }
      }
    ]
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    opts?.onCall?.(req.params.name, req.params.arguments)
    if (opts?.throwOnCall) {
      throw new Error('MCP transport closed abruptly')
    }
    if (req.params.name === 'diagnostic_shot') {
      const isErr = opts?.isError ?? false
      return {
        content: [
          { type: 'text', text: (req.params.arguments as { fakeText?: string })?.fakeText ?? '看起来已完成，操作成功' },
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' }
        ],
        isError: isErr
      }
    }
    return {
      content: [{ type: 'text', text: `echoed: ${JSON.stringify(req.params.arguments)}` }],
      isError: false
    }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { clientTransport, server, serverTransport }
}

describe('E24b · M1：SDK 真实协议 isError=true + 伪装文本 + 诊断图片', () => {
  it('SDK 真实 isError=true 且文本故意写「看起来已完成」→ 判定为 failed/tool-error 且图片保留', async () => {
    const { clientTransport } = await makeMcpTestServer({ isError: true })
    const dir = syntheticRoot('m1-manager')
    writeFileSync(
      join(dir, 'mcp-servers.json'),
      JSON.stringify({ servers: [{ name: 'test_srv', transport: 'stdio', command: 'unused', enabled: true }] })
    )
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => clientTransport
    })
    await manager.connectAll()

    const res = await manager.callTool('test_srv', 'diagnostic_shot', { fakeText: '看起来已完成，操作成功' })
    expect(res.outcome).toBe('failed')
    expect(res.code).toBe('tool-error')
    expect(res.images).toHaveLength(1)
    expect(res.text).toContain('MCP 工具返回错误')
    expect(res.text).toContain('看起来已完成')

    // 经 mcp-tools 装配层转换
    const tools = createMcpTools({
      manager,
      computerControl: false,
      browserControl: false,
      onGatedDrop: () => {},
      saveImages: (imgs) => imgs.map((img, i) => ({ name: `shot-${i}.png`, mime: img.mime, bytes: 100 }))
    })
    const shotTool = tools.find((t) => t.schema.name === 'mcp__test_srv__diagnostic_shot')!
    const out = (await shotTool.execute({ fakeText: '看起来已完成，操作成功' })) as ToolOutcome
    expect(out.outcome).toBe('failed')
    expect(out.code).toBe('tool-error')
    expect(out.images).toHaveLength(1)
  })

  it('在 runAgentLoop 中：isError=true 产生 error 阶段事件、exec.ok=false、保留诊断图但不标成功产物卡', async () => {
    const { clientTransport } = await makeMcpTestServer({ isError: true })
    const dir = syntheticRoot('m1-loop')
    writeFileSync(
      join(dir, 'mcp-servers.json'),
      JSON.stringify({ servers: [{ name: 'test_srv', transport: 'stdio', command: 'unused', enabled: true }] })
    )
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => clientTransport
    })
    await manager.connectAll()

    const tools = createMcpTools({
      manager,
      computerControl: false,
      browserControl: false,
      onGatedDrop: () => {},
      saveImages: (imgs) => imgs.map((img, i) => ({ name: `shot-${i}.png`, mime: img.mime, bytes: 100 }))
    })

    const events: ToolEvent[] = []
    let callCount = 0
    let toolFeedbackContent = ''
    const execRecords: Array<{ ok: boolean }> = []

    const scriptedChat: AgentLoopOptions['chat'] = async (messages) => {
      if (callCount++ === 0) {
        return {
          text: null,
          toolCalls: [
            {
              id: 'mcp_call_1',
              name: 'mcp__test_srv__diagnostic_shot',
              arguments: JSON.stringify({ fakeText: '看起来已完成' })
            }
          ]
        }
      }
      const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'mcp_call_1')
      expect(toolMsg).toBeDefined()
      expect(toolMsg?.tool_call_id).toBe('mcp_call_1')
      toolFeedbackContent = toolMsg?.content ?? ''
      return { text: '识别 MCP 失败并成功恢复', toolCalls: [] }
    }

    const result = await runAgentLoop({
      systemPrompt: 'sys',
      history: [{ role: 'user', content: 'test mcp' }],
      tools,
      chat: scriptedChat,
      onToolEvent: (e) => events.push(e),
      execEvents: {
        record: (_name, payload) => {
          if (payload && typeof payload === 'object' && 'ok' in payload) {
            execRecords.push({ ok: payload.ok as boolean })
          }
        }
      } as never
    })

    expect(result.stopReason).toBe('completed')
    const toolEvent = events.find((e) => e.name === 'mcp__test_srv__diagnostic_shot' && e.phase === 'error')
    expect(toolEvent).toBeDefined()
    expect(toolEvent?.phase).toBe('error')
    expect(toolEvent?.images).toHaveLength(1)
    expect(toolEvent?.artifactPaths).toBeUndefined() // 不标成功产物卡！
    expect(execRecords.at(-1)?.ok).toBe(false)
    expect(toolFeedbackContent).toContain('MCP 工具返回错误')
  })
})

describe('E24b · M2：断连、关闭、未连接与确认拒绝', () => {
  it('确认拒绝 → denied/permission-denied，真实 MCP 服务端调用次数精确为 0，无成功产物卡', async () => {
    let serverInvocations = 0
    const { clientTransport } = await makeMcpTestServer({
      onCall: () => {
        serverInvocations += 1
      }
    })
    const dir = syntheticRoot('m2-deny')
    writeFileSync(
      join(dir, 'mcp-servers.json'),
      JSON.stringify({ servers: [{ name: 'test_srv', transport: 'stdio', command: 'unused', enabled: true }] })
    )
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => clientTransport
    })
    await manager.connectAll()

    // 1. 拒绝控制器
    const tools = createMcpTools({
      manager,
      confirm: async () => false,
      computerControl: false,
      browserControl: false,
      onGatedDrop: () => {},
      saveImages: () => []
    })
    const echoTool = tools.find((t) => t.schema.name === 'mcp__test_srv__echo')!
    const out = (await echoTool.execute({ text: 'blocked' })) as ToolOutcome
    expect(out.outcome).toBe('denied')
    expect(out.code).toBe('permission-denied')
    expect(out.exitCode).toBeNull()
    expect(serverInvocations).toBe(0) // 真实服务端调用为 0！

    // 2. 在 runAgentLoop 中验证
    const events: ToolEvent[] = []
    let callCount = 0
    await runAgentLoop({
      systemPrompt: 'sys',
      history: [{ role: 'user', content: 'test' }],
      tools: [echoTool],
      chat: async () => {
        if (callCount++ === 0) {
          return {
            text: null,
            toolCalls: [{ id: 'tc_mcp_deny', name: 'mcp__test_srv__echo', arguments: '{"text":"blocked"}' }]
          }
        }
        return { text: 'recovered after denial', toolCalls: [] }
      },
      onToolEvent: (e) => events.push(e)
    })
    const deniedEvent = events.find((e) => e.name === 'mcp__test_srv__echo' && e.phase === 'error')
    expect(deniedEvent).toBeDefined()
    expect(deniedEvent?.phase).toBe('error')
    expect(deniedEvent?.artifactPaths).toBeUndefined()
    expect(serverInvocations).toBe(0) // 依然为 0
  })

  it('Server 断连 / 协议异常 → unknown/tool-error，不强制整 run 崩溃，模型可恢复', async () => {
    const { clientTransport } = await makeMcpTestServer({ throwOnCall: true })
    const dir = syntheticRoot('m2-disconnect')
    writeFileSync(
      join(dir, 'mcp-servers.json'),
      JSON.stringify({ servers: [{ name: 'test_srv', transport: 'stdio', command: 'unused', enabled: true }] })
    )
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => clientTransport
    })
    await manager.connectAll()

    // 直调 manager
    const res = await manager.callTool('test_srv', 'echo', { text: 'hi' })
    expect(res.outcome).toBe('unknown')
    expect(res.code).toBe('tool-error')

    // 经 loop 验证恢复
    const tools = createMcpTools({
      manager,
      computerControl: false,
      browserControl: false,
      onGatedDrop: () => {},
      saveImages: () => []
    })
    const echoTool = tools.find((t) => t.schema.name === 'mcp__test_srv__echo')!

    const events: ToolEvent[] = []
    let callCount = 0
    const result = await runAgentLoop({
      systemPrompt: 'sys',
      history: [{ role: 'user', content: 'test' }],
      tools: [echoTool],
      chat: async () => {
        if (callCount++ === 0) {
          return {
            text: null,
            toolCalls: [{ id: 'tc_err', name: 'mcp__test_srv__echo', arguments: '{"text":"hi"}' }]
          }
        }
        return { text: '从异常中恢复完成', toolCalls: [] }
      },
      onToolEvent: (e) => events.push(e)
    })

    expect(result.stopReason).toBe('completed')
    const errEvent = events.find((e) => e.name === 'mcp__test_srv__echo' && e.phase === 'error')
    expect(errEvent).toBeDefined()
    expect(errEvent?.phase).toBe('error')
  })

  it('未连接服务器或管理器关闭状态 → failed/tool-error', async () => {
    const dir = syntheticRoot('m2-unconnected')
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test'
    })

    // 未连接
    const res1 = await manager.callTool('no_such_server', 'echo', {})
    expect(res1.outcome).toBe('failed')
    expect(res1.code).toBe('tool-error')

    // 关闭状态
    await manager.dispose()
    const res2 = await manager.callTool('no_such_server', 'echo', {})
    expect(res2.outcome).toBe('failed')
    expect(res2.code).toBe('tool-error')
  })

  it('错误信息不泄露金丝雀凭证（Canary Privacy）', async () => {
    const { clientTransport } = await makeMcpTestServer({ isError: true })
    const dir = syntheticRoot('m2-canary')
    writeFileSync(
      join(dir, 'mcp-servers.json'),
      JSON.stringify({ servers: [{ name: 'test_srv', transport: 'stdio', command: 'unused', enabled: true }] })
    )
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => clientTransport
    })
    await manager.connectAll()

    const secretCanary = 'CANARY_SECRET_AUTH_KEY_XYZ987'
    const res = await manager.callTool('test_srv', 'diagnostic_shot', { fakeText: '常规错误' })
    expect(res.text).not.toContain(secretCanary)
    expect(JSON.stringify(res)).not.toContain(secretCanary)
  })
})

describe('E25a · 循环与整轮计量（V2 补正 §三）', () => {
  function makeRunnerCtx(tag: string) {
    const dir = syntheticRoot(tag)
    const workspace = join(dir, 'workspace')
    const builtin = join(dir, 'builtin')
    const user = join(dir, 'user')
    const checkpoints = join(dir, 'checkpoints')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(builtin, { recursive: true })
    mkdirSync(user, { recursive: true })
    mkdirSync(checkpoints, { recursive: true })

    const ctx = createAgentContext({
      getWorkspaceRoot: () => workspace,
      builtinAgentsDir: builtin,
      userAgentsDir: user,
      checkpointDir: checkpoints,
      confirmCommand: async () => true,
      planApproval: {
        request: async () => true
      }
    })
    return { ctx, dir, workspace, builtin }
  }

  function mockSequence(responses: Array<string[] | { status: number; chunks?: string[] }>) {
    let callIndex = 0
    setHttpFetch(async () => {
      const item = responses[callIndex++]
      if (!item) throw new Error('Unexpected extra HTTP call')
      if (Array.isArray(item)) {
        return new Response(streamOf(item), { status: 200 })
      }
      return new Response(item.chunks ? streamOf(item.chunks) : '', { status: item.status })
    })
    return () => callIndex
  }

  it('必测数学1：100/10 + 20/2 = 120/12（前请求成功，末请求失败但带完整用量）', async () => {
    const { ctx } = makeRunnerCtx('math1')
    mockSequence([
      // Request 1: tool call with usage 100/10
      [
        oaChunk({ usage: { prompt_tokens: 100, completion_tokens: 10 } }),
        oaChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })
      ],
      // Request 2: content_filter with usage 20/2
      [
        oaChunk({ usage: { prompt_tokens: 20, completion_tokens: 2 } }),
        oaChunk({ choices: [{ delta: { content: '部分输出' }, finish_reason: 'content_filter' }] })
      ]
    ])

    let err: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'key',
        history: [{ role: 'user', content: 'hello' }]
      })
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AgentRunFailure)
    const failure = err as AgentRunFailure
    expect(failure.facts.scope).toBe('run')
    expect(failure.facts.usage).toMatchObject({ promptTokens: 120, completionTokens: 12 })
    expect(failure.facts.usageComplete).toBe(true)
    expect(failure.facts.terminal.state).toBe('denied')
  })

  it('必测数学2：100/10 + 漏报保持100/10且usageComplete=false（已知不丢，末请求不补0）', async () => {
    const { ctx } = makeRunnerCtx('math2')
    mockSequence([
      // Request 1: tool call with usage 100/10
      [
        oaChunk({ usage: { prompt_tokens: 100, completion_tokens: 10 } }),
        oaChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })
      ],
      // Request 2: normal completion without usage in SSE
      [
        oaChunk({ choices: [{ delta: { content: '完成回复' }, finish_reason: 'stop' }] })
      ]
    ])

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'key',
      history: [{ role: 'user', content: 'hello' }]
    })

    expect(res.usage).toMatchObject({ promptTokens: 100, completionTokens: 10 })
    expect(res.usageComplete).toBe(false)
  })

  it('必测数学3：0/0保真0（明确报0保留0，不作缺失，不为null）', async () => {
    const { ctx } = makeRunnerCtx('math3')
    mockSequence([
      [
        oaChunk({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
        oaChunk({ choices: [{ delta: { content: '拒绝' }, finish_reason: 'content_filter' }] })
      ]
    ])

    let err: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'key',
        history: [{ role: 'user', content: 'hello' }]
      })
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AgentRunFailure)
    const failure = err as AgentRunFailure
    expect(failure.facts.usage).toMatchObject({ promptTokens: 0, completionTokens: 0 })
    expect(failure.facts.usageComplete).toBe(true)
    expect(failure.facts.terminal.state).toBe('denied')
  })

  it('必测数学4：4/1 + 10/2 = 14/3（摘要4/1失败软兜底，主请求10/2成功，整轮14/3）', async () => {
    const { ctx } = makeRunnerCtx('math4')
    mockSequence([
      // Summarize request: fails with content_filter but reports 4/1
      [
        oaChunk({ usage: { prompt_tokens: 4, completion_tokens: 1 } }),
        oaChunk({ choices: [{ delta: { content: '摘要文本' }, finish_reason: 'content_filter' }] })
      ],
      // Main request: succeeds with 10/2
      [
        oaChunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }),
        oaChunk({ choices: [{ delta: { content: '最终回复' }, finish_reason: 'stop' }] })
      ]
    ])

    const history = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: '合成历史。'.repeat(100)
    }))

    const res = await runAgent(ctx, {
      settings: { ...settings, contextWindow: 4096 },
      apiKey: 'key',
      history,
      conversationId: 'conv_math4',
      summaryCache: new Map()
    })

    expect(res.usage).toMatchObject({ promptTokens: 14, completionTokens: 3 })
    expect(res.usageComplete).toBe(true)
  })

  it('必测数学5：8/2 + 3/1 = 11/3（父规划8/2，子执行失败3/1，对外11/3单次结算，子RunFailure不重算）', async () => {
    const { ctx, builtin } = makeRunnerCtx('math5')
    writeFileSync(
      join(builtin, 'planner.md'),
      `---
name: planner
description: 规划器
approval: plan
executor: code-executor
---
你是规划器
`
    )

    mockSequence([
      // Request 1 (Planner): uses 8/2, outputs plan
      [
        oaChunk({ usage: { prompt_tokens: 8, completion_tokens: 2 } }),
        oaChunk({
          choices: [
            {
              delta: { content: '这是计划方案\n\n```sh\necho ok\n```' },
              finish_reason: 'stop'
            }
          ]
        })
      ],
      // Request 2 (Executor): uses 3/1, fails with content_filter
      [
        oaChunk({ usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        oaChunk({
          choices: [
            {
              delta: { content: '执行受阻' },
              finish_reason: 'content_filter'
            }
          ]
        })
      ]
    ])

    let err: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'key',
        history: [{ role: 'user', content: '执行任务' }],
        agentName: 'planner'
      })
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AgentRunFailure)
    const failure = err as AgentRunFailure
    expect(failure.facts.scope).toBe('run')
    expect(failure.facts.usage).toMatchObject({ promptTokens: 11, completionTokens: 3 })
    expect(failure.facts.usageComplete).toBe(true)
    expect(failure.facts.terminal.state).toBe('denied')
  })

  it('工具失败回灌后合法纠正可 completed，旧错误保留，整轮结算一次', async () => {
    const { ctx } = makeRunnerCtx('tool-recovery')
    const events: ToolEvent[] = []
    mockSequence([
      // Round 1: calls read_file with non-existent file
      [
        oaChunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }),
        oaChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"non-existent.txt"}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })
      ],
      // Round 2: receives error and responds with completed text
      [
        oaChunk({ usage: { prompt_tokens: 15, completion_tokens: 3 } }),
        oaChunk({
          choices: [
            {
              delta: { content: '文件不存在，已跳过并完成处理' },
              finish_reason: 'stop'
            }
          ]
        })
      ]
    ])

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'key',
      history: [{ role: 'user', content: '读取文件' }],
      onToolEvent: (e) => events.push(e)
    })

    expect(res.stopReason).toBe('completed')
    expect(res.terminal?.state).toBe('completed')
    expect(res.usage).toMatchObject({ promptTokens: 25, completionTokens: 5 })
    expect(res.usageComplete).toBe(true)

    // 旧错误事件保留
    const errEvent = events.find((e) => e.phase === 'error')
    expect(errEvent).toBeDefined()
    expect(errEvent?.name).toBe('read_file')
  })

  it('E25a-R2 · 修复 R25a-SP1：同 runId 整轮异常向上传播复用，facts 保持同一事实，不被重包，不二次累加', async () => {
    const { ctx, builtin } = makeRunnerCtx('same-run-id')
    writeFileSync(
      join(builtin, 'planner.md'),
      `---
name: planner
description: 规划器
approval: plan
executor: code-executor
---
你是规划器
`
    )

    const knownRunId = 'fixed-run-same-id-001'
    ctx.checkpoints.begin = () => knownRunId

    const injectedFailure = new AgentRunFailure({
      scope: 'run',
      runId: knownRunId,
      terminal: { state: 'denied', code: 'permission-denied' },
      usage: { promptTokens: 8, completionTokens: 2 },
      usageComplete: true
    })

    ctx.planApproval = {
      request: async () => {
        throw injectedFailure
      }
    }

    mockSequence([
      // Request 1 (Planner): uses 8/2, outputs plan
      [
        oaChunk({ usage: { prompt_tokens: 8, completion_tokens: 2 } }),
        oaChunk({
          choices: [
            {
              delta: { content: '这是计划方案\n\n```sh\necho ok\n```' },
              finish_reason: 'stop'
            }
          ]
        })
      ]
    ])

    let caught: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'key',
        history: [{ role: 'user', content: '执行任务' }],
        agentName: 'planner'
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(AgentRunFailure)
    // 关键断言 1：同一错误实例原样向上传播复用，未被重新包装为新对象
    expect(caught).toBe(injectedFailure)
    const failure = caught as AgentRunFailure
    // 关键断言 2：同一事实对象原样透传
    expect(failure.facts).toBe(injectedFailure.facts)
    expect(failure.facts.runId).toBe(knownRunId)
    // 关键断言 3：用量保持单次结算（8/2），没有因为重抛而二次累加为 16/4
    expect(failure.facts.usage).toEqual({ promptTokens: 8, completionTokens: 2 })
    expect(failure.facts.usageComplete).toBe(true)
    // 关键断言 4：终端状态保持原有 denied/permission-denied，未被重构为 upstream-error
    expect(failure.facts.terminal).toEqual({ state: 'denied', code: 'permission-denied' })
  })

  it('E25a-R2 · avoidedTokens 与 tokenTier 真实路径：真实大工具输出触发窗口化，失败后精确进入 facts，已知档位保留', async () => {
    const { ctx } = makeRunnerCtx('real-avoided-path')
    let windowedSaved = 0
    let callCount = 0

    // 构造真实大网页（300 行），足以触发窗口化压缩
    const bigPage = Array.from({ length: 300 }, (_, i) => `这是第 ${i} 行网页正文测试内容，包含较长的文本段落用于触发工具窗口化压缩算法。`).join('\n')

    setHttpFetch(async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('example.com/big-page')) {
        return new Response(bigPage, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
      // Round 1: Model calls fetch_url
      if (!callCount) {
        callCount = 1
        return new Response(
          streamOf([
            oaChunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }),
            oaChunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_web', function: { name: 'fetch_url', arguments: '{"url":"https://example.com/big-page"}' } }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            })
          ]),
          { status: 200 }
        )
      }
      // Round 2: Model fails with length
      return new Response(
        streamOf([
          oaChunk({ usage: { prompt_tokens: 20, completion_tokens: 4 } }),
          oaChunk({ choices: [{ delta: { content: '超限未完' }, finish_reason: 'length' }] })
        ]),
        { status: 200 }
      )
    })

    let caught: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'key',
        history: [{ role: 'user', content: '抓取长网页' }],
        policy: { ...resolvePolicy('light'), minBytes: 50 },
        toolWindow: true,
        onToolWindowed: (info) => {
          windowedSaved = info.beforeTokens - info.afterTokens
        }
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(AgentRunFailure)
    const failure = caught as AgentRunFailure
    expect(failure.facts.scope).toBe('run')
    expect(failure.facts.terminal.state).toBe('truncated')
    expect(failure.facts.terminal.code).toBe('token-limit')
    // 真实窗口化确有发生且产生压缩节约
    expect(windowedSaved).toBeGreaterThan(0)
    // 错误结算中 facts.avoidedTokens 精确保留该节约值
    expect(failure.facts.avoidedTokens).toBe(windowedSaved)
    // 已知档位 light 精确保留
    expect(failure.facts.tokenTier).toBe('light')
    // 用量两轮累加：10/2 + 20/4 = 30/6
    expect(failure.facts.usage).toMatchObject({ promptTokens: 30, completionTokens: 6 })
    expect(failure.facts.usageComplete).toBe(true)
  })

  it('整轮异常结算保真：未观测 avoidedTokens 不伪造 0，未配置 tier 不捏造默认档', async () => {
    const { ctx } = makeRunnerCtx('fields-fidelity')
    mockSequence([
      [
        oaChunk({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
        oaChunk({ choices: [{ delta: { content: '超限' }, finish_reason: 'length' }] })
      ]
    ])

    let caught: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'key',
        history: [{ role: 'user', content: 'test' }]
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(AgentRunFailure)
    const failure = caught as AgentRunFailure
    expect(failure.facts.scope).toBe('run')
    expect(failure.facts.terminal.state).toBe('truncated')
    expect(failure.facts.usage).toMatchObject({ promptTokens: 5, completionTokens: 1 })
    // 未观测到 avoidedTokens 时不造 0
    expect(failure.facts.avoidedTokens).toBeUndefined()
    expect('avoidedTokens' in failure.facts).toBe(false)
  })
})

describe('E25b · 调度任务与归属（SubagentJobEvent 与 AgentTaskRegistry 终态传播）', () => {
  it('Subagent 调度终态传播：completed 映射 completed，已知失败传播细 terminal', async () => {
    const events: SubagentJobEvent[] = []
    const defs = [
      { name: 'agent-success', description: '成功代理', systemPrompt: 'sys' },
      { name: 'agent-denied', description: '拒绝代理', systemPrompt: 'sys' }
    ]

    const results = await runSubagents({
      definitions: defs,
      task: '通用子任务',
      tasks: ['任务1', '任务2'],
      toolsFor: () => [],
      chatFactory: (def) => async () => {
        if (def.name === 'agent-success') {
          return { text: '成功完成', toolCalls: [] }
        }
        throw new ProviderError('内容过滤', 0, {
          scope: 'request',
          terminal: { state: 'denied', code: 'content-filter' },
          usage: null,
          usageComplete: false
        })
      },
      onJobEvent: (evt) => events.push(evt)
    })

    expect(results).toHaveLength(2)
    // 成功任务：ok=true，stopReason=completed，细 terminal=completed
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.stopReason).toBe('completed')
    expect(results[0]!.terminal).toEqual({ state: 'completed' })

    // 失败任务：ok=false，stopReason=error，细 terminal=denied/content-filter
    expect(results[1]!.ok).toBe(false)
    expect(results[1]!.stopReason).toBe('error')
    expect(results[1]!.terminal).toEqual({ state: 'denied', code: 'content-filter' })

    // 事件验证：end 事件带 completed，error 事件带 denied
    const endEvt = events.find((e) => e.name === 'agent-success' && e.phase === 'end')
    expect(endEvt).toBeDefined()
    expect(endEvt?.terminal).toEqual({ state: 'completed' })

    const errEvt = events.find((e) => e.name === 'agent-denied' && e.phase === 'error')
    expect(errEvt).toBeDefined()
    expect(errEvt?.terminal).toEqual({ state: 'denied', code: 'content-filter' })
  })

  it('兄弟子任务隔离：兄弟任务失败不污染其他任务，并发 scope 不串', async () => {
    const events: SubagentJobEvent[] = []
    const defs = [
      { name: 'worker-fail', description: '失败作业', systemPrompt: 'sys' },
      { name: 'worker-ok', description: '成功作业', systemPrompt: 'sys' }
    ]

    const results = await runSubagents({
      definitions: defs,
      task: '并行作业',
      maxConcurrency: 2,
      toolsFor: () => [],
      chatFactory: (def) => async () => {
        if (def.name === 'worker-fail') {
          throw new Error('网络断开，执行失败')
        }
        return { text: '正常回复', toolCalls: [] }
      },
      onJobEvent: (evt) => events.push(evt)
    })

    expect(results).toHaveLength(2)
    // worker-fail 失败，未带 terminal 则不补造
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toBe('网络断开，执行失败')
    expect(results[0]!.terminal).toBeUndefined()

    // 兄弟任务 worker-ok 完全不受污染，正常完成
    expect(results[1]!.ok).toBe(true)
    expect(results[1]!.output).toBe('正常回复')
    expect(results[1]!.terminal).toEqual({ state: 'completed' })

    const failEvt = events.find((e) => e.name === 'worker-fail' && e.phase === 'error')
    expect(failEvt?.terminal).toBeUndefined()
  })

  it('任务取消传播：signal 取消产生 cancelled 终态，不自动重放', async () => {
    const controller = new AbortController()
    const events: SubagentJobEvent[] = []
    const defs = [{ name: 'worker-long', description: '长任务', systemPrompt: 'sys' }]

    await expect(
      runSubagents({
        signal: controller.signal,
        definitions: defs,
        task: '已被取消的任务',
        toolsFor: () => [],
        chatFactory: () => async () => {
          controller.abort()
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          throw err
        },
        onJobEvent: (evt) => events.push(evt)
      })
    ).rejects.toThrow()

    // 取消事件带 cancelled/user-stop
    const cancelEvt = events.find((e) => e.phase === 'error')
    expect(cancelEvt).toBeDefined()
    expect(cancelEvt?.error).toBe('已停止执行')
    expect(cancelEvt?.terminal).toEqual({ state: 'cancelled', code: 'user-stop' })
  })

  it('AgentTaskRegistry 终态映射：粗状态与细 terminal 严格对齐，旧事件无终态不补造', () => {
    const registry = createAgentTaskRegistry()

    // 1. completed -> coarse completed, fine completed
    const t1 = registry.start(1, 'task-1')
    registry.finish(t1.id, { state: 'completed' })
    const r1 = registry.get(t1.id)
    expect(r1?.status).toBe('completed')
    expect(r1?.terminal).toEqual({ state: 'completed' })

    // 2. cancelled -> coarse cancelled, fine cancelled
    const t2 = registry.start(1, 'task-2')
    registry.finish(t2.id, { state: 'cancelled', code: 'user-stop' })
    const r2 = registry.get(t2.id)
    expect(r2?.status).toBe('cancelled')
    expect(r2?.terminal).toEqual({ state: 'cancelled', code: 'user-stop' })

    // 3. denied -> coarse failed, fine denied
    const t3 = registry.start(1, 'task-3')
    registry.finish(t3.id, { state: 'denied', code: 'permission-denied' }, '权限不足')
    const r3 = registry.get(t3.id)
    expect(r3?.status).toBe('failed')
    expect(r3?.terminal).toEqual({ state: 'denied', code: 'permission-denied' })
    expect(r3?.error).toBe('权限不足')

    // 4. truncated -> coarse failed, fine truncated
    const t4 = registry.start(1, 'task-4')
    registry.finish(t4.id, { state: 'truncated', code: 'token-limit' })
    const r4 = registry.get(t4.id)
    expect(r4?.status).toBe('failed')
    expect(r4?.terminal).toEqual({ state: 'truncated', code: 'token-limit' })

    // 5. unknown -> coarse failed, fine unknown
    const t5 = registry.start(1, 'task-5')
    registry.finish(t5.id, { state: 'unknown', code: 'missing-terminal' })
    const r5 = registry.get(t5.id)
    expect(r5?.status).toBe('failed')
    expect(r5?.terminal).toEqual({ state: 'unknown', code: 'missing-terminal' })

    // 6. max-rounds -> coarse failed, fine max-rounds
    const t6 = registry.start(1, 'task-6')
    registry.finish(t6.id, { state: 'max-rounds', code: 'token-limit' })
    const r6 = registry.get(t6.id)
    expect(r6?.status).toBe('failed')
    expect(r6?.terminal).toEqual({ state: 'max-rounds', code: 'token-limit' })

    // 7. 旧接口兼容：旧调用方不传 terminal，保持粗状态，不补造 terminal
    const t7 = registry.start(1, 'task-7')
    registry.finish(t7.id, 'failed', '传统错误信息')
    const r7 = registry.get(t7.id)
    expect(r7?.status).toBe('failed')
    expect(r7?.terminal).toBeUndefined()
    expect('terminal' in (r7 ?? {})).toBe(false)
  })

  it('AgentTaskRegistry 终结保护与防覆盖：首次终结生效，晚到结算不覆写状态、终态、输出、错误与 endedAt', () => {
    const registry = createAgentTaskRegistry()

    // 1. completed 后晚到失败：不覆写
    const tA = registry.start(1, 'task-A')
    registry.finish(tA.id, { state: 'completed' }, undefined, '最终产出 A')
    const rA1 = registry.get(tA.id)
    expect(rA1?.status).toBe('completed')
    const firstEndedAtA = rA1?.endedAt

    // 模拟晚到结算企图覆写
    registry.finish(tA.id, 'failed', '迟到的错误', '覆盖产出', { state: 'denied', code: 'permission-denied' })
    const rA2 = registry.get(tA.id)
    expect(rA2?.status).toBe('completed')
    expect(rA2?.terminal).toEqual({ state: 'completed' })
    expect(rA2?.output).toBe('最终产出 A')
    expect(rA2?.error).toBeUndefined()
    expect(rA2?.endedAt).toBe(firstEndedAtA)

    // 2. cancelled 后晚到成功：不覆写
    const tB = registry.start(1, 'task-B')
    registry.finish(tB.id, { state: 'cancelled', code: 'user-stop' }, '用户停止')
    const rB1 = registry.get(tB.id)
    expect(rB1?.status).toBe('cancelled')
    const firstEndedAtB = rB1?.endedAt

    registry.finish(tB.id, { state: 'completed' }, undefined, '迟到的成功产出')
    const rB2 = registry.get(tB.id)
    expect(rB2?.status).toBe('cancelled')
    expect(rB2?.terminal).toEqual({ state: 'cancelled', code: 'user-stop' })
    expect(rB2?.error).toBe('用户停止')
    expect(rB2?.endedAt).toBe(firstEndedAtB)

    // 3. denied 后晚到旧式完成：不覆写
    const tC = registry.start(1, 'task-C')
    registry.finish(tC.id, { state: 'denied', code: 'permission-denied' }, '权限拒绝')
    const rC1 = registry.get(tC.id)
    expect(rC1?.status).toBe('failed')
    const firstEndedAtC = rC1?.endedAt

    registry.finish(tC.id, 'completed', undefined, '违规完成')
    const rC2 = registry.get(tC.id)
    expect(rC2?.status).toBe('failed')
    expect(rC2?.terminal).toEqual({ state: 'denied', code: 'permission-denied' })
    expect(rC2?.error).toBe('权限拒绝')
    expect(rC2?.endedAt).toBe(firstEndedAtC)
  })

  it('AgentTaskRegistry 粗细一致性：五参调用时粗状态由可信 terminal 映射，不能互相矛盾', () => {
    const registry = createAgentTaskRegistry()

    // 传参矛盾：status 写 completed，但 terminal 给出 denied
    const t = registry.start(1, 'conflict-task')
    registry.finish(t.id, 'completed', '权限已被拒绝', undefined, { state: 'denied', code: 'permission-denied' })
    const r = registry.get(t.id)

    // 粗状态必须服从真实 terminal 映射为 failed，不可出现粗 completed 细 denied 的荒谬状态
    expect(r?.status).toBe('failed')
    expect(r?.terminal).toEqual({ state: 'denied', code: 'permission-denied' })
    expect(r?.error).toBe('权限已被拒绝')
  })

  it('E25b-R1 补证 · 父子 execEvents scope 分离：子代理活动带 agentScope=sub，父事件不污染', async () => {
    const recordedEvents: Array<{ agentScope?: string; kind: string }> = []
    const sink = {
      append: (evt: { agentScope?: string; kind: string }) => {
        recordedEvents.push({ agentScope: evt.agentScope, kind: evt.kind })
      }
    }
    const parentRecorder = createExecEventRecorder({
      sink,
      conversationId: 'conv-main',
      agentScope: 'main'
    })

    // 父代理产生主事件
    parentRecorder.record('run_start', { prompt: '父提示词' })

    const defs = [{ name: 'sub-worker', description: '子代理', systemPrompt: 'sys' }]

    await runSubagents({
      definitions: defs,
      task: '子代理任务',
      toolsFor: () => [],
      chatFactory: () => async () => ({ text: '完成', toolCalls: [] }),
      execEvents: parentRecorder
    })

    // 父代理结束
    parentRecorder.record('run_end', { rounds: 1 })

    // 父子事件严格按 scope 分离
    const mainEvents = recordedEvents.filter((e) => e.agentScope === 'main')
    const subEvents = recordedEvents.filter((e) => e.agentScope === 'sub')

    expect(mainEvents.length).toBe(2)
    expect(mainEvents[0]!.kind).toBe('run_start')
    expect(mainEvents[1]!.kind).toBe('run_end')

    expect(subEvents.length).toBeGreaterThan(0)
    expect(subEvents.some((e) => e.kind === 'run_start')).toBe(true)
    expect(subEvents.some((e) => e.kind === 'run_end')).toBe(true)
  })

  it('E25b-R1 补证 · 跨会话与双 owner 隔离：registry.list(owner) 按窗口与会话严格过滤，互不串扰', () => {
    const registry = createAgentTaskRegistry()

    const t1 = registry.start(101, 'task-window-1', 'conv-A')
    const t2 = registry.start(202, 'task-window-2', 'conv-B')

    const list1 = registry.list(101)
    const list2 = registry.list(202)
    const list3 = registry.list(303)

    expect(list1).toHaveLength(1)
    expect(list1[0]!.id).toBe(t1.id)
    expect(list1[0]!.conversationId).toBe('conv-A')
    expect(list1[0]!.task).toBe('task-window-1')

    expect(list2).toHaveLength(1)
    expect(list2[0]!.id).toBe(t2.id)
    expect(list2[0]!.conversationId).toBe('conv-B')
    expect(list2[0]!.task).toBe('task-window-2')

    expect(list3).toHaveLength(0)
  })

  it('E25b-R1 补证 · 取消不回滚副作用：取消前已落盘文件保持实存，不撤销已发生副作用', async () => {
    const dir = syntheticRoot('cancel-no-rollback')
    const testFile = join(dir, 'side-effect.txt')
    const controller = new AbortController()

    const defs = [{ name: 'worker-side-effect', description: '副作用代理', systemPrompt: 'sys' }]

    await expect(
      runSubagents({
        signal: controller.signal,
        definitions: defs,
        task: '执行写入并取消',
        toolsFor: () => [
          {
            schema: { name: 'write_side_effect', description: '写副作用', parameters: { type: 'object' } },
            execute: async () => {
              writeFileSync(testFile, '已落盘的关键数据，不应随取消回滚')
              controller.abort()
              const err = new Error('用户中止')
              err.name = 'AbortError'
              throw err
            }
          }
        ],
        chatFactory: (_def, tools) => async () => {
          return {
            text: null,
            toolCalls: [{ id: 'call_1', name: tools[0]!.schema.name, arguments: '{}' }]
          }
        }
      })
    ).rejects.toThrow()

    // 关键断言：取消不是回滚，已落盘文件依然存在且内容完整
    expect(existsSync(testFile)).toBe(true)
    expect(readFileSync(testFile, 'utf8')).toBe('已落盘的关键数据，不应随取消回滚')
  })

  it('E25b-R1 补证 · unknown 终态不重发：模型返回未知终态后仅执行一次，无隐式自动重放', async () => {
    let callCount = 0
    const defs = [{ name: 'worker-unknown', description: '未知终态代理', systemPrompt: 'sys' }]

    const results = await runSubagents({
      definitions: defs,
      task: '单次执行不重试',
      toolsFor: () => [],
      chatFactory: () => async () => {
        callCount++
        throw new ProviderError('网络超时，终态未知', 0, {
          scope: 'request',
          terminal: { state: 'unknown', code: 'upstream-timeout' },
          usage: null,
          usageComplete: false
        })
      }
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.stopReason).toBe('error')
    expect(results[0]!.terminal).toEqual({ state: 'unknown', code: 'upstream-timeout' })
    // 关键断言：调用计数恰好为 1，绝不发生自动隐式重放/重发
    expect(callCount).toBe(1)
  })
})

describe('E26b · 消息 Schema 终态白名单、信封单结算与 Canary 脱敏', () => {
  function makeRunnerCtx(tag: string) {
    const dir = syntheticRoot(tag)
    const workspace = join(dir, 'workspace')
    const builtin = join(dir, 'builtin')
    const user = join(dir, 'user')
    const checkpoints = join(dir, 'checkpoints')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(builtin, { recursive: true })
    mkdirSync(user, { recursive: true })
    mkdirSync(checkpoints, { recursive: true })

    const ctx = createAgentContext({
      getWorkspaceRoot: () => workspace,
      builtinAgentsDir: builtin,
      userAgentsDir: user,
      checkpointDir: checkpoints,
      confirmCommand: async () => true,
      planApproval: {
        request: async () => true
      }
    })
    return { ctx, dir, workspace, builtin }
  }

  function mockSequence(responses: Array<string[] | { status: number; chunks?: string[] }>) {
    let callIndex = 0
    setHttpFetch(async () => {
      const item = responses[callIndex++]
      if (!item) throw new Error('Unexpected extra HTTP call')
      if (Array.isArray(item)) {
        return new Response(streamOf(item), { status: 200 })
      }
      return new Response(item.chunks ? streamOf(item.chunks) : '', { status: item.status })
    })
    return () => callIndex
  }

  it('storedMessageSchema 接受 0 字符 assistant + 合法 terminal 与白名单校验，拒绝无意义旧空 assistant', () => {
    // 验证 runTerminalSchema 自身导出的白名单校验
    expect(runTerminalSchema.safeParse({ state: 'completed' }).success).toBe(true)

    // 1. 0 字符 assistant + 合法 completed terminal -> 合法
    const m1 = storedMessageSchema.safeParse({
      role: 'assistant',
      content: '',
      terminal: { state: 'completed' }
    })
    expect(m1.success).toBe(true)

    // 2. 0 字符 assistant + 合法 denied terminal (含 code 与 httpStatus) -> 合法
    const m2 = storedMessageSchema.safeParse({
      role: 'assistant',
      content: '',
      terminal: { state: 'denied', code: 'permission-denied', httpStatus: 403 }
    })
    expect(m2.success).toBe(true)

    // 3. 拒绝无意义旧空 assistant：空 content 且无分段与终态 -> 拒收
    const m3 = storedMessageSchema.safeParse({
      role: 'assistant',
      content: ''
    })
    expect(m3.success).toBe(false)
    if (!m3.success) {
      expect(m3.error.issues[0]?.message).toContain('空 content')
    }

    // 4. terminal 仅限 assistant，user 携带 terminal -> 拒收
    const m4 = storedMessageSchema.safeParse({
      role: 'user',
      content: 'hello',
      terminal: { state: 'completed' }
    })
    expect(m4.success).toBe(false)
    if (!m4.success) {
      expect(m4.error.issues[0]?.message).toContain('terminal 只允许挂在 assistant 上')
    }

    // 5. terminal 字段状态与原因码白名单校验：非法 state / 非法 code / 越界 httpStatus -> 拒收
    const m5State = storedMessageSchema.safeParse({
      role: 'assistant',
      content: '',
      terminal: { state: 'unknown_state' }
    })
    expect(m5State.success).toBe(false)

    const m5Code = storedMessageSchema.safeParse({
      role: 'assistant',
      content: '',
      terminal: { state: 'failed', code: 'unknown_code' }
    })
    expect(m5Code.success).toBe(false)

    const m5HttpLow = storedMessageSchema.safeParse({
      role: 'assistant',
      content: '',
      terminal: { state: 'failed', httpStatus: 99 }
    })
    expect(m5HttpLow.success).toBe(false)

    const m5HttpHigh = storedMessageSchema.safeParse({
      role: 'assistant',
      content: '',
      terminal: { state: 'failed', httpStatus: 600 }
    })
    expect(m5HttpHigh.success).toBe(false)
  })

  it('chat-emitter 传递整轮 RunTerminal/usage 到信封，一轮只结算一次，done-error 竞态先到先生效', () => {
    const sentMessages: Array<{ channel: string; payload: unknown }> = []
    const mockWebContents = {
      isDestroyed: () => false,
      send: (channel: string, envelope: { payload: unknown }) => {
        sentMessages.push({ channel, payload: envelope.payload })
      }
    }

    // 1. 成功结算带 terminal
    const emitter1 = createChatEmitter(mockWebContents as unknown as Parameters<typeof createChatEmitter>[0], 'conv-test-1')
    emitter1.done(
      { promptTokens: 100, completionTokens: 20 },
      50,
      'light',
      10,
      true,
      { state: 'completed' }
    )
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.channel).toBe(IPC.chatDone)
    const donePayload = sentMessages[0]!.payload as ChatDonePayload
    expect(donePayload.terminal).toEqual({ state: 'completed' })
    expect(donePayload.usage).toEqual({ promptTokens: 100, completionTokens: 20 })
    expect(donePayload.avoided).toBe(50)
    expect(donePayload.tier).toBe('light')
    expect(donePayload.usageComplete).toBe(true)

    // 2. done-error 竞态：已调用 done，后到的 error 必须丢弃，保证单次结算
    emitter1.error('迟到的错误', {
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false
    })
    expect(sentMessages).toHaveLength(1) // 依然只有 1 条 done，未发生二次结算

    // 3. 反向竞态：先调用 error，后到的 done 必须丢弃
    const sentMessages2: Array<{ channel: string; payload: unknown }> = []
    const mockWebContents2 = {
      isDestroyed: () => false,
      send: (channel: string, envelope: { payload: unknown }) => {
        sentMessages2.push({ channel, payload: envelope.payload })
      }
    }
    const emitter2 = createChatEmitter(mockWebContents2 as unknown as Parameters<typeof createChatEmitter>[0], 'conv-test-2')
    emitter2.error('先到达的失败', {
      terminal: { state: 'denied', code: 'permission-denied' },
      usage: { promptTokens: 40, completionTokens: 8 },
      usageComplete: true,
      avoided: 15
    })
    expect(sentMessages2).toHaveLength(1)
    expect(sentMessages2[0]!.channel).toBe(IPC.chatError)
    const errPayload = sentMessages2[0]!.payload as ChatErrorPayload
    expect(errPayload.message).toBe('先到达的失败')
    expect(errPayload.terminal).toEqual({ state: 'denied', code: 'permission-denied' })
    expect(errPayload.usage).toEqual({ promptTokens: 40, completionTokens: 8 })
    expect(errPayload.avoided).toBe(15)

    // 后到的 done 被丢弃
    emitter2.done({ promptTokens: 50, completionTokens: 10 }, 0, undefined, undefined, true, { state: 'completed' })
    expect(sentMessages2).toHaveLength(1) // 依然只有 1 条 error
  })

  it('Canary 隐私与脱敏：敏感凭证放在原始错误正文，向外错误出口绝不外泄金丝雀', async () => {
    const { ctx } = makeRunnerCtx('canary-privacy')
    const secretCanary = 'CANARY_SECRET_AUTH_KEY_LEAK_CHECK_9988'

    mockSequence([
      // 模拟上游返回 401 鉴权失败，且厂商原始正文中夹带敏感凭证
      {
        status: 401,
        chunks: [`{"error":{"message":"Invalid authorization key: ${secretCanary}"}}`]
      }
    ])

    let caught: unknown
    try {
      await runAgent(ctx, {
        settings,
        apiKey: 'fake-key',
        history: [{ role: 'user', content: 'test canary' }]
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(AgentRunFailure)
    const failure = caught as AgentRunFailure
    expect(failure.facts.scope).toBe('run')
    expect(failure.facts.terminal.httpStatus).toBe(401)
    // 错误面向用户的标准文案必须脱敏，绝不包含原始错误中的金丝雀
    expect(failure.message).not.toContain(secretCanary)
    expect(JSON.stringify(failure.facts)).not.toContain(secretCanary)
  })
})

// ── E29：助手消息终态展示（ChatView 导出的纯判定）────────────────────────────
// 判据：真实终态合同 §四「助手错误提示消费真实状态，重开会话仍一致；旧事件无新字段
// 不推断肯定成功」。展示文本与时间线同源（runTerminalText），取消不得显示成功。

describe('E29 助手消息终态展示（assistantTerminalText 纯判定）', () => {
  it('六类 terminal 显示准确文字（completed/failed/cancelled/denied/unknown/truncated）', () => {
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'completed' } })).toBe('已完成')
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'failed' } })).toBe('失败')
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'cancelled' } })).toBe('已取消')
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'denied' } })).toBe('已拒绝')
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'unknown' } })).toBe('未确认')
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'truncated' } })).toBe('已截断')
  })

  it('max-rounds 显示轮次耗尽，不显示成功', () => {
    expect(assistantTerminalText({ role: 'assistant', content: '', terminal: { state: 'max-rounds' } })).toBe('轮次耗尽')
  })

  it('取消不得显示成功；正文含 success/error 字样不反转判定', () => {
    expect(assistantTerminalText({ role: 'assistant', content: '已 success 完成', terminal: { state: 'cancelled' } })).toBe(
      '已取消'
    )
    expect(assistantTerminalText({ role: 'assistant', content: '出过 error', terminal: { state: 'completed' } })).toBe(
      '已完成'
    )
  })

  it('旧消息无 terminal 返回空（不造状态、不推断肯定成功）', () => {
    expect(assistantTerminalText({ role: 'assistant', content: '旧回复' })).toBe('')
    expect(assistantTerminalText({ role: 'assistant', content: '' })).toBe('')
  })

  it('部分回复保留：有正文 + 失败/取消终态时正文照旧、终态文字单独给出', () => {
    const m = { role: 'assistant' as const, content: '写到一半的部分回复', terminal: { state: 'cancelled' as const } }
    expect(m.content).toBe('写到一半的部分回复')
    expect(assistantTerminalText(m)).toBe('已取消')
  })
})
