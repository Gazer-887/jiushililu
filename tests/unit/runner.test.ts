import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'

// runner 集成测试 —— 补上"工具 schema 是否真的下发给模型"这条链路的覆盖。
// 起因（D-030）：交叉验证发现 runner 曾把空数组当工具清单传给模型，而 loop 测试注入
// mock chat 绕过了 runner，无人断言 schema 真的传下去了 → 静默回归无人发现。

const openaiSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))
const anthropicSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))

vi.mock('@main/providers/openai-agent', () => ({
  chatWithToolsOpenAI: (...args: unknown[]) => openaiSpy(...(args as []))
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  chatWithToolsAnthropic: (...args: unknown[]) => anthropicSpy(...(args as []))
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

function makeCtx(): { getWorkspaceRoot: () => string; builtinAgentsDir: string; userAgentsDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'jsl-runner-'))
  const ws = join(base, 'ws')
  return {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user')
  }
}

/** 取第 4 个参数（tools）的名字集合 */
function toolNamesOf(spy: typeof openaiSpy, callIndex = 0): string[] {
  const call = spy.mock.calls[callIndex] as unknown[] | undefined
  const tools = (call?.[3] ?? []) as Array<{ name: string }>
  return tools.map((t) => t.name)
}

describe('runAgent（工具链路集成）', () => {
  beforeEach(() => {
    openaiSpy.mockClear()
    anthropicSpy.mockClear()
  })

  it('【回归】工具 schema 确实下发给模型，且缺省排除高危 run_command', async () => {
    const ctx = makeCtx()
    const res = await runAgent(ctx, { settings, apiKey: 'k', task: '干个活' })

    expect(openaiSpy).toHaveBeenCalledTimes(1)
    const names = toolNamesOf(openaiSpy)
    expect(names.length).toBeGreaterThan(0) // ← 上一轮 bug 就是这里为空
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('fetch_url')
    // 高危工具缺省不下发（plan6 D4 追记）
    expect(names).not.toContain('run_command')
    expect(res.agent).toBe('内核默认')
  })

  it('自定义 Agent 显式声明 run_command 时才下发（白名单生效）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )

    const res = await runAgent(ctx, { settings, apiKey: 'k', task: '跑个命令', agentName: 'runner-bot' })
    const names = toolNamesOf(openaiSpy)
    expect(names).toContain('run_command')
    expect(names).not.toContain('write_file') // 白名单外的工具不下发
    expect(res.agent).toBe('runner-bot')
  })

  it('未知 agentName 抛人话错误', async () => {
    const ctx = makeCtx()
    await expect(runAgent(ctx, { settings, apiKey: 'k', task: 'x', agentName: '不存在' })).rejects.toThrow(
      '找不到名为「不存在」的 Agent 定义'
    )
  })

  it('anthropic 类型走 anthropic 通道且同样下发工具', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, {
      settings: { ...settings, providerType: 'anthropic' },
      apiKey: 'k',
      task: 'x'
    })
    expect(anthropicSpy).toHaveBeenCalledTimes(1)
    expect(openaiSpy).not.toHaveBeenCalled()
    expect(toolNamesOf(anthropicSpy).length).toBeGreaterThan(0)
  })
})
