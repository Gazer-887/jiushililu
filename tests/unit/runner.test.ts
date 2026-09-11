import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'

// runner 集成测试 —— 补上"工具 schema 是否真的下发给模型"这条链路的覆盖。
// 起因（D-030）：交叉验证发现 runner 曾把空数组当工具清单传给模型，而 loop 测试注入
// mock chat 绕过了 runner，无人断言 schema 真的传下去了 → 静默回归无人发现。

const openaiSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))
const anthropicSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))

// D-032 后 runner 走**流式**通道：mock 指向 stream*（chat* 保留给降级路径）
vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: unknown[]) => openaiSpy(...(args as [])),
  chatWithToolsOpenAI: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: (...args: unknown[]) => anthropicSpy(...(args as [])),
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
  const base = mkdtempSync(join(tmpdir(), 'jsl-runner-'))
  const ws = join(base, 'ws')
  return {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    // 检查点仓库（plan8 R4）：给一个独立临时目录，让本组测试真正走一遍快照链路
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
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
    const res = await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干个活' }] })

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

  it('【回归】提示词必须带「做事纪律」——禁止不查就答（真机实测后补）', async () => {
    // 起因（2026-09-12 真机验收）：用户问「看看工作区里有什么文件」，
    // 模型**没调工具**、直接答「目前是空的」，恰巧目录真空所以"对了"——
    // 但那是运气：若有文件它会编一个假列表，且语气笃定，用户看不出来。
    // 核因是提示词缺纪律，不是架构问题（模型确实会自主调工具）。
    // 本测试守住这条纪律不被后续重构丢掉。
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '看看有哪些文件' }] })

    const messages = openaiSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')?.content ?? ''

    expect(system).toContain('能查就查')
    expect(system).toContain('必须先调用工具核实')
    // 防注入的既有规则不能被顶掉
    expect(system).toContain('安全基线')
  })

  it('【回归】做事纪律对自定义子代理同样生效（不是只给内核默认加）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-discipline.md'),
      '---\nname: runner-discipline\ndescription: 测纪律\n---\n只读审查',
      'utf8'
    )
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'runner-discipline'
    })

    const messages = openaiSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('能查就查')
  })

  it('自定义 Agent 显式声明才下发声明内工具（白名单生效）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )

    const res = await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '跑个命令' }], agentName: 'runner-bot' })
    const names = toolNamesOf(openaiSpy)
    expect(names).not.toContain('write_file') // 白名单外的工具不下发
    expect(res.agent).toBe('runner-bot')
    // 默认「可写」档：run_command 属高危，即便定义里声明了也被权限档压住
    expect(names).not.toContain('run_command')
  })

  it('权限档是硬上限：完整访问档下，声明了 run_command 才下发', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'runner-bot',
      permission: 'full-access'
    })
    expect(toolNamesOf(openaiSpy)).toContain('run_command')
  })

  it('只读档：只给读类工具，写入类被挡', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }], permission: 'read-only' })
    const names = toolNamesOf(openaiSpy)
    expect(names).toContain('read_file')
    expect(names).toContain('list_dir')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_command')
  })

  it('未知 agentName 抛人话错误', async () => {
    const ctx = makeCtx()
    await expect(runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }], agentName: '不存在' })).rejects.toThrow(
      '找不到名为「不存在」的 Agent 定义'
    )
  })

  it('anthropic 类型走 anthropic 通道且同样下发工具', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, {
      settings: { ...settings, providerType: 'anthropic' },
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }]
    })
    expect(anthropicSpy).toHaveBeenCalledTimes(1)
    expect(openaiSpy).not.toHaveBeenCalled()
    expect(toolNamesOf(anthropicSpy).length).toBeGreaterThan(0)
  })
})
