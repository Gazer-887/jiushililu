import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAgent, type AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import { setHttpFetch } from '@main/providers/http-client'
import { resolvePolicy } from '@shared/token-tier'
import type { ModelSettings } from '@shared/ipc'

const roots: string[] = []
const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'http://127.0.0.1:1',
  model: 'synthetic',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 1024,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  inputModalities: ['text']
}
const pair = { prompt_tokens: 10, completion_tokens: 2 }
function context(): AgentRuntimeContext {
  const root = mkdtempSync(join(tmpdir(), 'jsl-usage-runner-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return {
    getWorkspaceRoot: () => workspace,
    builtinAgentsDir: join(root, 'builtin'),
    userAgentsDir: join(root, 'user'),
    checkpoints: createCheckpointStore(join(root, 'checkpoints'))
  }
}
function endpoint(reports: Array<typeof pair | null | Error>) {
  let count = 0
  setHttpFetch(async () => {
    const report = reports[count++]
    if (report instanceof Error) throw report
    const events = [
      { choices: [{ index: 0, delta: { content: '合成回复。' }, finish_reason: 'stop' }] },
      ...(report ? [{ choices: [], usage: report }] : [])
    ]
    return new Response(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    )
  })
  return () => count
}
afterEach(() => {
  setHttpFetch(null)
  for (const root of roots.splice(0)) {
    expect(resolve(dirname(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('jsl-usage-runner-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('真实runner与协议解析的请求覆盖', () => {
  it('无报告不造0，档位取本轮策略', async () => {
    const count = endpoint([null])
    const result = await runAgent(context(), {
      settings,
      apiKey: 'synthetic',
      conversationId: 'synthetic',
      history: [{ role: 'user', content: '任务' }],
      policy: resolvePolicy('light')
    })
    expect(count()).toBe(1)
    expect(result).toMatchObject({ usage: null, usageComplete: false, tokenTier: 'light' })
  })
  it('成对0是完整报告', async () => {
    endpoint([{ prompt_tokens: 0, completion_tokens: 0 }])
    expect(
      await runAgent(context(), {
        settings,
        apiKey: 'synthetic',
        conversationId: 'synthetic',
        history: [{ role: 'user', content: '任务' }]
      })
    ).toMatchObject({ usage: { promptTokens: 0, completionTokens: 0 }, usageComplete: true })
  })
  for (const reports of [
    [pair, pair],
    [null, pair],
    [pair, null]
  ] as Array<Array<typeof pair | null>>) {
    it(`批准后planner与executor覆盖：${reports.map((r) => (r ? '已报' : '漏报')).join('→')}`, async () => {
      const ctx = context()
      mkdirSync(ctx.userAgentsDir)
      writeFileSync(
        join(ctx.userAgentsDir, 'planner.md'),
        '---\nname: planner\ndescription: 合成计划者\napproval: plan\n---\n提出方案。'
      )
      ctx.planApproval = { request: async () => true, respond: () => false, abortAll: () => {} }
      const count = endpoint(reports)
      const result = await runAgent(ctx, {
        settings,
        apiKey: 'synthetic',
        conversationId: 'synthetic',
        history: [{ role: 'user', content: '任务' }],
        agentName: 'planner'
      })
      expect(count()).toBe(2)
      const reported = reports.filter(Boolean).length
      expect(result.usage).toMatchObject({
        promptTokens: reported * 10,
        completionTokens: reported * 2
      })
      expect(result.usageComplete).toBe(reported === 2)
    })
  }
  for (const summary of [pair, null, new Error('合成摘要连接失败')]) {
    it(`摘要请求${summary instanceof Error ? '失败' : summary ? '有报告' : '漏报'}的覆盖不能丢失`, async () => {
      const count = endpoint([summary, pair])
      const history = Array.from({ length: 120 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: '合成历史。'.repeat(100)
      }))
      const result = await runAgent(context(), {
        settings: { ...settings, contextWindow: 4096 },
        apiKey: 'synthetic',
        history,
        conversationId: 'synthetic',
        summaryCache: new Map()
      })
      expect(count()).toBe(2)
      expect(result.usageComplete).toBe(summary === pair)
      expect(result.usage?.promptTokens).toBe(summary === pair ? 20 : 10)
    })
  }
})
