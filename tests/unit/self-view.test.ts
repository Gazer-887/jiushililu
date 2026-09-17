// 自视段单测（2026-09-15 用户需求）。两层：composeSelfView 纯函数（静态性 / 有什么写什么）+
// 真 runner 接线（段真的进 system、模型名与工具清单与通道一致）。桩层测不出 prompt 组成，
// runner 层断言与 memory-injection.test.ts 同款手法（mock provider 收到的 messages）。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import { composeSelfView } from '@main/agent/self-view'

const openaiSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))

vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: unknown[]) => openaiSpy(...(args as [])),
  chatWithToolsOpenAI: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] })),
  chatWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))

const { runAgent } = await import('@main/agent/runner')

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'test-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  supportsImages: false
}

function makeCtx(): AgentRuntimeContext {
  const base = mkdtempSync(join(tmpdir(), 'jsl-self-view-'))
  return {
    getWorkspaceRoot: () => join(base, 'ws'),
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
}

function systemOf(callIndex = 0): string {
  const messages = openaiSpy.mock.calls[callIndex]?.[2] as
    | Array<{ role: string; content: string }>
    | undefined
  return messages?.find((m) => m.role === 'system')?.content ?? ''
}

const baseInput = {
  model: 'mimo-v2.5',
  providerType: 'openai-compatible',
  platform: 'win32' as NodeJS.Platform,
  toolNames: ['read_file', 'write_file'],
  subagentNames: ['explore'],
  computerControl: false
}

describe('composeSelfView 纯函数', () => {
  it('汇总模型 / 运行端 / 工具 / 子代理 / 电脑控制', () => {
    const block = composeSelfView(baseInput)
    expect(block).toContain('<self_view>')
    expect(block).toContain('mimo-v2.5')
    expect(block).toContain('Windows')
    expect(block).toContain('read_file、write_file')
    expect(block).toContain('explore')
    expect(block).toContain('未开启')
  })

  it('静态性：同输入字节级相同（前缀缓存的前提）', () => {
    expect(composeSelfView(baseInput)).toBe(composeSelfView(baseInput))
  })

  it('「有什么写什么」：子代理为空 → 子代理行整行不出现（不写"规划中"噪音）', () => {
    const block = composeSelfView({ ...baseInput, subagentNames: [] })
    expect(block).not.toContain('子代理')
  })

  it('电脑控制开着 → 如实报"由用户配置的 MCP server 提供"（plan44 接上实体，来源说清）', () => {
    const block = composeSelfView({ ...baseInput, computerControl: true })
    expect(block).toContain('已开启')
    expect(block).toContain('用户配置的 MCP server 提供')
    expect(block).not.toContain('尚无对应工具')
  })
})

describe('runner 接线：自视段进 system', () => {
  beforeEach(() => openaiSpy.mockClear())

  it('system 含 <self_view>，模型名与会话设置一致，工具名与实际下发一致', async () => {
    await runAgent(makeCtx(), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: '你能做什么' }]
    })
    const system = systemOf()
    expect(system).toContain('<self_view>')
    expect(system).toContain('test-model')
    // 工具清单里的名字必须真的出现在下发 schema 里（名单不是许愿，是实况）
    for (const name of ['read_file', 'write_file']) {
      expect(system).toContain(name)
    }
  })

  it('computerControl 缺省 = false → 报「未开启」（权限类不许替用户默认开）', async () => {
    await runAgent(makeCtx(), {
      settings,
      apiKey: 'k',
      conversationId: 'c1',
      history: [{ role: 'user', content: 'x' }]
    })
    expect(systemOf()).toContain('未开启')
  })
})
