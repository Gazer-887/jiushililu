// S3-50A 隐私反例：合成外部开发者配置与本地终态诊断放 Canary，核未授权出站 0、日志泄漏 0。
// 只走本地注入的假 fetch；不联网、不读真实配置。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRunFailure, ProviderError, mapHttpError } from '@main/providers/errors'
import { setHttpFetch } from '@main/providers/http-client'
import { OpenAICompatibleProvider } from '@main/providers/openai'
import { createProviderExecutionContext, resolveRequestPolicy } from '@shared/request-policy'
import type { ModelSettings } from '@shared/ipc'

const CANARY = 'CANARY-S3-50A-DO-NOT-LEAK'
const CANARY_ID = 'CANARY-S3-50A-ID-DO-NOT-LEAK'
const captured: Array<{ url: string; headers: unknown; body: string }> = []

afterEach(() => {
  setHttpFetch(null)
  vi.restoreAllMocks()
})

describe('S3-50A Canary：未授权出站 0、日志/错误事实泄漏 0', () => {
  it('合成版本/运行键不进请求 headers/body，错误正文与事实白名单也不回显 Canary', async () => {
    const consoleCalls: string[] = []
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      })
    }
    setHttpFetch(async (url, init) => {
      captured.push({ url: String(url), headers: init.headers, body: String(init.body ?? '') })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const settings = {
      providerType: 'openai-compatible',
      baseURL: 'https://public.invalid/v1',
      model: 'public-model',
      temperature: null,
      topP: null,
      topK: null,
      maxTokens: 64,
      timeoutMs: 1000,
      stream: false,
      contextWindow: 8192,
      reasoningEffort: 'default',
      maxToolRounds: 1,
      inputModalities: ['text']
    } as ModelSettings
    const context = createProviderExecutionContext({
      clientVersion: CANARY,
      purpose: 'connection-check',
      policy: resolveRequestPolicy(),
      randomUUID: (() => {
        let calls = 0
        return () => (calls++ === 0 ? CANARY_ID : CANARY_ID + '-2')
      })()
    })
    const provider = new OpenAICompatibleProvider()
    await provider.streamChat(
      {
        settings,
        apiKey: 'public-fake-key',
        messages: [{ role: 'user', content: '公共文本' }],
        signal: new AbortController().signal,
        context
      },
      { onChunk: () => {} }
    )
    expect(captured).toHaveLength(1)
    const outbound = JSON.stringify(captured)
    expect(outbound, '未授权出站不得出现 Canary 版本').not.toContain(CANARY)
    expect(outbound, '未授权出站不得出现 Canary 运行键').not.toContain(CANARY_ID)

    const mapped = mapHttpError(400, JSON.stringify({ error: { message: CANARY } }))
    expect(mapped).not.toContain(CANARY)
    const providerError = new ProviderError(CANARY, 400)
    expect(providerError.message).not.toContain(CANARY)

    const factsError = new ProviderError('x', 400, {
      scope: 'request',
      terminal: { state: 'failed', code: 'http-error', httpStatus: 400 },
      usage: null,
      usageComplete: false,
      canary: CANARY
    } as never)
    expect(JSON.stringify(factsError)).not.toContain(CANARY)
    const runFailure = new AgentRunFailure({
      scope: 'run',
      runId: 'run-public',
      terminal: { state: 'failed', code: 'upstream-error' },
      usage: null,
      usageComplete: false
    })
    expect(runFailure.message).toContain('失败')
    expect(runFailure.message).not.toContain(CANARY)
    expect(consoleCalls.join('\n')).not.toContain(CANARY)
  })
})
