import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'

// runner 集成测试：唯一断言"工具 schema 真下发给模型"这条链路的地方。
// ⚠️ loop 测试注入 mock chat 会绕过 runner —— 只在那儿断言，这条链路静默回归无人发现。

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
    // ⚠️ 真机实测：问「有哪些文件」时模型会**不调工具直接编**一个假列表，且语气笃定。
    // 纪律靠提示词兜住 —— 后续重构删掉它，不会有别的测试变红。
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
    // plan8 R5（2026-09-13 改正）：可写档下**声明了就下发** —— 每次执行前由确认桥把关
    // （此前这条断言写成 not.toContain，等于让 R5 永远触发不了，与界面文案"执行命令仍需逐次授权"矛盾）
    expect(names).toContain('run_command')
  })

  it('⚠️ 可写档 + 声明了 run_command：执行前**真的会问用户**，拒绝则该命令不执行（plan8 R5 的接线证明）', async () => {
    const ctx = makeCtx()
    const asked: Array<{ tool: string; detail: string }> = []
    // 确认桥：注入式（工具层不知道确认从哪来），这里用一个记录答案的替身
    ctx.confirmCommand = async (req) => {
      asked.push({ tool: req.tool, detail: req.detail })
      return false // 用户拒绝
    }
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )
    // 第 1 次模型回复要求执行一条命令；第 2 次收尾
    openaiSpy.mockResolvedValueOnce({
      text: '先跑个命令',
      // @ts-expect-error 测试替身：只填本用例断言用到的字段
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'echo JSL_R5' }) }]
    })
    openaiSpy.mockResolvedValueOnce({ text: '好', toolCalls: [] })

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '跑一下' }],
      agentName: 'runner-bot',
      conversationId: 'conv-r5'
    })

    expect(asked).toHaveLength(1)
    expect(asked[0]?.tool).toBe('run_command')
    expect(asked[0]?.detail).toContain('JSL_R5')
    // 拒绝后工具如实返回"用户拒绝"，而不是静默执行
    const secondCall = openaiSpy.mock.calls[1] as unknown[] | undefined
    const messages = (secondCall?.[2] ?? []) as Array<{ content?: string }>
    expect(messages.some((m) => (m.content ?? '').includes('用户拒绝'))).toBe(true)
  })

  it('完全访问档：高危工具不弹确认（那是用户明确选的"别拦我"）', async () => {
    const ctx = makeCtx()
    const asked: string[] = []
    ctx.confirmCommand = async (req) => {
      asked.push(req.detail)
      return true
    }
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )
    openaiSpy.mockResolvedValueOnce({
      text: '跑',
      // @ts-expect-error 测试替身：只填本用例断言用到的字段
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'echo JSL_NOASK' }) }]
    })
    openaiSpy.mockResolvedValueOnce({ text: '好', toolCalls: [] })

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '跑一下' }],
      agentName: 'runner-bot',
      permission: 'full-access',
      conversationId: 'conv-full'
    })

    expect(asked).toHaveLength(0)
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
